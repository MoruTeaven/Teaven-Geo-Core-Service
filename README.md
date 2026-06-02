# 🌍 Teaven Geo Core Service

全球统一地理路径解析 + 唯一 ID 映射服务，基于 Cloudflare Workers + D1 + KV。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MoruTeaven/Teaven-Geo-Core-Service)

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
| lang | string | 否 | 语言，默认 `zh` |

**响应示例：**

```json
{
  "children": [
    { "id": 1814991, "name": "中国", "level": "country" },
    { "id": 1861060, "name": "日本", "level": "country" }
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
  "path": "中国 山东 菏泽 定陶",
  "lang": "zh"
}
```

**响应示例：**

```json
{
  "location_id": 1812743,
  "level": "admin3",
  "path_tokens": ["中国", "山东", "菏泽", "定陶"],
  "cached": false
}
```

---

### ③ 单点查询

```
GET /geo/get?id=1814991&lang=zh
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | number | 是 | GeoNames ID |
| lang | string | 否 | 语言，默认 `zh` |

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
GET /geo/ancestors?id=1814990&lang=zh
```

**响应示例：**

```json
{
  "ancestors": [
    { "id": 1814991, "name": "中国", "level": "country" },
    { "id": 1796236, "name": "山东省", "level": "admin1" },
    { "id": 1799971, "name": "威海市", "level": "admin2" },
    { "id": 1814990, "name": "乳山市", "level": "admin3" }
  ]
}
```

---

### ⑤ 从属关系检查

```
GET /geo/is-subordinate?descendant=xxx&ancestor=xxx&lang=zh
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| descendant | number | 是 | 待检查的下级节点 GeoNames ID |
| ancestor | number | 是 | 目标上级节点 GeoNames ID |
| lang | string | 否 | 语言，默认 `zh` |

**说明：** 检查节点 `descendant` 是否为节点 `ancestor` 的下属行政单位，即 `ancestor` 是否出现在 `descendant` 的祖先链中。

**响应示例：**

```json
{
  "is_subordinate": true,
  "descendant": { "id": 1804645, "name": "济南市", "level": "admin2" },
  "ancestor": { "id": 1796236, "name": "山东省", "level": "admin1" },
  "depth": 1
}
```

- `is_subordinate`: `true` 表示 descendant 是 ancestor 的下属单位
- `depth`: `0` = 同级，`> 0` = descendant 在 ancestor 下面第几级，`-1` = 未找到从属关系

---



### ⑥ 搜索（末位即目标）

**核心规则：** 最后一个 token 是搜索目标，前面的 token 是层级面包屑（深度不限）。

**A) 已知层级 → 在指定范围内搜索：**

```
GET /geo/search?path=中国,山东,菏泽,定陶&lang=zh
GET /geo/search?path=中国,乳山&lang=zh
GET /geo/search?path=浙江,杭州&lang=zh
GET /geo/search?path=金华市,义乌市&lang=zh
```

**B) 单 token → 全库模糊（等同于旧版 q=）：**

```
GET /geo/search?q=定陶&lang=zh
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 否 | 逗号/空格/竖线分隔的层级路径，末位=搜索目标，前位=面包屑 |
| q | string | 否 | `path` 的简写形式（仅单 token 时等同于 `path=tok`） |
| lang | string | 否 | 语言，默认 `zh` |

**特色行为：**

- **层级不必完整** — `中国,乳山` 虽然跳过了山东、威海两层，仍能在全中国范围内搜到乳山
- **深度自适应** — `浙江,杭州` 搜的是市（admin2），`金华市,义乌市` 搜的是区县（admin3），代码不关心 level 标号
- **行政后缀自动归一化** — `金华市` → `金华`，`义乌市` → `义乌`，`New York City` → `new york`
- **名称和 ID 混用** — `?path=1814991,山东,菏泽` 第一级可以是 geonameid
- **三语通用** — `New York`(en)、`東京都`(ja)、`江苏省`(zh)

**响应示例：**

```json
{
  "results": [
    { "location_id": 1812743, "name": "定陶区", "level": "admin3", "country_code": "CN" }
  ],
  "query": "定陶",
  "hierarchy": ["中国", "山东", "菏泽"],
  "parent_id": 1799971
}
```

### ⑦ 健康检查

### ⑦ 健康检查

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
| path_key | TEXT PK | "中国\|山东\|济南\|莱芜" |
| location_id | INTEGER | 解析结果 |
| hit_count | INTEGER | 命中次数 |
| updated_at | INTEGER | 更新时间戳 |

## 配置说明

### 环境变量

可在 `wrangler.toml` 的 `[vars]` 段中配置以下变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEFAULT_LANG` | API 默认返回语言 | `zh` |
| `CACHE_TTL` | KV 缓存过期时间（秒） | `86400` |
| `HOT_CITIES` | 预热热点城市 | `"北京,上海,东京,New York,London,Paris,Singapore,Sydney"` |

**自定义默认语言示例：**

```toml
# wrangler.toml
[vars]
DEFAULT_LANG = "en"   # 改为英文
CACHE_TTL = 86400
```

支持的语言代码：`zh`（简体中文）、`en`（英文）、`ja`（日文）、`zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO`（繁体中文）。<parameter name="explanation" string="true">README 增加配置说明章节，说明 DEFAULT_LANG 自定义方式

1. **KV 缓存优先** - 热点路径秒级返回，TTL 24h
2. **D1 path_cache 双写** - KV miss 时 D1 兜底
3. **索引覆盖** - 所有查询命中 index
4. **名称归一化** - `name_norm` 字段预计算，避免运行时正则
5. **热点预热** - 支持 `warmHotCitiesCache` 预热高频城市

## 数据规范

- **主 ID**：必须使用 GeoNames ID（geonameid）
- **name_norm**：去行政后缀 + 小写 + trim
- **语言 fallback**：`请求语言 → zh → en → ja`
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

## 作者

- **主页**: [moruteaven.com](https://moruteaven.com)
- **邮箱**: [me@moruteaven.com](mailto:me@moruteaven.com)
