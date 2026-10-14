/**
 * 名称归一化工具（运行时门面）
 *
 * 归一化规则的唯一实现在 shared/normalize.mjs，与 scripts/process-geoname.js
 * 写库时共用，从而保证「写库 name_norm」与「查询归一化」永远一致。
 *
 * 本文件只放运行时（查询侧）专用工具，不参与写库。
 */

import { normalizeName } from '../../shared/normalize.mjs';

export {
  ADMIN_SUFFIXES,
  normalizeName,
  normalizeSearchTerm,
} from '../../shared/normalize.mjs';

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
