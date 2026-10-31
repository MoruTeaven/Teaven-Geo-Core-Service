/**
 * 地理业务服务层
 * 
 * 核心逻辑：
 * 1. 级联子级查询
 * 2. 路径反向解析（path → location_id）
 * 3. 单点详情查询
 * 4. 多语言 fallback
 */

import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import {
  queryChildren,
  queryLocationById,
  queryByNameNorm,
  queryByNameNormFuzzy,
  queryPathCache,
  upsertPathCache,
  queryParentById,
  queryParentsBatch,
  queryAncestorChain,
  type ChildResult,
  type LocationByIdRow,
} from '../db/queries';
import {
  normalizeName,
  normalizeSearchTerm,
  buildPathKey,
  parsePathTokens,
  resolveLangPriority,
  isTraditionalChinese,
} from '../utils/normalize';
import { toTraditional } from '../utils/s2t';
import { kvGet, kvSet, type CacheEntry } from '../utils/cache';
import { invalidParam, notFound, ambiguousMatch } from '../utils/errors';
import { likePrefix, likeContains, SQLITE_LIKE_ESCAPE } from '../utils/like';

// =============================================
// ① 获取子级（级联选择）
// =============================================

export async function getChildren(
  db: D1Database,
  parentId: number | null,
  lang: string = 'zh',
): Promise<{ children: ChildResult[] }> {
  // zh-Hant 请求时，用 zh 数据查询
  const queryLang = isTraditionalChinese(lang) ? 'zh' : lang;
  const stmt = queryChildren(db, parentId, queryLang);
  const result = await stmt.all<ChildResult>();
  
  // 如果是繁体中文请求，转换名称
  if (isTraditionalChinese(lang)) {
    return {
      children: (result.results || []).map(c => ({
        ...c,
        name: toTraditional(c.name),
      })),
    };
  }
  
  return { children: result.results || [] };
}

// =============================================
// ② 路径解析（核心）
// =============================================

export interface ResolveResult {
  location_id: number;
  level: string;
  path_tokens: string[];
  cached: boolean;
  partial?: boolean;
}

export async function resolvePath(
  db: D1Database,
  kv: KVNamespace,
  path: string,
  lang: string = 'zh',
  kvTtlSeconds: number = 86400,
): Promise<ResolveResult> {
  // 预处理路径
  const tokens = parsePathTokens(path);
  if (tokens.length === 0) {
    throw invalidParam('path is required');
  }

  const pathKey = buildPathKey(tokens);

  // Step 1: 查 KV 缓存
  const kvEntry = await kvGet(kv, pathKey);
  if (kvEntry) {
    return {
      location_id: kvEntry.location_id,
      level: kvEntry.level,
      path_tokens: tokens,
      cached: true,
    };
  }

  // Step 2: 查 D1 path_cache
  const cacheStmt = queryPathCache(db, pathKey);
  const cacheResult = await cacheStmt.first<{ location_id: number }>();
  if (cacheResult) {
    // 回写 KV
    const locStmt = queryLocationById(db, cacheResult.location_id);
    const loc = await locStmt.first<{ level: string }>();
    if (loc) {
      await kvSet(kv, pathKey, {
        location_id: cacheResult.location_id,
        level: loc.level,
        cached_at: Date.now(),
      }, kvTtlSeconds);
    }
    return {
      location_id: cacheResult.location_id,
      level: loc?.level || 'unknown',
      path_tokens: tokens,
      cached: true,
    };
  }

  // Step 3: 逐级匹配
  const normalizedTokens = tokens.map(normalizeName);
  let parentId: number | null = null;
  let lastId: number | null = null;
  let lastLevel: string = 'unknown';
  let partialMatch = false;

  for (let i = 0; i < normalizedTokens.length; i++) {
    const nameNorm = normalizedTokens[i];

    // 精确匹配
    let stmt = queryByNameNorm(db, nameNorm, parentId);
    let result = await stmt.first<{ id: number; level: string; parent_id: number | null }>();

    // 如果精确匹配失败，尝试模糊匹配（不受 parent_id 约束）
    if (!result) {
      const fuzzyStmt = queryByNameNormFuzzy(db, nameNorm);
      const fuzzyResult = await fuzzyStmt.all<{
        id: number;
        parent_id: number | null;
        level: string;
      }>();

      if (fuzzyResult.results && fuzzyResult.results.length > 0) {
        if (parentId !== null) {
          // 非第一级：在候选列表中优先找 parent_id 匹配的
          const matched = fuzzyResult.results.find(
            r => r.parent_id === parentId,
          );
          if (matched) {
            result = matched;
          } else if (fuzzyResult.results.length === 1) {
            result = fuzzyResult.results[0];
          }
        } else if (fuzzyResult.results.length === 1) {
          // 第一级 token：仅当候选唯一时取用
          result = fuzzyResult.results[0];
        } else {
          // 多候选无法消歧，报错而非静默取第一个
          throw ambiguousMatch(
            `Ambiguous match for "${tokens[i]}", please specify a more precise path`,
          );
        }
      }
    }

    if (!result) {
      // 部分匹配：返回最后匹配到的节点（但不写缓存）
      if (lastId !== null) {
        partialMatch = true;
        break;
      }
      throw notFound(`Cannot resolve token: "${tokens[i]}"`);
    }

    parentId = result.id;
    lastId = result.id;
    lastLevel = result.level;
  }

  if (lastId === null) {
    throw notFound('Path resolution failed');
  }

  // Step 4: 写入缓存（双写 KV + D1）—— 部分匹配不写缓存
  if (!partialMatch) {
    const cacheEntry: CacheEntry = {
      location_id: lastId,
      level: lastLevel,
      cached_at: Date.now(),
    };

    // 异步双写，不阻塞响应
    await Promise.allSettled([
      kvSet(kv, pathKey, cacheEntry, kvTtlSeconds),
      upsertPathCache(db, pathKey, lastId).run(),
    ]);
  }

  return {
    location_id: lastId,
    level: lastLevel,
    path_tokens: tokens,
    cached: false,
    partial: partialMatch || undefined,
  };
}

