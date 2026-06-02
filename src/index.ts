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
import { getChildren, resolvePath, getLocation, getAncestors, isSubordinate, resolveHierarchyName, searchChildren } from './services/geo';
import { corsPreflight } from './utils/response';
import { normalizeSearchTerm } from './utils/normalize';

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
// ⑥ GET /geo/search - 级联搜索
//
//   末位 token = 搜索目标，前位 token = 层级面包屑（深度不限）
//
//   示例：
//     ?path=中国,山东,菏泽,定陶      → 在菏泽下搜"定陶"
//     ?path=中国,乳山                → 在中国下搜"乳山"（跳过中间层级）
//     ?path=浙江,杭州                → 在浙江下搜"杭州"
//     ?path=金华市,义乌市            → 在金华市下搜"义乌市"（自动处理行政后缀）
//     ?q=定陶                        → 单 token 全库搜索（向后兼容）
//   支持两种传参方式：
//     A) ?path=中国,乳山               → 单参逗号分隔
//     B) ?path=中国&path=乳山           → 多参每参一个 token
//   也支持：名称或 GeoNames ID（纯数字）
// =============================================
router.get('/geo/search', async (req: Request, env: Env) => {
  const url = new URL(req.url);
  const lang = url.searchParams.get('lang') || env.DEFAULT_LANG || 'zh';
  const q = url.searchParams.get('q') || '';

  // path 兼容两种传法：单参逗号分隔 / 多参每参一个
  const pathValues = url.searchParams.getAll('path');
  const pathStr = pathValues.length > 0 ? pathValues.join(',') : '';

  // path 优先，q 兜底（向后兼容）
  const rawInput = pathStr || q;
  if (!rawInput.trim()) {
    return respond({ error: 'path or q is required' }, 400);
  }

  // 多分隔符切分 token
  const tokens = rawInput.split(/[\s,|，、]+/).map(t => t.trim()).filter(t => t.length > 0);
  if (tokens.length === 0) {
    return respond({ error: 'path or q is required' }, 400);
  }

  // 最后一个 token 是搜索目标，前面的都是层级面包屑
  const searchToken = tokens[tokens.length - 1];
  const hierarchy = tokens.slice(0, -1);

  try {
    if (hierarchy.length === 0) {
      // ———— 单 token：全库模糊搜索 ————
      const qNorm = normalizeSearchTerm(searchToken);
      const stmt = env.DB.prepare(
        `SELECT DISTINCT ln.location_id, ln.name, l.level, l.country_code
         FROM location_names ln
         INNER JOIN locations l ON ln.location_id = l.id
         WHERE (ln.name_norm = ?1 OR ln.name LIKE ?2)
           AND ln.lang = ?3
           AND l.is_active = 1
         ORDER BY
           CASE WHEN ln.name_norm = ?1 THEN 0 ELSE 1 END,
           ln.name ASC
         LIMIT 20`
      ).bind(qNorm, `${searchToken}%`, lang);
      const result = await stmt.all();
      return respond({ results: result.results || [], query: searchToken });
    }

    // ———— 多 token：逐级解析层级面包屑，在最后一个 parent 下搜索 ————
    let parentId: number | null = null;
    for (const name of hierarchy) {
      parentId = await resolveHierarchyName(env.DB, name, parentId);
    }

    const results = await searchChildren(env.DB, parentId!, searchToken, lang);
    return respond({
      results,
      query: searchToken,
      hierarchy,
      parent_id: parentId,
    });
  } catch (e: any) {
    return respond({ error: e.message }, 404);
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
