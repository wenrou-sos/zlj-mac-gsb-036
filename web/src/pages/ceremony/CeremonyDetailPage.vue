<template>
  <div v-if="ceremony">
    <!-- 头部 -->
    <n-card size="small">
      <n-space justify="space-between" align="start">
        <n-space align="center">
          <n-button quaternary circle @click="router.push('/ceremonies')">
            <template #icon><n-icon :component="ArrowBackOutline" /></template>
          </n-button>
          <div>
            <n-space align="center">
              <n-text strong style="font-size:18px">{{ ceremony.name }}</n-text>
              <n-tag :type="CEREMONY_STATUS_TYPE[ceremony.status]" round size="small">
                {{ CEREMONY_STATUS_LABEL[ceremony.status] }}
              </n-tag>
            </n-space>
            <n-text depth="3" style="font-size:13px">
              {{ ceremony.start_date }} ~ {{ ceremony.end_date }} · 接待上限
              {{ ceremony.capacity }} 人 · {{ ceremony.note || '' }}
            </n-text>
          </div>
        </n-space>
        <n-space>
          <n-button @click="showImportBatches = true">
            <template #icon><n-icon :component="DocumentTextOutline" /></template>
            导入批次
          </n-button>
          <n-button @click="showEvents = true">
            <template #icon><n-icon :component="ListOutline" /></template>
            操作留痕
          </n-button>
          <n-button @click="showReports = true">
            <template #icon><n-icon :component="BarChartOutline" /></template>
            统计
          </n-button>
          <n-button
            v-if="ceremony.status === 'preparing'"
            type="primary"
            ghost
            @click="startCeremony"
          >
            法会开始
          </n-button>
          <n-popconfirm
            v-if="ceremony.status !== 'closed'"
            title="圆满结束：批量释放全部临时床位（在寺人员办离寺）？"
            @positive-click="releaseAll"
          >
            <template #trigger>
              <n-button type="error" ghost>圆满结束并释放床位</n-button>
            </template>
          </n-popconfirm>
        </n-space>
      </n-space>

      <!-- 名额概览 -->
      <n-grid :cols="6" :x-gap="8" style="margin-top:14px">
        <n-gi><n-statistic label="有效登记" :value="ceremony.active_count" /></n-gi>
        <n-gi>
          <n-statistic label="接待占用">
            <span :style="{ color: (ceremony.active_count ?? 0) >= ceremony.capacity ? '#d03050' : '#8c5a2e' }">
              {{ ceremony.active_count }} / {{ ceremony.capacity }}
            </span>
          </n-statistic>
        </n-gi>
        <n-gi><n-statistic label="已分床" :value="(ceremony.confirmed_count ?? 0) + (ceremony.checked_in_count ?? 0)" /></n-gi>
        <n-gi><n-statistic label="待确认床位" :value="ceremony.offered_count" /></n-gi>
        <n-gi><n-statistic label="候补" :value="ceremony.waitlist_count" /></n-gi>
        <n-gi><n-statistic label="在寺签到" :value="ceremony.checked_in_count" /></n-gi>
      </n-grid>
    </n-card>

    <!-- 人员名册 -->
    <n-card size="small" style="margin-top:14px">
      <n-tabs v-model:value="tab" type="line" @update:value="onTabChange">
        <n-tab-pane name="active" tab="接待名册">
          <n-space style="margin:4px 0 12px" wrap>
            <n-button type="primary" @click="showImport = true">
              <template #icon><n-icon :component="CloudUploadOutline" /></template>
              表格批量导入
            </n-button>
            <n-button :loading="allocating" @click="allocateBeds">
              <template #icon><n-icon :component="BedOutline" /></template>
              自动分床
            </n-button>
            <n-select
              v-model:value="groupFilter"
              :options="groupOptions"
              placeholder="按分组筛选"
              clearable
              style="width:150px"
              @update:value="loadParticipants"
            />
            <n-select
              v-model:value="statusFilter"
              :options="statusFilterOptions"
              placeholder="按状态筛选"
              clearable
              style="width:150px"
              @update:value="loadParticipants"
            />
            <n-input v-model:value="keyword" placeholder="搜法名/戒牒号" clearable style="width:170px" @keyup.enter="loadParticipants" />
            <n-button @click="loadParticipants">查询</n-button>
            <n-tag v-if="selectedKeys.length" type="info" size="small" style="align-self:center">
              已选 {{ selectedKeys.length }} 人
            </n-tag>
            <n-space style="margin-left:auto">
              <n-button size="small" :disabled="!checkedInable.length" @click="bulk('checkin')">
                批量签到（{{ checkedInable.length }}）
              </n-button>
              <n-button size="small" :disabled="!noShowable.length" @click="bulk('no-show')">
                标记未到（{{ noShowable.length }}）
              </n-button>
              <n-button size="small" :disabled="!earlyLeavable.length" @click="bulk('early-leave')">
                提前离寺（{{ earlyLeavable.length }}）
              </n-button>
              <n-button size="small" :disabled="!checkoutable.length" @click="bulk('checkout')">
                批量离寺（{{ checkoutable.length }}）
              </n-button>
            </n-space>
          </n-space>

          <n-data-table
            :columns="columns"
            :data="filteredParticipants"
            :loading="loading"
            :row-key="(r: CeremonyParticipant) => r.id"
            :checked-row-keys="selectedKeys"
            :row-class-name="rowClass"
            @update:checked-row-keys="onCheck"
            :scroll-x="1280"
            :pagination="{ pageSize: 12 }"
            striped
          />
        </n-tab-pane>

        <n-tab-pane name="waitlist" tab="候补队列">
          <n-data-table
            :columns="waitlistColumns"
            :data="waitlist"
            :loading="loading"
            :row-key="(r: CeremonyParticipant) => r.id"
            :pagination="false"
            striped
          />
        </n-tab-pane>
      </n-tabs>
    </n-card>

    <ImportModal v-model:show="showImport" :ceremony-id="ceremony.id" @imported="loadAll" />
    <BedModal v-model:show="showBed" :ceremony-id="ceremony.id" :participant="bedTarget" @saved="loadAll" />
    <ReportsModal v-model:show="showReports" :ceremony-id="ceremony.id" />
    <EventDrawer v-model:show="showEvents" :ceremony-id="ceremony.id" />
    <ImportBatchesDrawer v-model:show="showImportBatches" :ceremony-id="ceremony.id" />
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NCard, NSpace, NButton, NIcon, NTag, NText, NGrid, NGi, NStatistic,
  NTabs, NTabPane, NDataTable, NSelect, NInput, NPopconfirm, useMessage, useDialog,
} from 'naive-ui';
import type { DataTableColumns, SelectOption } from 'naive-ui';
import {
  ArrowBackOutline, DocumentTextOutline, ListOutline, BarChartOutline,
  CloudUploadOutline, BedOutline,
} from '@vicons/ionicons5';
import {
  http,
  CEREMONY_STATUS_LABEL, CEREMONY_STATUS_TYPE,
  PARTICIPANT_STATUS_LABEL, PARTICIPANT_STATUS_TYPE,
} from '../../api.js';
import type { Ceremony, CeremonyParticipant } from '../../types.js';
import ImportModal from './ImportModal.vue';
import BedModal from './BedModal.vue';
import ReportsModal from './ReportsModal.vue';
import EventDrawer from './EventDrawer.vue';
import ImportBatchesDrawer from './ImportBatchesDrawer.vue';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();