// =============================================
// ③ 单点查询
// =============================================

/**
 * /geo/get 对外响应形状（唯一定义处）
 * 原先与 src/types.ts 的 LocationDetail、db/queries.ts 的 LocationDetail
 * 三处重复定义，已收敛：DB 行形状 = queries.ts 的 LocationByIdRow，
 * 响应形状 = 本接口。
 */
export interface GetResult {
  id: number;
  parent_id: number | null;
  level: string;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  name: string;
  names: {
    zh: string | null;
    en: string | null;
    ja: string | null;
  };
}

export async function getLocation(
  db: D1Database,
  id: number,
  preferredLang: string = 'zh',
): Promise<GetResult> {
  const stmt = queryLocationById(db, id);
  const result = await stmt.first<LocationByIdRow>();

  if (!result) {
    throw notFound(`Location not found: ${id}`);
  }

  // 按优先级选择显示名称
  const langPriority = resolveLangPriority(preferredLang);
  let displayName = result.name_en || result.name_zh || '';
  for (const lang of langPriority) {
    const nameMap: Record<string, string | null> = {
      zh: result.name_zh,
      en: result.name_en,
      ja: result.name_ja,
    };
    if (nameMap[lang]) {
      displayName = nameMap[lang]!;
      break;
    }
  }

  // 繁体中文请求：转换名称
  const needConvert = isTraditionalChinese(preferredLang);
  const convert = (s: string | null): string | null =>
    s && needConvert ? toTraditional(s) : s;

  return {
    id: result.id,
    parent_id: result.parent_id,
    level: result.level,
    country_code: result.country_code,
    latitude: result.latitude,
    longitude: result.longitude,
    name: needConvert ? toTraditional(displayName) : displayName,
    names: {
      zh: convert(result.name_zh),
      en: result.name_en,  // 英文不转换
      ja: result.name_ja,  // 日文不转换
    },
  };
}

// =============================================
// ④ 获取父级链（面包屑）
// =============================================

/** 祖先链最大深度：行政层级实际 ≤6 层，留余量并防止坏数据成环导致死递归 */
const ANCESTOR_MAX_DEPTH = 10;

