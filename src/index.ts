/**
 * Teaven Geo Core Service - Cloudflare Worker
 * 
 * 全球统一地理服务 API
 * 
 * 路由:
 *   GET  /geo/children?parent_id=xxx&lang=zh   - 级联子级查询
 *   GET/POST /geo/resolve                         - 路径反解析（支持 query string 和 JSON body）
 *   GET  /geo/get?id=xxx&lang=zh                 - 单点查询
 *   GET  /geo/ancestors?id=xxx&lang=zh           - 父级链（面包屑）
 *   GET  /geo/is-subordinate?descendant=xxx&ancestor=xxx&lang=zh - 从属关系检查
 *   GET  /geo/search?q=xxx&lang=zh               - 搜索（未来扩展）
 *   GET  /health                                  - 健康检查
 */

import { AutoRouter, cors, json } from 'itty-router';
import { getChildren, resolvePath, getLocation, getAncestors, isSubordinate } from './services/geo';
import { corsPreflight } from './utils/response';
import { normalizeName } from './utils/normalize';

// itty-router v5 的 json(data, init) 要求 init 为 ResponseInit 对象
// 封装一个接受纯 statusCode 的便捷函数
const respond = (data: any, status: number = 200) => json(data, { status });

// =============================================
// 环境类型
// =============================================

export interface Env {
  DB: D1Database;
  GEO_CACHE: KVNamespace;
  CACHE_TTL: string;
  HOT_CITIES: string;
  DEFAULT_LANG: string;
}

// =============================================
// 路由定义
// =============================================

const { preflight, corsify } = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] });

const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

// OPTIONS 预检
router.options('*', () => corsPreflight());

// =============================================
// 健康检查
// =============================================
router.get('/health', async (_req: Request, env: Env) => {
  try {
    // 测试 D1 连接
    await env.DB.prepare('SELECT 1').first();
    return respond({
      status: 'healthy',
      timestamp: Date.now(),
      services: { d1: 'ok', kv: 'ok' },
    });
  } catch (e: any) {
    return respond({
      status: 'unhealthy',
      error: e.message,
      timestamp: Date.now(),
    }, 503);
  }
});

// =============================================
// ① GET /geo/children - 级联子级查询
// =============================================
router.get('/geo/children', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const parentIdStr = url.searchParams.get('parent_id');
  const lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';

  // parent_id 为空时返回顶级（国家列表）
  const parentId = parentIdStr ? parseInt(parentIdStr, 10) : null;
  if (parentIdStr && isNaN(parentId as number)) {
    return respond({ error: 'Invalid parent_id' }, 400);
  }

  try {
    const result = await getChildren(env.DB, parentId, lang);
    return respond(result);
  } catch (e: any) {
    return respond({ error: e.message }, 500);
  }
});

// =============================================
// ② /geo/resolve - 路径反解析 (支持 GET 和 POST)
// =============================================

// 抽取核心解析逻辑，GET 和 POST 复用
async function handleResolve(req: Request, env: Env, path: string, lang: string) {
  if (!path || typeof path !== 'string' || path.trim().length === 0) {
    return respond({ error: 'path is required' }, 400);
  }

  try {
    const result = await resolvePath(env.DB, env.GEO_CACHE, path, lang);
    return respond(result);
  } catch (e: any) {
    return respond({ error: e.message }, 404);
  }
}

// GET: 从 query string 读取参数
router.get('/geo/resolve', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const path = url.searchParams.get('path') || '';
  const lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';
  return handleResolve(req, env, path, lang);
});

// POST: 从 JSON body 读取参数
router.post('/geo/resolve', async (req: Request, env: Env) => {
  let path: string;
  let lang: string;

  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    let body: { path: string; lang?: string };
    try {
      body = await req.json();
    } catch {
      return respond({ error: 'Invalid JSON body' }, 400);
    }
    path = body.path || '';
    lang = body.lang || env.DEFAULT_LANG || 'zh';
  } else {
    // 也支持 POST form 或 query string
    const url = new URL(req.url);
    path = url.searchParams.get('path') || '';
    lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';
  }

  return handleResolve(req, env, path, lang);
});

// =============================================
// ③ GET /geo/get - 单点查询
// =============================================
router.get('/geo/get', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const idStr = url.searchParams.get('id');
  const lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';

  if (!idStr) {
    return respond({ error: 'id is required' }, 400);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return respond({ error: 'Invalid id' }, 400);
  }

  try {
    const result = await getLocation(env.DB, id, lang);
    return respond(result);
  } catch (e: any) {
    return respond({ error: e.message }, 404);
  }
});

// =============================================
// ④ GET /geo/ancestors - 父级链（面包屑）
// =============================================
router.get('/geo/ancestors', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const idStr = url.searchParams.get('id');
  const lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';

  if (!idStr) {
    return respond({ error: 'id is required' }, 400);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    return respond({ error: 'Invalid id' }, 400);
  }

  try {
    const ancestors = await getAncestors(env.DB, id, lang);
    return respond({ ancestors });
  } catch (e: any) {
    return respond({ error: e.message }, 404);
  }
});

// =============================================
// ⑤ GET /geo/is-subordinate - 从属关系检查
// =============================================
router.get('/geo/is-subordinate', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const descendantStr = url.searchParams.get('descendant');
  const ancestorStr = url.searchParams.get('ancestor');
  const lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';

  if (!descendantStr || !ancestorStr) {
    return respond({ error: 'Both descendant and ancestor (GeoNames IDs) are required' }, 400);
  }

  const descendantId = parseInt(descendantStr, 10);
  const ancestorId = parseInt(ancestorStr, 10);
  if (isNaN(descendantId) || isNaN(ancestorId)) {
    return respond({ error: 'Invalid ID(s)' }, 400);
  }

  try {
    const result = await isSubordinate(env.DB, descendantId, ancestorId, lang);
    return respond(result);
  } catch (e: any) {
    return respond({ error: e.message }, 404);
  }
});

// =============================================
// ⑥ GET /geo/search - 搜索（未来扩展）
// =============================================
router.get('/geo/search', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  const lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';

  if (!q || q.trim().length === 0) {
    return respond({ error: 'q is required' }, 400);
  }

  try {
    // 归一化搜索关键词（去掉行政后缀如"市"、"区"等），与数据中的 name_norm 匹配
    const qNorm = normalizeName(q);
    // 同时用原始关键词和归一化关键词搜索 name 和 name_norm
    const stmt = env.DB.prepare(
      `SELECT DISTINCT ln.location_id, ln.name, l.level, l.country_code
       FROM location_names ln
       INNER JOIN locations l ON ln.location_id = l.id
       WHERE (ln.name LIKE ?1 OR ln.name_norm LIKE ?1 OR ln.name_norm LIKE ?2)
         AND ln.lang = ?3
         AND l.is_active = 1
       ORDER BY ln.name ASC
       LIMIT 20`
    ).bind(`%${q}%`, `%${qNorm}%`, lang);

    const result = await stmt.all();
    return respond({ results: result.results || [], query: q });
  } catch (e: any) {
    return respond({ error: e.message }, 500);
  }
});

// =============================================
// 404
// =============================================
router.all('*', () => respond({ error: 'Not Found' }, 404));

// =============================================
// 导出 Worker
// =============================================
export default router;
