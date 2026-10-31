/**
 * SQL LIKE 模式转义
 *
 * SQLite LIKE 的 % 与 _ 是通配符。用户输入若未转义直接拼进 LIKE 模式：
 * - "%%%" 之类的纯通配输入会绕过前缀索引命中，全表扫描，放大 D1 查询成本
 * - 可借通配符探测数据（如 "a%b" 探测名称结构）
 *
 * 修复方式：对用户输入做转义，并在 SQL 中加 ESCAPE '\' 子句，
 * 使 % _ \ 均按字面量匹配。
 */

const LIKE_WILDCARDS = /[\\%_]/g;

/**
 * 转义 LIKE 模式中的通配符与转义符
 * 单次 replace 逐字符处理，天然满足「先转反斜杠、再转通配符」的顺序要求：
 * "a%b_c\\d" → "a\\%b\\_c\\\\d"
 */
export function escapeLike(input: string): string {
  return input.replace(LIKE_WILDCARDS, '\\$&');
}

/** 构造前缀匹配模式（escaped + '%'） */
export function likePrefix(input: string): string {
  return `${escapeLike(input)}%`;
}

/** 构造包含匹配模式（'%' + escaped + '%'） */
export function likeContains(input: string): string {
  return `%${escapeLike(input)}%`;
}

/**
 * SQLite LIKE 的 ESCAPE 子句片段（源码写 '\\' 才是一个反斜杠字符）
 * 用法：WHERE n.name LIKE ?1 ${SQLITE_LIKE_ESCAPE}
 */
export const SQLITE_LIKE_ESCAPE = "ESCAPE '\\'";
