<template>
  <n-space vertical :size="12">
    <n-alert type="warning" :show-icon="false">
      床位释放（提前离寺/未到/调床/取消）时，系统按候补先后自动递补并先占床位，
      须由知客确认后方正式纳入名单；拒绝则回候补队尾，继续尝试下一位。
      <n-button size="tiny" quaternary type="warning" style="margin-left:8px" :disabled="ceremony?.status === 'closed'" @click="manualPromote">
        手动尝试递补一位
      </n-button>
    </n-alert>

    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :row-key="(r: Participant) => r.id"
      size="small"
      :pagination="{ pageSize: 20 }"
      striped
    />
  </n-space>
</template>

<script setup lang="ts">
import { h, onMounted, ref, watch } from 'vue';
import {
  NSpace, NDataTable, NTag, NText, NButton, NAlert, NPopconfirm, useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { http, PARTICIPANT_STATUS_LABEL, PARTICIPANT_STATUS_TYPE } from '../../api.js';
import type { Ceremony, Participant } from '../../types.js';

const props = defineProps<{ ceremony: Ceremony | null }>();
const emit = defineEmits<{ (e: 'changed'): void }>();
const message = useMessage();

const rows = ref<Participant[]>([]);
const loading = ref(false);

async function load() {
  if (!props.ceremony) return;
  loading.value = true;
  try {
    const { data } = await http.get<Participant[]>(`/ceremonies/${props.ceremony.id}/participants`);
    rows.value = data.filter((p) => ['waitlisted', 'proposed'].includes(p.status));
  } finally {
    loading.value = false;
  }
}

async function confirm(p: Participant) {
  await http.post(`/ceremonies/${props.ceremony!.id}/participants/${p.id}/confirm`, {});
  message.success(`已确认 ${p.dharma_name} 的递补床位`);
  emit('changed');
  await load();
}

async function reject(p: Participant) {
  await http.post(`/ceremonies/${props.ceremony!.id}/participants/${p.id}/reject`, { reason: '知客拒绝' });
  message.info(`已拒绝 ${p.dharma_name}，继续尝试下一位候补`);
  emit('changed');
  await load();
}

async function cancel(p: Participant) {
  await http.post(`/ceremonies/${props.ceremony!.id}/participants/${p.id}/cancel`, {});
  message.success('已取消并尝试递补');
  emit('changed');
  await load();
}

async function manualPromote() {
  const { data } = await http.post<{ promoted: { dharma_name: string } | null; message?: string }>(
    `/ceremonies/${props.ceremony!.id}/promote`, {});
  if (data.promoted) message.success(`已递补 ${data.promoted.dharma_name}，等待确认`);
  else message.info(data.message ?? '暂无可递补候补');
  emit('changed');
  await load();
}

const columns: DataTableColumns<Participant> = [
  { title: '法名', key: 'dharma_name', width: 100, render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  { title: '状态', key: 'status', width: 90, render: (r) =>
      h(NTag, { size: 'small', type: PARTICIPANT_STATUS_TYPE[r.status], bordered: false },
        { default: () => PARTICIPANT_STATUS_LABEL[r.status] }) },
  { title: '到寺', key: 'arrive_date', width: 110 },
  { title: '离寺', key: 'leave_date', width: 110 },
  { title: '特殊需求', key: 'special_need' },
  { title: '预分床位', key: 'bed', width: 150, render: (r) =>
      r.room_no ? h(NText, { type: 'warning' }, { default: () => `${r.room_no} · ${r.bed_no}床` }) : '—' },
  {
    title: '操作', key: 'op', width: 230,
    render: (r) => {
      if (props.ceremony?.status === 'closed') return h(NText, { depth: 3 }, { default: () => '—' });
      if (r.status === 'proposed') {
        return h(NSpace, { size: 4 }, {
          default: () => [
            h(NButton, { size: 'small', type: 'primary', onClick: () => confirm(r) }, { default: () => '确认递补' }),
            h(NPopconfirm, { onPositiveClick: () => reject(r) }, {
              trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => '拒绝' }),
              default: () => `拒绝 ${r.dharma_name}？将继续尝试下一位`,
            }),
          ],
        });
      }
      return h(NPopconfirm, { onPositiveClick: () => cancel(r) }, {
        trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => '取消候补' }),
        default: () => `取消 ${r.dharma_name} 的候补？`,
      });
    },
  },
];

watch(() => props.ceremony?.id, load);
onMounted(load);
</script>
