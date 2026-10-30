/**
 * 验证 /geo/search 与 searchChildren / getAncestors / isSubordinate 的 N+1 修复
 *
 * 用 esbuild 把 src/services/geo.ts 打包为 CJS 后加载**真实实现**，
 * 用 sql.js 内存库模拟 D1 接口（prepare/bind/all/first），
 * 并在 mock 上记录每次 prepare 的 SQL，断言批量上溯的查询次数。
 *
 * 覆盖：
 * - searchChildren：深层祖先命中、直接子节点命中、链断、inactive 截断、
 *   第 6/7 代祖先命中边界、LIMIT 20 顺序语义、查询次数（≤6 次，旧实现最高 ~251 次）
 * - getAncestors：递归 CTE 链顺序（根→自身）、语言 fallback、zh-Hant 转换、截断
 * - isSubordinate：depth 语义（直接父级 = 0）、同节点、无关节点、环保护
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);
const geo = require('../dist/test-build/geo.cjs');

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
  const sqlite = new SQL.Database();
  sqlite.run(SCHEMA);

  // 模拟 D1 接口：prepare(sql).bind(...params).all()/first()，并记录查询日志
  const queryLog = [];
  const d1 = {
    prepare(sql) {
      return {
        bind(...params) {
          queryLog.push(sql.replace(/\s+/g, ' ').trim());
          return {
            async all() {
              const stmt = sqlite.prepare(sql);
              stmt.bind(params);
              const rows = [];
              while (stmt.step()) rows.push(stmt.getAsObject());
              stmt.free();
              return { results: rows };
            },
            async first() {
              const r = await this.all();
              return r.results.length > 0 ? r.results[0] : null;
            },
            async run() {
              sqlite.run(sql, params);
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { d1, sqlite, queryLog };
}

function loc(sqlite, id, parentId, level, isActive = 1) {
  sqlite.run(
    `INSERT INTO locations (id, parent_id, level, country_code, is_active) VALUES (?, ?, ?, 'CN', ?)`,
    [id, parentId, level, isActive],
  );
}

function name(sqlite, id, lang, nameText, norm) {
  sqlite.run(
    `INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (?, ?, ?, ?)`,
    [id, lang, nameText, norm ?? nameText],
  );
}

/** 基础树：中国 → 山东 → 济南 → {历下区, 市中区}；另有广东→广州、日本→东京 */
function seedBaseTree(sqlite) {
  loc(sqlite, 1000, null, 'country');
  name(sqlite, 1000, 'zh', '中国');
  name(sqlite, 1000, 'en', 'China');
  name(sqlite, 1000, 'ja', '中華');

  loc(sqlite, 1100, 1000, 'admin1');
  name(sqlite, 1100, 'zh', '山东');
  name(sqlite, 1100, 'en', 'Shandong');

  loc(sqlite, 1110, 1100, 'admin2');
  name(sqlite, 1110, 'zh', '济南');
  name(sqlite, 1110, 'en', 'Jinan');

  loc(sqlite, 1111, 1110, 'admin3');
  name(sqlite, 1111, 'zh', '历下区');
  name(sqlite, 1111, 'en', 'Lixia');

  loc(sqlite, 1112, 1110, 'admin3');
  name(sqlite, 1112, 'zh', '市中区');
  name(sqlite, 1112, 'en', 'Shizhong');

  loc(sqlite, 1200, 1000, 'admin1');
  name(sqlite, 1200, 'zh', '广东');
  name(sqlite, 1200, 'en', 'Guangdong');

  loc(sqlite, 1210, 1200, 'admin2');
  name(sqlite, 1210, 'zh', '广州');
  name(sqlite, 1210, 'en', 'Guangzhou');

  loc(sqlite, 2000, null, 'country');
  name(sqlite, 2000, 'zh', '日本');
  name(sqlite, 2000, 'en', 'Japan');

  loc(sqlite, 2100, 2000, 'admin1');
  name(sqlite, 2100, 'zh', '东京');
  name(sqlite, 2100, 'en', 'Tokyo');
}

// =============================================
// searchChildren — 分层批量上溯
// =============================================

