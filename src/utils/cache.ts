/**
 * KV 缓存策略
 * 
 * 设计:
 * - 路径解析结果缓存到 KV + D1 path_cache 双写
 * - KV 优先 → D1 path_cache 兜底
 * - KV 过期时间由 env.CACHE_TTL 配置（见 geo.ts resolveKvTtl）
 */

export interface CacheEntry {
  location_id: number;
  level: string;
  cached_at: number;
}

/** KV expirationTtl 的 Cloudflare 下限（秒） */
const KV_MIN_TTL_SECONDS = 60;

/**
 * 解析 CACHE_TTL 环境变量为 KV 过期秒数。
 * wrangler.toml 的 [vars] 全部是字符串，且 Cloudflare 规定 expirationTtl ≥ 60，
 * 因此这里做数值解析 + 下限兜底：未配置 / 非数字 / 过小 → 回退 86400（24h）。
 */
export function parseCacheTtl(envTtl?: string): number {
  const parsed = parseInt(envTtl || '', 10);
  if (!Number.isFinite(parsed) || parsed < KV_MIN_TTL_SECONDS) return 86400;
  return parsed;
}

/**
 * KV 缓存 Key 生成
 */
export function kvCacheKey(pathKey: string): string {
  return `geo:resolve:${pathKey}`;
}

/**
 * 从 KV 读取缓存
 */
export async function kvGet(
  kv: KVNamespace,
  pathKey: string,
): Promise<CacheEntry | null> {
  try {
    const raw = await kv.get(kvCacheKey(pathKey));
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

/**
 * 写入 KV 缓存
 * @param ttlSeconds KV 过期秒数；由调用方从 env.CACHE_TTL 解析传入，缺省 24h
 */
export async function kvSet(
  kv: KVNamespace,
  pathKey: string,
  entry: CacheEntry,
  ttlSeconds: number = 86400,
): Promise<void> {
  try {
    await kv.put(kvCacheKey(pathKey), JSON.stringify(entry), {
      expirationTtl: ttlSeconds,
    });
  } catch {
    // KV 写入失败不阻塞主流程
  }
}
