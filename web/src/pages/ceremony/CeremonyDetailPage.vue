<template>
  <div>
    <n-page-header @back="router.push('/ceremonies')">
      <template #title>
        <n-space align="center" :size="12">
          <span>{{ ceremony?.name ?? '法会' }}</span>
          <n-tag v-if="ceremony" :type="CEREMONY_STATUS_TYPE[ceremony.status]" size="small" :bordered="false">
            {{ CEREMONY_STATUS_LABEL[ceremony.status] }}
          </n-tag>
        </n-space>
      </template>
      <template #extra>
        <n-space>
          <n-button v-if="ceremony?.status === 'preparing'" type="primary" @click="startCeremony">
            法会开始（开放签到）
          </n-button>
          <n-button v-if="ceremony && ceremony.status !== 'closed'" @click="openEdit">
            修改设置
          </n-button>
          <n-popconfirm v-if="ceremony && ceremony.status !== 'closed'" @positive-click="closeCeremony">
            <template #trigger>
              <n-button type="error" ghost>圆满结束（批量释放床位）</n-button>
            </template>
            结束后未签到者记为未到、床位全部释放并冻结统计，确认？
          </n-popconfirm>
        </n-space>
      </template>
      <template #subtitle>
        <span v-if="ceremony">
          {{ ceremony.start_date }} ~ {{ ceremony.end_date }} ｜ 每日接待上限 {{ ceremony.daily_capacity }} 人
        </span>
      </template>
    </n-page-header>

    <n-card size="small" style="margin-top:12px">
      <n-tabs v-model:value="tab" type="line" animated class="detail-tabs">
        <n-tab-pane name="roster">
          
            <RosterTab :ceremony="ceremony" @changed="loadCeremony" />
        </n-tab-pane>
        <n-tab-pane name="beds">
          
            <BedsTab :ceremony="ceremony" @changed="loadCeremony" />
        </n-tab-pane>
        <n-tab-pane name="waitlist">
          
            <WaitlistTab :ceremony="ceremony" @changed="loadCeremony" />
        </n-tab-pane>
        <n-tab-pane name="checkin">
          
            <CheckinTab :ceremony="ceremony" @changed="loadCeremony" />
        </n-tab-pane>
        <n-tab-pane name="stats">
          
            <StatsTab :ceremony="ceremony" />
        </n-tab-pane>
        <n-tab-pane name="logs">
          
            <LogsTab :ceremony="ceremony" />
        </n-tab-pane>
      </n-tabs>
    </n-card>

    <!-- 修改设置 -->
    <n-modal v-model:show="editShow" preset="card" title="修改法会设置（仅筹备中）" style="width:460px">
      <n-space vertical>
        <n-input v-model:value="editForm.name" placeholder="法会名称" />
        <n-date-picker v-model:formatted-value="editForm.start_date" value-format="yyyy-MM-dd" type="date" style="width:100%" />
        <n-date-picker v-model:formatted-value="editForm.end_date" value-format="yyyy-MM-dd" type="date" style="width:100%" />
        <n-input-number v-model:value="editForm.daily_capacity" :min="1" style="width:100%" />
        <n-input v-model:value="editForm.note" type="textarea" placeholder="备注" />
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button @click="editShow = false">取消</n-button>
          <n-button type="primary" @click="saveEdit">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NTag, NButton, NCard, NTabs, NTabPane, NSpace, NModal, NInput,
  NDatePicker, NInputNumber, NPopconfirm, NPageHeader, useMessage, useDialog,
} from 'naive-ui';
import { http, CEREMONY_STATUS_LABEL, CEREMONY_STATUS_TYPE } from '../../api.js';
import type { Ceremony, CeremonyStats } from '../../types.js';
import RosterTab from './RosterTab.vue';
import BedsTab from './BedsTab.vue';
import WaitlistTab from './WaitlistTab.vue';
import CheckinTab from './CheckinTab.vue';
import StatsTab from './StatsTab.vue';
import LogsTab from './LogsTab.vue';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const tab = ref((route.query.tab as string) || 'roster');
const ceremony = ref<Ceremony | null>(null);
const editShow = ref(false);
const editForm = ref({ name: '', start_date: '' as string | null, end_date: '' as string | null, daily_capacity: 0, note: '' as string });

const cid = () => route.params.id as string;

async function loadCeremony() {
  const { data } = await http.get<Ceremony>(`/ceremonies/${cid()}`);
  ceremony.value = data;
}

watch(tab, (v) => router.replace({ query: { tab: v } }));

function startCeremony() {
  dialog.warning({
    title: '确认法会开始',
    content: '开始后签到功能开放，法会设置不可再修改。',
    positiveText: '开始',
    onPositiveClick: async () => {
      await http.post(`/ceremonies/${cid()}/start`, {});
      message.success('法会已开始');
      await loadCeremony();
    },
  });
}

async function closeCeremony() {
  const { data } = await http.post<{ ok: boolean; stats: CeremonyStats }>(`/ceremonies/${cid()}/close`, {});
  message.success(`法会已圆满，床位已全部释放，实到率 ${data.stats.arrival_rate}%，统计已冻结`);
  await loadCeremony();
  tab.value = 'stats';
}

function syncEditForm() {
  if (!ceremony.value) return;
  editForm.value = {
    name: ceremony.value.name, start_date: ceremony.value.start_date,
    end_date: ceremony.value.end_date, daily_capacity: ceremony.value.daily_capacity,
    note: ceremony.value.note ?? '',
  };
}

function openEdit() {
  syncEditForm();
  editShow.value = true;
}

function saveEdit() {
  http.put(`/ceremonies/${cid()}`, editForm.value).then(() => {
    message.success('已保存');
    editShow.value = false;
    loadCeremony();
  });
}

watch(ceremony, (c) => {
  if (c && editShow.value === false) {
    editForm.value = {
      name: c.name, start_date: c.start_date, end_date: c.end_date,
      daily_capacity: c.daily_capacity, note: c.note ?? '',
    };
  }
});

onMounted(async () => {
  await loadCeremony();
  if (ceremony.value) {
    editForm.value = {
      name: ceremony.value.name, start_date: ceremony.value.start_date,
      end_date: ceremony.value.end_date, daily_capacity: ceremony.value.daily_capacity,
      note: ceremony.value.note ?? '',
    };
  }
});
</script>

<style scoped>
:deep(.detail-tabs .n-tab-pane) {
  padding-top: 10px;
}
</style>