test('searchChildren: 深层祖先命中（候选的祖父的父 = 目标）且查询次数 ≤ 6', async () => {
  const { d1, sqlite, queryLog } = await makeDb();
  seedBaseTree(sqlite);

  const results = await geo.searchChildren(d1, 1000, '市中', 'zh');

  // 市中区(1112) 链: 1112→1110→1100→1000（第 3 层命中）
  assert.equal(results.length, 1);
  assert.equal(results[0].location_id, 1112);
  assert.equal(results[0].name, '市中区');
  assert.equal(results[0].level, 'admin3');

  // 旧实现此处为 1(Step1) + 3(逐候选上溯) = 4 次；新实现应 ≤ 6（本例 3 次）
  assert.ok(queryLog.length <= 6, `查询次数应为 ≤6，实际 ${queryLog.length}`);
  assert.ok(queryLog.length >= 2, '至少包含 Step1 与一层批量上溯');
  // 所有上溯查询必须是批量 IN 形式，而非逐个点查
  const batchQueries = queryLog.filter(s => s.includes('WHERE id IN'));
  assert.ok(batchQueries.length >= 1, '应包含 WHERE id IN 批量查询');
  assert.ok(
    queryLog.filter(s => s.includes('WHERE id = ?1 AND is_active = 1')).length === 0,
    '不应出现逐个 queryParentById 点查（N+1）',
  );
});

test('searchChildren: 直接子节点与深层后代混合命中，按候选顺序返回', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  // 「广」命中 广东(1200, 直接子节点) + 广州(1210, parent 1200 深层)
  const results = await geo.searchChildren(d1, 1000, '广', 'zh');
  assert.deepEqual(
    results.map(r => r.location_id),
    [1200, 1210],
    '应按 SQL 候选顺序返回直接命中与深层命中',
  );
});

test('searchChildren: 跨国候选被过滤（祖先链不含目标）', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  // 东京(2100) 链: 2100→2000(日本)，不含中国(1000)
  const results = await geo.searchChildren(d1, 1000, '东京', 'zh');
  assert.equal(results.length, 0);
});

test('searchChildren: 链断（parent 指向不存在的节点）候选被淘汰', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);
  loc(sqlite, 9000, 8999, 'admin3');
  name(sqlite, 9000, 'zh', '幽灵区');

  const results = await geo.searchChildren(d1, 1000, '幽灵', 'zh');
  assert.equal(results.length, 0);
});

test('searchChildren: inactive 祖先使链截断，候选被淘汰', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);
  sqlite.run('UPDATE locations SET is_active = 0 WHERE id = 1100'); // 山东停用

  // 市中区链在山东处截断 → 不再从属于中国
  const results = await geo.searchChildren(d1, 1000, '市中', 'zh');
  assert.equal(results.length, 0);
});

test('searchChildren: 第 6 代祖先命中、第 7 代祖先不命中（5 层上溯边界）', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  // TARGET(6000) 下构造两条链（链上中间节点用「桥」命名，不匹配搜索词，仅端点是候选）：
  // D 链：深链乙(7001) → 桥乙2..桥乙6 → TARGET：TARGET 是 7001 的第 6 代祖先 → 命中
  // C 链：深链甲(7101) → 桥甲2..桥甲7 → TARGET：TARGET 是 7101 的第 7 代祖先 → 不命中
  loc(sqlite, 6000, null, 'country');
  name(sqlite, 6000, 'zh', '深链靶');
  for (let i = 6; i >= 2; i--) {
    loc(sqlite, 7000 + i, i === 6 ? 6000 : 7000 + i + 1, 'admin3');
    name(sqlite, 7000 + i, 'zh', `桥乙${i}`);
  }
  loc(sqlite, 7001, 7002, 'admin3');
  name(sqlite, 7001, 'zh', '深链乙');
  for (let i = 7; i >= 2; i--) {
    loc(sqlite, 7100 + i, i === 7 ? 6000 : 7100 + i + 1, 'admin3');
    name(sqlite, 7100 + i, 'zh', `桥甲${i}`);
  }
  loc(sqlite, 7101, 7102, 'admin3');
  name(sqlite, 7101, 'zh', '深链甲');

  const results = await geo.searchChildren(d1, 6000, '深链', 'zh');
  assert.deepEqual(
    results.map(r => r.location_id),
    [7001],
    '第 6 代祖先命中应保留，第 7 代应被淘汰',
  );
});

