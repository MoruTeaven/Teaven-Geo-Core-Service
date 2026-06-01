/**
 * 名称归一化工具
 * 
 * 规则：
 * 1. toLowerCase()
 * 2. 去掉行政后缀（省/市/区/县/province/city/district 等）
 * 3. trim()
 */

// 各语言的行政后缀
const ADMIN_SUFFIXES: Record<string, string[]> = {
  zh: ['省', '市', '区', '县', '自治区', '特别行政区', '自治州', '自治县', '镇', '乡', '村'],
  en: ['province', 'city', 'district', 'county', 'state', 'prefecture', 
       'autonomous region', 'special administrative region', 'municipality',
       'town', 'township', 'village', 'ward'],
  ja: ['省', '市', '区', '県', '町', '村', '都', '道', '府'],
};

// 全局去后缀正则（编译一次）
const GLOBAL_SUFFIX_PATTERN: RegExp = (() => {
  const allSuffixes = new Set<string>();
  for (const suffixes of Object.values(ADMIN_SUFFIXES)) {
    for (const s of suffixes) {
      allSuffixes.add(s);
      allSuffixes.add(s.toLowerCase());
    }
  }
  // 按长度降序排列，确保长后缀先匹配
  const sorted = [...allSuffixes].sort((a, b) => b.length - a.length);
  const escaped = sorted.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^(${escaped.join('|')})|(${escaped.join('|')})$`, 'gi');
})();

/**
 * 归一化名称
 * - 去行政后缀
 * - 转小写
 * - 去首尾空格
 */
export function normalizeName(name: string): string {
  let normalized = name.trim().toLowerCase();
  
  // 去掉前后缀
  normalized = normalized.replace(GLOBAL_SUFFIX_PATTERN, '');
  
  // 再次清理多余空格和特殊字符
  normalized = normalized
    .replace(/\s+/g, ' ')   // 合并多个空格
    .replace(/[^\w\s\-]/g, '') // 去掉特殊字符（保留字母数字空格和连字符）
    .trim();
  
  return normalized;
}

/**
 * 搜索用轻量归一化（仅去行政后缀 + 小写，保留所有语言文字字符）
 * 与 normalizeName 的区别：不调用 [^\w\s\-] 过滤，避免误删中日韩等非 ASCII 字符
 */
export function normalizeSearchTerm(term: string): string {
  let normalized = term.trim().toLowerCase();
  normalized = normalized.replace(GLOBAL_SUFFIX_PATTERN, '');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

/**
 * 构建路径 key（用于缓存查询）
 * "中国 山东 济南 长清" → "中国|山东|济南|长清"
 */
export function buildPathKey(pathTokens: string[]): string {
  return pathTokens.join('|');
}

/**
 * 解析路径字符串为 token 数组
 * 支持空格、逗号、竖线等多种分隔符
 */
export function parsePathTokens(path: string): string[] {
  return path
    .split(/[\s,|，、]+/)
    .map(t => t.trim())
    .filter(t => t.length > 0);
}

/**
 * 语言优先级解析
 * 规则: lang → en → zh
 * 
 * 注意: zh-Hant/zh-TW/zh-HK 会映射到 zh 数据（数据库无繁简之分），
 *       由上层服务在返回前做简→繁转换。
 */
export function resolveLangPriority(preferredLang: string): string[] {
  const lang = preferredLang?.toLowerCase() || 'zh';
  
  // 繁体中文映射：查询时仍用 zh，转换在服务层做
  const isHant = lang === 'zh-hant' || lang === 'zh-tw' || lang === 'zh-hk' || lang === 'zh-mo';
  
  let result: string[];
  if (isHant) {
    // zh-Hant 优先级: zh → en → ja（数据源是 zh）
    result = ['zh'];
  } else {
    result = [lang];
  }
  
  // 按优先级追加 fallback
  const fallbackOrder = ['en', 'zh', 'ja'];
  for (const fb of fallbackOrder) {
    if (!result.includes(fb)) {
      result.push(fb);
    }
  }
  return result;
}

/**
 * 判断是否为繁体中文请求
 */
export function isTraditionalChinese(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'zh-hant' || l === 'zh-tw' || l === 'zh-hk' || l === 'zh-mo';
}

/**
 * 批量归一化名称
 */
export function normalizeNames(names: string[]): string[] {
  return names.map(normalizeName);
}
