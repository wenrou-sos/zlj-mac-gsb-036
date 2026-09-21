<template>
  <div>
    <n-card size="small">
      <n-space justify="space-between" align="center">
        <n-radio-group v-model:value="filterStatus" size="medium" @update:value="load">
          <n-radio-button value="">全部</n-radio-button>
          <n-radio-button value="preparing">备会中</n-radio-button>
          <n-radio-button value="ongoing">进行中</n-radio-button>
          <n-radio-button value="closed">已圆满</n-radio-button>
        </n-radio-group>
        <n-button type="primary" @click="openCreate">
          <template #icon><n-icon :component="AddOutline" /></template>
          启建法会
        </n-button>
      </n-space>
    </n-card>

    <n-grid :cols="3" :x-gap="16" :y-gap="16" style="margin-top:16px" responsive="screen">
      <n-gi v-for="c in rows" :key="c.id" @click="openDetail(c.id)">
        <n-card hoverable class="ceremony-card" size="small">
          <n-space justify="space-between" align="start">
            <n-text strong style="font-size:16px">{{ c.name }}</n-text>
            <n-tag :type="CEREMONY_STATUS_TYPE[c.status]" size="small" round>
              {{ CEREMONY_STATUS_LABEL[c.status] }}
            </n-tag>
          </n-space>
          <div style="margin:10px 0 6px;color:#7a6a58;font-size:13px">
            {{ c.start_date }} ~ {{ c.end_date }}
          </div>
          <n-space size="large" style="font-size:13px">
            <span>接待上限 <n-text strong>{{ c.capacity }}</n-text></span>
            <span>已登记 <n-text strong type="info">{{ c.active_count ?? 0 }}</n-text></span>
            <span v-if="c.waitlist_count">
              候补 <n-text strong type="warning">{{ c.waitlist_count }}</n-text>
            </span>
            <span v-if="c.checked_in_count">
              在寺签到 <n-text strong type="success">{{ c.checked_in_count }}</n-text>
            </span>
          </n-space>
          <n-progress
            v-if="c.capacity"
            type="line"
            :percentage="Math.min(100, Math.round(((c.active_count ?? 0) / c.capacity) * 100))"
            :show-indicator="false"
            :height="6"
            style="margin-top:12px"
            :color="(c.active_count ?? 0) >= c.capacity ? '#d03050' : '#8c5a2e'"
          />
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 启建法会 -->
    <n-modal v-model:show="showCreate" preset="card" title="启建大型法会" style="width:520px">
      <n-form ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="96px">
        <n-form-item label="法会名称" path="name">
          <n-input v-model:value="form.name" placeholder="例：2026 秋季水陆法会" />
        </n-form-item>
        <n-grid :cols="2">
          <n-grid-item>
            <n-form-item label="开始日期" path="start_date">
              <n-date-picker v-model:formatted-value="form.start_date" value-format="yyyy-MM-dd" type="date" style="width:100%" />
            </n-form-item>
          </n-grid-item>
          <n-grid-item>
            <n-form-item label="结束日期" path="end_date">
              <n-date-picker v-model:formatted-value="form.end_date" value-format="yyyy-MM-dd" type="date" style="width:100%" />
            </n-form-item>
          </n-grid-item>
        </n-grid>
        <n-form-item label="接待上限" path="capacity">
          <n-input-number v-model:value="form.capacity" :min="1" :max="5000" style="width:100%" />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="form.note" type="textarea" :autosize="{ minRows: 2 }" placeholder="法会安排、特殊接待说明" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submit">启建</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard, NSpace, NRadioGroup, NRadioButton, NButton, NIcon, NGrid, NGi,
  NModal, NForm, NFormItem, NDatePicker, NInputNumber, NInput, NTag, NText, NProgress,
  useMessage,
} from 'naive-ui';
import type { FormInst, FormRules } from 'naive-ui';
import { AddOutline } from '@vicons/ionicons5';
import { http, CEREMONY_STATUS_LABEL, CEREMONY_STATUS_TYPE } from '../../api.js';
import type { Ceremony } from '../../types.js';

const router = useRouter();
const message = useMessage();
const rows = ref<Ceremony[]>([]);
const filterStatus = ref('ongoing');
const showCreate = ref(false);
const saving = ref(false);
const formRef = ref<FormInst | null>(null);
const form = ref({
  name: '',
  start_date: new Date().toISOString().slice(0, 10),
  end_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
  capacity: 50,
  note: '',
});
const rules: FormRules = {
  name: { required: true, message: '请填写法会名称', trigger: 'blur' },
  start_date: { required: true, message: '请选择开始日期', trigger: 'change' },
  end_date: { required: true, message: '请选择结束日期', trigger: 'change' },
  capacity: { required: true, type: 'number', min: 1, message: '接待上限须大于 0', trigger: 'blur' },
};

async function load() {
  const params: Record<string, string> = {};
  if (filterStatus.value) params.status = filterStatus.value;
  const { data } = await http.get<Ceremony[]>('/ceremonies', { params });
  rows.value = data;
}

function openCreate() {
  form.value = {
    name: '',
    start_date: new Date().toISOString().slice(0, 10),
    end_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
    capacity: 50,
    note: '',
  };
  showCreate.value = true;
}

async function submit() {
  await formRef.value?.validate();
  if (form.value.end_date < form.value.start_date) {
    message.error('结束日期不能早于开始日期');
    return;
  }
  saving.value = true;
  try {
    await http.post('/ceremonies', form.value);
    message.success('法会已启建');
    showCreate.value = false;
    filterStatus.value = '';
    load();
  } finally {
    saving.value = false;
  }
}

function openDetail(id: string) {
  router.push(`/ceremonies/${id}`);
}

onMounted(load);
</script>

<style scoped>
.ceremony-card {
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.ceremony-card:hover {
  transform: translateY(-2px);
}
</style>
