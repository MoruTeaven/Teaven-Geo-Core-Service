<!--
  前端级联组件示例 - Vue 3

  使用方式:
    <GeoCascader lang="zh" @select="onSelect" />
-->
<template>
  <div class="geo-cascader">
    <select
      v-for="(level, index) in visibleLevels"
      :key="index"
      v-model="selected[index]"
      :disabled="loading || level.nodes.length === 0"
      @change="onLevelChange(index)"
    >
      <option value="">
        {{ levelLabels[index] }}
      </option>
      <option
        v-for="node in level.nodes"
        :key="node.id"
        :value="node.id"
      >
        {{ node.name }}
      </option>
    </select>
    <span v-if="loading" class="loading">加载中...</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';

interface GeoNode {
  id: number;
  name: string;
  level: string;
  hasChildren: boolean;
}

const props = withDefaults(defineProps<{
  baseUrl?: string;
  lang?: 'zh' | 'en' | 'ja';
  placeholder?: string;
}>(), {
  baseUrl: 'https://geo.your-domain.com',
  lang: 'zh',
});

const emit = defineEmits<{
  select: [node: GeoNode];
}>();

const levelLabels = ['国家', '省份', '城市', '区县'];

// 四个层级的数据
const levels = ref<{ nodes: GeoNode[] }[]>([
  { nodes: [] }, { nodes: [] }, { nodes: [] }, { nodes: [] },
]);
const selected = ref<(number | string)[]>([ '', '', '', '' ]);
const loading = ref(false);

// 只显示有数据的层级
const visibleLevels = computed(() => {
  return levels.value.filter((level, index) => {
    return level.nodes.length > 0 || index === 0;
  });
});

// 加载子级
async function loadChildren(parentId: number | null, levelIndex: number) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ lang: props.lang });
    if (parentId !== null) params.set('parent_id', String(parentId));

    const res = await fetch(`${props.baseUrl}/geo/children?${params}`);
    const data = await res.json();

    const nodes: GeoNode[] = (data.children || []).map((c: any) => ({
      ...c,
      hasChildren: c.level !== 'admin3',
    }));

    levels.value[levelIndex].nodes = nodes;
    // 清空后续层级
    for (let i = levelIndex + 1; i < levels.value.length; i++) {
      levels.value[i].nodes = [];
      selected.value[i] = '';
    }
  } catch (err) {
    console.error('Failed to load children:', err);
  } finally {
    loading.value = false;
  }
}

// 层级变更
function onLevelChange(index: number) {
  const id = Number(selected.value[index]);
  const node = levels.value[index].nodes.find(n => n.id === id);
  if (!node) return;

  emit('select', node);

  if (node.hasChildren) {
    loadChildren(node.id, index + 1);
  }
}

onMounted(() => {
  loadChildren(null, 0);
});
</script>

<style scoped>
.geo-cascader {
  display: flex;
  gap: 8px;
  align-items: center;
}

.geo-cascader select {
  padding: 6px 12px;
  border-radius: 4px;
  min-width: 120px;
  border: 1px solid #d1d5db;
  background: white;
  font-size: 14px;
}

.geo-cascader select:disabled {
  background: #f3f4f6;
  color: #9ca3af;
}

.loading {
  font-size: 12px;
  color: #6b7280;
}
</style>