const ceremony = ref<Ceremony | null>(null);
const participants = ref<CeremonyParticipant[]>([]);
const waitlist = ref<CeremonyParticipant[]>([]);
const loading = ref(false);
const allocating = ref(false);
const tab = ref('active');

const showImport = ref(false);
const showBed = ref(false);
const showReports = ref(false);
const showEvents = ref(false);
const showImportBatches = ref(false);
const bedTarget = ref<CeremonyParticipant | null>(null);

const groupFilter = ref<string | null>(null);
const statusFilter = ref<string | null>(null);
const keyword = ref('');
const selectedKeys = ref<string[]>([]);
const actionDate = ref(new Date().toISOString().slice(0, 10));

async function loadCeremony() {
  const { data } = await http.get<Ceremony>(`/ceremonies/${route.params.id}`);
  ceremony.value = data;
}

async function loadParticipants() {
  loading.value = true;
  try {
    const params: Record<string, string> = {};
    if (statusFilter.value) params.status = statusFilter.value;
    if (groupFilter.value) params.group = groupFilter.value;
    const { data } = await http.get<CeremonyParticipant[]>(`/ceremonies/${route.params.id}/participants`, { params });
    participants.value = data;
  } finally {
    loading.value = false;
  }
}

async function loadWaitlist() {
  const { data } = await http.get<CeremonyParticipant[]>(`/ceremonies/${route.params.id}/waitlist`);
  waitlist.value = data;
}

