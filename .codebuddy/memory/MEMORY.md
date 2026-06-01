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
