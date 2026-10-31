/**
 * D1 数据访问层 - 预编译 SQL 查询
 * 
 * 所有 SQL 查询集中管理，确保：
 * - 参数化查询（防注入）
 * - Index 命中
 * - 可维护性
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

// =============================================
// 类型定义
// 说明：本模块只定义「查询结果行」的形状（与 SQL SELECT 列一一对应）；
// 表结构以 db/migrations/001_init.sql 为唯一真相源，不在此重复声明；
// 对外响应形状定义在 services/geo.ts（业务层负责投影与多语言 fallback）。
// =============================================

/** queryChildren 的结果行 */
export interface ChildResult {
  id: number;
  name: string;
  level: string;
}

/** queryLocationById 的结果行（locations + 三路 LEFT JOIN 的多语言名称） */
export interface LocationByIdRow {
  id: number;
  parent_id: number | null;
  level: string;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
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
  if (parentId !== null) {
    return db
      .prepare(
        `SELECT l.id, n.name, l.level
         FROM locations l
         INNER JOIN location_names n ON l.id = n.location_id AND n.lang = ?2
         WHERE l.parent_id = ?1
           AND l.is_active = 1
         ORDER BY n.name ASC`,
      )
      .bind(parentId, lang);
  }
  return db
    .prepare(
      `SELECT l.id, n.name, l.level
       FROM locations l
       INNER JOIN location_names n ON l.id = n.location_id AND n.lang = ?1
       WHERE l.level = 'country'
         AND l.is_active = 1
       ORDER BY n.name ASC`,
    )
    .bind(lang);
}

// =============================================
// 单点查询
// =============================================

/**
 * 获取单个 location 详情（含多语言名称）
 * 命中主键 idx_locations(id) + idx_names_location
 */
export function queryLocationById(
  db: D1Database,
  id: number,
): D1PreparedStatement {
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

  const stmt = db.prepare(
    `SELECT l.id, l.parent_id, l.level, l.country_code
     FROM location_names n
     INNER JOIN locations l ON n.location_id = l.id
     WHERE n.name_norm = ?1
       AND ${parentCondition}
       AND l.is_active = 1
     LIMIT 1`,
  );
  // 只在 SQL 中有 ?2 占位符时才绑定 parentId
  return parentId !== null
    ? stmt.bind(nameNorm, parentId)
    : stmt.bind(nameNorm);
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
// 批量查询（分层批量上溯）
// =============================================

/**
 * 批量获取多个节点的 parent_id（分层批量上溯用）
 * 一次 IN 查询替代逐个 queryParentById 的 N+1 模式
 *
 * 注意：D1 单条语句绑定参数上限 100，调用方传入超过 100 个 id 时必须分块
 * （geo.ts 的 fetchParentMap 已按 90 个/块分块，留有余量）
 */
export function queryParentsBatch(db: D1Database, ids: number[]) {
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, parent_id
       FROM locations
       WHERE id IN (${placeholders})
         AND is_active = 1`,
    )
    .bind(...ids);
}

// =============================================
// 祖先链查询（递归 CTE）
// =============================================

/**
 * 一次查询获取某节点到根的完整祖先链（含自身）
 *
 * 用 SQLite 递归 CTE 替代逐级 queryLocationById/queryParentById 的 N+1 上溯：
 * - 起点为自身（depth 0），不带 is_active 过滤（与 queryLocationById 语义一致）
 * - 递归步骤带 is_active = 1 过滤（与 queryParentById 语义一致），
 *   inactive / 不存在的祖先使链在此截断
 * - depth 上限防坏数据成环导致死循环/死递归
 *
 * 返回按 depth 升序（自身在前、根在后），需要面包屑顺序（根在前）时由调用方倒序
 */
export function queryAncestorChain(db: D1Database, id: number, maxDepth: number) {
  return db
    .prepare(
      `WITH RECURSIVE chain(id, parent_id, level, depth) AS (
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
       ORDER BY c.depth ASC`,
    )
    .bind(id, maxDepth);
}