async function loadAll() {
  await Promise.all([loadCeremony(), loadParticipants(), loadWaitlist()]);
}

function onTabChange(v: string) {
  if (v === 'waitlist') loadWaitlist();
}

const groupOptions = computed<SelectOption[]>(() => {
  const groups = new Set(participants.value.map((p) => p.group_code).filter(Boolean) as string[]);
  return [...groups].sort().map((g) => ({ label: `分组 ${g}`, value: g }));
});

const statusFilterOptions: SelectOption[] = Object.entries(PARTICIPANT_STATUS_LABEL).map(([value, label]) => ({ label, value }));

const filteredParticipants = computed(() => {
  const kw = keyword.value.trim();
  if (!kw) return participants.value;
  return participants.value.filter(
    (p) => p.dharma_name.includes(kw) || (p.ordination_no ?? '').includes(kw),
  );
});

function onCheck(keys: Array<string | number>) {
  selectedKeys.value = keys.map(String);
}

const selectedRows = computed(() => {
  const set = new Set(selectedKeys.value);
  return filteredParticipants.value.filter((p) => set.has(p.id));
});
const checkedInable = computed(() => selectedRows.value.filter((p) => ['registered', 'bed_offered', 'confirmed'].includes(p.status)));
const noShowable = computed(() => selectedRows.value.filter((p) => ['registered', 'bed_offered', 'confirmed', 'waitlisted'].includes(p.status)));
const earlyLeavable = computed(() => selectedRows.value.filter((p) => p.status === 'checked_in'));
const checkoutable = computed(() => selectedRows.value.filter((p) => ['checked_in', 'early_left'].includes(p.status)));

function rowClass(p: CeremonyParticipant) {
  if (p.status === 'bed_offered') return 'row-offered';
  if (p.status === 'waitlisted') return 'row-waitlist';
  return '';
}

// ---------------- 批量操作 ----------------
async function bulk(kind: 'checkin' | 'no-show' | 'early-leave' | 'checkout') {
  let ids: string[] = [];
  let title = '';
  if (kind === 'checkin') { ids = checkedInable.value.map((p) => p.id); title = `确认 ${ids.length} 人按 ${actionDate.value} 签到（晚于到寺日自动记迟到）？`; }
  if (kind === 'no-show') { ids = noShowable.value.map((p) => p.id); title = `标记 ${ids.length} 人未到？其床位将释放并自动递补候补`; }
  if (kind === 'early-leave') { ids = earlyLeavable.value.map((p) => p.id); title = `${ids.length} 人于 ${actionDate.value} 提前离寺？床位将释放并自动递补`; }
  if (kind === 'checkout') { ids = checkoutable.value.map((p) => p.id); title = `${ids.length} 人于 ${actionDate.value} 办理离寺？`; }
  if (ids.length === 0) return;

  const date = kind === 'checkin' || kind === 'early-leave' || kind === 'no-show' || kind === 'checkout'
    ? await askDate(title)
    : actionDate.value;
  if (!date) return;
  actionDate.value = date;

  const { data } = await http.post<{
    total?: number; on_time?: number; late?: number;
    promoted?: { dharma_name: string }[];
  }>(`/ceremonies/${route.params.id}/${kind}`, { participant_ids: ids, date });
  if (kind === 'checkin') {
    message.success(`签到完成：如期 ${data.on_time} 人，迟到 ${data.late} 人`);
  } else {
    message.success(`已处理 ${data.total ?? ids.length} 人`);
    if (data.promoted?.length) {
      message.info(`床位释放，自动递补：${data.promoted.map((p) => p.dharma_name).join('、')}（待知客确认）`);
    }
  }
  selectedKeys.value = [];
  loadAll();
}

