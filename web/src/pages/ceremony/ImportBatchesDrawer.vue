<template>
  <n-drawer :show="show" :width="820" @update:show="(v: boolean) => emit('update:show', v)">
    <n-drawer-content title="导入批次记录" closable>
      <n-spin :show="loading">
        <n-space vertical :size="12">
          <n-card v-for="b in batches" :key="b.id" size="small">
            <n-space justify="space-between" align="center">
              <n-space>
                <n-text strong>{{ b.file_name ?? '未命名导入' }}</n-text>
                <n-text depth="3" style="font-size:12px">{{ fmtTime(b.created_at) }} · {{ b.imported_by }}</n-text>
              </n-space>
              <n-space :size="4">
                <n-tag size="small" type="success">登记 {{ b.accepted_count }}</n-tag>
                <n-tag size="small" type="warning">候补 {{ b.waitlisted_count }}</n-tag>
                <n-tag size="small" type="error">重复 {{ b.duplicate_count }}</n-tag>
                <n-tag size="small" type="error">撞期 {{ b.conflict_count }}</n-tag>
                <n-tag size="small" type="info">错误 {{ b.invalid_count }}</n-tag>
                <n-button size="tiny" quaternary @click="toggle(b.id)">
                  {{ openId === b.id ? '收起' : '逐行结果' }}
                </n-button>
              </n-space>
            </n-space>
            <n-data-table
              v-if="openId === b.id"
              :columns="columns"
              :data="rowMap[b.id] ?? []"
              :row-key="(r: ImportRowResult) => r.row_no"
              :pagination="false"
              size="small"
              style="margin-top:10px"
              max-height="360"
            />
          </n-card>
          <n-text v-if="!loading && batches.length === 0" depth="3">暂无导入批次</n-text>
        </n-space>
      </n-spin>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import {
  NDrawer, NDrawerContent, NSpin, NSpace, NCard, NText, NTag, NButton, NDataTable,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { http, IMPORT_STATUS_LABEL, IMPORT_STATUS_TYPE } from '../../api.js';
import type { ImportBatch, ImportRowResult } from '../../types.js';

const props = defineProps<{ show: boolean; ceremonyId: string }>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>();

const batches = ref<ImportBatch[]>([]);
const rowMap = ref<Record<string, ImportRowResult[]>>({});
const openId = ref<string | null>(null);
const loading = ref(false);

const columns = computed<DataTableColumns<ImportRowResult>>(() => [
  { title: '行', key: 'row_no', width: 48 },
  { title: '法名', key: 'dharma_name', width: 90 },
  { title: '戒牒编号', key: 'ordination_no', width: 120 },
  { title: '到寺', key: 'arrive_date', width: 100 },
  { title: '离寺', key: 'leave_date', width: 100 },
  {
    title: '结果', key: 'status', width: 90,
    render: (r) => h(NTag, { size: 'small', type: IMPORT_STATUS_TYPE[r.status], bordered: false }, { default: () => IMPORT_STATUS_LABEL[r.status] }),
  },
  { title: '说明', key: 'message' },
]);

function fmtTime(t: string) {
  return t.replace('T', ' ').slice(0, 16);
}

async function toggle(id: string) {
  if (openId.value === id) {
    openId.value = null;
    return;
  }
  openId.value = id;
  if (!rowMap.value[id]) {
    const { data } = await http.get<ImportBatch>(`/ceremonies/${props.ceremonyId}/import-batches/${id}`);
    rowMap.value[id] = data.row_results ?? [];
  }
}

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    openId.value = null;
    loading.value = true;
    try {
      const { data } = await http.get<ImportBatch[]>(`/ceremonies/${props.ceremonyId}/import-batches`);
      batches.value = data;
    } finally {
      loading.value = false;
    }
  },
);
</script>
