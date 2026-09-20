<template>
  <div>
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <n-space align="center">
          <n-radio-group v-model:value="statusFilter" size="small" @update:value="load">
            <n-radio-button value="">全部</n-radio-button>
            <n-radio-button value="registered">已登记</n-radio-button>
            <n-radio-button value="proposed">待确认</n-radio-button>
            <n-radio-button value="checked_in">已签到</n-radio-button>
            <n-radio-button value="late">迟到</n-radio-button>
            <n-radio-button value="waitlisted">候补</n-radio-button>
            <n-radio-button value="early_left">提前离寺</n-radio-button>
            <n-radio-button value="no_show">未到</n-radio-button>
          </n-radio-group>
          <n-input v-model:value="keyword" placeholder="法名 / 戒牒" clearable size="small" style="width:180px" @keyup.enter="load" @clear="load" />
          <n-button size="small" @click="load">查询</n-button>
        </n-space>
        <n-space>
          <n-button type="primary" size="small" @click="showImport = true">
            <template #icon><n-icon :component="CloudUploadOutline" /></template>
            表格批量导入
          </n-button>
          <n-button size="small" :disabled="ceremony?.status === 'closed'" @click="autoAssign">
            <template #icon><n-icon :component="BedOutline" /></template>
            按组自动分床
          </n-button>
        </n-space>
      </n-space>

      <n-data-table
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="(r: Participant) => r.id"
        :pagination="{ pageSize: 12 }"
        size="small"
        striped
      />
    </n-space>

    <!-- 批量导入 -->
    <n-modal v-model:show="showImport" preset="card" title="表格批量导入（逐行反馈）" style="width: 760px">
      <n-space vertical :size="10">
        <n-text depth="3" style="font-size:13px">
          首行须为表头：法名、出家寺庙、戒牒编号、到寺日期、离寺日期、特殊需求。
          可直接从 Excel/WPS 复制区域粘贴（Tab 分隔），日期格式 YYYY-MM-DD。
        </n-text>
        <n-space>
          <n-button size="tiny" quaternary @click="copyTemplate">复制表头模板</n-button>
          <n-text depth="3" style="font-size:12px">导入在一个事务内完成；错误行逐行给出原因，不影响其他行</n-text>
        </n-space>
        <n-input
          v-model:value="pasteText" type="textarea" :autosize="{ minRows: 6, maxRows: 12 }"
          :input-props="{ spellcheck: false }"
          placeholder="法名	出家寺庙	戒牒编号	到寺日期	离寺日期	特殊需求&#10;宗印	五台山	FH001	2026-10-01	2026-10-07	腿脚不便"
        />
        <n-space justify="space-between">
          <n-text depth="3" style="font-size:12px">
            已识别 {{ parsedCount }} 行数据（不含表头）
          </n-text>
          <n-space>
            <n-button @click="showImport = false">关闭</n-button>
            <n-button type="primary" :loading="importing" :disabled="parsedCount === 0" @click="doImport">
              导入（{{ parsedCount }} 行）
            </n-button>
          </n-space>
        </n-space>
      </n-space>
    </n-modal>

    <!-- 导入结果 -->
    <n-modal v-model:show="showResult" preset="card" title="导入逐行反馈" style="width: 820px">
      <n-space vertical :size="10">
        <n-space>
          <n-tag type="success" :bordered="false">成功 {{ result?.imported ?? 0 }}</n-tag>
          <n-tag type="warning" :bordered="false">候补 {{ result?.waitlisted ?? 0 }}</n-tag>
          <n-tag type="error" :bordered="false">错误 {{ result?.errors ?? 0 }}</n-tag>
          <n-text depth="3">批次号 #{{ result?.batch_no }}</n-text>
        </n-space>
        <n-data-table
          :columns="resultColumns"
          :data="result?.results ?? []"
          :row-key="(r: ImportResultRow) => r.line_no"
          :max-height="420"
          size="small"
          :pagination="{ pageSize: 200 }"
        />
        <n-space justify="end">
          <n-button @click="showResult = false">知道了</n-button>
        </n-space>
      </n-space>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NSpace, NRadioGroup, NRadioButton, NInput, NButton, NIcon, NDataTable,
  NModal, NTag, NText, useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { CloudUploadOutline, BedOutline } from '@vicons/ionicons5';
import { http, PARTICIPANT_STATUS_LABEL, PARTICIPANT_STATUS_TYPE } from '../../api.js';
import type { Ceremony, Participant, ImportResponse, ImportResultRow } from '../../types.js';
import { parseTable, IMPORT_TEMPLATE } from '../../ceremony-import.js';