test('searchChildren: 50 候选共享祖先时批量上溯仅 2 次查询，LIMIT 20 生效', async () => {
  const { d1, sqlite, queryLog } = await makeDb();
  seedBaseTree(sqlite);

  // TARGET(6000) ← 10 个中层(5000+j) ← 50 个候选(3000+i)，共享中层
  loc(sqlite, 6000, null, 'country');
  name(sqlite, 6000, 'zh', '深链靶');
  for (let j = 0; j < 10; j++) {
    loc(sqlite, 5000 + j, 6000, 'admin1');
    name(sqlite, 5000 + j, 'zh', `中层${j}`);
  }
  for (let i = 0; i < 50; i++) {
    loc(sqlite, 3000 + i, 5000 + (i % 10), 'admin3');
    name(sqlite, 3000 + i, 'zh', `候选${String(i).padStart(2, '0')}`);
  }

  const results = await geo.searchChildren(d1, 6000, '候选', 'zh');

  assert.equal(results.length, 20, '命中 50 条时只返回前 20 条');
  // 1(Step1) + 1(批量上溯中层) = 2 次；旧实现为 1 + 50×1 = 51 次
  assert.equal(queryLog.length, 2, `共享祖先场景应仅 2 次查询，实际 ${queryLog.length}`);
});

test('searchChildren: 全部直接子节点命中时不触发批量上溯（仅 Step1 一次查询）', async () => {
  const { d1, sqlite, queryLog } = await makeDb();
  seedBaseTree(sqlite);

  // 30 个直接子节点，全部 parent = 1000
  for (let i = 0; i < 30; i++) {
    loc(sqlite, 4000 + i, 1000, 'admin3');
    name(sqlite, 4000 + i, 'zh', `直辖区${String(i).padStart(2, '0')}`);
  }

  const results = await geo.searchChildren(d1, 1000, '直辖', 'zh');
  assert.equal(results.length, 20);
  assert.equal(queryLog.length, 1, '直接命中场景应只有 Step1 一次查询');
});

// =============================================
// getAncestors — 递归 CTE 祖先链
// =============================================

test('getAncestors: 返回根→自身的完整链（含自身），查询次数为 1', async () => {
  const { d1, sqlite, queryLog } = await makeDb();
  seedBaseTree(sqlite);

  const result = await geo.getAncestors(d1, 1111, 'zh');

  assert.deepEqual(
    result.map(a => [a.id, a.name, a.level]),
    [
      [1000, '中国', 'country'],
      [1100, '山东', 'admin1'],
      [1110, '济南', 'admin2'],
      [1111, '历下区', 'admin3'],
    ],
    '面包屑顺序应为根在前、自身在后',
  );
  assert.equal(queryLog.length, 1, '整条链应一次 CTE 查询完成');
  assert.ok(queryLog[0].includes('WITH RECURSIVE'), '应使用递归 CTE');
});

test('getAncestors: 语言 fallback（ja 缺失退 en，再退 zh）', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  const result = await geo.getAncestors(d1, 1110, 'ja');
  assert.deepEqual(
    result.map(a => [a.id, a.name]),
    [
      [1000, '中華'], // ja 存在
      [1100, 'Shandong'], // ja 缺失 → en
      [1110, 'Jinan'], // ja 缺失 → en
    ],
  );
});

test('getAncestors: zh-Hant 用 zh 数据并转繁体', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  const result = await geo.getAncestors(d1, 1110, 'zh-Hant');
  assert.deepEqual(
    result.map(a => a.name),
    ['中國', '山東', '濟南'],
  );
});

test('getAncestors: 不存在的 id 返回空数组', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  const result = await geo.getAncestors(d1, 99999, 'zh');
  assert.deepEqual(result, []);
});

test('getAncestors: inactive 起点仍返回链，inactive 祖先使链截断', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  // 起点自身 inactive：与旧实现一致（起点不过滤），链完整
  sqlite.run('UPDATE locations SET is_active = 0 WHERE id = 1111');
  let result = await geo.getAncestors(d1, 1111, 'zh');
  assert.deepEqual(
    result.map(a => a.id),
    [1000, 1100, 1110, 1111],
  );

  // 祖先 inactive：链在该处截断
  sqlite.run('UPDATE locations SET is_active = 0 WHERE id = 1100');
  result = await geo.getAncestors(d1, 1111, 'zh');
  assert.deepEqual(
    result.map(a => a.id),
    [1110, 1111],
    '山东 inactive 后，链只剩 济南→历下区',
  );
});

