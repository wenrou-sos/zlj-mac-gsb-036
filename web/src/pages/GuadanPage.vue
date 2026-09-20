<template>
  <div>
    <n-card size="small">
      <n-space justify="space-between" align="center">
        <n-space align="center">
          <n-radio-group v-model:value="filterStatus" size="medium" @update:value="load">
            <n-radio-button value="active">在寺挂单</n-radio-button>
            <n-radio-button value="closed">历史舍单</n-radio-button>
            <n-radio-button value="">全部</n-radio-button>
          </n-radio-group>
          <n-input
            v-model:value="keyword"
            placeholder="搜法名 / 戒牒编号"
            clearable
            style="width: 220px"
            @keyup.enter="load"
            @clear="load"
          >
            <template #prefix><n-icon :component="SearchOutline" /></template>
          </n-input>
          <n-button @click="load">查询</n-button>
        </n-space>
        <n-button type="primary" @click="openCreate">
          <template #icon><n-icon :component="AddOutline" /></template>
          新到挂单登记
        </n-button>
      </n-space>
    </n-card>

    <n-card size="small" style="margin-top:16px">
      <n-data-table
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="(r: Guadan) => r.id"
        :pagination="{ pageSize: 10 }"
        striped
      />
    </n-card>

    <!-- 挂单登记 -->
    <n-modal v-model:show="showCreate" preset="card" title="云游僧人挂单登记" style="width: 560px">
      <n-form ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="92px">
        <n-form-item label="法名" path="dharma_name">
          <n-input v-model:value="form.dharma_name" placeholder="例：法远" />
        </n-form-item>
        <n-form-item label="出家寺庙" path="home_monastery">
          <n-input v-model:value="form.home_monastery" placeholder="例：河南嵩山少林寺" />
        </n-form-item>
        <n-form-item label="戒牒编号" path="ordination_no">
          <n-input v-model:value="form.ordination_no" placeholder="例：JD20210455" />
        </n-form-item>
        <n-grid :cols="2">
          <n-grid-item>
            <n-form-item label="到寺日期" path="arrive_date">
              <n-date-picker
                v-model:formatted-value="form.arrive_date"
                value-format="yyyy-MM-dd"
                type="date"
                style="width: 100%"
              />
            </n-form-item>
          </n-grid-item>
          <n-grid-item>
            <n-form-item label="预计住几天" path="expected_days">
              <n-input-number v-model:value="form.expected_days" :min="1" :max="365" style="width:100%" />
            </n-form-item>
          </n-grid-item>
        </n-grid>
        <n-form-item label="安排床位">
          <n-select
            v-model:value="form.bed_id"
            :options="bedOptions"
            placeholder="可稍后由寮元安排"
            clearable
            filterable
          />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="form.note" type="textarea" :autosize="{ minRows: 2 }" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitCreate">登记</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 安排床位 -->
    <n-modal v-model:show="showBed" preset="card" title="安排 / 调换床位" style="width: 420px">
      <n-form label-placement="left" label-width="72px">
        <n-form-item label="僧人">
          <span>{{ bedTarget?.dharma_name }}</span>
        </n-form-item>
        <n-form-item label="床位">
          <n-select v-model:value="bedChoice" :options="bedOptions" filterable placeholder="选择空闲床位" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showBed = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitBed">确定</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 续单 -->
    <n-modal v-model:show="showExtend" preset="card" title="续单" style="width: 360px">
      <n-form label-placement="left" label-width="90px">
        <n-form-item label="续住天数">
          <n-input-number v-model:value="extendDays" :min="1" :max="365" style="width:100%" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showExtend = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitExtend">确定</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import {
  NCard, NSpace, NRadioGroup, NRadioButton, NInput, NButton, NIcon, NDataTable,
  NModal, NForm, NFormItem, NDatePicker, NInputNumber, NSelect, NGrid, NGridItem,
  NTag, NPopconfirm, NText, useMessage,
} from 'naive-ui';
import type { DataTableColumns, FormInst, FormRules, SelectOption } from 'naive-ui';
import { AddOutline, SearchOutline } from '@vicons/ionicons5';
import { http, MONK_STATUS_LABEL, MONK_STATUS_TYPE } from '../api.js';
import type { AvailableBed, Guadan } from '../types.js';

const message = useMessage();
const rows = ref<Guadan[]>([]);
const loading = ref(false);
const filterStatus = ref('active');
const keyword = ref('');

