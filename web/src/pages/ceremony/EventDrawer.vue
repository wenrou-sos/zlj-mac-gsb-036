<template>
  <n-drawer :show="show" :width="560" @update:show="(v: boolean) => emit('update:show', v)">
    <n-drawer-content title="操作留痕（导入 / 调床 / 递补 / 签到 全程保留）" closable>
      <n-radio-group v-model:value="typeFilter" size="small" style="margin-bottom:12px" @update:value="load">
        <n-radio-button value="">全部</n-radio-button>
        <n-radio-button v-for="(label, key) in EVENT_LABELS" :key="key" :value="key">
          {{ label }}
        </n-radio-button>
      </n-radio-group>
      <n-spin :show="loading">
        <n-timeline>
          <n-timeline-item
            v-for="e in events"
            :key="e.id"
            :type="dotType(e.event_type)"
            :title="`${CEREMONY_EVENT_LABEL[e.event_type] ?? e.event_type}${e.dharma_name ? ' · ' + e.dharma_name : ''}`"
            :time="fmtTime(e.created_at)"
          >
            <div style="font-size:13px">
              <n-text depth="3">{{ e.operator }}</n-text>
              <div v-if="Object.keys(e.detail ?? {}).length" style="margin-top:2px">
                <n-text code v-for="(v, k) in e.detail" :key="String(k)" style="margin-right:6px;font-size:12px">
                  {{ k }}: {{ formatVal(v) }}
                </n-text>
              </div>
            </div>
          </n-timeline-item>
        </n-timeline>
      </n-spin>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  NDrawer, NDrawerContent, NRadioGroup, NRadioButton, NSpin, NTimeline, NTimelineItem,
  NText,
} from 'naive-ui';
import { http, CEREMONY_EVENT_LABEL } from '../../api.js';
import type { CeremonyEvent } from '../../types.js';

const props = defineProps<{ show: boolean; ceremonyId: string }>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>();

const events = ref<CeremonyEvent[]>([]);
const loading = ref(false);
const typeFilter = ref('');
const EVENT_LABELS = Object.fromEntries(
  ['import', 'allocate', 'bed_change', 'waitlist_promote', 'offer_confirm', 'checkin', 'early_leave', 'no_show', 'release_all']
    .map((k) => [k, CEREMONY_EVENT_LABEL[k]]),
);

function dotType(t: string): 'default' | 'success' | 'info' | 'warning' | 'error' {
  if (['checkin', 'offer_confirm'].includes(t)) return 'success';
  if (['early_leave', 'no_show', 'offer_reject', 'cancel'].includes(t)) return 'error';
  if (['waitlist_promote', 'release', 'release_all'].includes(t)) return 'warning';
  if (['import', 'allocate', 'bed_change'].includes(t)) return 'info';
  return 'default';
}

function fmtTime(t: string) {
  return t.replace('T', ' ').slice(0, 16);
}

function formatVal(v: unknown) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function load() {
  loading.value = true;
  try {
    const params: Record<string, string> = {};
    if (typeFilter.value) params.type = typeFilter.value;
    const { data } = await http.get<CeremonyEvent[]>(`/ceremonies/${props.ceremonyId}/events`, { params });
    events.value = data;
  } finally {
    loading.value = false;
  }
}

watch(() => props.show, (s) => { if (s) load(); });
</script>