function askDate(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    const d = ref(actionDate.value);
    dialog.info({
      title: '请确认操作日期',
      content: () =>
        h('div', { style: 'margin-top:10px' }, [
          h('p', { style: 'margin:0 0 10px;color:#5a4d40' }, title),
          h('input', {
            type: 'date',
            value: d.value,
            style: 'padding:6px 10px;border:1px solid #d8cbb8;border-radius:6px',
            onInput: (e: Event) => { d.value = (e.target as HTMLInputElement).value; },
          }),
        ]),
      positiveText: '确定',
      negativeText: '取消',
      onPositiveClick: () => resolve(d.value),
      onNegativeClick: () => resolve(null),
    });
  });
}

async function allocateBeds() {
  allocating.value = true;
  try {
    const { data } = await http.post<{ allocated: unknown[]; total: number; bedless: number }>(
      `/ceremonies/${route.params.id}/allocate-beds`,
      {},
    );
    message.success(`已自动分床 ${data.allocated.length} 人（待分床 ${data.bedless} 人，床位不足时保留登记）`);
    loadAll();
  } finally {
    allocating.value = false;
  }
}

async function startCeremony() {
  await http.post(`/ceremonies/${route.params.id}/action/start`, {});
  message.success('法会已开始');
  loadAll();
}

async function releaseAll() {
  const { data } = await http.post<{ released: number; checked_out: number }>(
    `/ceremonies/${route.params.id}/release-all`,
    { date: actionDate.value },
  );
  message.success(`已释放床位 ${data.released} 张，办理离寺 ${data.checked_out} 人；可在统计中查看实到率与床位峰值`);
  loadAll();
}

function openBed(p: CeremonyParticipant) {
  bedTarget.value = p;
  showBed.value = true;
}

async function confirmOffer(p: CeremonyParticipant) {
  await http.post(`/ceremonies/${route.params.id}/participants/${p.id}/offer/confirm`, {});
  message.success(`已确认 ${p.dharma_name} 的递补床位`);
  loadAll();
}

async function rejectOffer(p: CeremonyParticipant) {
  await http.post(`/ceremonies/${route.params.id}/participants/${p.id}/offer/reject`, {});
  message.success(`已谢绝，${p.dharma_name} 回到候补队尾，床位继续递补下一位`);
  loadAll();
}

async function releaseBed(p: CeremonyParticipant) {
  const { data } = await http.post<{ promoted?: { dharma_name: string }[] }>(
    `/ceremonies/${route.params.id}/participants/${p.id}/release-bed`,
    { date: actionDate.value },
  );
  message.success(`${p.dharma_name} 床位已释放`);
  if (data.promoted?.length) {
    message.info(`自动递补：${data.promoted.map((x) => x.dharma_name).join('、')}（待确认）`);
  }
  loadAll();
}

async function cancelP(p: CeremonyParticipant) {
  await http.post(`/ceremonies/${route.params.id}/participants/${p.id}/cancel`, {});
  message.success('已取消登记');
  loadAll();
}

