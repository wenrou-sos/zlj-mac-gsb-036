<template>
  <n-space vertical :size="16">
    <n-grid :cols="4" :x-gap="12">
      <n-gi>
        <n-card size="small" title="已纳名单">
          <n-statistic label="人" :value="stats?.admitted ?? 0" />
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="实到">
          <n-statistic label="人" :value="stats?.arrived ?? 0">
            <n-text depth="3" style="font-size:13px">未到 {{ stats?.no_show ?? 0 }}，候补 {{ stats?.waitlisted ?? 0 }}</n-text>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="实到率">
          <n-statistic :value="stats?.arrival_rate ?? 0">
            <template #suffix>%</template>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi>
        <n-card size="small" title="床位峰值">
          <n-statistic label="床/日" :value="stats?.bed_peak ?? 0" />
        </n-card>
      </n-gi>
    </n-grid>

    <n-card size="small" :title="ceremony?.status === 'closed' ? '每日入住趋势（已冻结）' : '每日入住趋势（实时）'">
      <template #header-extra>
        <n-text depth="3" style="font-size:12px">
          柱：在寺实到人数　线：床位使用　虚线：每日接待上限
        </n-text>
      </template>
      <div class="chart">
        <div v-for="d in stats?.daily ?? []" :key="d.day" class="col">
          <div class="bar-area">
            <div class="bar present" :style="{ height: barH(d.present) }" :title="`实到 ${d.present}`" />
            <div class="bar admitted" :style="{ height: barH(d.admitted) }" :title="`已纳 ${d.admitted}`" />
            <div class="bed-dot" :style="{ bottom: barH(d.beds_used) }" :title="`床位 ${d.beds_used}`">●</div>
          </div>
          <div class="cap-line" :style="{ bottom: barH(ceremony?.daily_capacity ?? 0) }" :title="`上限 ${ceremony?.daily_capacity}`" />
          <div class="lbl">{{ d.day.slice(5) }}</div>
          <div class="num">{{ d.present }}/{{ d.admitted }}</div>
        </div>
      </div>
    </n-card>
  </n-space>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { NSpace, NGrid, NGi, NCard, NStatistic, NText } from 'naive-ui';
import { http } from '../../api.js';
import type { Ceremony, CeremonyStats } from '../../types.js';

const props = defineProps<{ ceremony: Ceremony | null }>();
const stats = ref<CeremonyStats | null>(null);

async function load() {
  if (!props.ceremony) return;
  const { data } = await http.get<CeremonyStats>(`/ceremonies/${props.ceremony.id}/stats`);
  stats.value = data;
}

function barH(n: number) {
  const max = Math.max(props.ceremony?.daily_capacity ?? 1, ...(stats.value?.daily.map((d) => d.admitted) ?? [1]), 1);
  return `${Math.round((n / max) * 100)}%`;
}

watch(() => props.ceremony?.id, load);
onMounted(load);
</script>

<style scoped>
.chart {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 220px;
  overflow-x: auto;
  padding-top: 10px;
}
.col {
  position: relative;
  flex: 1 0 34px;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}
.bar-area {
  position: relative;
  width: 100%;
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
}
.bar {
  width: 12px;
  border-radius: 3px 3px 0 0;
  min-height: 2px;
}
.bar.present {
  background: linear-gradient(180deg, #b08a54, #8c5a2e);
}
.bar.admitted {
  background: #e6dccb;
}
.bed-dot {
  position: absolute;
  color: #c0502e;
  font-size: 10px;
}
.cap-line {
  position: absolute;
  left: 10%;
  right: 10%;
  border-top: 1px dashed #b0a08c;
}
.lbl {
  font-size: 11px;
  color: #7a6a58;
  margin-top: 4px;
}
.num {
  font-size: 10px;
  color: #9a8a76;
}
</style>