/**
 * 一次递归 CTE 查询拿到完整祖先链（含自身），替代逐级上溯的 N+1 查询
 * 语义与旧实现一致：
 * - 起点（含 inactive）始终参与，祖先按 is_active 过滤，链在缺失/停用处截断
 * - 名称按 lang 选取，en/zh 兜底；zh-Hant 用 zh 数据并转繁体
 * - 返回顺序：根在前、自身在后
 */
export async function getAncestors(
  db: D1Database,
  id: number,
  lang: string = 'zh',
): Promise<Array<{ id: number; name: string; level: string }>> {
  const result = await queryAncestorChain(db, id, ANCESTOR_MAX_DEPTH).all<{
    id: number;
    level: string;
    name_zh: string | null;
    name_en: string | null;
    name_ja: string | null;
  }>();

  const needConvert = isTraditionalChinese(lang);
  const lookupLang = needConvert ? 'zh' : lang;

  // CTE 按 depth 升序返回（自身→根），面包屑需要根→自身
  const rows = (result.results || []).slice().reverse();

  return rows.map(loc => {
    const nameMap: Record<string, string | null> = {
      zh: loc.name_zh,
      en: loc.name_en,
      ja: loc.name_ja,
    };
    let name = nameMap[lookupLang] || loc.name_en || loc.name_zh || '';
    if (needConvert) {
      name = toTraditional(name);
    }
    return { id: loc.id, name, level: loc.level };
  });
}

// =============================================
// ⑤ 从属关系检查
// =============================================

export interface SubordinateResult {
  is_subordinate: boolean;
  descendant: { id: number; name: string; level: string };
  ancestor: { id: number; name: string; level: string };
  depth: number; // descendant 在 ancestor 下面第几级（0 = 同级，-1 = 未找到关系）
}

/**
 * 检查 descendant 是否为 ancestor 的下属行政单位
 * 即：ancestor 是否出现在 descendant 的祖先链中
 * 
 * @example
 *   isSubordinate(db, 济南id, 山东id)  → true  (济南是山东的下属)
 *   isSubordinate(db, 山东id, 济南id)  → false (山东不是济南的下属)
 */
export async function isSubordinate(
  db: D1Database,
  descendantId: number,
  ancestorId: number,
  lang: string = 'zh',
): Promise<SubordinateResult> {
  // 获取 descendant 的信息
  const descStmt = queryLocationById(db, descendantId);
  const descLoc = await descStmt.first<LocationByIdRow>();
  if (!descLoc) {
    throw notFound(`Location not found: ${descendantId}`);
  }

  // 获取 ancestor 的信息
  const ancStmt = queryLocationById(db, ancestorId);
  const ancLoc = await ancStmt.first<LocationByIdRow>();
  if (!ancLoc) {
    throw notFound(`Location not found: ${ancestorId}`);
  }

  // 名称获取辅助函数
  const getName = (loc: Pick<LocationByIdRow, 'name_zh' | 'name_en' | 'name_ja'>): string => {
    const nameMap: Record<string, string | null> = { zh: loc.name_zh, en: loc.name_en, ja: loc.name_ja };
    return nameMap[lang] || loc.name_en || loc.name_zh || '';
  };

  // 同一节点不算从属
  if (descendantId === ancestorId) {
    return {
      is_subordinate: false,
      descendant: { id: descLoc.id, name: getName(descLoc), level: descLoc.level },
      ancestor: { id: ancLoc.id, name: getName(ancLoc), level: ancLoc.level },
      depth: 0,
    };
  }

  // 一次递归 CTE 拿到整条祖先链（含自身 depth 0，祖先带 is_active 过滤），
  // 替代逐级 queryParentById 的 N+1 上溯；depth 上限同时防坏数据成环死循环
  const chain = await queryAncestorChain(db, descendantId, ANCESTOR_MAX_DEPTH).all<{
    id: number;
    depth: number;
  }>();

  // 链中 depth 0 是 descendant 自身（前面已排除同节点），
  // 祖先从 depth 1 开始；旧语义：直接父级命中时 depth = 0
  let depth = -1;
  for (const row of chain.results || []) {
    if (row.depth >= 1 && row.id === ancestorId) {
      depth = row.depth - 1;
      break;
    }
  }

  return {
    is_subordinate: depth >= 0,
    descendant: { id: descLoc.id, name: getName(descLoc), level: descLoc.level },
    ancestor: { id: ancLoc.id, name: getName(ancLoc), level: ancLoc.level },
    depth,
  };
}

