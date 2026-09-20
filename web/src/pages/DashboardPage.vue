<template>
  <n-spin :show="loading">
    <n-grid :cols="4" :x-gap="16" :y-gap="16" item-responsive responsive="screen">
      <n-grid-item span="4 m:2 l:1">
        <n-card>
          <n-statistic label="在寺总众" :value="inHouseTotal">
            <template #suffix>位</template>
          </n-statistic>
          <div class="stat-sub">
            常住 {{ countOf('permanent') }} · 考察 {{ countOf('inspection') }} · 挂单 {{ countOf('guadan') }}
          </div>
        </n-card>
      </n-grid-item>
      <n-grid-item span="4 m:2 l:1">
        <n-card>
          <n-statistic label="床位使用" :value="data?.bed_usage.occupied ?? 0">
            <template #suffix>/ {{ data?.bed_usage.total ?? 0 }}</template>
          </n-statistic>
          <n-progress
            class="stat-sub"
            type="line"
            :percentage="bedPercent"
            :show-indicator="false"
            :height="6"
            color="#8c5a2e"
          />
        </n-card>
      </n-grid-item>
      <n-grid-item span="4 m:2 l:1">
        <n-card hoverable class="clickable" @click="router.push('/attendance')">
          <n-statistic label="今日早/晚课缺勤" :value="todayAbsent">
            <template #suffix>人次</template>
          </n-statistic>
          <div class="stat-sub">
            待登记 早 {{ data?.attendance_today.morning_pending ?? '-' }} /
            晚 {{ data?.attendance_today.evening_pending ?? '-' }}
          </div>
        </n-card>
      </n-grid-item>
      <n-grid-item span="4 m:2 l:1">
        <n-card hoverable class="clickable" @click="router.push('/alerts')">
          <n-statistic label="缺勤满次待办" :value="data?.open_alerts ?? 0">
            <template #suffix>件</template>
          </n-statistic>
          <div class="stat-sub">客堂提醒，待知客知悉</div>
        </n-card>
      </n-grid-item>
    </n-grid>

    <n-grid :cols="2" :x-gap="16" :y-gap="16" item-responsive responsive="screen" style="margin-top:16px">
      <n-grid-item span="2 l:1">
        <n-card title="近三日预计舍单" size="small">
          <n-empty v-if="!data?.expiring_guadan.length" description="暂无即将到期的挂单" />
          <n-list v-else bordered>
            <n-list-item v-for="g in data?.expiring_guadan" :key="g.id">
              <n-thing :title="g.dharma_name">
                <template #description>
                  预计离寺 {{ g.expected_leave }}
                  <n-tag size="small" :type="g.days_left === 0 ? 'error' : 'warning'" style="margin-left:8px">
                    {{ g.days_left === 0 ? '今日到期' : `还有 ${g.days_left} 天` }}
                  </n-tag>
                </template>
              </n-thing>
            </n-list-item>
          </n-list>
        </n-card>
      </n-grid-item>

      <n-grid-item span="2 l:1">
        <n-card title="考察期进行中" size="small">
          <n-empty v-if="!data?.pending_inspections.length" description="暂无考察期僧人" />
          <n-list v-else bordered>
            <n-list-item v-for="i in data?.pending_inspections" :key="i.id">
              <n-thing :title="i.dharma_name">
                <template #description>
                  自 {{ i.start_date }} 起，已考察 {{ i.days_elapsed }} 天，
                  剩 <n-text strong>{{ Math.max(i.days_left ?? 0, 0) }}</n-text> 天期满
                  <n-space :size="4" style="margin-top:4px">
                    <n-tag size="small" :bordered="false"
                           :type="(i.completed_rounds ?? 0) >= (i.required_reviews ?? 0) ? 'success' : 'warning'">
                      月度评议 {{ i.completed_rounds ?? 0 }}/{{ i.required_reviews }}
                    </n-tag>
                    <n-tag v-if="(i.makeup_pending ?? 0) > 0" size="small" type="error" :bordered="false">
                      缺席待补 {{ i.makeup_pending }}
                    </n-tag>
                    <n-tag v-if="(i.open_alert_count ?? 0) > 0" size="small" type="error" :bordered="false">
                      缺勤待办 {{ i.open_alert_count }}
                    </n-tag>
                    <n-tag v-if="i.overall_avg !== null && i.overall_avg !== undefined" size="small"
                           :type="Number(i.overall_avg) >= i.pass_score ? 'success' : 'error'" :bordered="false">
                      均分 {{ i.overall_avg }}
                    </n-tag>
                  </n-space>
                </template>
                <n-progress
                  type="line"
                  :percentage="inspectionPercent(i)"
                  :height="6"
                  color="#b08a54"
                  style="margin-top:6px"
                />
              </n-thing>
            </n-list-item>
          </n-list>
          <template #footer>
            <n-button text type="primary" @click="router.push('/inspections')">前往考察管理 →</n-button>
          </template>
        </n-card>
      </n-grid-item>
    </n-grid>

    <n-card v-if="data" size="small" style="margin-top:16px" title="今日功课随众情况">
      <n-descriptions label-placement="left" :column="2" bordered size="small">
        <n-descriptions-item label="早课（随众 / 缺勤 / 请假）">
          {{ data.attendance_today.morning_present }} /
          <n-text :type="data.attendance_today.morning_absent ? 'error' : undefined">
            {{ data.attendance_today.morning_absent }}
          </n-text>
          / {{ data.attendance_today.morning_leave }}
        </n-descriptions-item>
        <n-descriptions-item label="晚课（随众 / 缺勤 / 请假）">
          {{ data.attendance_today.evening_present }} /
          <n-text :type="data.attendance_today.evening_absent ? 'error' : undefined">
            {{ data.attendance_today.evening_absent }}
          </n-text>
          / {{ data.attendance_today.evening_leave }}
        </n-descriptions-item>
      </n-descriptions>
    </n-card>
  </n-spin>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NSpin, NGrid, NGridItem, NCard, NStatistic, NProgress, NList, NListItem, NThing,
  NSpace, NTag, NEmpty, NButton, NDescriptions, NDescriptionsItem, NText,
} from 'naive-ui';
import { http } from '../api.js';
import type { Dashboard, Inspection, MonkStatus } from '../types.js';

const router = useRouter();
const data = ref<Dashboard | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await http.get<Dashboard>('/dashboard');
    data.value = res.data;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const inHouseTotal = computed(() =>
  (data.value?.status_counts ?? []).reduce((sum, x) => sum + x.n, 0),
);
function countOf(status: MonkStatus) {
  return data.value?.status_counts.find((x) => x.status === status)?.n ?? 0;
}
const bedPercent = computed(() => {
  const u = data.value?.bed_usage;
  if (!u || u.total === 0) return 0;
  return Math.round((u.occupied / u.total) * 100);
});
const todayAbsent = computed(() => {
  const a = data.value?.attendance_today;
  if (!a) return 0;
  return (a.morning_absent ?? 0) + (a.evening_absent ?? 0);
});
function inspectionPercent(i: Inspection) {
  const total = Math.max((new Date(i.expected_end).getTime() - new Date(i.start_date).getTime()) / 86400000, 1);
  return Math.min(100, Math.round(((i.days_elapsed ?? 0) / total) * 100));
}
</script>

<style scoped>
.stat-sub {
  margin-top: 8px;
  font-size: 12px;
  color: #9b8f80;
}
.clickable {
  cursor: pointer;
}
</style>