// =============================================
// isSubordinate — 递归 CTE 从属检查
// =============================================

test('isSubordinate: 直接父级 depth=0，逐级递增', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  const direct = await geo.isSubordinate(d1, 1111, 1110, 'zh');
  assert.equal(direct.is_subordinate, true);
  assert.equal(direct.depth, 0);

  const grand = await geo.isSubordinate(d1, 1111, 1100, 'zh');
  assert.equal(grand.is_subordinate, true);
  assert.equal(grand.depth, 1);

  const great = await geo.isSubordinate(d1, 1111, 1000, 'zh');
  assert.equal(great.is_subordinate, true);
  assert.equal(great.depth, 2);
  assert.equal(great.descendant.name, '历下区');
  assert.equal(great.ancestor.name, '中国');
});

test('isSubordinate: 同节点不算从属（depth 0），无关节点返回 -1', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  const same = await geo.isSubordinate(d1, 1111, 1111, 'zh');
  assert.equal(same.is_subordinate, false);
  assert.equal(same.depth, 0);

  const unrelated = await geo.isSubordinate(d1, 1111, 1200, 'zh');
  assert.equal(unrelated.is_subordinate, false);
  assert.equal(unrelated.depth, -1);
});

test('isSubordinate: inactive 祖先截断从属关系', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);
  sqlite.run('UPDATE locations SET is_active = 0 WHERE id = 1100');

  const blocked = await geo.isSubordinate(d1, 1111, 1000, 'zh');
  assert.equal(blocked.is_subordinate, false);
  assert.equal(blocked.depth, -1);

  // 直接父级（未停用的 1110）仍成立
  const ok = await geo.isSubordinate(d1, 1111, 1110, 'zh');
  assert.equal(ok.is_subordinate, true);
});

test('isSubordinate: 坏数据成环时不死循环并返回未找到', async (t) => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  // A ↔ B 互为父级
  loc(sqlite, 8001, 8002, 'admin3');
  loc(sqlite, 8002, 8001, 'admin3');
  name(sqlite, 8001, 'zh', '环甲');
  name(sqlite, 8002, 'zh', '环乙');

  const res = await geo.isSubordinate(d1, 8001, 1000, 'zh');
  assert.equal(res.is_subordinate, false);
  assert.equal(res.depth, -1, '环应在深度上限处截断');
});

test('isSubordinate: descendant 或 ancestor 不存在时抛错', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  await assert.rejects(
    () => geo.isSubordinate(d1, 88888, 1000, 'zh'),
    /Location not found: 88888/,
  );
  await assert.rejects(
    () => geo.isSubordinate(d1, 1111, 77777, 'zh'),
    /Location not found: 77777/,
  );
});

// =============================================
// 递归 CTE SQL — depth 上限参数直接验证
// =============================================

test('递归 CTE: maxDepth 参数限制链长（防御环数据）', async () => {
  const { d1, sqlite } = await makeDb();
  seedBaseTree(sqlite);

  // 与 src/db/queries.ts queryAncestorChain 同步的 SQL
  const SQL_CHAIN = `WITH RECURSIVE chain(id, parent_id, level, depth) AS (
         SELECT id, parent_id, level, 0
         FROM locations
         WHERE id = ?1
         UNION ALL
         SELECT l.id, l.parent_id, l.level, c.depth + 1
         FROM locations l
         INNER JOIN chain c ON l.id = c.parent_id
         WHERE c.depth < ?2
           AND l.is_active = 1
       )
       SELECT c.id, c.level, c.depth,
              zn.name AS name_zh,
              en.name AS name_en,
              jn.name AS name_ja
       FROM chain c
       LEFT JOIN location_names zn ON c.id = zn.location_id AND zn.lang = 'zh'
       LEFT JOIN location_names en ON c.id = en.location_id AND en.lang = 'en'
       LEFT JOIN location_names jn ON c.id = jn.location_id AND jn.lang = 'ja'
       ORDER BY c.depth ASC`;

  const r = await d1.prepare(SQL_CHAIN).bind(1111, 2).all();
  assert.deepEqual(
    r.results.map(row => [row.id, row.depth]),
    [[1111, 0], [1110, 1], [1100, 2]],
    'maxDepth=2 时链应止于第 2 代祖先',
  );
});
