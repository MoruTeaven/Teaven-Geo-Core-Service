/**
 * 单 IP 速率限制（/geo/* 守卫）
 *
 * 两级实现：
 * 1. 优先使用 Cloudflare Workers Rate Limiting Binding（env.RATE_LIMITER）：
 *    跨 isolate 全局精确计数，生产环境推荐在 wrangler.toml 启用。
 * 2. 未配置 binding 时回退 isolate 内存滑动窗口：
 *    单 PoP 单 isolate 内有效，零外部成本，作为第一道防线兜底。
 *
 * 动机：D1 按查询计费，公开端点若无限制，恶意刷 /geo/search 可直接放大账单。
 */

/** Cloudflare Workers Rate Limiting Binding 的最小接口 */
export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitConfig {
  /** 窗口内最大请求数 */
  max: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
}

export interface RateLimitResult {
  limited: boolean;
  /** 限流时建议客户端等待的秒数（Retry-After） */
  retryAfterSeconds: number;
}

/** 解析环境变量配置，非法值回退默认（120 次 / 60 秒） */
export function parseRateLimitConfig(envMax?: string, envWindow?: string): RateLimitConfig {
  const max = Math.max(1, parseInt(envMax || '', 10) || 120);
  const windowMs = Math.max(1000, parseInt(envWindow || '', 10) || 60000);
  return { max, windowMs };
}

// ———— 内存滑动窗口（isolate 内） ————

/** key → 窗口内请求时间戳 */
const buckets = new Map<string, number[]>();

/** 防 map 随攻击 IP 数无限膨胀的容量上限 */
const MAX_BUCKETS = 5000;

export function checkRateLimitInMemory(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();

  // 容量自愈：超上限时清掉已过期窗口，仍超则整体清空（牺牲瞬时精度保内存）
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, v] of buckets) {
      if (!v.some(ts => now - ts < config.windowMs)) buckets.delete(k);
    }
    if (buckets.size > MAX_BUCKETS) buckets.clear();
  }

  const window = (buckets.get(key) || []).filter(ts => now - ts < config.windowMs);

  if (window.length >= config.max) {
    buckets.set(key, window);
    const oldest = window[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000));
    return { limited: true, retryAfterSeconds };
  }

  window.push(now);
  buckets.set(key, window);
  return { limited: false, retryAfterSeconds: 0 };
}

/**
 * 检查请求是否限流
 * @param env        Worker 环境（可选 RATE_LIMITER / RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS）
 * @param clientIp   客户端 IP（CF-Connecting-IP）
 * @param routeGroup 路由分组（限流计数维度，如 'geo'）
 */
export async function checkRateLimit(
  env: {
    RATE_LIMITER?: RateLimitBinding;
    RATE_LIMIT_MAX?: string;
    RATE_LIMIT_WINDOW_MS?: string;
  },
  clientIp: string,
  routeGroup: string,
): Promise<RateLimitResult> {
  const config = parseRateLimitConfig(env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_MS);

  if (env.RATE_LIMITER) {
    try {
      const result = await env.RATE_LIMITER.limit({ key: `${routeGroup}:${clientIp}` });
      return { limited: !result.success, retryAfterSeconds: Math.ceil(config.windowMs / 1000) };
    } catch (e) {
      // binding 异常不阻断业务：降级到内存窗口
      console.error('[rate-limit] binding failed, fallback to memory:',
        e instanceof Error ? e.message : String(e));
    }
  }

  return checkRateLimitInMemory(`${routeGroup}:${clientIp}`, config);
}

/**
 * 提取客户端真实 IP
 * Cloudflare 注入 CF-Connecting-IP（不可伪造）；本地开发回退 X-Forwarded-For 首段
 */
export function getClientIp(req: Request): string {
  const cf = req.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = req.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim() || 'unknown';
  return 'unknown';
}