const showCreate = ref(false);
const showBed = ref(false);
const showExtend = ref(false);
const saving = ref(false);
const formRef = ref<FormInst | null>(null);
const bedOptions = ref<SelectOption[]>([]);
const bedTarget = ref<Guadan | null>(null);
const bedChoice = ref<string | null>(null);
const extendDays = ref<number>(7);
const extendTarget = ref<Guadan | null>(null);

const form = ref({
  dharma_name: '',
  home_monastery: '',
  ordination_no: '',
  arrive_date: new Date().toISOString().slice(0, 10),
  expected_days: 7,
  bed_id: null as string | null,
  note: '',
});

const rules: FormRules = {
  dharma_name: { required: true, message: '请填写法名', trigger: 'blur' },
  arrive_date: { required: true, message: '请选择到寺日期', trigger: 'change' },
  expected_days: { required: true, type: 'number', min: 1, message: '预计住几天须大于 0', trigger: 'blur' },
};

async function load() {
  loading.value = true;
  try {
    const params: Record<string, string> = {};
    if (filterStatus.value) params.status = filterStatus.value;
    if (keyword.value.trim()) params.q = keyword.value.trim();
    const { data } = await http.get<Guadan[]>('/guadan', { params });
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

async function loadBeds() {
  const { data } = await http.get<AvailableBed[]>('/rooms/available-beds');
  bedOptions.value = data.map((b) => ({
    label: `${b.room_no} · ${b.bed_no} 床`,
    value: b.id,
  }));
}

function openCreate() {
  form.value = {
    dharma_name: '',
    home_monastery: '',
    ordination_no: '',
    arrive_date: new Date().toISOString().slice(0, 10),
    expected_days: 7,
    bed_id: null,
    note: '',
  };
  loadBeds();
  showCreate.value = true;
}

async function submitCreate() {
  await formRef.value?.validate();
  saving.value = true;
  try {
    await http.post('/guadan', form.value);
    message.success('挂单登记完成，欢迎法师驻锡');
    showCreate.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

function openBed(row: Guadan) {
  bedTarget.value = row;
  bedChoice.value = row.bed_id;
  loadBeds();
  showBed.value = true;
}

async function submitBed() {
  if (!bedChoice.value) {
    message.warning('请选择床位');
    return;
  }
  saving.value = true;
  try {
    await http.put(`/guadan/${bedTarget.value?.id}/bed`, { bed_id: bedChoice.value });
    message.success('床位已安排');
    showBed.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

function openExtend(row: Guadan) {
  extendTarget.value = row;
  extendDays.value = 7;
  showExtend.value = true;
}

async function submitExtend() {
  saving.value = true;
  try {
    await http.put(`/guadan/${extendTarget.value?.id}/extend`, { days: extendDays.value });
    message.success('已续单');
    showExtend.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

async function checkout(row: Guadan) {
  await http.post(`/guadan/${row.id}/checkout`, {
    leave_date: new Date().toISOString().slice(0, 10),
  });
  message.success(`${row.dharma_name} 已舍单离寺，床位已释放`);
  load();
}

const columns: DataTableColumns<Guadan> = [
  { title: '法名', key: 'dharma_name', width: 100, fixed: 'left', render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  { title: '身份', key: 'monk_status', width: 90, render: (r) => h(NTag, { size: 'small', type: MONK_STATUS_TYPE[r.monk_status], bordered: false }, { default: () => MONK_STATUS_LABEL[r.monk_status] }) },
  { title: '出家寺庙', key: 'home_monastery' },
  { title: '戒牒编号', key: 'ordination_no', width: 120 },
  { title: '到寺日期', key: 'arrive_date', width: 110 },
  { title: '预计天数', key: 'expected_days', width: 90, render: (r) => `${r.expected_days} 天` },
  { title: '预计离寺', key: 'expected_leave', width: 110 },
  {
    title: '床位',
    key: 'bed',
    width: 130,
    render: (r) => (r.room_no ? `${r.room_no} · ${r.bed_no}床` : h(NText, { type: 'warning' }, { default: () => '未安排' })),
  },
  {
    title: '操作',
    key: 'actions',
    width: 250,
    fixed: 'right',
    render: (r) => {
      if (r.status !== 'active') return h(NText, { depth: 3 }, { default: () => `已于 ${r.leave_date ?? ''} 舍单` });
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => openBed(r) }, { default: () => '床位' }),
          h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => openExtend(r) }, { default: () => '续单' }),
          h(NPopconfirm, { onPositiveClick: () => checkout(r) }, {
            trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => '舍单' }),
            default: () => `确认 ${r.dharma_name} 今日舍单离寺？`,
          }),
        ],
      });
    },
  },
];

onMounted(load);
</script>
