/** shared/normalize.mjs 的类型声明（供 TS 侧 import 使用） */

/** 各语言的行政后缀表 */
export declare const ADMIN_SUFFIXES: Record<string, string[]>;

/**
 * 归一化地名（trim + 小写 + 只去词尾行政后缀 + 合并空白）
 * 纯后缀词回退为原值，绝不返回空串。
 */
export declare function normalizeName(name: string): string;

/** 搜索词归一化（与 normalizeName 同一实现） */
export declare const normalizeSearchTerm: (term: string) => string;
