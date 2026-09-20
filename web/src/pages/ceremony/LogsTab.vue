<template>
  <n-space vertical :size="12">
    <n-space align="center">
      <n-select v-model:value="actionFilter" :options="actionOptions" size="small" clearable placeholder="操作类型" style="width:200px" @update:value="load" />
      <n-input v-model:value="batchNo" size="small" placeholder="批次号" style="width:110px" @keyup.enter="load" />
      <n-button size="small" @click="load">查询</n-button>
      <n-text depth="3" style="font-size:12px">完整保留：导入 / 自动分床 / 调床 / 递补 / 签到 / 离寺 / 圆满</n-text>
    </n-space>
    <n-timeline>
      <n-timeline-item v-for="l in logs" :key="l.id" :type="typeOf(l.action)" :title="titleOf(l.action)" :time="fmt(l.created_at)">
        <n-text depth="3" style="margin-right:8px">{{ l.dharma_name ? `【${l.dharma_name}】` : '' }}{{ l.operator }}</n-text>
        <n-text v-if="l.batch_no" depth="3" style="font-size:12px">批次 #{{ l.batch_no }}</n-text>
        <pre class="detail">{{ JSON.stringify(l.detail, null, 1) }}</pre>
      </n-timeline-item>
    </n-timeline>
  </n-space>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { NSpace, NSelect, NInput, NButton, NText, NTimeline, NTimelineItem } from 'naive-ui';
import type { SelectOption } from 'naive-ui';
import { http } from '../../api.js';
import type { Ceremony, CeremonyLog } from '../../types.js';

const props = defineProps<{ ceremony: Ceremony | null }>();
const logs = ref<CeremonyLog[]>([]);
const actionFilter = ref<string | null>(null);
const batchNo = ref('');

const actionOptions: SelectOption[] = [
  { label: '导入人员', value: 'import' },
  { label: '导入批次', value: 'import_batch' },
  { label: '自动分床', value: 'auto_assign' },
  { label: '分床跳过', value: 'auto_assign_skip' },
  { label: '调床', value: 'transfer' },
  { label: '自动递补', value: 'promote' },
  { label: '知客确认递补', value: 'promote_confirm' },
  { label: '拒绝递补', value: 'promote_reject' },
  { label: '签到', value: 'checked_in' },
  { label: '迟到', value: 'late' },
  { label: '未到', value: 'no_show' },
  { label: '提前离寺', value: 'early_leave' },
  { label: '取消', value: 'cancel' },
  { label: '法会开始', value: 'start' },
  { label: '法会圆满', value: 'close' },
];

const LABEL: Record<string, string> = Object.fromEntries(actionOptions.map((o) => [o.value as string, o.label as string]));

async function load() {
  if (!props.ceremony) return;
  const { data } = await http.get<CeremonyLog[]>(`/ceremonies/${props.ceremony.id}/logs`, {
    params: {
      ...(actionFilter.value ? { action: actionFilter.value } : {}),
      ...(batchNo.value.trim() ? { batch_no: batchNo.value.trim() } : {}),
    },
  });
  logs.value = data;
}

function titleOf(a: string) {
  return LABEL[a] ?? a;
}
function typeOf(a: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (['checked_in', 'promote_confirm', 'start'].includes(a)) return 'success';
  if (['late', 'promote', 'auto_assign', 'transfer', 'import', 'import_batch'].includes(a)) return 'info';
  if (['early_leave', 'cancel', 'promote_reject', 'auto_assign_skip'].includes(a)) return 'warning';
  if (['no_show'].includes(a)) return 'error';
  return 'default';
}
function fmt(t: string) {
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

watch(() => props.ceremony?.id, load);
onMounted(load);
</script>

<style scoped>
.detail {
  margin: 4px 0 0;
  font-size: 12px;
  color: #8a7a66;
  white-space: pre-wrap;
  word-break: break-all;
  background: #f7f4ee;
  border-radius: 4px;
  padding: 4px 8px;
}
</style>
