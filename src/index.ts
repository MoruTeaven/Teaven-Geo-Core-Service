/**
 * Teaven Geo Core Service - Cloudflare Worker
 * 
 * 全球统一地理服务 API
 * 
 * 路由:
 *   GET  /geo/children?parent_id=xxx&lang=zh   - 级联子级查询
 *   POST /geo/resolve                            - 路径反解析
 *   GET  /geo/get?id=xxx&lang=zh                 - 单点查询
 *   GET  /geo/ancestors?id=xxx&lang=zh           - 父级链（面包屑）
 *   GET  /geo/search?q=xxx&lang=zh               - 搜索（未来扩展）
 *   GET  /health                                  - 健康检查
 */

import { AutoRouter, cors, json } from 'itty-router';
import { getChildren, resolvePath, getLocation, getAncestors } from './services/geo';
import { corsPreflight } from './utils/response';

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
  const lang = url.searchParams.get('lang') || 'en';

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
// ② POST /geo/resolve - 路径反解析
// =============================================
router.post('/geo/resolve', async (req: Request, env: Env) => {
  let body: { path: string; lang?: string };
  try {
    body = await req.json();
  } catch {
    return respond({ error: 'Invalid JSON body' }, 400);
  }

  const { path, lang = 'en' } = body;
  if (!path || typeof path !== 'string' || path.trim().length === 0) {
    return respond({ error: 'path is required' }, 400);
  }

  try {
    const result = await resolvePath(env.DB, env.GEO_CACHE, path, lang);
    return respond(result);
  } catch (e: any) {
    return respond({ error: e.message }, 404);
  }
});

// =============================================
// ③ GET /geo/get - 单点查询
// =============================================
router.get('/geo/get', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const idStr = url.searchParams.get('id');
  const lang = url.searchParams.get('lang') || 'en';

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
  const lang = url.searchParams.get('lang') || 'en';

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
// ⑤ GET /geo/search - 搜索（未来扩展）
// =============================================
router.get('/geo/search', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  const lang = url.searchParams.get('lang') || 'en';

  if (!q || q.trim().length === 0) {
    return respond({ error: 'q is required' }, 400);
  }

  try {
    // 简单搜索实现：使用 location_search 表
    const stmt = env.DB.prepare(
      `SELECT DISTINCT ls.location_id, ln.name, l.level, l.country_code
       FROM location_search ls
       INNER JOIN location_names ln ON ls.location_id = ln.location_id AND ln.lang = ?2
       INNER JOIN locations l ON ls.location_id = l.id
       WHERE ls.token LIKE ?1 AND ls.lang = ?2
       LIMIT 20`
    ).bind(`%${q.toLowerCase()}%`, lang);

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
