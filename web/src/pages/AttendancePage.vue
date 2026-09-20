<template>
  <n-card size="small">
    <n-tabs v-model:value="tab" type="line" animated>
      <!-- ========== 日常登记 ========== -->
      <n-tab-pane name="daily" tab="日常登记">
        <n-space align="center" style="margin: 4px 0 14px">
          <n-date-picker
            v-model:formatted-value="attendDate"
            value-format="yyyy-MM-dd"
            type="date"
            @update:formatted-value="loadRoster"
          />
          <n-radio-group v-model:value="session" @update:value="loadRoster">
            <n-radio-button value="morning">早课</n-radio-button>
            <n-radio-button value="evening">晚课</n-radio-button>
          </n-radio-group>
          <n-button @click="markAll('present')">全部随众</n-button>
          <n-button @click="markAll('leave')" secondary>全部请假</n-button>
          <n-button type="primary" :loading="saving" @click="saveBulk">提交登记</n-button>
          <n-text depth="3" style="margin-left:auto"
            >已标缺勤 {{ absentMarked }} 人，满 3 次将自动进入客堂提醒</n-text
          >
        </n-space>

        <n-data-table
          :columns="rosterColumns"
          :data="roster"
          :loading="loading"
          :row-key="(r: AttendanceRow) => r.monk_id"
          :pagination="false"
          max-height="62vh"
          striped
        />
      </n-tab-pane>

      <!-- ========== 缺勤统计 ========== -->
      <n-tab-pane name="summary" tab="缺勤统计">
        <n-space align="center" style="margin: 4px 0 14px">
          <n-text depth="3">统计区间：近</n-text>
          <n-input-number v-model:value="windowDays" :min="7" :max="365" :step="1" @update:value="loadSummary" />
          <n-text depth="3">日</n-text>
          <n-button @click="loadSummary">刷新</n-button>
          <n-button text type="primary" @click="router.push('/alerts')">查看缺勤提醒 →</n-button>
        </n-space>
        <n-data-table
          :columns="summaryColumns"
          :data="summary"
          :loading="loading"
          :row-key="(r: AttendanceSummary) => r.monk_id"
          :pagination="{ pageSize: 12 }"
          striped
        />
      </n-tab-pane>
    </n-tabs>
  </n-card>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard, NTabs, NTabPane, NSpace, NDatePicker, NRadioGroup, NRadioButton,
  NButton, NDataTable, NInputNumber, NText, NTag,
  useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { http, ATTENDANCE_LABEL, ATTENDANCE_TYPE, MONK_STATUS_LABEL, MONK_STATUS_TYPE } from '../api.js';
import type { AttendanceRow, AttendanceSummary, AttendanceStatus, SessionType } from '../types.js';

const router = useRouter();
const message = useMessage();
const tab = ref('daily');
const attendDate = ref(new Date().toISOString().slice(0, 10));
const session = ref<SessionType>('morning');
const roster = ref<AttendanceRow[]>([]);
const summary = ref<AttendanceSummary[]>([]);
const loading = ref(false);
const saving = ref(false);
const windowDays = ref(30);

// 本地编辑态：monk_id -> status
const marks = ref<Record<string, AttendanceStatus>>({});

async function loadRoster() {
  if (!attendDate.value) return;
  loading.value = true;
  try {
    const { data } = await http.get<AttendanceRow[]>('/attendance', {
      params: { attend_date: attendDate.value, session: session.value },
    });
    roster.value = data;
    marks.value = {};
    for (const r of data) {
      if (r.status) marks.value[r.monk_id] = r.status;
    }
  } finally {
    loading.value = false;
  }
}

async function loadSummary() {
  loading.value = true;
  try {
    const { data } = await http.get<AttendanceSummary[]>('/attendance/summary', {
      params: { days: windowDays.value },
    });
    summary.value = data;
  } finally {
    loading.value = false;
  }
}

function setMark(monkId: string, status: AttendanceStatus) {
  marks.value[monkId] = status;
}

function markAll(status: AttendanceStatus) {
  for (const r of roster.value) marks.value[r.monk_id] = status;
}

const absentMarked = computed(
  () => Object.values(marks.value).filter((s) => s === 'absent').length,
);

