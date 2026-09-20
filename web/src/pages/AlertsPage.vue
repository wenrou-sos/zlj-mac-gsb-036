<template>
  <n-card size="small">
    <n-space align="center" justify="space-between">
      <n-radio-group v-model:value="statusFilter" @update:value="load">
        <n-radio-button value="open">待处理</n-radio-button>
        <n-radio-button value="acknowledged">已知悉</n-radio-button>
        <n-radio-button value="">全部</n-radio-button>
      </n-radio-group>
      <n-text depth="3">规则：近 30 日早晚课缺勤累计满 3 次，系统自动生成客堂提醒</n-text>
    </n-space>
  </n-card>

  <n-grid :cols="2" :x-gap="16" :y-gap="16" item-responsive responsive="screen" style="margin-top:16px">
    <n-grid-item v-for="a in alerts" :key="a.id" span="2 l:1">
      <n-card size="small" :class="['alert-card', a.status]">
        <n-space align="center" justify="space-between">
          <n-space align="center">
            <n-icon :component="AlertCircleOutline" :size="22" color="#c0392b" />
            <div>
              <div class="alert-name">
                {{ a.dharma_name }}
                <n-tag size="small" :type="MONK_STATUS_TYPE[a.monk_status]" :bordered="false" style="margin-left:6px">
                  {{ MONK_STATUS_LABEL[a.monk_status] }}
                </n-tag>
                <n-tag v-if="a.current_post" size="small" type="primary" :bordered="false" style="margin-left:4px">
                  {{ a.current_post }}
                </n-tag>
              </div>
              <div class="alert-sub">
                近 {{ a.window_days }} 日缺勤 <n-text type="error" strong>{{ a.absence_count }}</n-text> 次
                <template v-if="a.room_no"> · {{ a.room_no }} {{ a.bed_no }}床</template>
              </div>
            </div>
          </n-space>
          <n-tag v-if="a.status === 'open'" type="error" size="small" :bordered="false">待处理</n-tag>
          <n-tag v-else type="default" size="small" :bordered="false">
            {{ a.acknowledged_by ? `${a.acknowledged_by} 已知悉` : '已知悉' }}
          </n-tag>
        </n-space>
        <div class="alert-foot">
          <n-text depth="3" style="font-size:12px">
            最近缺勤 {{ a.last_absence }} · 提醒生成 {{ a.created_at.slice(0, 10) }}
            <template v-if="a.acknowledged_at"> · 处理于 {{ a.acknowledged_at.slice(0, 10) }}</template>
          </n-text>
          <n-space v-if="a.status === 'open'">
            <n-button size="small" @click="router.push('/attendance')">查看考勤</n-button>
            <n-button size="small" type="primary" :loading="acking === a.id" @click="ack(a)">
              知客已知悉
            </n-button>
          </n-space>
        </div>
      </n-card>
    </n-grid-item>
  </n-grid>

  <n-empty v-if="!loading && alerts.length === 0" description="暂无缺勤提醒，大众精进" style="margin-top:80px" />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard, NGrid, NGridItem, NSpace, NRadioGroup, NRadioButton, NButton, NTag,
  NText, NIcon, NEmpty, useMessage,
} from 'naive-ui';
import { AlertCircleOutline } from '@vicons/ionicons5';
import { http, MONK_STATUS_LABEL, MONK_STATUS_TYPE } from '../api.js';
import type { AbsenceAlert } from '../types.js';

const router = useRouter();
const message = useMessage();
const alerts = ref<AbsenceAlert[]>([]);
const statusFilter = ref('open');
const loading = ref(false);
const acking = ref('');

async function load() {
  loading.value = true;
  try {
    const params = statusFilter.value ? { status: statusFilter.value } : {};
    const { data } = await http.get<AbsenceAlert[]>('/alerts', { params });
    alerts.value = data;
  } finally {
    loading.value = false;
  }
}

async function ack(a: AbsenceAlert) {
  acking.value = a.id;
  try {
    await http.post(`/alerts/${a.id}/ack`, { acknowledged_by: '知客' });
    message.success('已标记知悉');
    load();
  } finally {
    acking.value = '';
  }
}

onMounted(load);
</script>

<style scoped>
.alert-card {
  border-left: 4px solid #d8cbb8;
}
.alert-card.open {
  border-left-color: #c0392b;
  background: #fdf6f3;
}
.alert-name {
  font-size: 15px;
  font-weight: 600;
}
.alert-sub {
  font-size: 13px;
  color: #6b5d4d;
  margin-top: 4px;
}
.alert-foot {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed #e5d9c8;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
