/**
 * D1 数据访问层 - 预编译 SQL 查询
 * 
 * 所有 SQL 查询集中管理，确保：
 * - 参数化查询（防注入）
 * - Index 命中
 * - 可维护性
 */

import type { D1Database } from '@cloudflare/workers-types';

// =============================================
// 类型定义
// =============================================

export interface LocationRow {
  id: number;
  parent_id: number | null;
  level: string;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  is_active: number;
}

export interface LocationNameRow {
  location_id: number;
  lang: string;
  name: string;
  name_norm: string;
}

export interface PathCacheRow {
  path_key: string;
  location_id: number;
  hit_count: number;
  updated_at: number;
}

export interface ChildResult {
  id: number;
  name: string;
  level: string;
}

export interface LocationDetail {
  id: number;
  parent_id: number | null;
  level: string;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  name: string;
  name_zh: string | null;
  name_en: string | null;
  name_ja: string | null;
}

// =============================================
// 子级查询
// =============================================

/**
 * 获取某节点的子级列表（用于级联）
 * 命中 idx_locations_parent + idx_names_lang
 */
export function queryChildren(
  db: D1Database,
  parentId: number | null,
  lang: string,
) {
  const parentCondition = parentId !== null
    ? 'l.parent_id = ?1'
    : 'l.level = \'country\'';

  return db
    .prepare(
      `SELECT l.id, n.name, l.level
       FROM locations l
       INNER JOIN location_names n ON l.id = n.location_id AND n.lang = ?2
       WHERE ${parentCondition}
         AND l.is_active = 1
       ORDER BY n.name ASC`,
    )
    .bind(parentId, lang);
}

// =============================================
// 单点查询
// =============================================

/**
 * 获取单个 location 详情（含多语言名称）
 * 命中主键 idx_locations(id) + idx_names_location
 */
export function queryLocationById(db: D1Database, id: number) {
  return db
    .prepare(
      `SELECT 
         l.id,
         l.parent_id,
         l.level,
         l.country_code,
         l.latitude,
         l.longitude,
         zn.name AS name_zh,
         en.name AS name_en,
         jn.name AS name_ja
       FROM locations l
       LEFT JOIN location_names zn ON l.id = zn.location_id AND zn.lang = 'zh'
       LEFT JOIN location_names en ON l.id = en.location_id AND en.lang = 'en'
       LEFT JOIN location_names jn ON l.id = jn.location_id AND jn.lang = 'ja'
       WHERE l.id = ?1`,
    )
    .bind(id);
}

// =============================================
// 路径解析查询
// =============================================

/**
 * 按 name_norm + parent_id 查找单个节点
 * 命中 idx_names_norm
 * 这是路径逐级解析的核心查询
 */
export function queryByNameNorm(
  db: D1Database,
  nameNorm: string,
  parentId: number | null,
) {
  const parentCondition = parentId !== null
    ? 'l.parent_id = ?2'
    : 'l.parent_id IS NULL';

  return db
    .prepare(
      `SELECT l.id, l.parent_id, l.level, l.country_code
       FROM location_names n
       INNER JOIN locations l ON n.location_id = l.id
       WHERE n.name_norm = ?1
         AND ${parentCondition}
         AND l.is_active = 1
       LIMIT 1`,
    )
    .bind(nameNorm, parentId);
}

/**
 * 多候选匹配（parent_id 不明确时的模糊匹配）
 */
export function queryByNameNormFuzzy(
  db: D1Database,
  nameNorm: string,
) {
  return db
    .prepare(
      `SELECT l.id, l.parent_id, l.level, l.country_code, n.lang, n.name
       FROM location_names n
       INNER JOIN locations l ON n.location_id = l.id
       WHERE n.name_norm = ?1
         AND l.is_active = 1
       LIMIT 20`,
    )
    .bind(nameNorm);
}

// =============================================
// 路径缓存查询
// =============================================

/**
 * 查询路径缓存
 * 命中主键 path_key
 */
export function queryPathCache(db: D1Database, pathKey: string) {
  return db
    .prepare(
      `SELECT path_key, location_id, hit_count, updated_at
       FROM path_cache
       WHERE path_key = ?1`,
    )
    .bind(pathKey);
}

/**
 * 写入/更新路径缓存 (UPSERT)
 */
export function upsertPathCache(
  db: D1Database,
  pathKey: string,
  locationId: number,
) {
  return db
    .prepare(
      `INSERT INTO path_cache (path_key, location_id, hit_count, updated_at)
       VALUES (?1, ?2, 1, unixepoch())
       ON CONFLICT(path_key) DO UPDATE SET
         hit_count = hit_count + 1,
         updated_at = unixepoch()`,
    )
    .bind(pathKey, locationId);
}

// =============================================
// 多语言名称查询
// =============================================

/**
 * 获取某 location 的特定语言名称
 */
export function queryNameByLang(
  db: D1Database,
  locationId: number,
  lang: string,
) {
  return db
    .prepare(
      `SELECT name, name_norm
       FROM location_names
       WHERE location_id = ?1 AND lang = ?2
       LIMIT 1`,
    )
    .bind(locationId, lang);
}

// =============================================
// 从属关系检查
// =============================================

/**
 * 获取某节点的 parent_id（用于上游遍历）
 * 命中主键 idx_locations(id)
 */
export function queryParentById(db: D1Database, id: number) {
  return db
    .prepare(
      `SELECT id, parent_id, level
       FROM locations
       WHERE id = ?1 AND is_active = 1
       LIMIT 1`,
    )
    .bind(id);
}

// =============================================
// 批量查询（预热热点城市等场景）
// =============================================

/**
 * 批量查询多个 location 的名称
 */
export function queryNamesBatch(
  db: D1Database,
  locationIds: number[],
  lang: string,
) {
  const placeholders = locationIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT n.location_id, n.name
       FROM location_names n
       WHERE n.location_id IN (${placeholders})
         AND n.lang = ?`,
    )
    .bind(...locationIds, lang);
}

// =============================================
// 级联搜索：在指定 parent 的整个子树中按名称搜索
// =============================================

/**
 * 在指定 parent 的**整个子树**（递归所有后代）中搜索匹配名称的 location
 * 使用递归 CTE 覆盖跳过中间层级的场景（如"中国,余杭"跳过浙江/杭州）
 * 命中 idx_locations_parent + idx_names_norm
 */
export function querySearchChildren(
  db: D1Database,
  parentId: number,
  nameNorm: string,
  namePrefix: string,
  lang: string,
) {
  return db
    .prepare(
      `WITH RECURSIVE subtree AS (
         SELECT id, level FROM locations
         WHERE parent_id = ?1 AND is_active = 1
         UNION ALL
         SELECT l.id, l.level
         FROM locations l
         INNER JOIN subtree s ON l.parent_id = s.id
         WHERE l.is_active = 1
       )
       SELECT DISTINCT ln.location_id, ln.name, l.level, l.country_code
       FROM subtree s
       INNER JOIN location_names ln ON s.id = ln.location_id
       INNER JOIN locations l ON s.id = l.id
       WHERE (ln.name_norm = ?2 OR ln.name LIKE ?3)
         AND ln.lang = ?4
       ORDER BY
         CASE WHEN ln.name_norm = ?2 THEN 0 ELSE 1 END,
         ln.name ASC
       LIMIT 20`,
    )
    .bind(parentId, nameNorm, namePrefix, lang);
}
