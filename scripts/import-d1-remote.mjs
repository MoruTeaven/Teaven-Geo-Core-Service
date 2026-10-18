/**
 * 生产 D1 分批导入脚本（HTTP API，可重跑、可续传）
 *
 * 为什么不用 `wrangler d1 execute --remote --file`：
 *   50 MB / 百万行级别的 SQL 文件会让 wrangler 在 workerd 层做超大 import，
 *   本机曾出现 C++ 层崩溃（HashIndex），且中途失败无法续传。
 *
 * 做法：
 *   1. 逐字符切分 seed.sql（正确处理字符串里的 ; 与 '' 转义）
 *   2. 把切出的语句重定向到影子表 locations_new / location_names_new
 *   3. 分批 POST 到 D1 REST API，失败按退避重试，进度落盘可续传
 *   4. 全部灌完后：校验影子表 → 单请求原子切换（DROP 旧表 + RENAME + 建索引）
 *
 * 使用方式：
 *   node scripts/import-d1-remote.mjs --prepare        # 建影子表
 *   node scripts/import-d1-remote.mjs --load           # 灌数据（可重复执行续传）
 *   node scripts/import-d1-remote.mjs --verify         # 校验影子表
 *   node scripts/import-d1-remote.mjs --swap           # 原子切换
 *   node scripts/import-d1-remote.mjs --status         # 看进度
 *
 * 环境变量：
 *   CLOUDFLARE_API_TOKEN   必填
 *   CF_ACCOUNT_ID          必填
 *   D1_DATABASE_ID         必填
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SEED_FILE = path.join(PROJECT_ROOT, 'data', 'processed', 'seed.sql');
const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'processed', '.import-progress.json');

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const DATABASE_ID = process.env.D1_DATABASE_ID;

/** 是否作为 CLI 直接运行（被 import 时只取 splitStatements，不执行网络操作） */
const IS_CLI = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (IS_CLI && (!TOKEN || !ACCOUNT_ID || !DATABASE_ID)) {
  console.error('ERROR: 需要环境变量 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / D1_DATABASE_ID');
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;

/** 每次请求携带的语句数上限（D1 单请求语句数与执行时长都有上限） */
const BATCH_STATEMENTS = 20;
/** 每次请求的 SQL 字节上限，避免超过 D1 请求体限制 */
const BATCH_BYTES = 900 * 1024;

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// =============================================
// SQL 切分：正确处理字符串字面量
// =============================================

/**
 * 把整份 SQL 切成独立语句（去掉注释与空语句）
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  const statements = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // 行注释：-- 到行尾
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // 字符串字面量：'...' ，内部 '' 表示一个单引号
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            buf += "''";
            i += 2;
            continue;
          }
          buf += "'";
          i++;
          break;
        }
        buf += sql[i];
        i++;
      }
      continue;
    }

    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt) statements.push(stmt);
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

// =============================================
// HTTP 调用
// =============================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 执行一批 SQL（单请求多语句）
 * @param {string[]} statements
 * @returns {Promise<any>}
 */
async function runBatch(statements) {
  const sql = statements.join(';\n') + ';';
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql }),
      });
      const json = await res.json();
      if (json.success) return json;
      const msg = JSON.stringify(json.errors || json).slice(0, 400);
      // 唯一键冲突等确定性错误不重试
      if (/UNIQUE|PRIMARY KEY|syntax error|no such table/i.test(msg)) {
        throw new Error(`SQL 失败: ${msg}`);
      }
      lastErr = new Error(msg);
    } catch (e) {
      if (String(e.message).startsWith('SQL 失败')) throw e;
      lastErr = e;
    }
    await sleep(1000 * attempt);
  }
  throw lastErr;
}

/** 单条查询 */
async function query(sql) {
  const json = await runBatch([sql]);
  return json.result?.[0];
}

// =============================================
// 影子表语句重写
// =============================================

/**
 * 把 INSERT 目标表改成影子表
 * @param {string} stmt
 */
