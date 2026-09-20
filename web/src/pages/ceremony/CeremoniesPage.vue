<template>
  <div>
    <n-card size="small">
      <n-space justify="space-between" align="center">
        <n-radio-group v-model:value="filterStatus" size="medium" @update:value="load">
          <n-radio-button value="">全部法会</n-radio-button>
          <n-radio-button value="preparing">筹备中</n-radio-button>
          <n-radio-button value="active">进行中</n-radio-button>
          <n-radio-button value="closed">已圆满</n-radio-button>
        </n-radio-group>
        <n-button type="primary" @click="openCreate">
          <template #icon><n-icon :component="AddOutline" /></template>
          创办法会
        </n-button>
      </n-space>
    </n-card>

    <n-card size="small" style="margin-top:16px">
      <n-data-table
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="(r: Ceremony) => r.id"
        :pagination="{ pageSize: 10 }"
        striped
      />
    </n-card>

    <!-- 创办法会 -->
    <n-modal v-model:show="showCreate" preset="card" title="创办法会" style="width: 520px">
      <n-form ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100px">
        <n-form-item label="法会名称" path="name">
          <n-input v-model:value="form.name" placeholder="例：秋季精进佛七" />
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
        <n-form-item label="每日接待上限" path="daily_capacity">
          <n-input-number v-model:value="form.daily_capacity" :min="1" :max="10000" style="width:100%">
            <template #suffix>人/日（人天口径）</template>
          </n-input-number>
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="form.note" type="textarea" :autosize="{ minRows: 2 }" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitCreate">创办</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import {
  NCard, NSpace, NRadioGroup, NRadioButton, NButton, NIcon, NDataTable,
  NModal, NForm, NFormItem, NDatePicker, NInputNumber, NInput, NGrid, NGridItem,
  NTag, useMessage,
} from 'naive-ui';
import type { DataTableColumns, FormInst, FormRules } from 'naive-ui';
import { AddOutline } from '@vicons/ionicons5';
import { useRouter } from 'vue-router';
import { http, CEREMONY_STATUS_LABEL, CEREMONY_STATUS_TYPE } from '../../api.js';
import type { Ceremony } from '../../types.js';

const router = useRouter();
const message = useMessage();
const rows = ref<Ceremony[]>([]);
const loading = ref(false);
const filterStatus = ref('');
const showCreate = ref(false);
const saving = ref(false);
const formRef = ref<FormInst | null>(null);

const form = ref({
  name: '',
  start_date: null as string | null,
  end_date: null as string | null,
  daily_capacity: 100,
  note: '',
});

const rules: FormRules = {
  name: { required: true, message: '请填写法会名称', trigger: 'blur' },
  start_date: { required: true, type: 'string', message: '请选择开始日期', trigger: 'change' },
  end_date: { required: true, type: 'string', message: '请选择结束日期', trigger: 'change' },
  daily_capacity: { required: true, type: 'number', min: 1, message: '接待上限须大于 0', trigger: 'blur' },
};

async function load() {
  loading.value = true;
  try {
    const { data } = await http.get<Ceremony[]>('/ceremonies', {
      params: filterStatus.value ? { status: filterStatus.value } : {},
    });
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = { name: '', start_date: null, end_date: null, daily_capacity: 100, note: '' };
  showCreate.value = true;
}

async function submitCreate() {
  await formRef.value?.validate();
  saving.value = true;
  try {
    const { data } = await http.post<Ceremony>('/ceremonies', form.value);
    message.success('法会已创办');
    showCreate.value = false;
    router.push(`/ceremonies/${data.id}`);
  } finally {
    saving.value = false;
  }
}

const columns: DataTableColumns<Ceremony> = [
  { title: '法会名称', key: 'name', render: (r) => h('a', {
      style: 'color:#8c5a2e;font-weight:600;cursor:pointer',
      onClick: () => router.push(`/ceremonies/${r.id}`),
    }, r.name) },
  { title: '状态', key: 'status', width: 90, render: (r) =>
      h(NTag, { size: 'small', type: CEREMONY_STATUS_TYPE[r.status], bordered: false },
        { default: () => CEREMONY_STATUS_LABEL[r.status] }) },
  { title: '会期', key: 'range', width: 200, render: (r) => `${r.start_date} ~ ${r.end_date}` },
  { title: '接待上限', key: 'daily_capacity', width: 90, render: (r) => `${r.daily_capacity} 人/日` },
  { title: '已纳名单', key: 'admitted_count', width: 90, render: (r) => r.admitted_count ?? '-' },
  { title: '已签到', key: 'checkedin_count', width: 80, render: (r) => r.checkedin_count ?? 0 },
  {
    title: '候补',
    key: 'waitlist_count',
    width: 80,
    render: (r) => (r.waitlist_count ? h(NTag, { size: 'small', type: 'warning', bordered: false },
      { default: () => `${r.waitlist_count} 人` }) : '—'),
  },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    render: (r) => h(NButton, {
      size: 'small', quaternary: true, type: 'primary',
      onClick: () => router.push(`/ceremonies/${r.id}`),
    }, { default: () => '进入客堂' }),
  },
];

onMounted(load);
</script>
