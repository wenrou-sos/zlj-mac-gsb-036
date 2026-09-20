<template>
  <n-space vertical :size="12">
    <n-text depth="3" style="font-size:13px">
      已安排床位人员可在此调床；系统以日期区间方式加排他约束，法会预留时段不会与常住/挂单入住冲突。
      原床位释放时若有候补，将自动递补并等待知客确认。
    </n-text>
    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :row-key="(r: Participant) => r.id"
      :pagination="{ pageSize: 12 }"
      size="small"
      striped
    />

    <n-modal v-model:show="showBed" preset="card" title="调床" style="width:420px">
      <n-space vertical>
        <n-text>法师：<b>{{ target?.dharma_name }}</b>（{{ target?.arrive_date }} ~ {{ target?.leave_date }}）</n-text>
        <n-select v-model:value="bedChoice" :options="bedOptions" filterable placeholder="选择该时段空闲床位" />
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showBed = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitBed">确定调床</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-space>
</template>

<script setup lang="ts">
import { h, onMounted, ref, watch } from 'vue';
import {
  NSpace, NDataTable, NTag, NText, NButton, NModal, NSelect, useMessage,
} from 'naive-ui';
import type { DataTableColumns, SelectOption } from 'naive-ui';
import { http, PARTICIPANT_STATUS_LABEL, PARTICIPANT_STATUS_TYPE } from '../../api.js';
import type { Ceremony, Participant, CeremonyBed } from '../../types.js';

const props = defineProps<{ ceremony: Ceremony | null }>();
const emit = defineEmits<{ (e: 'changed'): void }>();
const message = useMessage();

const rows = ref<Participant[]>([]);
const loading = ref(false);
const showBed = ref(false);
const saving = ref(false);
const target = ref<Participant | null>(null);
const bedChoice = ref<string | null>(null);
const bedOptions = ref<SelectOption[]>([]);

async function load() {
  if (!props.ceremony) return;
  loading.value = true;
  try {
    const { data } = await http.get<Participant[]>(`/ceremonies/${props.ceremony.id}/participants`);
    rows.value = data.filter((p) => ['registered', 'proposed', 'checked_in', 'late'].includes(p.status));
  } finally {
    loading.value = false;
  }
}

async function openTransfer(p: Participant) {
  target.value = p;
  bedChoice.value = null;
  const { data } = await http.get<CeremonyBed[]>(`/ceremonies/${props.ceremony!.id}/available-beds`, {
    params: { arrive: p.arrive_date, leave: p.leave_date },
  });
  bedOptions.value = data.map((b) => ({ label: `${b.room_no} · ${b.bed_no}床`, value: b.bed_id }));
  showBed.value = true;
}

async function submitBed() {
  if (!bedChoice.value || !target.value) return message.warning('请选择床位');
  saving.value = true;
  try {
    const { data } = await http.put<{ promoted: { dharma_name: string } | null }>(
      `/ceremonies/${props.ceremony!.id}/participants/${target.value.id}/bed`,
      { bed_id: bedChoice.value },
    );
    message.success(data.promoted ? `调床完成，已自动递补候补：${data.promoted.dharma_name}（待确认）` : '调床完成');
    showBed.value = false;
    emit('changed');
    await load();
  } finally {
    saving.value = false;
  }
}

const columns: DataTableColumns<Participant> = [
  { title: '法名', key: 'dharma_name', width: 100, render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  { title: '状态', key: 'status', width: 90, render: (r) =>
      h(NTag, { size: 'small', type: PARTICIPANT_STATUS_TYPE[r.status], bordered: false },
        { default: () => PARTICIPANT_STATUS_LABEL[r.status] }) },
  { title: '在寺区间', key: 'range', width: 200, render: (r) =>
      `${r.arrive_date} ~ ${r.actual_leave_date ?? r.leave_date}` },
  { title: '特殊需求', key: 'special_need', render: (r) => r.special_need ?? '—' },
  { title: '当前床位', key: 'bed', width: 150, render: (r) =>
      r.room_no ? `${r.room_no} · ${r.bed_no}床` : h(NText, { type: 'warning' }, { default: () => '未安排' }) },
  {
    title: '操作', key: 'op', width: 90,
    render: (r) => props.ceremony?.status === 'closed'
      ? h(NText, { depth: 3 }, { default: () => '—' })
      : h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => openTransfer(r) },
        { default: () => '调床' }),
  },
];

watch(() => props.ceremony?.id, load);
onMounted(load);
</script>