function toShadow(stmt) {
  return stmt
    .replace(/^INSERT INTO locations\s*\(/i, 'INSERT INTO locations_new (')
    .replace(/^INSERT INTO location_names\s*\(/i, 'INSERT INTO location_names_new (');
}

// =============================================
// 进度
// =============================================

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { done: 0, total: 0, startedAt: null };
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// =============================================
// 命令
// =============================================

const SHADOW_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS locations_new (
     id INTEGER PRIMARY KEY,
     parent_id INTEGER,
     level TEXT NOT NULL,
     country_code TEXT,
     latitude REAL,
     longitude REAL,
     is_active INTEGER DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS location_names_new (
     location_id INTEGER NOT NULL,
     lang TEXT NOT NULL,
     name TEXT NOT NULL,
     name_norm TEXT NOT NULL,
     PRIMARY KEY (location_id, lang)
   )`,
];

async function cmdPrepare() {
  console.log('=== 创建影子表 ===');
  for (const stmt of SHADOW_SCHEMA) {
    await runBatch([stmt]);
    console.log('  OK:', stmt.split('\n')[0].trim());
  }
  // 清空（支持重跑）
  await runBatch(['DELETE FROM locations_new', 'DELETE FROM location_names_new']);
  console.log('  已清空影子表');
  saveProgress({ done: 0, total: 0, startedAt: null });
}

async function cmdLoad() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error(`ERROR: ${SEED_FILE} 不存在，先跑 node scripts/process-geoname.js`);
    process.exit(1);
  }
  console.log('=== 切分 seed.sql ===');
  const raw = fs.readFileSync(SEED_FILE, 'utf-8');
  const all = splitStatements(raw);
  const inserts = all.filter((s) => /^INSERT INTO (locations|location_names)\s*\(/i.test(s));
  console.log(`  语句总数: ${all.length}，INSERT 语句: ${inserts.length}`);

  // 按字节与语句数双约束切批
  const batches = [];
  let cur = [];
  let bytes = 0;
  for (const stmt of inserts) {
    const len = Buffer.byteLength(stmt, 'utf-8');
    if (cur.length > 0 && (cur.length >= BATCH_STATEMENTS || bytes + len > BATCH_BYTES)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(toShadow(stmt));
    bytes += len;
  }
  if (cur.length) batches.push(cur);

  const progress = loadProgress();
  const startBatch = Math.min(progress.done || 0, batches.length);
  const maxBatches = Number(argOf('max-batches', '0')) || batches.length;
  const endBatch = Math.min(startBatch + maxBatches, batches.length);
  console.log(`  批次: ${batches.length}，已完成 ${startBatch}，本次跑到第 ${endBatch} 批`);

  const t0 = Date.now();
  for (let b = startBatch; b < endBatch; b++) {
    await runBatch(batches[b]);
    saveProgress({ done: b + 1, total: batches.length, startedAt: progress.startedAt || new Date().toISOString() });
    if ((b + 1) % 10 === 0 || b + 1 === endBatch) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (b + 1 - startBatch) / Math.max(elapsed, 1);
      const eta = Math.round((batches.length - b - 1) / Math.max(rate, 0.01));
      console.log(`  进度 ${b + 1}/${batches.length} (${((b + 1) / batches.length * 100).toFixed(1)}%) 已用 ${elapsed.toFixed(0)}s 预计剩余 ${eta}s`);
    }
  }
  console.log('=== 灌数据完成 ===');
}

async function cmdVerify() {
  console.log('=== 校验影子表 ===');
  const locs = await query('SELECT COUNT(*) AS c FROM locations_new');
  const names = await query('SELECT COUNT(*) AS c FROM location_names_new');
  console.log(`  locations_new: ${locs.results[0].c}`);
  console.log(`  location_names_new: ${names.results[0].c}`);

  const byLang = await query(
    `SELECT lang, COUNT(*) AS total,
            SUM(CASE WHEN name_norm = '' THEN 1 ELSE 0 END) AS empty_norm
     FROM location_names_new GROUP BY lang ORDER BY lang`,
  );
  console.log('  各语言 name_norm 为空行数:');
  for (const r of byLang.results) {
    console.log(`    ${r.lang}: ${r.empty_norm} / ${r.total}`);
  }

  const sample = await query(
    `SELECT name, name_norm, lang FROM location_names_new
     WHERE name IN ('北京市','北京','城关','華盛頓縣','市南区','東京都','大阪市')
     LIMIT 10`,
  );
  console.log('  抽样:');
  for (const r of sample.results) {
    console.log(`    ${r.lang} ${r.name} → ${JSON.stringify(r.name_norm)}`);
  }

  const emptyZh = byLang.results.find((r) => r.lang === 'zh')?.empty_norm ?? -1;
  const emptyJa = byLang.results.find((r) => r.lang === 'ja')?.empty_norm ?? -1;
  const ok = emptyZh === 0 && emptyJa === 0;
  console.log(`\n  结论: ${ok ? 'PASS 可以切换' : 'FAIL 空 name_norm 未归零，禁止切换'}`);
  if (!ok) process.exit(1);
}

async function cmdSwap() {
  console.log('=== 原子切换 ===');
  const stmts = [
    'PRAGMA foreign_keys = OFF',
    // 视图依赖旧表名，必须先删，否则 DROP TABLE 会因视图引用而失败
    'DROP VIEW IF EXISTS v_location_full',
    'DROP TABLE IF EXISTS location_names',
    'DROP TABLE IF EXISTS locations',
    'ALTER TABLE locations_new RENAME TO locations',
    'ALTER TABLE location_names_new RENAME TO location_names',
    'CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_locations_level ON locations(level)',
    'CREATE INDEX IF NOT EXISTS idx_locations_country ON locations(country_code)',
    'CREATE INDEX IF NOT EXISTS idx_names_norm ON location_names(name_norm)',
    'CREATE INDEX IF NOT EXISTS idx_names_lang ON location_names(lang)',
    'CREATE INDEX IF NOT EXISTS idx_names_location ON location_names(location_id)',
    `CREATE VIEW v_location_full AS
     SELECT l.id, l.parent_id, l.level, l.country_code, l.latitude, l.longitude, l.is_active,
            COALESCE(zn.name, en.name, jn.name) AS default_name,
            zn.name AS name_zh, en.name AS name_en, jn.name AS name_ja
     FROM locations l
     LEFT JOIN location_names zn ON l.id = zn.location_id AND zn.lang = 'zh'
     LEFT JOIN location_names en ON l.id = en.location_id AND en.lang = 'en'
     LEFT JOIN location_names jn ON l.id = jn.location_id AND jn.lang = 'ja'`,
    // 旧缓存里的解析结果由旧数据产出，必须清空（错误结果固化问题见卡 t-mv3ur0j9）
    'DELETE FROM path_cache',
  ];
  const json = await runBatch(stmts);
  console.log('  切换成功，语句数:', json.result?.length);
  for (const r of json.result || []) {
    if (!r.success) console.log('  警告: 有语句失败', JSON.stringify(r).slice(0, 200));
  }
}

async function cmdStatus() {
  const p = loadProgress();
  console.log('  进度:', JSON.stringify(p));
  const locs = await query('SELECT COUNT(*) AS c FROM locations_new');
  const names = await query('SELECT COUNT(*) AS c FROM location_names_new');
  console.log(`  locations_new: ${locs.results[0].c}，location_names_new: ${names.results[0].c}`);
}

async function main() {
  if (has('prepare')) return cmdPrepare();
  if (has('load')) return cmdLoad();
  if (has('verify')) return cmdVerify();
  if (has('swap')) return cmdSwap();
  if (has('status')) return cmdStatus();
  console.log('Usage: node scripts/import-d1-remote.mjs --prepare | --load | --verify | --swap | --status');
  process.exit(1);
}

if (IS_CLI) {
  main().catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
}
