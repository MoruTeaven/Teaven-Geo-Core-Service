-- =============================================
-- Teaven Geo Core Service - D1 Schema
-- Migration: 001_init
-- =============================================

-- 1️⃣ 核心树结构
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,          -- geonameid（唯一ID）
  parent_id INTEGER,               -- 上级节点
  level TEXT NOT NULL,             -- country / admin1 / admin2 / admin3
  country_code TEXT,               -- ISO 3166-1 alpha-2
  latitude REAL,
  longitude REAL,
  is_active INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);
CREATE INDEX IF NOT EXISTS idx_locations_level ON locations(level);
CREATE INDEX IF NOT EXISTS idx_locations_country ON locations(country_code);

-- 2️⃣ 多语言名称表
CREATE TABLE IF NOT EXISTS location_names (
  location_id INTEGER NOT NULL,
  lang TEXT NOT NULL,              -- zh / en / ja
  name TEXT NOT NULL,              -- 原始名称
  name_norm TEXT NOT NULL,         -- 归一化名称（去行政后缀、小写）
  PRIMARY KEY (location_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_names_norm ON location_names(name_norm);
CREATE INDEX IF NOT EXISTS idx_names_lang ON location_names(lang);
CREATE INDEX IF NOT EXISTS idx_names_location ON location_names(location_id);

-- 3️⃣ 路径缓存表
CREATE TABLE IF NOT EXISTS path_cache (
  path_key TEXT PRIMARY KEY,       -- "中国|山东|济南|长清"
  location_id INTEGER NOT NULL,
  hit_count INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_path_location ON path_cache(location_id);

-- 4️⃣ 搜索索引（未来扩展）
CREATE TABLE IF NOT EXISTS location_search (
  token TEXT NOT NULL,
  location_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  PRIMARY KEY (token, location_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_search_token ON location_search(token);
CREATE INDEX IF NOT EXISTS idx_search_location ON location_search(location_id);

-- =============================================
-- 视图：常用查询视图
-- =============================================

-- 完整 location 视图（含父级信息，方便调试）
CREATE VIEW IF NOT EXISTS v_location_full AS
SELECT 
  l.id,
  l.parent_id,
  l.level,
  l.country_code,
  l.latitude,
  l.longitude,
  l.is_active,
  COALESCE(zn.name, en.name, jn.name) AS default_name,
  zn.name AS name_zh,
  en.name AS name_en,
  jn.name AS name_ja
FROM locations l
LEFT JOIN location_names zn ON l.id = zn.location_id AND zn.lang = 'zh'
LEFT JOIN location_names en ON l.id = en.location_id AND en.lang = 'en'
LEFT JOIN location_names jn ON l.id = jn.location_id AND jn.lang = 'ja';