async function saveBulk() {
  saving.value = true;
  try {
    const entries = roster.value
      .filter((r) => marks.value[r.monk_id])
      .map((r) => ({ monk_id: r.monk_id, status: marks.value[r.monk_id] }));
    await http.post('/attendance/bulk', {
      attend_date: attendDate.value,
      session: session.value,
      recorded_by: '僧值',
      entries,
    });
    message.success(`${session.value === 'morning' ? '早课' : '晚课'}考勤已登记`);
    loadRoster();
  } finally {
    saving.value = false;
  }
}

const STATUS_OPTIONS: { label: string; value: AttendanceStatus }[] = [
  { label: '随众', value: 'present' },
  { label: '缺勤', value: 'absent' },
  { label: '请假', value: 'leave' },
];

function statusOf(r: AttendanceRow): AttendanceStatus | null {
  return marks.value[r.monk_id] ?? r.status;
}

const rosterColumns: DataTableColumns<AttendanceRow> = [
  {
    title: '法名',
    key: 'dharma_name',
    width: 140,
    render: (r) =>
      h('span', { style: 'font-weight:600' }, [
        r.dharma_name,
        r.current_post ? h(NTag, { size: 'small', type: 'primary', bordered: false, style: 'margin-left:8px' }, { default: () => r.current_post ?? '' }) : null,
      ]),
  },
  {
    title: '身份',
    key: 'monk_status',
    width: 90,
    render: (r) =>
      h(NTag, { size: 'small', type: MONK_STATUS_TYPE[r.monk_status], bordered: false }, { default: () => MONK_STATUS_LABEL[r.monk_status] }),
  },
  {
    title: '出勤',
    key: 'status',
    width: 320,
    render: (r) => {
      const current = statusOf(r);
      return h(
        NRadioGroup,
        {
          value: current,
          onUpdateValue: (v: AttendanceStatus) => setMark(r.monk_id, v),
        },
        {
          default: () =>
            STATUS_OPTIONS.map((o) =>
              h(
                NRadioButton,
                {
                  value: o.value,
                  type: o.value === 'absent' && current === 'absent' ? 'error' : undefined,
                  style: 'margin-right:8px',
                },
                { default: () => o.label },
              ),
            ),
        },
      );
    },
  },
  {
    title: '当前状态',
    key: 'cur',
    render: (r) => {
      const s = statusOf(r);
      if (!s) return h(NText, { depth: 3 }, { default: () => '未登记' });
      return h(NTag, { size: 'small', type: ATTENDANCE_TYPE[s], bordered: false }, { default: () => ATTENDANCE_LABEL[s] });
    },
  },
];

const summaryColumns: DataTableColumns<AttendanceSummary> = [
  { title: '法名', key: 'dharma_name', width: 120, render: (r) => h('span', { style: 'font-weight:600' }, () => r.dharma_name) },
  {
    title: '身份',
    key: 'monk_status',
    width: 90,
    render: (r) => h(NTag, { size: 'small', type: MONK_STATUS_TYPE[r.monk_status], bordered: false }, { default: () => MONK_STATUS_LABEL[r.monk_status] }),
  },
  { title: '职务', key: 'current_post', width: 100, render: (r) => r.current_post ?? '—' },
  { title: '随众', key: 'present_count', width: 80 },
  {
    title: '缺勤',
    key: 'absent_count',
    width: 100,
    render: (r) =>
      h(NText, { type: r.absent_count >= 3 ? 'error' : undefined, strong: r.absent_count >= 3 }, { default: () => `${r.absent_count} 次` }),
  },
  { title: '请假', key: 'leave_count', width: 80 },
  { title: '最近缺勤', key: 'last_absence', width: 120, render: (r) => r.last_absence ?? '—' },
  {
    title: '客堂提醒',
    key: 'has_open_alert',
    render: (r) =>
      r.has_open_alert
        ? h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => '待处理' })
        : r.absent_count >= 3
          ? h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '已处理' })
          : h(NText, { depth: 3 }, { default: () => '—' }),
  },
];

onMounted(() => {
  loadRoster();
  loadSummary();
});
</script>