// ---------------- 表格列 ----------------
const columns = computed<DataTableColumns<CeremonyParticipant>>(() => [
  { type: 'selection', width: 40, fixed: 'left' },
  { title: '法名', key: 'dharma_name', width: 90, fixed: 'left', render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  {
    title: '状态', key: 'status', width: 100,
    render: (r) => h(NTag, { size: 'small', type: PARTICIPANT_STATUS_TYPE[r.status], bordered: false }, { default: () => PARTICIPANT_STATUS_LABEL[r.status] }),
  },
  { title: '分组', key: 'group_code', width: 62, render: (r) => r.group_code ?? '—' },
  { title: '出家寺庙', key: 'home_monastery', width: 150, ellipsis: { tooltip: true } },
  { title: '戒牒编号', key: 'ordination_no', width: 115 },
  { title: '到寺', key: 'arrive_date', width: 100 },
  { title: '离寺', key: 'leave_date', width: 100 },
  {
    title: '特殊需求', key: 'special_need', width: 130, ellipsis: { tooltip: true },
    render: (r) => r.special_need
      ? h(NText, { type: 'warning', style: 'font-size:12px' }, { default: () => r.special_need })
      : '—',
  },
  {
    title: '床位', key: 'bed', width: 150,
    render: (r) => {
      if (!r.room_no) return h(NText, { depth: 3, style: 'font-size:12px' }, { default: () => (r.status === 'waitlisted' ? '候补中' : '未安排') });
      return h('span', { style: 'font-size:13px' }, [
        `${r.room_no} · ${r.bed_no}床`,
        r.stay_status === 'held' ? h(NTag, { size: 'tiny', type: 'warning', style: 'margin-left:4px' }, { default: () => '待确认' }) : null,
      ]);
    },
  },
  {
    title: '签到', key: 'checkin', width: 130,
    render: (r) => {
      if (!r.checkin_date) return '—';
      return h('span', { style: 'font-size:12px' }, [
        r.checkin_date,
        h(NTag, { size: 'tiny', type: r.checkin_kind === 'late' ? 'warning' : 'success', style: 'margin-left:4px' },
          { default: () => r.checkin_kind === 'late' ? '迟到' : '如期' }),
      ]);
    },
  },
  {
    title: '操作', key: 'actions', width: 250, fixed: 'right',
    render: (r) => {
      const btns = [];
      btns.push(h(NButton, { size: 'tiny', quaternary: true, type: 'primary', onClick: () => openBed(r) },
        { default: () => (r.room_no ? '调床' : '分床') }));
      if (r.status === 'bed_offered') {
        btns.push(h(NButton, { size: 'tiny', quaternary: true, type: 'success', onClick: () => confirmOffer(r) }, { default: () => '确认' }));
        btns.push(h(NButton, { size: 'tiny', quaternary: true, type: 'warning', onClick: () => rejectOffer(r) }, { default: () => '谢绝' }));
      }
      if (['registered', 'confirmed', 'bed_offered', 'checked_in'].includes(r.status)) {
        btns.push(h(NPopconfirm, { onPositiveClick: () => releaseBed(r) }, {
          trigger: () => h(NButton, { size: 'tiny', quaternary: true, type: 'warning' }, { default: () => '释床' }),
          default: () => `释放 ${r.dharma_name} 的床位？释放后自动递补候补首位`,
        }));
      }
      if (!['checked_in', 'early_left', 'checked_out', 'cancelled'].includes(r.status)) {
        btns.push(h(NPopconfirm, { onPositiveClick: () => cancelP(r) }, {
          trigger: () => h(NButton, { size: 'tiny', quaternary: true, type: 'error' }, { default: () => '取消' }),
          default: () => `取消 ${r.dharma_name} 的登记？`,
        }));
      }
      return h('div', { style: 'display:flex;flex-wrap:wrap' }, btns);
    },
  },
]);

const waitlistColumns = computed<DataTableColumns<CeremonyParticipant>>(() => [
  { title: '候补序号', key: 'waitlist_seq', width: 90, render: (r) => h(NText, { strong: true, type: 'warning' }, { default: () => `第 ${r.waitlist_seq} 位` }) },
  { title: '法名', key: 'dharma_name', width: 100, render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  { title: '分组', key: 'group_code', width: 70, render: (r) => r.group_code ?? '—' },
  { title: '到寺', key: 'arrive_date', width: 110 },
  { title: '离寺', key: 'leave_date', width: 110 },
  { title: '特殊需求', key: 'special_need' },
  {
    title: '操作', key: 'op', width: 120,
    render: (r) => h(NButton, { size: 'small', type: 'primary', quaternary: true, onClick: () => openBed(r) },
      { default: () => '手工指定床位' }),
  },
]);

onMounted(loadAll);
</script>

<style>
.n-data-table .row-offered td {
  background-color: #fdf6ec !important;
}
.n-data-table .row-waitlist td {
  background-color: #faf8f5 !important;
}
</style>