// =============================================
// ⑥ 层级名解析（搜索用）
// =============================================

/**
 * 解析单个层级名称到 geonameid
 * - 纯数字 → 直接作为 ID 使用（验证存在性）
 * - 字符串 → 先精确父级约束匹配，再模糊兜底
 * 
 * @param db D1 数据库
 * @param nameOrId 名称或纯数字 ID 字符串
 * @param parentId 父节点 ID（null = 无约束/顶级）
 * @returns 解析到的 geonameid，失败抛出错误
 */
export async function resolveHierarchyName(
  db: D1Database,
  nameOrId: string,
  parentId: number | null,
  lang: string = 'zh',
): Promise<number> {
  const trimmed = nameOrId.trim();
  if (!trimmed) throw invalidParam('Empty hierarchy name');

  // 纯数字 → 当作 geonameid 直接使用
  if (/^\d+$/.test(trimmed)) {
    const id = parseInt(trimmed, 10);
    const locStmt = queryLocationById(db, id);
    const loc = await locStmt.first<{ id: number }>();
    if (!loc) throw notFound(`Location not found: ${id}`);
    // 可选：验证 parent 关系
    if (parentId !== null) {
      const parentStmt = queryParentById(db, id);
      const parent = await parentStmt.first<{ parent_id: number | null }>();
      if (!parent || parent.parent_id !== parentId) {
        throw invalidParam(`Location ${id} is not a child of ${parentId}`);
      }
    }
    return id;
  }

  // 名称 → 归一化后查找
  const nameNorm = normalizeSearchTerm(trimmed);

  // Step 1: 精确匹配（parent_id 约束）
  const exactStmt = queryByNameNorm(db, nameNorm, parentId);
  const exact = await exactStmt.first<{ id: number }>();
  if (exact) return exact.id;

  // Step 2: 模糊匹配 name_norm（不受 parent_id 约束）
  const fuzzyStmt = queryByNameNormFuzzy(db, nameNorm);
  const fuzzyResult = await fuzzyStmt.all<{ id: number; parent_id: number | null }>();
  if (fuzzyResult.results && fuzzyResult.results.length > 0) {
    if (parentId !== null) {
      const matched = fuzzyResult.results.find(r => r.parent_id === parentId);
      if (matched) return matched.id;
    }
    // 仅当候选唯一时取用，多候选留给 Step 3 LIKE 兜底
    if (fuzzyResult.results.length === 1) {
      return fuzzyResult.results[0].id;
    }
  }

  // Step 3: name LIKE 兜底 — 按 lang 过滤，优先精确匹配
  // LIKE 通配符转义：用户输入的 % _ 按字面量匹配，防探测与索引劣化
  const likeStmt = db
    .prepare(
      `SELECT l.id
       FROM location_names n
       INNER JOIN locations l ON n.location_id = l.id
       WHERE n.name LIKE ?1 ${SQLITE_LIKE_ESCAPE} AND n.lang = ?2 AND l.is_active = 1
       ORDER BY
         CASE WHEN n.name = ?3 THEN 0 ELSE 1 END,
         n.name ASC
       LIMIT 1`,
    )
    .bind(likeContains(trimmed), lang, trimmed);
  const likeResult = await likeStmt.first<{ id: number }>();
  if (likeResult) return likeResult.id;

  throw notFound(`Cannot resolve: "${trimmed}"`);
}

/** D1 单条语句绑定参数上限 100，按 90 分块留余量 */
const IN_CLAUSE_CHUNK_SIZE = 90;

/**
 * 批量查一批 id 的 parent_id，返回 id → parent_id 映射
 * 仅含 is_active = 1 的行（与 queryParentById 过滤语义一致）
 */
async function fetchParentMap(
  db: D1Database,
  ids: number[],
): Promise<Map<number, number | null>> {
  const map = new Map<number, number | null>();
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
    const result = await queryParentsBatch(db, chunk).all<{
      id: number;
      parent_id: number | null;
    }>();
    for (const row of result.results || []) {
      map.set(row.id, row.parent_id);
    }
  }
  return map;
}

