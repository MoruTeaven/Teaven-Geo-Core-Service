/**
 * 公共类型定义
 */

// 地理级别
export type GeoLevel = 'country' | 'admin1' | 'admin2' | 'admin3';

// 语言代码
export type LangCode = 'zh' | 'en' | 'ja';

// =============================================
// API 响应类型
// =============================================

export interface ChildItem {
  id: number;
  name: string;
  level: string;
}

export interface ChildrenResponse {
  children: ChildItem[];
}

export interface ResolveRequest {
  path: string;
  lang?: string;
}

export interface ResolveResponse {
  location_id: number;
  level: string;
  path_tokens: string[];
  cached: boolean;
}

export interface LocationDetail {
  id: number;
  parent_id: number | null;
  level: string;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  name: string;
  names: {
    zh: string | null;
    en: string | null;
    ja: string | null;
  };
}

export interface AncestorItem {
  id: number;
  name: string;
  level: string;
}

export interface AncestorsResponse {
  ancestors: AncestorItem[];
}

export interface SubordinateResponse {
  is_subordinate: boolean;
  descendant: { id: number; name: string; level: string };
  ancestor: { id: number; name: string; level: string };
  depth: number; // 0 = 同级, > 0 = descendant 在 ancestor 下面第几级, -1 = 未找到从属关系
}

export interface SearchResponse {
  results: Array<{
    location_id: number;
    name: string;
    level: string;
    country_code: string;
  }>;
  query: string;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: number;
  services?: {
    d1: string;
    kv: string;
  };
  error?: string;
}

export interface ErrorResponse {
  error: boolean;
  message: string;
}
