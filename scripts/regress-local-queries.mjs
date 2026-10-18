/**
 * 本地查询级回归：把 seed.sql 灌进 node:sqlite，直接跑生产查询 SQL
 *
 * 为什么需要它：线上回归（scripts/regress-zh-query.mjs）依赖生产 D1 的每日额度，
 * 额度耗尽时无法验证。本脚本不碰网络，用与生产完全相同的 seed.sql 和与
 * src/db/queries.ts 逐字相同的 SQL，验证「name_norm 精确命中」这条主路径。
 *
 * 使用方式：
 *   node scripts/regress-local-queries.mjs
 *   node scripts/regress-local-queries.mjs --file=data/processed/seed.sql
 *
 * 退出码：0 = 全部用例通过；1 = 有失败。
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

// =============================================
// 与 src/db/queries.ts 逐字相同的 SQL
// =============================================

/** queryByNameNorm：parentId 为 null 时用 IS NULL 变体 */
function sqlByNameNorm(hasParent) {
  return `SELECT l.id, l.parent_id, l.level, l.country_code
     FROM location_names n
     INNER JOIN locations l ON n.location_id = l.id
     WHERE n.name_norm = ?
       AND ${hasParent ? 'l.parent_id = ?' : 'l.parent_id IS NULL'}
       AND l.is_active = 1
     LIMIT 1`;
}

/** queryByNameNormFuzzy */
const SQL_FUZZY = `SELECT l.id, l.parent_id, l.level, l.country_code, n.lang, n.name
   FROM location_names n
   INNER JOIN locations l ON n.location_id = l.id
   WHERE n.name_norm = ?
     AND l.is_active = 1
   LIMIT 20`;

/** /geo/search 单 token 的 SQL（src/index.ts 内联） */
const SQL_SEARCH = `SELECT DISTINCT ln.location_id, ln.name, l.level, l.country_code
   FROM location_names ln
   INNER JOIN locations l ON ln.location_id = l.id
   WHERE (ln.name_norm = ?1 OR ln.name LIKE ?2)
     AND ln.lang = ?3
     AND l.is_active = 1
   ORDER BY
     CASE WHEN ln.name_norm = ?1 THEN 0 ELSE 1 END,
     ln.name ASC
   LIMIT 20`;

// =============================================
// resolvePath 的逐级解析（与 src/services/geo.ts 同逻辑）
// =============================================

function resolvePath(db, pathStr) {
  const tokens = pathStr.split(/[\s,|，、]+/).map((t) => t.trim()).filter(Boolean);
  let parentId = null;
  let lastId = null;
  let lastLevel = 'unknown';
  let partial = false;
  let exactHits = 0;
  let fuzzyHits = 0;

  for (let i = 0; i < tokens.length; i++) {
    const nameNorm = normalizeName(tokens[i]);

    let row = db.prepare(sqlByNameNorm(parentId !== null)).get(
      ...(parentId !== null ? [nameNorm, parentId] : [nameNorm]),
    );

    if (row) {
      exactHits++;
    } else {
      const candidates = db.prepare(SQL_FUZZY).all(nameNorm);
      if (candidates.length > 0) {
        fuzzyHits++;
        if (parentId !== null) {
          const matched = candidates.find((r) => r.parent_id === parentId);
          if (matched) row = matched;
          else if (candidates.length === 1) row = candidates[0];
        } else if (candidates.length === 1) {
          row = candidates[0];
        } else {
          return { error: `Ambiguous name "${tokens[i]}": ${candidates.length} candidates` };
        }
      }
    }

    if (!row) {
      if (lastId !== null) { partial = true; break; }
      return { error: `Cannot resolve token: "${tokens[i]}" (normalized: "${nameNorm}")` };
    }
    parentId = row.id;
    lastId = row.id;
    lastLevel = row.level;
  }

  if (lastId === null) return { error: 'Path resolution failed' };
  return { location_id: lastId, level: lastLevel, partial, exactHits, fuzzyHits };
}

// =============================================
// 用例
// =============================================

const RESOLVE_CASES = [
  { path: '中国 北京', expect: (r) => r.location_id > 0 && r.level === 'admin1', exactOnly: true },
  { path: '中国 山东省 济南', expect: (r) => r.location_id > 0, exactOnly: true },
  { path: '中国 山东省 济南市', expect: (r) => r.location_id > 0, exactOnly: true },
  { path: '中国 北京市 北京市 朝阳区', expect: (r) => r.location_id > 0, exactOnly: true },
  { path: '日本 大阪', lang: 'ja', expect: (r) => r.location_id > 0, exactOnly: true },
  { path: '日本 東京都', lang: 'ja', expect: (r) => r.location_id > 0, exactOnly: true },
];

const SEARCH_CASES = [
  { q: '北京', lang: 'zh', expect: (rows) => rows.some((r) => r.name === '北京市') },
  { q: '城关', lang: 'zh', expect: (rows) => rows.length > 0 },
  { q: '朝阳', lang: 'zh', expect: (rows) => rows.length > 0 },
  { q: '大阪', lang: 'ja', expect: (rows) => rows.length > 0 },
  { q: '東京都', lang: 'ja', expect: (rows) => rows.length > 0 },
];

function main() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error(`ERROR: seed 文件不存在: ${SEED_FILE}`);
    process.exit(1);
  }

  console.log('=== 本地查询级回归（node:sqlite + 生产同款 SQL）===');
  console.log(`  seed: ${SEED_FILE}`);

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf-8'));
  const t0 = Date.now();
  db.exec(fs.readFileSync(SEED_FILE, 'utf-8'));
  console.log(`  载入耗时: ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

  const failures = [];

  console.log('  /geo/resolve（逐级 name_norm 精确命中）:');
  for (const c of RESOLVE_CASES) {
    const r = resolvePath(db, c.path);
    const ok = !r.error && c.expect(r);
    const detail = r.error
      ? r.error
      : `id=${r.location_id} level=${r.level}${r.partial ? ' partial' : ''} 精确${r.exactHits}/模糊${r.fuzzyHits}`;
    console.log(`    ${ok ? '[PASS]' : '[FAIL]'} ${c.path}${c.lang ? ` (${c.lang})` : ''} — ${detail}`);
    if (!ok) failures.push(`resolve:${c.path}`);
  }

  console.log('\n  /geo/search（单 token，name_norm 优先）:');
  for (const c of SEARCH_CASES) {
    const rows = db.prepare(SQL_SEARCH).all(normalizeName(c.q), `${c.q}%`, c.lang);
    const ok = c.expect(rows);
    const brief = rows.length
      ? `${rows.length} 条，首条 ${rows[0].name}(${rows[0].level})`
      : '0 条';
    console.log(`    ${ok ? '[PASS]' : '[FAIL]'} ${c.q} (${c.lang}) — ${brief}`);
    if (!ok) failures.push(`search:${c.q}`);
  }

  db.close();

  console.log('\n=== 结论 ===');
  if (failures.length === 0) {
    console.log(`  全部 ${RESOLVE_CASES.length + SEARCH_CASES.length} 个用例通过`);
    process.exit(0);
  }
  console.log(`  ${failures.length} 个失败: ${failures.join(', ')}`);
  process.exit(1);
}

main();