/**
 * 在指定父节点的**整个子树**中搜索匹配名称的后代
 *
 * 分两步：① 全局搜名字 → ② 验证祖先链是否包含 parentId
 *
 * ② 为分层批量上溯：先把全部候选的祖先按层收集成 parent 映射
 * （每层一次 `WHERE id IN (...)` 批量查询，最多 5 层），
 * 再按候选顺序判定，替代旧版逐候选串行上溯的 N+1 模式
 * （单次搜索最多 ~250 次 D1 查询 → 现在最多 6 次）。
 * 判定语义与旧版一致：候选的 parent 及向上最多 5 层祖先命中即保留，
 * 链在缺失/inactive 处截断，按候选顺序取前 20 条。
 * 全部为普通 SELECT，未依赖递归 CTE（规避 D1 兼容性顾虑）。
 */
export async function searchChildren(
  db: D1Database,
  parentId: number,
  q: string,
  lang: string,
): Promise<Array<{ location_id: number; name: string; level: string; country_code: string | null }>> {
  const qNorm = normalizeSearchTerm(q);

  // Step 1: 全局搜索名字匹配的候选（多取一些供过滤）
  // LIKE 通配符转义：用户输入的 % _ 按字面量匹配，防探测与索引劣化
  const stmt = db
    .prepare(
      `SELECT DISTINCT ln.location_id, ln.name, l.level, l.country_code, l.parent_id
       FROM location_names ln
       INNER JOIN locations l ON ln.location_id = l.id
       WHERE (ln.name_norm = ?1 OR ln.name LIKE ?2 ${SQLITE_LIKE_ESCAPE})
         AND ln.lang = ?3
         AND l.is_active = 1
       ORDER BY
         CASE WHEN ln.name_norm = ?1 THEN 0 ELSE 1 END,
         ln.name ASC
       LIMIT 50`,
    )
    .bind(qNorm, likePrefix(q), lang);
  const result = await stmt.all<{
    location_id: number; name: string; level: string;
    country_code: string | null; parent_id: number | null;
  }>();
  const candidates = result.results || [];

  // Step 2: 分层批量上溯，构建已探明节点的 parent 映射
  // 只追「parent 存在且不是目标」的候选链：直接子节点本地即命中，顶级节点不可能命中
  const parentOf = new Map<number, number | null>();
  const pendingParents = candidates
    .filter(c => c.parent_id !== null && c.parent_id !== parentId)
    .map(c => c.parent_id as number);

  if (pendingParents.length > 0) {
    let frontier = [...new Set(pendingParents)];
    // 最多 5 层：与旧版「最多向上追溯 5 层」一致
    for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
      const parentMap = await fetchParentMap(db, frontier);
      const nextFrontier: number[] = [];
      for (const [id, pid] of parentMap) {
        if (!parentOf.has(id)) {
          parentOf.set(id, pid);
          // 链上出现 parentId 即命中，无需继续向上探明
          if (pid !== null && pid !== parentId) nextFrontier.push(pid);
        }
      }
      frontier = [...new Set(nextFrontier)];
    }
  }

  /** 候选的祖先链（parent + 最多 5 次上溯）是否包含 parentId */
  const isUnderAncestry = (startId: number | null): boolean => {
    let cursor: number | null = startId;
    for (let hop = 0; hop <= 5 && cursor !== null; hop++) {
      if (cursor === parentId) return true;
      if (hop === 5) break;
      const next = parentOf.get(cursor);
      if (next === undefined) return false; // 链在缺失/inactive 处截断
      cursor = next;
    }
    return false;
  };

  // Step 3: 按候选顺序保留命中者，取前 20（与旧版顺序语义一致）
  const filtered: Array<{ location_id: number; name: string; level: string; country_code: string | null }> = [];

  for (const c of candidates) {
    if (c.parent_id === parentId || isUnderAncestry(c.parent_id)) {
      filtered.push({
        location_id: c.location_id,
        name: c.name,
        level: c.level,
        country_code: c.country_code,
      });
      if (filtered.length >= 20) break;
    }
  }

  return filtered;
}