const props = defineProps<{ ceremony: Ceremony | null }>();
const emit = defineEmits<{ (e: 'changed'): void }>();
const message = useMessage();

const rows = ref<Participant[]>([]);
const loading = ref(false);
const statusFilter = ref('');
const keyword = ref('');

const showImport = ref(false);
const pasteText = ref('');
const importing = ref(false);
const showResult = ref(false);
const result = ref<ImportResponse | null>(null);

const parsedCount = computed(() => {
  const { rows } = parseTable(pasteText.value);
  return rows.length;
});

function copyTemplate() {
  navigator.clipboard.writeText(IMPORT_TEMPLATE).then(() => message.success('模板已复制，可直接粘贴到 Excel'));
}

async function load() {
  if (!props.ceremony) return;
  loading.value = true;
  try {
    const { data } = await http.get<Participant[]>(`/ceremonies/${props.ceremony.id}/participants`, {
      params: {
        ...(statusFilter.value ? { status: statusFilter.value } : {}),
        ...(keyword.value.trim() ? { q: keyword.value.trim() } : {}),
      },
    });
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

async function doImport() {
  if (!props.ceremony) return;
  const { rows: dataRows } = parseTable(pasteText.value);
  if (dataRows.length === 0) return;
  importing.value = true;
  try {
    const { data } = await http.post<ImportResponse>(`/ceremonies/${props.ceremony.id}/import`, { rows: dataRows });
    result.value = data;
    showImport.value = false;
    showResult.value = true;
    pasteText.value = '';
    emit('changed');
    await load();
    if (data.errors === 0 && data.waitlisted === 0) message.success(`${data.imported} 人全部导入成功`);
  } finally {
    importing.value = false;
  }
}

async function autoAssign() {
  if (!props.ceremony) return;
  const { data } = await http.post<{ assigned: number; skipped: number }>(
    `/ceremonies/${props.ceremony.id}/auto-assign`, {});
  message.success(`已自动分配 ${data.assigned} 个床位${data.skipped ? `，${data.skipped} 人无合适床位（见流水）` : ''}`);
  emit('changed');
  await load();
}

const columns: DataTableColumns<Participant> = [
  { title: '法名', key: 'dharma_name', width: 90, fixed: 'left', render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  { title: '状态', key: 'status', width: 90, render: (r) =>
      h(NTag, { size: 'small', type: PARTICIPANT_STATUS_TYPE[r.status], bordered: false },
        { default: () => PARTICIPANT_STATUS_LABEL[r.status] }) },
  { title: '出家寺庙', key: 'home_monastery', width: 140, ellipsis: { tooltip: true } },
  { title: '戒牒编号', key: 'ordination_no', width: 120 },
  { title: '到寺', key: 'arrive_date', width: 100 },
  { title: '离寺', key: 'leave_date', width: 100 },
  { title: '实际离寺', key: 'actual_leave_date', width: 100, render: (r) => r.actual_leave_date ?? '—' },
  { title: '特殊需求', key: 'special_need', width: 140, ellipsis: { tooltip: true }, render: (r) =>
      r.special_need ? h(NText, { type: 'warning' }, { default: () => r.special_need }) : '—' },
  { title: '床位', key: 'bed', width: 130, render: (r) =>
      r.room_no ? `${r.room_no}·${r.bed_no}床` : h(NText, { depth: 3 }, { default: () => '未安排' }) },
];

const resultColumns: DataTableColumns<ImportResultRow> = [
  { title: '行', key: 'line_no', width: 50 },
  { title: '法名', key: 'dharma_name', width: 90 },
  { title: '戒牒', key: 'ordination_no', width: 120 },
  { title: '到寺', key: 'arrive_date', width: 100 },
  { title: '离寺', key: 'leave_date', width: 100 },
  {
    title: '结果', key: 'result', width: 90,
    render: (r) => {
      const map = {
        ok: ['success', '成功'], waitlisted: ['warning', '候补'], error: ['error', '错误'],
      } as const;
      const [type, label] = map[r.result];
      return h(NTag, { size: 'small', type, bordered: false }, { default: () => label });
    },
  },
  { title: '说明', key: 'message', render: (r) => h(NText, { type: r.result === 'error' ? 'error' : r.result === 'waitlisted' ? 'warning' : undefined },
    { default: () => r.message }) },
];

onMounted(load);
</script>
