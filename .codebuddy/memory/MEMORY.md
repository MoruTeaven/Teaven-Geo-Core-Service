# Teaven Geo Core Service - 项目记忆

## 项目概述
全球统一地理路径解析 + 唯一 ID 映射服务，基于 Cloudflare Workers + D1 + KV。

## 技术选型
- **运行时**: Cloudflare Workers (TypeScript)
- **数据库**: Cloudflare D1 (SQLite)
- **缓存**: Cloudflare KV
- **路由**: itty-router v5
- **数据源**: GeoNames (allCountries + admin1/admin2 + alternateNamesV2 + hierarchy)
- **主 ID**: GeoNames ID (geonameid)，全球唯一

## 核心 API
- `GET /geo/children?parent_id=xxx&lang=zh` - 级联子级
- `POST /geo/resolve { path, lang }` - 路径反解析
- `GET /geo/get?id=xxx&lang=zh` - 单点查询
- `GET /geo/ancestors?id=xxx&lang=zh` - 父级链
- `GET /geo/search?q=xxx&lang=zh` - 搜索
- `GET /health` - 健康检查

## 数据导入流程
1. `scripts/download-geoname.js` - 下载 GeoNames 原始数据
2. `scripts/process-geoname.js` - 解析并生成 D1 SQL
3. `scripts/import-geoname.js --local/--remote` - 一键导入

## 名称归一化规则
- toLowerCase()
- 去掉行政后缀（省/市/区/县/province/city/district 等）
- trim()

## 语言优先级
lang → en → zh

## 缓存策略
- KV 优先（TTL 24h）→ D1 path_cache 兜底
- 双写 KV + D1

## 已知问题 & 修复记录
- **2026-06-01**: 修复 `/geo/search` 接口始终返回空结果的问题。原因：搜索查询了 `location_search` 表，但 `process-geoname.js` 导入脚本从未向该表写入数据（表仅供未来扩展预留）。修复方式：改为直接从 `location_names` 表模糊匹配 `name` 字段。
- **2026-06-02**: 修复 `normalizeName` 函数导致中文 `name_norm` 全部为空字符串的致命 BUG。原因：`replace(/[^\\w\\s\\-]/g, '')` 中的 `\\w` 只匹配 ASCII 字母数字，中文等 Unicode 字符被误删。已在 `src/utils/normalize.ts` 和 `scripts/process-geoname.js` 两处移除该正则。注意 `normalizeSearchTerm` 之前已正确跳过此过滤。修复后需重新执行 `process-geoname.js` 生成新的 seed.sql 并重新导入数据库。
