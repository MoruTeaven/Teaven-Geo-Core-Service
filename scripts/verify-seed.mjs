/**
 * seed.sql 本地校验脚本（零依赖，Node 22+ 内置 node:sqlite）
 *
 * 用途：在导入生产 D1 之前，先在本机把 seed.sql 灌进内存库，核对
 *   - 各语言 name_norm 为空的行数（历史 BUG：zh/ja 全空）
 *   - 关键地名的 name_norm 是否符合 shared/normalize.mjs 的规则
 *   - 与 normalizeName() 的一致性（写库与查询规则不能分叉）
 *
 * 使用方式：
 *   node scripts/verify-seed.mjs                     # 默认校验 data/processed/seed.sql
 *   node scripts/verify-seed.mjs --file=path/to.sql
 *   node scripts/verify-seed.mjs --expect-empty=0    # 空 name_norm 允许上限（默认 0）
 *
 * 退出码：0 = 全部通过；1 = 有校验项不通过。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { normalizeName } from '../shared/normalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SEED_FILE = path.resolve(PROJECT_ROOT, argOf('file', 'data/processed/seed.sql'));
const SCHEMA_FILE = path.join(PROJECT_ROOT, 'db', 'migrations', '001_init.sql');
const MAX_EMPTY = Number(argOf('expect-empty', '0'));

/** 关键地名：名称 → 期望的 name_norm（由 shared/normalize.mjs 推导，不手写死值） */
const SAMPLE_NAMES = [
  '北京市', '北京', '城关', '華盛頓縣', '山东省', '市南区',
  '東京都', '大阪市', '北海道',
  'Beijing', 'City of London', 'New York City',
];

/** 纯后缀词：去后缀后为空，必须回退为原值（绝不能是空串） */
const SUFFIX_ONLY = ['省', '市', 'City', '縣'];

function loadSql(db, file) {
  const sql = fs.readFileSync(file, 'utf-8');
  // 逐条执行：seed.sql 由 process-geoname.js 生成，语句以 ";\n\n" 结尾
  db.exec(sql);
}

function main() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error(`ERROR: seed 文件不存在: ${SEED_FILE}`);
    process.exit(1);
  }

  console.log(`=== seed.sql 校验 ===`);
  console.log(`  文件: ${SEED_FILE}`);
  console.log(`  大小: ${(fs.statSync(SEED_FILE).size / 1024 / 1024).toFixed(1)} MB`);

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf-8'));

  const t0 = Date.now();
  loadSql(db, SEED_FILE);
  console.log(`  导入内存库耗时: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const failures = [];
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };

  // ① 行数
  const locCount = db.prepare('SELECT COUNT(*) AS c FROM locations').get().c;
  const nameCount = db.prepare('SELECT COUNT(*) AS c FROM location_names').get().c;
  console.log(`\n  locations: ${locCount}`);
  console.log(`  location_names: ${nameCount}`);
  check('locations 非空', locCount > 400000, `${locCount} 行`);
  check('location_names 非空', nameCount > 500000, `${nameCount} 行`);

  // ② 各语言空 name_norm
  console.log('\n  各语言 name_norm 为空的行数:');
  const rows = db
    .prepare(
      `SELECT lang,
              COUNT(*) AS total,
              SUM(CASE WHEN name_norm = '' THEN 1 ELSE 0 END) AS empty_norm
       FROM location_names
       GROUP BY lang
       ORDER BY lang`,
    )
    .all();
  for (const r of rows) {
    const pct = ((r.empty_norm / r.total) * 100).toFixed(3);
    console.log(`    ${r.lang}: ${r.empty_norm} / ${r.total} (${pct}%)`);
  }
  const zh = rows.find((r) => r.lang === 'zh');
  const ja = rows.find((r) => r.lang === 'ja');
  const en = rows.find((r) => r.lang === 'en');
  check('zh 数据存在', !!zh, zh ? `${zh.total} 行` : '缺失');
  check('ja 数据存在', !!ja, ja ? `${ja.total} 行` : '缺失');
  check(`zh 空 name_norm ≤ ${MAX_EMPTY}`, !!zh && zh.empty_norm <= MAX_EMPTY, zh ? `${zh.empty_norm} 行` : '-');
  check(`ja 空 name_norm ≤ ${MAX_EMPTY}`, !!ja && ja.empty_norm <= MAX_EMPTY, ja ? `${ja.empty_norm} 行` : '-');
  check(`en 空 name_norm ≤ ${MAX_EMPTY}`, !!en && en.empty_norm <= MAX_EMPTY, en ? `${en.empty_norm} 行` : '-');

  // ③ 关键地名：库里的 name_norm 必须等于 normalizeName(原名称)
  console.log('\n  关键地名 name_norm 抽样:');
  for (const name of SAMPLE_NAMES) {
    const expected = normalizeName(name);
    const hits = db
      .prepare(
        `SELECT lang, name, name_norm FROM location_names
         WHERE name = ?1 AND name_norm <> ''
         LIMIT 3`,
      )
      .all(name);
    if (hits.length === 0) {
      // 该名称可能不在当前数据集内（ GeoNames 会变动），只记录不算失败
      console.log(`    [SKIP] ${name} — 数据集中无此名称`);
      continue;
    }
    const wrong = hits.filter((h) => h.name_norm !== expected);
    console.log(
      `    ${wrong.length === 0 ? '[PASS]' : '[FAIL]'} ${name} → ${hits.map((h) => `${h.lang}:${h.name_norm}`).join(', ')} (期望 ${expected})`,
    );
    if (wrong.length > 0) failures.push(`sample:${name}`);
  }

  // ④ 纯后缀词不得退化为空串
  console.log('\n  纯后缀词（去后缀后为空，须回退为原值）:');
  for (const name of SUFFIX_ONLY) {
    const expected = normalizeName(name);
    const ok = expected !== '' && expected === name.toLowerCase();
    const rows2 = db
      .prepare('SELECT lang, name_norm FROM location_names WHERE name = ?1 LIMIT 3')
      .all(name);
    console.log(
      `    ${ok ? '[PASS]' : '[FAIL]'} ${name} → normalizeName=${JSON.stringify(expected)}` +
        (rows2.length ? `，库内: ${rows2.map((r) => `${r.lang}:${JSON.stringify(r.name_norm)}`).join(', ')}` : '，数据集内无此名称'),
    );
    if (!ok) failures.push(`suffix:${name}`);
  }

  // ⑤ 写库规则与查询规则一致性（全量抽查 2000 行）
  console.log('\n  写库 name_norm 与 normalizeName() 一致性:');
  const sample = db
    .prepare('SELECT name, name_norm FROM location_names ORDER BY location_id LIMIT 2000 OFFSET 100000')
    .all();
  const mismatch = sample.filter((r) => normalizeName(r.name) !== r.name_norm);
  check(
    '抽样 2000 行 name_norm === normalizeName(name)',
    mismatch.length === 0,
    mismatch.length === 0 ? '' : `不一致 ${mismatch.length} 行，例: ${JSON.stringify(mismatch[0])}`,
  );

  db.close();

  console.log('\n=== 结论 ===');
  if (failures.length === 0) {
    console.log('  全部校验通过，可以导入生产 D1。');
    process.exit(0);
  }
  console.log(`  未通过 ${failures.length} 项: ${failures.join(', ')}`);
  process.exit(1);
}

main();
