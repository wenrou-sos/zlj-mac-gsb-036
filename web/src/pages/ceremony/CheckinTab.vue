<template>
  <n-space vertical :size="12">
    <n-space justify="space-between" align="center">
      <n-space>
        <n-button type="primary" size="small" :disabled="ceremony?.status !== 'active'" @click="bulk('checkin')">
          批量签到
        </n-button>
        <n-button size="small" :disabled="ceremony?.status !== 'active'" @click="bulk('late')">标记迟到</n-button>
        <n-button size="small" type="error" ghost :disabled="ceremony?.status !== 'active'" @click="bulk('no_show')">
          标记未到（释放床位/自动递补）
        </n-button>
      </n-space>
      <n-text depth="3" style="font-size:12px">已选 {{ checkedKeys.length }} 人（仅已登记/待确认可签到）</n-text>
    </n-space>

    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :row-key="(r: Participant) => r.id"
      :checked-row-keys="checkedKeys"
      :row-class-name="rowClass"
      size="small"
      :pagination="{ pageSize: 15 }"
      striped
      @update:checked-row-keys="(v) => (checkedKeys = v as string[])"
    />
  </n-space>
</template>

<script setup lang="ts">
import { h, onMounted, ref, watch } from 'vue';
import {
  NSpace, NDataTable, NTag, NText, NButton, NPopconfirm, useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { http, PARTICIPANT_STATUS_LABEL, PARTICIPANT_STATUS_TYPE } from '../../api.js';
import type { Ceremony, Participant } from '../../types.js';

const props = defineProps<{ ceremony: Ceremony | null }>();
const emit = defineEmits<{ (e: 'changed'): void }>();
const message = useMessage();

const rows = ref<Participant[]>([]);
const loading = ref(false);
const checkedKeys = ref<string[]>([]);

async function load() {
  if (!props.ceremony) return;
  loading.value = true;
  try {
    const { data } = await http.get<Participant[]>(`/ceremonies/${props.ceremony.id}/participants`);
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

function rowClass(r: Participant) {
  if (['checked_in', 'late'].includes(r.status)) return 'row-done';
  if (r.status === 'no_show') return 'row-noshow';
  return '';
}

async function bulk(action: 'checkin' | 'late' | 'no_show') {
  if (checkedKeys.value.length === 0) return message.warning('请先勾选人员');
  const { data } = await http.post<{ processed: number; skipped: { reason: string }[] }>(
    `/ceremonies/${props.ceremony!.id}/checkins/bulk`,
    { participant_ids: checkedKeys.value, action },
  );
  const label = action === 'checkin' ? '签到' : action === 'late' ? '迟到' : '未到';
  if (data.processed) message.success(`已处理 ${data.processed} 人（${label}）`);
  if (data.skipped.length) message.warning(`${data.skipped.length} 人因当前状态跳过`);
  checkedKeys.value = [];
  emit('changed');
  await load();
}

async function earlyLeave(p: Participant) {
  const { data } = await http.post<{ promoted: { dharma_name: string } | null }>(
    `/ceremonies/${props.ceremony!.id}/participants/${p.id}/early-leave`, {});
  message.success(data.promoted
    ? `${p.dharma_name} 已提前离寺，床位递补：${data.promoted.dharma_name}（待确认）`
    : `${p.dharma_name} 已提前离寺`);
  emit('changed');
  await load();
}

const columns: DataTableColumns<Participant> = [
  { type: 'selection', disabled: (r) => !['registered', 'proposed'].includes(r.status) },
  { title: '法名', key: 'dharma_name', width: 90, render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  { title: '状态', key: 'status', width: 90, render: (r) =>
      h(NTag, { size: 'small', type: PARTICIPANT_STATUS_TYPE[r.status], bordered: false },
        { default: () => PARTICIPANT_STATUS_LABEL[r.status] }) },
  { title: '应到', key: 'arrive_date', width: 110 },
  { title: '应离', key: 'leave_date', width: 110 },
  { title: '签到时间', key: 'checkin_at', width: 170, render: (r) =>
      r.checkin_at ? new Date(r.checkin_at).toLocaleString('zh-CN', { hour12: false }) : '—' },
  { title: '床位', key: 'bed', width: 130, render: (r) =>
      r.room_no ? `${r.room_no}·${r.bed_no}床` : '—' },
  {
    title: '操作', key: 'op', width: 120,
    render: (r) => {
      if (props.ceremony?.status !== 'active') return h(NText, { depth: 3 }, { default: () => '—' });
      if (['checked_in', 'late', 'registered', 'proposed'].includes(r.status)) {
        return h(NPopconfirm, { onPositiveClick: () => earlyLeave(r) }, {
          trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'warning' }, { default: () => '提前离寺' }),
          default: () => `${r.dharma_name} 提前离寺？床位将释放并自动递补`,
        });
      }
      return h(NText, { depth: 3 }, { default: () => '—' });
    },
  },
];

watch(() => props.ceremony?.id, load);
onMounted(load);
</script>

<style scoped>
:deep(.row-done) {
  background-color: #f2f9f2;
}
:deep(.row-noshow) {
  background-color: #fcf2f2;
}
</style>
