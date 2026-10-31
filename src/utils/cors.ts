/**
 * CORS 收敛模块
 *
 * 公开只读 API 默认仍为 *（任意网页可读，保持既有调用方兼容），
 * 但支持通过 ALLOWED_ORIGINS 环境变量配置白名单：
 * - 未配置（默认）→ Access-Control-Allow-Origin: *（公开读取语义）
 * - 配置后        → 仅回显白名单内的 Origin，其余请求不携带 CORS 头（浏览器拒绝跨域读取）
 *
 * 按请求回显 Origin 时必须带 Vary: Origin，防止中间缓存把 A 站的响应串给 B 站。
 */

export const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';
export const CORS_ALLOW_HEADERS = 'Content-Type';

/**
 * 解析 ALLOWED_ORIGINS 环境变量
 * @returns 白名单数组；null 表示未配置（= *，不限制）
 */
export function parseAllowedOrigins(raw: string | undefined | null): string[] | null {
  if (!raw || !raw.trim()) return null;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * 计算本次请求应设置的 Access-Control-Allow-Origin
 * @param origin  请求的 Origin 头（无则为非浏览器请求）
 * @param allowed 白名单（null = 未配置）
 * @returns 应设置的值；null = 不允许（不携带 CORS 头）
 */
export function resolveAllowOrigin(
  origin: string | null,
  allowed: string[] | null,
): string | null {
  if (allowed === null) return '*';
  if (!origin) return null;
  return allowed.includes(origin) ? origin : null;
}
