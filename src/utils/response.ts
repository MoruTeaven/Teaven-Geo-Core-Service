/**
 * API 响应格式化工具
 *
 * 注意：CORS 头不再在此硬编码（原 Access-Control-Allow-Origin: * 已移除），
 * 统一由 src/index.ts 的 applyCorsHeaders 出口按 ALLOWED_ORIGINS 白名单注入。
 */

export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export function corsPreflight(): Response {
  // 仅预检专用头；Allow-Origin/Methods/Headers 由统一 CORS 出口注入
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Max-Age': '86400',
    },
  });
}
