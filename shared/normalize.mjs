/**
 * 地名归一化规则（唯一实现）
 *
 * 本文件同时被两处使用，必须保持单一来源：
 *   - scripts/process-geoname.js   写入 D1 的 location_names.name_norm
 *   - src/utils/normalize.ts       运行时查询归一化
 *
 * 历史问题：两处曾各自实现且规则不等价——写库只去后缀，运行时去前后缀，
 * 导致「市南区」写库存 "市南"、运行时算成 "南"，这类地名的精确匹配永远失败。
 *
 * 规则：
 *   1. trim + toLowerCase
 *   2. 去掉行政后缀（只锚定词尾，不动词首）
 *   3. 合并连续空白
 *   4. 若去后缀后为空（纯后缀词，如「省」「city」），回退为步骤 1 的结果，
 *      避免产生空字符串与其它空值行互相误匹配
 */

/** 各语言的行政后缀（仅作为后缀匹配，不作为前缀） */
export const ADMIN_SUFFIXES = {
  // 同时收录繁体变体：生产库 zh 行含大量繁体地名（華盛頓縣、傑佛遜縣 等）
  zh: ['省', '市', '区', '區', '县', '縣', '自治区', '自治區', '特别行政区', '特別行政區',
       '自治州', '自治县', '自治縣', '镇', '鎮', '乡', '鄉', '村'],
  en: ['province', 'city', 'district', 'county', 'state', 'prefecture',
       'autonomous region', 'special administrative region', 'municipality',
       'town', 'township', 'village', 'ward'],
  ja: ['省', '市', '区', '県', '郡', '町', '村', '都', '道', '府'],
};

// 后缀正则（编译一次）
const SUFFIX_PATTERN = (() => {
  const all = new Set();
  for (const list of Object.values(ADMIN_SUFFIXES)) {
    for (const s of list) {
      all.add(s);
      all.add(s.toLowerCase());
    }
  }
  // 按长度降序，确保长后缀优先（「特别行政区」先于「区」）
  const sorted = [...all].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // 只锚定词尾：地名开头的「市/县/区」属于名称本身（如「市南区」），不可剥离
  return new RegExp('(' + escaped.join('|') + ')$', 'i');
})();

/**
 * 合并连续空白并去首尾空格
 * @param {string} s
 * @returns {string}
 */
function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 归一化地名
 * @param {string} name 原始名称
 * @returns {string} 归一化结果；纯后缀词回退为原值，绝不返回空串
 */
export function normalizeName(name) {
  const base = collapse(String(name ?? '').toLowerCase());
  const stripped = collapse(base.replace(SUFFIX_PATTERN, ''));
  return stripped || base;
}

/**
 * 搜索词归一化
 *
 * 与 normalizeName 使用完全相同的规则。历史上二者曾被描述为有差异
 * （注释称不做非 ASCII 过滤），但实际实现早已等价——此处合并为同一实现，
 * 保留两个导出名仅为兼容既有调用点。
 * @type {(term: string) => string}
 */
export const normalizeSearchTerm = normalizeName;
