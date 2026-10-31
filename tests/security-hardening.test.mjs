/**
 * 安全加固回归测试
 *
 * 覆盖：
 * - LIKE 通配符转义（% _ \）：转义函数单元 + sql.js 对照实验（转义/未转义行为差异）
 * - 错误契约：对外仅稳定错误码，D1/SQL 内部细节只进日志不进响应体
 * - 错误语义：DB 故障返回 500（非误报 404）、无此地 404、歧义 422、参数 400
 * - 速率限制：内存滑动窗口超限 429 + Retry-After、binding 优先、binding 故障回退
 * - CORS：默认 * 公开读取、白名单回显与拒绝、预检
 * - 端到端（itty-router worker + sql.js 模拟 D1）：正常路径回归
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

const require = createRequire(import.meta.url);
const like = require('../dist/test-build/like.cjs');
const errors = require('../dist/test-build/errors.cjs');
const cors = require('../dist/test-build/cors.cjs');
const rateLimit = require('../dist/test-build/rateLimit.cjs');
const worker = require('../dist/test-build/index.cjs');

// =============================================
// 工具：sql.js 模拟 D1
// =============================================

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

async function makeSqlite() {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  sqlite.run(SCHEMA);
  return sqlite;
}

/** 模拟 D1 接口（prepare/bind/all/first/run），可选按 SQL 注入故障 */
function makeD1(sqlite, failWhen) {
  return {
    prepare(sql) {
      if (failWhen && failWhen(sql)) {
        throw new Error('SQLITE_ERROR: no such table: injected_failure');
      }
      // 与真实 D1 一致：prepare 后未 bind 也可直接 all/first/run
      const exec = (params = []) => ({
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
      });
      return { bind: (...params) => exec(params), ...exec([]) };
    },
  };
}

function makeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, _opts) { store.set(key, value); },
  };
}

