# 🌍 Teaven Geo Core Service

全球统一地理路径解析 + 唯一 ID 映射服务，基于 Cloudflare Workers + D1 + KV。

## 核心能力

| 能力 | 说明 |
|------|------|
| 🌐 级联选择 | 国家 → 省 → 市 → 区 四级联动 |
| 🌍 多语言 | 中 (zh) / 英 (en) / 日 (ja) 显示 |
| 🔎 反向解析 | 任意路径 → 唯一 GeoNames ID |
| 🆔 统一 ID | 使用 GeoNames ID，全球唯一 |
| ⚡ KV 缓存 | 热点路径秒级返回 |

## 架构

```
Frontend
   ↓
Cloudflare Worker (API) ← KV Cache
   ↓
D1 Database (Geo Data)
```

## 快速开始

### 前置条件

- Node.js 18+
- Cloudflare 账号
- Wrangler CLI (`npm i -g wrangler`)

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create teaven-geo-db
```

将输出的 `database_id` 填入 `wrangler.toml` 中的 `{{YOUR_D1_DATABASE_ID}}`。

### 3. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create GEO_CACHE
```

将输出的 `id` 填入 `wrangler.toml` 中的 `{{YOUR_KV_NAMESPACE_ID}}`。

### 4. 初始化数据库 Schema

```bash
# 本地
npx wrangler d1 execute teaven-geo-db --local --file=db/migrations/001_init.sql

# 远程
npx wrangler d1 execute teaven-geo-db --file=db/migrations/001_init.sql
```

### 5. 导入 GeoNames 数据

```bash
# 一键导入（本地）
node scripts/import-geoname.js --local

# 一键导入（远程）
node scripts/import-geoname.js --remote
```

也可以分步执行：

```bash
# 仅下载原始数据
node scripts/download-geoname.js

# 仅处理数据生成 SQL
node scripts/process-geoname.js

# 手动导入
npx wrangler d1 execute teaven-geo-db --local --file=data/processed/seed.sql
```

### 6. 启动本地开发

```bash
npm run dev
```

### 7. 部署

```bash
npm run deploy
```

## API 文档

### ① 获取子级（级联）

```
GET /geo/children?parent_id=xxx&lang=zh
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| parent_id | number | 否 | 父节点 ID，为空返回顶级（国家列表） |
| lang | string | 否 | 语言，默认 `en` |

**响应示例：**

```json
{
  "children": [
    { "id": 1814991, "name": "China", "level": "country" },
    { "id": 1861060, "name": "Japan", "level": "country" }
  ]
}
```

---

### ② 路径解析（核心）

```
POST /geo/resolve
```

**请求体：**

```json
{
  "path": "中国 山东 济南 长清",
  "lang": "zh"
}
```

**响应示例：**

```json
{
  "location_id": 123456,
  "level": "admin3",
  "path_tokens": ["中国", "山东", "济南", "长清"],
  "cached": false
}
```

---

### ③ 单点查询

```
GET /geo/get?id=123456&lang=zh
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | number | 是 | GeoNames ID |
| lang | string | 否 | 语言，默认 `en` |

**响应示例：**

```json
{
  "id": 1814991,
  "parent_id": null,
  "level": "country",
  "country_code": "CN",
  "latitude": 35.0,
  "longitude": 105.0,
  "name": "中国",
  "names": {
    "zh": "中国",
    "en": "China",
    "ja": "中華人民共和国"
  }
}
```

---

### ④ 父级链（面包屑）

```
GET /geo/ancestors?id=123456&lang=zh
```

**响应示例：**

```json
{
  "ancestors": [
    { "id": 1814991, "name": "中国", "level": "country" },
    { "id": 1796236, "name": "山东省", "level": "admin1" },
    { "id": 1804645, "name": "济南市", "level": "admin2" },
    { "id": 123456, "name": "长清区", "level": "admin3" }
  ]
}
```

---

### ⑤ 搜索（预览）

```
GET /geo/search?q=济南&lang=zh
```

### ⑥ 健康检查

```
GET /health
```

## 数据库设计

### locations - 核心树结构

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | GeoNames ID |
| parent_id | INTEGER | 上级节点 |
| level | TEXT | country / admin1 / admin2 / admin3 |
| country_code | TEXT | ISO 3166-1 alpha-2 |
| latitude | REAL | 纬度 |
| longitude | REAL | 经度 |
| is_active | INTEGER | 是否启用 |

### location_names - 多语言名称

| 字段 | 类型 | 说明 |
|------|------|------|
| location_id | INTEGER PK | 关联 locations.id |
| lang | TEXT PK | zh / en / ja |
| name | TEXT | 原始名称 |
| name_norm | TEXT | 归一化名称（去行政后缀） |

### path_cache - 路径缓存

| 字段 | 类型 | 说明 |
|------|------|------|
| path_key | TEXT PK | "中国\|山东\|济南\|长清" |
| location_id | INTEGER | 解析结果 |
| hit_count | INTEGER | 命中次数 |
| updated_at | INTEGER | 更新时间戳 |

## 性能优化

1. **KV 缓存优先** - 热点路径秒级返回，TTL 24h
2. **D1 path_cache 双写** - KV miss 时 D1 兜底
3. **索引覆盖** - 所有查询命中 index
4. **名称归一化** - `name_norm` 字段预计算，避免运行时正则
5. **热点预热** - 支持 `warmHotCitiesCache` 预热高频城市

## 数据规范

- **主 ID**：必须使用 GeoNames ID（geonameid）
- **name_norm**：去行政后缀 + 小写 + trim
- **语言 fallback**：`lang → en → zh`
- **路径分隔**：支持空格、逗号、竖线等多种分隔符

## 项目结构

```
teaven-geo-core-service/
├── src/
│   ├── index.ts              # Worker 入口 + 路由
│   ├── db/
│   │   └── queries.ts        # D1 数据访问层（预编译 SQL）
│   ├── services/
│   │   └── geo.ts            # 业务服务层（核心逻辑）
│   └── utils/
│       ├── normalize.ts      # 名称归一化工具
│       ├── cache.ts          # KV 缓存策略
│       └── response.ts       # API 响应格式化
├── db/
│   └── migrations/
│       └── 001_init.sql      # D1 Schema 迁移
├── scripts/
│   ├── download-geoname.js   # GeoNames 数据下载
│   ├── process-geoname.js    # 数据处理 → SQL 生成
│   └── import-geoname.js     # 一键导入脚本
├── data/
│   ├── raw/                  # 原始下载文件
│   └── processed/            # 处理后的 SQL 文件
├── wrangler.toml             # Cloudflare 配置
├── package.json
└── tsconfig.json
```

## 技术栈

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Router**: itty-router
- **Language**: TypeScript

## 许可证

本项目代码采用 [MIT](LICENSE) 协议。

### 数据归属

本项目使用 [GeoNames](https://www.geonames.org/) 地理数据，遵循
[Creative Commons Attribution 4.0 (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/) 协议。
