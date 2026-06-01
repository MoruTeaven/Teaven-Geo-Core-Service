/**
 * KV 缓存策略
 * 
 * 设计:
 * - 热点城市常驻 KV
 * - 路径解析结果缓存到 KV + D1 path_cache 双写
 * - KV 优先 → D1 path_cache 兜底
 */

export interface CacheEntry {
  location_id: number;
  level: string;
  cached_at: number;
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

/**
 * 预热热点城市缓存
 * 在 Worker 启动时或按需调用
 */
export async function warmHotCitiesCache(
  kv: KVNamespace,
  hotCityPaths: Map<string, CacheEntry>,
  ttlSeconds: number = 86400,
): Promise<void> {
  const entries: [string, string][] = [];
  for (const [pathKey, entry] of hotCityPaths) {
    entries.push([kvCacheKey(pathKey), JSON.stringify(entry)]);
  }

  // 批量写入（如果 KV 支持 bulk put）
  // Cloudflare KV 没有原生 bulk put，逐个写入
  await Promise.allSettled(
    entries.map(([key, value]) =>
      kv.put(key, value, { expirationTtl: ttlSeconds }),
    ),
  );
}
