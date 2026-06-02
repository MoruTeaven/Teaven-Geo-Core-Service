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
  queryNameByLang,
  queryParentById,
  querySearchChildren,
  type ChildResult,
  type LocationDetail,
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
}

export async function resolvePath(
  db: D1Database,
  kv: KVNamespace,
  path: string,
  lang: string = 'zh',
): Promise<ResolveResult> {
  // 预处理路径
  const tokens = parsePathTokens(path);
  if (tokens.length === 0) {
    throw new Error('Empty path');
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
      });
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

      if (fuzzyResult.results) {
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
        } else {
          // 第一级 token：直接取第一个候选（通常是最合理的匹配）
          result = fuzzyResult.results[0];
        }
      }
    }

    if (!result) {
      // 部分匹配：返回最后匹配到的节点
      if (lastId !== null) {
        break;
      }
      throw new Error(`Cannot resolve token: "${tokens[i]}" (normalized: "${nameNorm}")`);
    }

    parentId = result.id;
    lastId = result.id;
    lastLevel = result.level;
  }

  if (lastId === null) {
    throw new Error('Path resolution failed');
  }

  // Step 4: 写入缓存（双写 KV + D1）
  const cacheEntry: CacheEntry = {
    location_id: lastId,
    level: lastLevel,
    cached_at: Date.now(),
  };

  // 异步双写，不阻塞响应
  await Promise.allSettled([
    kvSet(kv, pathKey, cacheEntry),
    upsertPathCache(db, pathKey, lastId).run(),
  ]);

  return {
    location_id: lastId,
    level: lastLevel,
    path_tokens: tokens,
    cached: false,
  };
}

// =============================================
// ③ 单点查询
// =============================================

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
  const result = await stmt.first<{
    id: number;
    parent_id: number | null;
    level: string;
    country_code: string | null;
    latitude: number | null;
    longitude: number | null;
    name_zh: string | null;
    name_en: string | null;
    name_ja: string | null;
  }>();

  if (!result) {
    throw new Error(`Location not found: ${id}`);
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

export async function getAncestors(
  db: D1Database,
  id: number,
  lang: string = 'zh',
): Promise<Array<{ id: number; name: string; level: string }>> {
  const ancestors: Array<{ id: number; name: string; level: string }> = [];
  let currentId: number | null = id;
  const needConvert = isTraditionalChinese(lang);

  while (currentId !== null) {
    const locStmt = queryLocationById(db, currentId);
    const loc = await locStmt.first<{
      id: number;
      parent_id: number | null;
      level: string;
      name_zh: string | null;
      name_en: string | null;
      name_ja: string | null;
    }>();

    if (!loc) break;

    const nameMap: Record<string, string | null> = {
      zh: loc.name_zh,
      en: loc.name_en,
      ja: loc.name_ja,
    };
    // zh-Hant 时用 zh 数据
    const lookupLang = needConvert ? 'zh' : lang;
    let name = nameMap[lookupLang] || loc.name_en || loc.name_zh || '';
    if (needConvert) {
      name = toTraditional(name);
    }

    ancestors.unshift({ id: loc.id, name, level: loc.level });
    currentId = loc.parent_id;
  }

  return ancestors;
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
  const descLoc = await descStmt.first<{
    id: number;
    level: string;
    name_zh: string | null;
    name_en: string | null;
    name_ja: string | null;
  }>();
  if (!descLoc) {
    throw new Error(`Location not found: ${descendantId}`);
  }

  // 获取 ancestor 的信息
  const ancStmt = queryLocationById(db, ancestorId);
  const ancLoc = await ancStmt.first<{
    id: number;
    level: string;
    name_zh: string | null;
    name_en: string | null;
    name_ja: string | null;
  }>();
  if (!ancLoc) {
    throw new Error(`Location not found: ${ancestorId}`);
  }

  // 名称获取辅助函数
  const getName = (loc: { name_zh: string | null; name_en: string | null; name_ja: string | null }): string => {
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

  // 从 descendant 向上遍历 parent_id，查找 ancestor
  let currentId: number | null = descLoc.id;
  let depth = 0;
  let found = false;

  while (currentId !== null) {
    const parentStmt = queryParentById(db, currentId);
    const parent = await parentStmt.first<{ id: number; parent_id: number | null; level: string }>();
    if (!parent) break;

    if (parent.id === ancestorId) {
      found = true;
      break;
    }

    currentId = parent.parent_id;
    depth++;
  }

  return {
    is_subordinate: found,
    descendant: { id: descLoc.id, name: getName(descLoc), level: descLoc.level },
    ancestor: { id: ancLoc.id, name: getName(ancLoc), level: ancLoc.level },
    depth: found ? depth : -1,
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
): Promise<number> {
  const trimmed = nameOrId.trim();
  if (!trimmed) throw new Error('Empty hierarchy name');

  // 纯数字 → 当作 geonameid 直接使用
  if (/^\d+$/.test(trimmed)) {
    const id = parseInt(trimmed, 10);
    const locStmt = queryLocationById(db, id);
    const loc = await locStmt.first<{ id: number }>();
    if (!loc) throw new Error(`Location not found: ${id}`);
    // 可选：验证 parent 关系
    if (parentId !== null) {
      const parentStmt = queryParentById(db, id);
      const parent = await parentStmt.first<{ parent_id: number | null }>();
      if (!parent || parent.parent_id !== parentId) {
        throw new Error(`Location ${id} is not a child of ${parentId}`);
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

  // Step 2: 模糊匹配（不受 parent_id 约束）
  const fuzzyStmt = queryByNameNormFuzzy(db, nameNorm);
  const fuzzyResult = await fuzzyStmt.all<{ id: number; parent_id: number | null }>();
  if (fuzzyResult.results && fuzzyResult.results.length > 0) {
    if (parentId !== null) {
      // 在候选列表中优先找 parent_id 匹配的
      const matched = fuzzyResult.results.find(r => r.parent_id === parentId);
      if (matched) return matched.id;
    }
    // 取第一个候选
    return fuzzyResult.results[0].id;
  }

  throw new Error(`Cannot resolve: "${trimmed}"`);
}

/**
 * 在指定父节点下搜索匹配名称的子节点
 */
export async function searchChildren(
  db: D1Database,
  parentId: number,
  q: string,
  lang: string,
): Promise<Array<{ location_id: number; name: string; level: string; country_code: string | null }>> {
  const qNorm = normalizeSearchTerm(q);
  const stmt = querySearchChildren(db, parentId, qNorm, `${q}%`, lang);
  const result = await stmt.all<{ location_id: number; name: string; level: string; country_code: string | null }>();
  return result.results || [];
}
