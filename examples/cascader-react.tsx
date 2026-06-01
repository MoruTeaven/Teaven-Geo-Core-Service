/**
 * 前端级联组件示例 - React
 * 
 * 使用方式:
 *   <GeoCascader lang="zh" onSelect={(loc) => console.log(loc)} />
 */

import React, { useState, useEffect, useCallback } from 'react';

// --- 类型 ---
interface GeoNode {
  id: number;
  name: string;
  level: string;
  hasChildren: boolean;
}

interface GeoCascaderProps {
  baseUrl?: string;
  lang?: 'zh' | 'en' | 'ja';
  onSelect?: (node: GeoNode) => void;
  placeholder?: string;
}

// --- 组件 ---
export const GeoCascader: React.FC<GeoCascaderProps> = ({
  baseUrl = 'https://geo.your-domain.com',
  lang = 'zh',
  onSelect,
  placeholder = '请选择地区',
}) => {
  // 级联层级: [国家列表, 省列表, 市列表, 区列表]
  const [levels, setLevels] = useState<GeoNode[][]>([[], [], [], []]);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);

  // 加载子级
  const loadChildren = useCallback(
    async (parentId: number | null, levelIndex: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ lang });
        if (parentId !== null) params.set('parent_id', String(parentId));

        const res = await fetch(`${baseUrl}/geo/children?${params}`);
        const data = await res.json();

        const nodes: GeoNode[] = (data.children || []).map((c: any) => ({
          ...c,
          hasChildren: c.level !== 'admin3', // admin3 是最后一级
        }));

        setLevels(prev => {
          const next = [...prev];
          next[levelIndex] = nodes;
          // 清空后续层级
          for (let i = levelIndex + 1; i < next.length; i++) {
            next[i] = [];
          }
          return next;
        });
      } catch (err) {
        console.error('Failed to load children:', err);
      } finally {
        setLoading(false);
      }
    },
    [baseUrl, lang],
  );

  // 初始加载国家列表
  useEffect(() => {
    loadChildren(null, 0);
  }, [loadChildren]);

  // 选择处理
  const handleSelect = (node: GeoNode, levelIndex: number) => {
    const newSelected = [...selected.slice(0, levelIndex), node.id];
    setSelected(newSelected);

    if (node.hasChildren) {
      loadChildren(node.id, levelIndex + 1);
    }

    onSelect?.(node);
  };

  // 解析路径
  const handleResolve = async (path: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/geo/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, lang }),
      });
      const data = await res.json();
      if (data.location_id) {
        // 获取父级链填充选择
        const ancestorsRes = await fetch(
          `${baseUrl}/geo/ancestors?id=${data.location_id}&lang=${lang}`,
        );
        const ancestorsData = await ancestorsRes.json();
        // 按层级设置选中值
        const ids = ancestorsData.ancestors.map((a: any) => a.id);
        setSelected(ids);
      }
    } catch (err) {
      console.error('Failed to resolve path:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {[0, 1, 2, 3].map(levelIndex => {
        const nodes = levels[levelIndex];
        if (nodes.length === 0 && levelIndex > 0) return null;

        return (
          <select
            key={levelIndex}
            value={selected[levelIndex] || ''}
            onChange={e => {
              const id = Number(e.target.value);
              const node = nodes.find(n => n.id === id);
              if (node) handleSelect(node, levelIndex);
            }}
            disabled={loading || nodes.length === 0}
            style={{ padding: '6px 12px', borderRadius: 4, minWidth: 120 }}
          >
            <option value="">
              {levelIndex === 0 ? '国家' : levelIndex === 1 ? '省份' : levelIndex === 2 ? '城市' : '区县'}
            </option>
            {nodes.map(node => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        );
      })}
      {loading && <span>加载中...</span>}
    </div>
  );
};
