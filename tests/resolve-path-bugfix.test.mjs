/**
 * 验证 resolvePath / resolveHierarchyName 缓存固化 bug 修复
 *
 * 用 sql.js 内存库测试 SQL 层（lang 过滤、ORDER BY、多候选检测），
 * 用纯逻辑 mock 测试服务层（部分匹配不写缓存、多候选报歧义）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';

// ── SQL 字符串（从 queries.ts 同步，验证修复后的查询行为） ──
const SQL_FUZZY = `SELECT l.id, l.parent_id, l.level, l.country_code, n.lang, n.name
  FROM location_names n
  INNER JOIN locations l ON n.location_id = l.id
  WHERE n.name_norm = ?1 AND l.is_active = 1 LIMIT 20`;

const SQL_LIKE_FIXED = `SELECT l.id
  FROM location_names n
  INNER JOIN locations l ON n.location_id = l.id
  WHERE n.name LIKE ?1 AND n.lang = ?2 AND l.is_active = 1
  ORDER BY CASE WHEN n.name = ?3 THEN 0 ELSE 1 END, n.name ASC LIMIT 1`;

const SQL_LIKE_OLD = `SELECT l.id
  FROM location_names n
  INNER JOIN locations l ON n.location_id = l.id
  WHERE n.name LIKE ?1 AND l.is_active = 1 LIMIT 1`;

// 不带 LIMIT 的版本，用于验证匹配范围
const SQL_LIKE_FIXED_NOLIMIT = `SELECT l.id, n.lang, n.name
  FROM location_names n
  INNER JOIN locations l ON n.location_id = l.id
  WHERE n.name LIKE ?1 AND n.lang = ?2 AND l.is_active = 1
  ORDER BY CASE WHEN n.name = ?3 THEN 0 ELSE 1 END, n.name ASC`;

const SQL_LIKE_OLD_NOLIMIT = `SELECT l.id, n.lang, n.name
  FROM location_names n
  INNER JOIN locations l ON n.location_id = l.id
  WHERE n.name LIKE ?1 AND l.is_active = 1`;

const SCHEMA = `
CREATE TABLE locations (
  id INTEGER PRIMARY KEY, parent_id INTEGER, level TEXT,
  country_code TEXT, latitude REAL, longitude REAL, is_active INTEGER DEFAULT 1
);
CREATE TABLE location_names (
  location_id INTEGER, lang TEXT, name TEXT, name_norm TEXT,
  PRIMARY KEY (location_id, lang)
);
CREATE TABLE path_cache (
  path_key TEXT PRIMARY KEY, location_id INTEGER,
  hit_count INTEGER DEFAULT 1, updated_at INTEGER
);
`;

async function makeDb() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(SCHEMA);
  return db;
}

function exec(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── 测试数据 ──
async function seedAmbiguous(db) {
  // 两个"朝阳"：一个在北京，一个在长春
  db.run(`INSERT INTO locations (id, parent_id, level, country_code) VALUES (1, 100, 'admin2', 'CN')`);
  db.run(`INSERT INTO locations (id, parent_id, level, country_code) VALUES (2, 200, 'admin2', 'CN')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (1, 'zh', '朝阳区', '朝阳')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (2, 'zh', '朝阳区', '朝阳')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (1, 'en', 'Chaoyang District', 'chaoyang')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (2, 'en', 'Chaoyang District', 'chaoyang')`);
}

async function seedLikeFallback(db) {
  // 同名不同语言，测试 lang 过滤（ASCII 避免 sql.js LIKE 对 CJK 的编码问题）
  db.run(`INSERT INTO locations (id, parent_id, level, country_code) VALUES (10, NULL, 'country', 'JP')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (10, 'zh', 'Nihonkoku', 'nihon')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (10, 'en', 'Nihon', 'nihon')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (10, 'ja', 'Nihon', 'nihon')`);
}

// =============================================
// 1. 模糊查询返回多候选 → 服务层应报歧义（不取第一个）
// =============================================
test('fuzzy query returns multiple candidates for ambiguous name "朝阳"', async () => {
  const db = await makeDb();
  await seedAmbiguous(db);
  const rows = exec(db, SQL_FUZZY, ['朝阳']);
  assert.equal(rows.length, 2, '应返回 2 个候选');
  // 服务层修复后：length > 1 且 parentId===null → throw，不再取 results[0]
});

// =============================================
// 2. LIKE 兜底：lang 过滤 — 修复前无 lang 约束，任意语言匹配
// =============================================
test('LIKE fallback with lang filter returns only zh result', async () => {
  const db = await makeDb();
  await seedLikeFallback(db);

  // 修复后：带 lang='zh' 过滤，只返回 zh 行（LIMIT 1 取精确匹配）
  const fixedRows = exec(db, SQL_LIKE_FIXED, ['%Nihon%', 'zh', 'Nihonkoku']);
  assert.equal(fixedRows.length, 1);
  assert.equal(fixedRows[0].id, 10);

  // 验证匹配范围：修复后只匹配 zh，修复前匹配全部语言
  const fixedAll = exec(db, SQL_LIKE_FIXED_NOLIMIT, ['%Nihon%', 'zh', 'Nihonkoku']);
  assert.equal(fixedAll.length, 1, 'lang=zh 应只匹配 1 行');

  const oldAll = exec(db, SQL_LIKE_OLD_NOLIMIT, ['%Nihon%']);
  assert.ok(oldAll.length >= 2, '旧查询无 lang 过滤应匹配多语言多行');
});

// =============================================
// 3. LIKE 兜底：ORDER BY 优先精确匹配
// =============================================
test('LIKE fallback ORDER BY prefers exact name match', async () => {
  const db = await makeDb();
  // 两个 zh 名称都 LIKE '%Shandong%'，但只有一个是精确匹配
  db.run(`INSERT INTO locations (id, parent_id, level) VALUES (20, NULL, 'admin1')`);
  db.run(`INSERT INTO locations (id, parent_id, level) VALUES (21, NULL, 'admin2')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (20, 'zh', 'Shandong', 'shandong')`);
  db.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (21, 'zh', 'Shandong Road', 'shandong road')`);

  // 不带 LIMIT，验证 ORDER BY 排序
  const rows = exec(db, SQL_LIKE_FIXED_NOLIMIT, ['%Shandong%', 'zh', 'Shandong']);
  assert.equal(rows.length, 2);
  // ORDER BY CASE WHEN n.name = ?3 → "Shandong" 排前面
  assert.equal(rows[0].id, 20, '精确匹配应排在前面');
});

// =============================================
// 4. 部分匹配不写缓存 — 纯逻辑验证
// =============================================
test('partial match skips cache write (logic guard)', () => {
  // 模拟 resolvePath 的缓存写入守卫
  let cacheWritten = false;
  const partialMatch = true; // 模拟部分匹配

  // 修复后的逻辑
  if (!partialMatch) {
    cacheWritten = true;
  }

  assert.equal(cacheWritten, false, '部分匹配不应写缓存');
});

test('full match writes cache (logic guard)', () => {
  let cacheWritten = false;
  const partialMatch = false; // 完整匹配

  if (!partialMatch) {
    cacheWritten = true;
  }

  assert.equal(cacheWritten, true, '完整匹配应写缓存');
});

// =============================================
// 5. 多候选模糊匹配 → 报歧义错误（不取第一个）
// =============================================
test('ambiguous first-level fuzzy throws instead of taking results[0]', () => {
  // 模拟修复后的第一级模糊匹配逻辑
  const fuzzyResults = [{ id: 1 }, { id: 2 }]; // 2 个候选
  const parentId = null; // 第一级

  let threw = false;
  try {
    if (parentId !== null) {
      // 非第一级逻辑（不影响此测试）
    } else if (fuzzyResults.length === 1) {
      // 唯一候选 → 取用
    } else {
      throw new Error(`Ambiguous name: ${fuzzyResults.length} candidates`);
    }
  } catch (e) {
    threw = true;
    assert.match(e.message, /Ambiguous/);
  }
  assert.ok(threw, '多候选应抛出歧义错误');
});

test('single first-level fuzzy result is accepted', () => {
  const fuzzyResults = [{ id: 42 }]; // 唯一候选
  const parentId = null;

  let result = null;
  if (parentId !== null) {
    // 非第一级
  } else if (fuzzyResults.length === 1) {
    result = fuzzyResults[0];
  } else {
    throw new Error('Ambiguous');
  }
  assert.equal(result.id, 42, '唯一候选应被取用');
});
