<template>
  <n-modal
    :show="show"
    preset="card"
    title="法会接待统计"
    style="width:820px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <n-spin :show="loading">
      <n-grid :cols="4" :x-gap="12" :y-gap="12">
        <n-gi>
          <n-statistic label="应到（未取消）" :value="data?.expected_total ?? 0" />
        </n-gi>
        <n-gi>
          <n-statistic label="实到人数" :value="data?.arrived_total ?? 0">
            <template #suffix>
              <n-tag size="small" type="success" style="margin-left:6px">
                实到率 {{ data?.arrived_rate ?? 0 }}%
              </n-tag>
            </template>
          </n-statistic>
        </n-gi>
        <n-gi>
          <n-statistic label="床位峰值" :value="data?.bed_peak ?? 0">
            <template #suffix>
              <span style="font-size:13px;color:#7a6a58">
                / {{ data?.capacity }} · {{ data?.bed_peak_date ?? '' }}
              </span>
            </template>
          </n-statistic>
        </n-gi>
        <n-gi>
          <n-statistic label="累计床位数（人晚）" :value="data?.bed_nights ?? 0" />
        </n-gi>
        <n-gi>
          <n-statistic label="如期签到" :value="data?.on_time_count ?? 0" />
        </n-gi>
        <n-gi>
          <n-statistic label="迟到" :value="data?.late_count ?? 0" />
        </n-gi>
        <n-gi>
          <n-statistic label="未到" :value="data?.no_show_count ?? 0" />
        </n-gi>
        <n-gi>
          <n-statistic label="提前离寺" :value="data?.early_left_count ?? 0" />
        </n-gi>
      </n-grid>

      <n-divider style="margin:14px 0">每日床位入住趋势</n-divider>
      <div class="chart">
        <div v-for="d in data?.daily_occupancy ?? []" :key="d.date" class="bar-col">
          <div class="bar-val">{{ d.beds_occupied }}</div>
          <div
            class="bar"
            :style="{
              height: `${barHeight(d.beds_occupied)}px`,
              background: d.date === data?.bed_peak_date ? '#b08a54' : '#8c5a2e',
            }"
          />
          <div class="bar-date">{{ d.date.slice(5) }}</div>
        </div>
      </div>

      <n-divider style="margin:14px 0">状态分布</n-divider>
      <n-space>
        <n-tag
          v-for="s in data?.status_dist ?? []"
          :key="s.status"
          :type="PARTICIPANT_STATUS_TYPE[s.status] ?? 'default'"
        >
          {{ PARTICIPANT_STATUS_LABEL[s.status] }} {{ s.n }}
        </n-tag>
      </n-space>
    </n-spin>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  NModal, NSpin, NGrid, NGi, NStatistic, NDivider, NSpace, NTag,
} from 'naive-ui';
import { http, PARTICIPANT_STATUS_LABEL, PARTICIPANT_STATUS_TYPE } from '../../api.js';
import type { CeremonyReports } from '../../types.js';

const props = defineProps<{ show: boolean; ceremonyId: string }>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>();

const data = ref<CeremonyReports | null>(null);
const loading = ref(false);
const MAX_H = 160;

function barHeight(n: number) {
  const daily = (data.value?.daily_occupancy ?? []) as { beds_occupied: number }[];
  const max = Math.max(data.value?.capacity ?? 1, ...daily.map((x) => x.beds_occupied), 1);
  return Math.max(4, Math.round((n / max) * MAX_H));
}

watch(
  () => props.show,
  async (s) => {
    if (!s) return;
    loading.value = true;
    try {
      const { data: d } = await http.get<CeremonyReports>(`/ceremonies/${props.ceremonyId}/reports`);
      data.value = d;
    } finally {
      loading.value = false;
    }
  },
);
</script>

<style scoped>
.chart {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 216px;
  padding: 8px 4px 0;
  overflow-x: auto;
}
.bar-col {
  flex: 1 0 26px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
}
.bar {
  width: 70%;
  min-width: 14px;
  border-radius: 3px 3px 0 0;
  transition: height 0.3s ease;
}
.bar-val {
  font-size: 12px;
  color: #3a2f25;
  margin-bottom: 2px;
}
.bar-date {
  font-size: 11px;
  color: #9a8a78;
  margin-top: 4px;
}
</style>