function makeEnv(db, vars = {}) {
  return {
    DB: db,
    GEO_CACHE: makeKV(),
    CACHE_TTL: '86400',
    HOT_CITIES: '',
    DEFAULT_LANG: 'zh',
    ...vars,
  };
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

/** 基础树：中国 → 山东 → 济南 → 历下区，外加通配符探测与歧义测试数据 */
function seedTree(sqlite) {
  loc(sqlite, 1000, null, 'country');
  name(sqlite, 1000, 'zh', '中国');
  name(sqlite, 1000, 'en', 'China');

  loc(sqlite, 1100, 1000, 'admin1');
  name(sqlite, 1100, 'zh', '山东');
  name(sqlite, 1100, 'en', 'Shandong');

  loc(sqlite, 1110, 1100, 'admin2');
  name(sqlite, 1110, 'zh', '济南');

  loc(sqlite, 1111, 1110, 'admin3');
  name(sqlite, 1111, 'zh', '历下区', '历下');
  name(sqlite, 1111, 'en', 'Lixia');

  // 通配符探测数据：名称含字面 % 与 _
  loc(sqlite, 5001, 1000, 'admin3');
  name(sqlite, 5001, 'zh', '100%街');
  loc(sqlite, 5002, 1000, 'admin3');
  name(sqlite, 5002, 'zh', '正常街');
  loc(sqlite, 5003, 1000, 'admin3');
  name(sqlite, 5003, 'zh', 'A_B村');
  loc(sqlite, 5004, 1000, 'admin3');
  name(sqlite, 5004, 'zh', 'AXB村');

  // 歧义数据：两个「朝阳」分属不同父级（首级模糊匹配多候选）
  loc(sqlite, 6001, 100, 'admin2');
  name(sqlite, 6001, 'zh', '朝阳区', '朝阳');
  loc(sqlite, 6002, 200, 'admin2');
  name(sqlite, 6002, 'zh', '朝阳区', '朝阳');
}

async function makeWorkerDb(vars = {}, failWhen) {
  const sqlite = await makeSqlite();
  seedTree(sqlite);
  return makeEnv(makeD1(sqlite, failWhen), vars);
}

/** 收集 console.error 输出（同时静音，避免测试噪音） */
function captureConsoleError() {
  const logs = [];
  const orig = console.error;
  console.error = (...args) => logs.push(args.map(a => (a instanceof Error ? (a.stack || a.message) : String(a))).join(' '));
  return { logs, restore: () => { console.error = orig; } };
}

async function jsonOf(res) {
  return { status: res.status, body: await res.json(), headers: res.headers };
}

// =============================================
// 1. escapeLike 单元
// =============================================

test('escapeLike: 转义 % _ \\ 为字面量', () => {
  assert.equal(like.escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
  assert.equal(like.escapeLike('plain'), 'plain');
  assert.equal(like.escapeLike(''), '');
  assert.equal(like.escapeLike('%%'), '\\%\\%');
  assert.equal(like.escapeLike('_'), '\\_');
  assert.equal(like.escapeLike('\\'), '\\\\');
  // 尾随反斜杠不被误当转义前缀
  assert.equal(like.escapeLike('abc\\'), 'abc\\\\');
});

test('likePrefix/likeContains: 包装模式正确且保留语义通配', () => {
  // 前缀匹配：输入内通配符转义，末尾仍是语义 %
  assert.equal(like.likePrefix('100%'), '100\\%%');
  assert.equal(like.likePrefix('定陶'), '定陶%');
  assert.equal(like.likeContains('a_b'), '%a\\_b%');
  assert.equal(like.likeContains('%街'), '%\\%街%');
  // ESCAPE 子句恰好是一个反斜杠字符
  assert.equal(like.SQLITE_LIKE_ESCAPE, "ESCAPE '\\'");
});

// =============================================
// 2. sql.js 对照实验：ESCAPE 子句实际行为
// =============================================

test('sql.js: ESCAPE 子句使字面 % _ 匹配（未转义对照会过匹配）', async () => {
  const sqlite = await makeSqlite();
  sqlite.run(`INSERT INTO locations (id, parent_id, level) VALUES (1, NULL, 'admin3')`);
  sqlite.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (1, 'zh', '100%街', '100%街')`);
  sqlite.run(`INSERT INTO locations (id, parent_id, level) VALUES (2, NULL, 'admin3')`);
  sqlite.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (2, 'zh', 'X街', 'x街')`);

  const exec = (sql, params) => {
    const stmt = sqlite.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };

  // contains 字面 '%街'：转义后只命中 100%街，未转义 '%%街%' 会连带 X街
  const escaped = exec(
    `SELECT location_id AS id FROM location_names WHERE name LIKE ?1 ESCAPE '\\' AND lang = 'zh'`,
    [like.likeContains('%街')],
  );
  assert.deepEqual(escaped.map(r => r.id), [1], '转义后 %街 只命中 100%街');

  const unescaped = exec(
    `SELECT location_id AS id FROM location_names WHERE name LIKE ?1 AND lang = 'zh'`,
    ['%%街%'],
  );
  assert.deepEqual(unescaped.map(r => r.id).sort(), [1, 2], '未转义对照：X街 也被匹配');

  // contains 字面 '_'：转义后只命中 A_B 行，未转义 'A_%' 会连带 AXB 行
  sqlite.run(`INSERT INTO locations (id, parent_id, level) VALUES (3, NULL, 'admin3')`);
  sqlite.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (3, 'zh', 'A_B', 'a_b')`);
  sqlite.run(`INSERT INTO locations (id, parent_id, level) VALUES (4, NULL, 'admin3')`);
  sqlite.run(`INSERT INTO location_names (location_id, lang, name, name_norm) VALUES (4, 'zh', 'AXB', 'axb')`);
  const escUnderscore = exec(
    `SELECT location_id AS id FROM location_names WHERE name LIKE ?1 ESCAPE '\\' ORDER BY id`,
    [like.likePrefix('A_')],
  );
  assert.deepEqual(escUnderscore.map(r => r.id), [3], '转义后 A_ 前缀只命中 A_B');
  const unescUnderscore = exec(
    `SELECT location_id AS id FROM location_names WHERE name LIKE ?1 ORDER BY id`,
    ['A_%'],
  );
  assert.deepEqual(unescUnderscore.map(r => r.id), [3, 4], '未转义对照：AXB 也被匹配');
});

// =============================================
// 3. 端到端：LIKE 探测防护（/geo/search）
// =============================================

test('/geo/search: 纯通配 q=% 不再匹配任何行（探测失效）', async () => {
  const env = await makeWorkerDb();
  // 未转义时 '%%' 匹配全库（≥4 行）；转义后只匹配「% 开头」的字面名称 → 0 行
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/search?q=%25'), env,
  ));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, []);
});

test('/geo/search: 下划线按字面匹配（q=A_ 只命中 A_B村）', async () => {
  const env = await makeWorkerDb();
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/search?q=A_'), env,
  ));
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 1, '未转义时 A_% 会连带 AXB村');
  assert.equal(res.body.results[0].name, 'A_B村');
});

test('/geo/search: 名称中的字面 % 不影响正常搜索（q=100%）', async () => {
  const env = await makeWorkerDb();
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/search?q=100%25'), env,
  ));
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].name, '100%街');
});

// =============================================
// 4. 端到端：错误契约与语义
// =============================================

test('/geo/get: 不存在的 ID → 404 NOT_FOUND（稳定错误码）', async () => {
  const env = await makeWorkerDb();
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/get?id=99999'), env,
  ));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: true, code: 'NOT_FOUND', message: 'Location not found: 99999' });
});

test('/geo/get: 非法参数 → 400 INVALID_PARAM', async () => {
  const env = await makeWorkerDb();
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/get?id=abc'), env,
  ));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PARAM');
});

test('DB 故障 → 500 INTERNAL_ERROR，内部 SQL 细节只进日志不进响应体', async () => {
  const env = await makeWorkerDb({}, () => true); // 所有 prepare 抛内部错误
  const { logs, restore } = captureConsoleError();
  try {
    const res = await jsonOf(await worker.default.fetch(
      new Request('http://localhost/geo/children'), env,
    ));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: true, code: 'INTERNAL_ERROR', message: 'Internal server error' });
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('SQLITE_ERROR'), '响应体不得含 SQLITE_ERROR');
    assert.ok(!serialized.includes('injected_failure'), '响应体不得含内部错误细节');
    assert.ok(!serialized.includes('no such table'), '响应体不得含 SQL 术语');
    assert.ok(logs.join('\n').includes('SQLITE_ERROR'), '内部细节应写入服务端日志');
  } finally {
    restore();
  }
});

test('/geo/resolve: DB 故障返回 500 而非误报 404（错误语义修正）', async () => {
  const env = await makeWorkerDb({}, sql => sql.includes('path_cache'));
  const { logs, restore } = captureConsoleError();
  try {
    const res = await jsonOf(await worker.default.fetch(
      new Request('http://localhost/geo/resolve?path=' + encodeURIComponent('中国 山东 济南 历下区')), env,
    ));
    assert.equal(res.status, 500, '服务故障不能伪装成「无此地」404');
    assert.equal(res.body.code, 'INTERNAL_ERROR');
    assert.ok(logs.join('\n').includes('path_cache') || logs.length > 0);
  } finally {
    restore();
  }
});

test('/geo/resolve: 正常路径解析不受影响（happy path 回归）', async () => {
  const env = await makeWorkerDb();
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/resolve?path=' + encodeURIComponent('中国 山东 济南 历下区')), env,
  ));
  assert.equal(res.status, 200);
  assert.equal(res.body.location_id, 1111);
  assert.equal(res.body.cached, false);
});

test('/geo/resolve: 无此地 → 404；地名歧义 → 422 AMBIGUOUS_MATCH', async () => {
  const env = await makeWorkerDb();

  const notFoundRes = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/resolve?path=' + encodeURIComponent('不存在的地名')), env,
  ));
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.body.code, 'NOT_FOUND');

  // 首级「朝阳」有 2 个候选（分属不同父级）且无父级约束可消歧
  const ambiguousRes = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/resolve?path=' + encodeURIComponent('朝阳')), env,
  ));
  assert.equal(ambiguousRes.status, 422);
  assert.equal(ambiguousRes.body.code, 'AMBIGUOUS_MATCH');
});

test('/geo/resolve: 空 path → 400', async () => {
  const env = await makeWorkerDb();
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/geo/resolve'), env,
  ));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PARAM');
});

test('未知路径 → 404 稳定错误体', async () => {
  const env = await makeWorkerDb();
  const res = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/nothing'), env,
  ));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: true, code: 'NOT_FOUND', message: 'Not Found' });
});

test('/health: D1 正常 → healthy；D1 故障 → 503 且不泄露错误细节', async () => {
  const envOk = await makeWorkerDb();
  const okRes = await jsonOf(await worker.default.fetch(
    new Request('http://localhost/health'), envOk,
  ));
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.status, 'healthy');

  const envBad = await makeWorkerDb({}, () => true);
  const { restore } = captureConsoleError();
  try {
    const badRes = await jsonOf(await worker.default.fetch(
      new Request('http://localhost/health'), envBad,
    ));
    assert.equal(badRes.status, 503);
    assert.equal(badRes.body.status, 'unhealthy');
    const serialized = JSON.stringify(badRes.body);
    assert.ok(!serialized.includes('SQLITE_ERROR'), 'health 响应不得泄露内部错误');
  } finally {
    restore();
  }
});

// =============================================
// 5. 端到端：速率限制
// =============================================

test('速率限制: 超过窗口配额返回 429 + Retry-After，其它 IP 不受影响', async () => {
  const env = await makeWorkerDb({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });

  const ip = ipAddr => new Request('http://localhost/geo/children', { headers: { 'CF-Connecting-IP': ipAddr } });
  const f = ipAddr => worker.default.fetch(ip(ipAddr), env);

  // 3.3.3.3：前 3 次正常，第 4 次 429
  for (let i = 0; i < 3; i++) {
    const res = await jsonOf(await f('3.3.3.3'));
    assert.equal(res.status, 200, `第 ${i + 1} 次应放行`);
  }
  const limited = await jsonOf(await f('3.3.3.3'));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('Retry-After')) >= 1, '应携带 Retry-After 头');

  // 换 IP 不受影响
  const other = await jsonOf(await f('4.4.4.4'));
  assert.equal(other.status, 200);

  // /health 不在 /geo/* 限流范围
  const health = await worker.default.fetch(new Request('http://localhost/health'), env);
  assert.equal(health.status, 200);
});

test('rateLimit: parseRateLimitConfig 默认与非法值回退', () => {
  assert.deepEqual(rateLimit.parseRateLimitConfig(), { max: 120, windowMs: 60000 });
  assert.deepEqual(rateLimit.parseRateLimitConfig('abc', 'xyz'), { max: 120, windowMs: 60000 });
  assert.deepEqual(rateLimit.parseRateLimitConfig('5', '30000'), { max: 5, windowMs: 30000 });
  assert.equal(rateLimit.parseRateLimitConfig('0').max, 1, 'max 最小为 1');
});

test('rateLimit: 内存滑动窗口超限与窗口过期恢复', async () => {
  const cfg = { max: 2, windowMs: 80 };
  const r1 = rateLimit.checkRateLimitInMemory('unit-key', cfg);
  const r2 = rateLimit.checkRateLimitInMemory('unit-key', cfg);
  assert.equal(r1.limited, false);
  assert.equal(r2.limited, false);
  const r3 = rateLimit.checkRateLimitInMemory('unit-key', cfg);
  assert.equal(r3.limited, true);
  assert.ok(r3.retryAfterSeconds >= 1);

  await new Promise(r => setTimeout(r, 120));
  const r4 = rateLimit.checkRateLimitInMemory('unit-key', cfg);
  assert.equal(r4.limited, false, '窗口过期后应恢复放行');
});

test('rateLimit: binding 优先且故障时回退内存窗口', async () => {
  // binding 拒绝 → limited
  const denied = await rateLimit.checkRateLimit(
    { RATE_LIMITER: { limit: async () => ({ success: false }) } }, '1.1.1.1', 'geo',
  );
  assert.equal(denied.limited, true);

  // binding 放行 → 不限
  const allowed = await rateLimit.checkRateLimit(
    { RATE_LIMITER: { limit: async () => ({ success: true }) } }, '1.1.1.2', 'geo',
  );
  assert.equal(allowed.limited, false);

  // binding 抛异常 → 回退内存窗口（首次不限流）
  const fallback = await rateLimit.checkRateLimit(
    { RATE_LIMITER: { limit: async () => { throw new Error('binding boom'); } } }, '1.1.1.3', 'geo',
  );
  assert.equal(fallback.limited, false);
});

// =============================================
// 6. 端到端：CORS
// =============================================

test('CORS: 默认（未配置白名单）保持 * 公开读取', async () => {
  const env = await makeWorkerDb();
  const res = await worker.default.fetch(
    new Request('http://localhost/geo/children', { headers: { Origin: 'https://a.example' } }), env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('CORS: 白名单内回显 Origin + Vary，白名单外不携带 CORS 头', async () => {
  const env = await makeWorkerDb({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' });

  const inList = await worker.default.fetch(
    new Request('http://localhost/geo/children', { headers: { Origin: 'https://a.example' } }), env,
  );
  assert.equal(inList.headers.get('Access-Control-Allow-Origin'), 'https://a.example');
  assert.match(inList.headers.get('Vary') || '', /Origin/);

  const outList = await worker.default.fetch(
    new Request('http://localhost/geo/children', { headers: { Origin: 'https://evil.example' } }), env,
  );
  assert.equal(outList.status, 200, 'API 层仍可访问（非浏览器客户端），但浏览器将拒绝跨域读取');
  assert.equal(outList.headers.get('Access-Control-Allow-Origin'), null, '白名单外不得携带 CORS 头');
});

test('CORS: OPTIONS 预检返回 204 并携带 CORS 头', async () => {
  const env = await makeWorkerDb();
  const res = await worker.default.fetch(
    new Request('http://localhost/geo/resolve', { method: 'OPTIONS', headers: { Origin: 'https://a.example' } }), env,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(res.headers.get('Access-Control-Allow-Methods'));
});

// =============================================
// 7. cors 模块单元
// =============================================

test('cors: parseAllowedOrigins 解析与回退', () => {
  assert.equal(cors.parseAllowedOrigins(undefined), null);
  assert.equal(cors.parseAllowedOrigins(''), null);
  assert.equal(cors.parseAllowedOrigins('  '), null);
  assert.deepEqual(cors.parseAllowedOrigins('https://a.com, https://b.com'), ['https://a.com', 'https://b.com']);
});

test('cors: resolveAllowOrigin 组合语义', () => {
  // 未配置白名单 → *
  assert.equal(cors.resolveAllowOrigin('https://x.com', null), '*');
  assert.equal(cors.resolveAllowOrigin(null, null), '*');
  // 配置白名单：命中回显，未命中拒绝，无 Origin 拒绝
  const list = ['https://a.com'];
  assert.equal(cors.resolveAllowOrigin('https://a.com', list), 'https://a.com');
  assert.equal(cors.resolveAllowOrigin('https://evil.com', list), null);
  assert.equal(cors.resolveAllowOrigin(null, list), null);
});

// =============================================
// 8. errors 契约单元
// =============================================

test('errors: ApiError 分类与 toApiError 收敛', () => {
  const nf = errors.notFound('Location not found: 7');
  assert.equal(nf.status, 404);
  assert.equal(nf.code, 'NOT_FOUND');

  const mapped = errors.toApiError(nf, 'test');
  assert.deepEqual(mapped, {
    body: { error: true, code: 'NOT_FOUND', message: 'Location not found: 7' },
    status: 404,
  });

  const { logs, restore } = captureConsoleError();
  try {
    const internal = errors.toApiError(new Error('SQLITE_ERROR: secret internal detail'), 'test');
    assert.equal(internal.status, 500);
    assert.deepEqual(internal.body, {
      error: true, code: 'INTERNAL_ERROR', message: 'Internal server error',
    });
    assert.equal(internal.body.message.includes('secret'), false);
    assert.ok(logs.join('\n').includes('secret'), '内部细节应进日志');
  } finally {
    restore();
  }
});
