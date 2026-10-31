-- Migration: 002_drop_location_search
-- 移除从未被查询使用的搜索索引表：
-- 全部搜索路径（单 token / 级联搜索 / 层级解析）实际走
-- location_names.name_norm 精确匹配 + name LIKE，location_search
-- 从建库起无任何读写（scripts 导入脚本也不写入），删除以减少 D1 存储成本。
-- 表删除时其索引（idx_search_token / idx_search_location）随之删除。

DROP TABLE IF EXISTS location_search;
