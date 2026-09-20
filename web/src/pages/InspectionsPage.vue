<template>
  <n-card size="small">
    <n-space align="center" justify="space-between">
      <n-radio-group v-model:value="resultFilter" size="medium" @update:value="load">
        <n-radio-button value="pending">考察中</n-radio-button>
        <n-radio-button value="passed">已转常住</n-radio-button>
        <n-radio-button value="failed">未通过</n-radio-button>
        <n-radio-button value="">全部</n-radio-button>
      </n-radio-group>
      <n-button type="primary" @click="openStart">
        <template #icon><n-icon :component="HourglassOutline" /></template>
        发心常住 · 转入考察
      </n-button>
    </n-space>
  </n-card>

  <n-card size="small" style="margin-top:16px">
    <n-data-table
      :columns="columns"
      :data="rows"
      :loading="loading"
      :row-key="(r: Inspection) => r.id"
      :pagination="{ pageSize: 10 }"
      striped
    />
  </n-card>

  <!-- 发起考察期 -->
  <n-modal v-model:show="showStart" preset="card" title="发心常住 · 转入考察期" style="width: 500px">
    <n-form ref="startFormRef" :model="startForm" :rules="startRules" label-placement="left" label-width="100px">
      <n-form-item label="挂单僧人" path="guadan_id">
        <n-select
          v-model:value="startForm.guadan_id"
          :options="guadanOptions"
          filterable
          placeholder="选择在寺挂单僧人"
        />
      </n-form-item>
      <n-form-item label="考察开始" path="start_date">
        <n-date-picker
          v-model:formatted-value="startForm.start_date"
          value-format="yyyy-MM-dd"
          style="width: 100%"
        />
      </n-form-item>
      <n-grid :cols="3">
        <n-grid-item>
          <n-form-item label="考察时长" path="duration_months" label-placement="top">
            <n-input-number v-model:value="startForm.duration_months" :min="3" :max="6" style="width:100%">
              <template #suffix>个月</template>
            </n-input-number>
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item label="规定评议次数" path="required_reviews" label-placement="top">
            <n-input-number v-model:value="startForm.required_reviews" :min="1" :max="6" style="width:100%">
              <template #suffix>次</template>
            </n-input-number>
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item label="羯磨达标分" path="pass_score" label-placement="top">
            <n-input-number v-model:value="startForm.pass_score" :min="0" :max="100" style="width:100%">
              <template #suffix>分</template>
            </n-input-number>
          </n-form-item>
        </n-grid-item>
      </n-grid>
      <n-form-item label="备注">
        <n-input v-model:value="startForm.note" type="textarea" :autosize="{ minRows: 2 }" placeholder="发心因缘、初步印象" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showStart = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submitStart">转入考察</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 羯磨通过（资格清单 + 决策快照） -->
  <n-modal v-model:show="showPass" preset="card" title="考察通过 · 羯磨转常住" style="width: 560px">
    <n-spin :show="checking">
      <n-form label-placement="left" label-width="92px">
        <n-form-item label="僧人">
          <n-text strong>{{ passTarget?.dharma_name }}</n-text>
        </n-form-item>
      </n-form>

      <n-text strong>发起条件核对</n-text>
      <n-list bordered style="margin:8px 0 14px">
        <n-list-item v-for="c in eligibility?.checks ?? []" :key="c.key">
          <n-space align="start" :size="10" style="width:100%">
            <n-icon :component="c.ok ? CheckmarkCircleOutline : CloseCircleOutline"
                    :color="c.ok ? '#18a058' : '#d03050'" size="18" style="margin-top:3px" />
            <div>
              <n-text :strong="!c.ok">{{ c.label }}</n-text>
              <div style="font-size:12px;color:#9b8f80">{{ c.detail }}</div>
            </div>
          </n-space>
        </n-list-item>
      </n-list>
      <n-alert v-if="eligibility && !eligibility.eligible" type="error" style="margin-bottom:12px">
        条件尚未具足，不可发起羯磨；请先完成缺席补评、阶段汇总或处理缺勤提醒。
      </n-alert>

      <n-form label-placement="left" label-width="92px">
        <n-form-item label="羯磨日期">
          <n-date-picker
            v-model:formatted-value="passForm.karma_date"
            value-format="yyyy-MM-dd"
            style="width: 100%"
            :disabled="!eligibility?.eligible"
          />
        </n-form-item>
        <n-form-item label="担任职务">
          <n-select
            v-model:value="passForm.current_post"
            :options="postOptions"
            filterable
            tag
            placeholder="知客 / 维那 / 典座等（可留空）"
            clearable
            :disabled="!eligibility?.eligible"
          />
        </n-form-item>
        <n-form-item label="羯磨备注">
          <n-input v-model:value="passForm.note" type="textarea" :autosize="{ minRows: 2 }"
                   :disabled="!eligibility?.eligible" />
        </n-form-item>
      </n-form>
      <n-text depth="3" style="font-size:12px">
        提交后将冻结历次月度评分、修订留痕与资格核对结果，生成不可变羯磨决策快照。
      </n-text>
    </n-spin>
    <template #footer>
      <n-space justify="space-between">
        <n-button @click="showPass = false">取消</n-button>
        <n-button type="primary" :loading="saving" :disabled="!eligibility?.eligible" @click="submitPass">
          羯磨成就
        </n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 决策快照查看 -->
  <n-modal v-model:show="showSnapshot" preset="card"
           :title="`羯磨决策快照 · ${snapshot?.monk_name}`" style="width:720px">
    <n-spin :show="snapshotLoading">
      <template v-if="snapshot">
        <n-descriptions bordered :column="2" size="small" label-placement="left">
          <n-descriptions-item label="羯磨日期">{{ snapshot.karma_date }}</n-descriptions-item>
          <n-descriptions-item label="担任职务">{{ snapshot.current_post ?? '—' }}</n-descriptions-item>
          <n-descriptions-item label="规定/已完成评议">
            {{ snapshot.required_reviews }} / {{ snapshot.completed_reviews }} 次
          </n-descriptions-item>
          <n-descriptions-item label="历次均分 / 达标分">
            <n-text type="success" strong>{{ snapshot.overall_avg_score }}</n-text>
            / {{ snapshot.pass_score }}
          </n-descriptions-item>
          <n-descriptions-item label="发起时缺勤待办">{{ snapshot.open_alert_count }} 件</n-descriptions-item>
          <n-descriptions-item label="发起时缺席待补">{{ snapshot.makeup_pending }} 席</n-descriptions-item>
          <n-descriptions-item label="羯磨主持">{{ snapshot.decided_by }}</n-descriptions-item>
          <n-descriptions-item label="落档时间">{{ new Date(snapshot.created_at).toLocaleString('zh-CN') }}</n-descriptions-item>
          <n-descriptions-item label="阶段总评" :span="2">
            <span style="white-space:pre-wrap">{{ snapshot.stage_summary ?? '—' }}</span>
          </n-descriptions-item>
        </n-descriptions>

        <n-text strong style="display:block;margin:14px 0 6px">资格核对（发起时）</n-text>
        <n-space>
          <n-tag v-for="c in snapshot.eligibility" :key="c.key"
                 :type="c.ok ? 'success' : 'error'" size="small">
            {{ c.label }}
          </n-tag>
        </n-space>

        <n-text strong style="display:block;margin:14px 0 6px">逐月评议归档</n-text>
        <n-table size="small" :single-line="false" :bordered="true">
          <thead>
            <tr>
              <th>月次</th><th>区间</th><th>会议</th><th>均分</th><th>结论</th>
              <th>执事评分（含补评、修订）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in snapshotRounds" :key="r.seq_no">
              <td>第 {{ r.seq_no }} 月</td>
              <td>{{ r.period_start }} ~ {{ r.period_end }}</td>
              <td>{{ r.meeting_date }}</td>
              <td>{{ r.average_score }}</td>
              <td>{{ CONCLUSION_LABEL[r.conclusion] ?? r.conclusion }}</td>
              <td>
                <n-space vertical :size="2">
                  <n-text v-for="s in r.scores" :key="s.reviewer_name" style="font-size:12px">
                    {{ s.reviewer_name }}（{{ s.reviewer_role ?? '执事' }}）：
                    <n-text strong>{{ s.score }}</n-text>
                    <n-tag v-if="s.submission_type === 'makeup'" size="tiny" type="warning">补</n-tag>
                    <n-text v-if="s.revisions.length" type="info">
                      （修订 {{ s.revisions.length }} 次）
                    </n-text>
                  </n-text>
                </n-space>
              </td>
            </tr>
          </tbody>
        </n-table>
      </template>
    </n-spin>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showSnapshot = false">关闭</n-button>
      </n-space>
    </template>
  </n-modal>

  <ReviewDrawer v-model:show="drawerShow" :inspection="drawerTarget" @changed="load" />
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NCard, NSpace, NRadioGroup, NRadioButton, NButton, NIcon, NDataTable, NModal,
  NForm, NFormItem, NSelect, NDatePicker, NInputNumber, NInput, NGrid, NGridItem,
  NTag, NPopconfirm, NText, NList, NListItem, NAlert, NSpin,
  NDescriptions, NDescriptionsItem, NTable, useMessage,
} from 'naive-ui';
import type { DataTableColumns, FormInst, FormRules, SelectOption } from 'naive-ui';
import { HourglassOutline, CheckmarkCircleOutline, CloseCircleOutline } from '@vicons/ionicons5';
import { http, POSTS, CONCLUSION_LABEL } from '../api.js';
import type { Guadan, Inspection, Eligibility, KarmaSnapshot } from '../types.js';
import ReviewDrawer from './inspection/ReviewDrawer.vue';

const message = useMessage();
const rows = ref<Inspection[]>([]);
const loading = ref(false);
const resultFilter = ref('pending');
const saving = ref(false);

const showStart = ref(false);
const showPass = ref(false);
const showSnapshot = ref(false);
const startFormRef = ref<FormInst | null>(null);
const guadanOptions = ref<SelectOption[]>([]);
const passTarget = ref<Inspection | null>(null);
const drawerShow = ref(false);
const drawerTarget = ref<Inspection | null>(null);

const checking = ref(false);
const eligibility = ref<Eligibility | null>(null);
const snapshot = ref<KarmaSnapshot | null>(null);
const snapshotLoading = ref(false);
const snapshotRounds = computed<any[]>(() => (snapshot.value?.rounds as any[]) ?? []);

const startForm = ref({
  guadan_id: null as string | null,
  start_date: new Date().toISOString().slice(0, 10),
  duration_months: 4,
  required_reviews: 4,
  pass_score: 75,
  note: '',
});
const startRules: FormRules = {
  guadan_id: { required: true, message: '请选择挂单僧人', trigger: 'change' },
  start_date: { required: true, message: '请选择开始日期', trigger: 'change' },
  duration_months: { required: true, type: 'number', min: 3, max: 6, message: '考察期为 3-6 个月', trigger: 'blur' },
};

const passForm = ref({ karma_date: new Date().toISOString().slice(0, 10), current_post: null as string | null, note: '' });
const postOptions: SelectOption[] = POSTS.map((p) => ({ label: p, value: p }));

async function load() {
  loading.value = true;
  try {
    const params = resultFilter.value ? { result: resultFilter.value } : {};
    const { data } = await http.get<Inspection[]>('/inspections', { params });
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

async function openStart() {
  startForm.value = {
    guadan_id: null,
    start_date: new Date().toISOString().slice(0, 10),
    duration_months: 4,
    required_reviews: 4,
    pass_score: 75,
    note: '',
  };
  const { data } = await http.get<Guadan[]>('/guadan', { params: { status: 'active' } });
  guadanOptions.value = data
    .filter((g) => g.monk_status === 'guadan')
    .map((g) => ({
      label: `${g.dharma_name}（${g.home_monastery ?? '出家寺庙未录'} · 到寺 ${g.arrive_date}）`,
      value: g.id,
    }));
  showStart.value = true;
}

async function submitStart() {
  await startFormRef.value?.validate();
  saving.value = true;
  try {
    await http.post('/inspections', startForm.value);
    message.success('已转入考察期，可逐月召集评议');
    showStart.value = false;
    resultFilter.value = 'pending';
    load();
  } finally {
    saving.value = false;
  }
}

async function openPass(row: Inspection) {
  passTarget.value = row;
  passForm.value = { karma_date: new Date().toISOString().slice(0, 10), current_post: null, note: '' };
  eligibility.value = null;
  showPass.value = true;
  checking.value = true;
  try {
    const { data } = await http.get<Eligibility>(`/inspections/${row.id}/eligibility`);
    eligibility.value = data;
  } finally {
    checking.value = false;
  }
}

async function submitPass() {
  saving.value = true;
  try {
    const { data } = await http.post<{ ok: boolean; snapshot_id: string }>(
      `/inspections/${passTarget.value?.id}/pass`,
      passForm.value,
    );
    message.success('羯磨成就，已转为常住并生成决策快照');
    showPass.value = false;
    void openSnapshot(data.snapshot_id, passTarget.value?.id);
    load();
  } finally {
    saving.value = false;
  }
}

async function fail(row: Inspection) {
  await http.post(`/inspections/${row.id}/fail`, { note: null });
  message.warning('考察未通过，已退回挂单身份');
  load();
}

function openReviews(row: Inspection) {
  drawerTarget.value = row;
  drawerShow.value = true;
}

async function openSnapshot(snapshotId?: string, inspectionId?: string) {
  if (!snapshotId && inspectionId) {
    const { data } = await http.get<KarmaSnapshot[]>(`/inspections/${inspectionId}/snapshots`);
    if (!data.length) {
      message.info('该考察尚无决策快照');
      return;
    }
    snapshotId = data[0].id;
  }
  if (!snapshotId) return;
  showSnapshot.value = true;
  snapshot.value = null;
  snapshotLoading.value = true;
  try {
    const { data } = await http.get<KarmaSnapshot>(`/inspections/snapshots/${snapshotId}`);
    snapshot.value = data;
  } finally {
    snapshotLoading.value = false;
  }
}

const RESULT_LABEL: Record<string, string> = { pending: '考察中', passed: '已转常住', failed: '未通过' };
const RESULT_TYPE: Record<string, 'warning' | 'success' | 'error'> = {
  pending: 'warning', passed: 'success', failed: 'error',
};

function renderProgress(r: Inspection) {
  if (r.result !== 'pending') return '—';
  return h(NText, { depth: 3 }, {
    default: () => `第 ${r.days_elapsed} 天`,
  });
}

function renderReviews(r: Inspection) {
  const done = r.completed_rounds ?? 0;
  const total = r.required_reviews;
  const type = done >= total ? 'success' : 'warning';
  const tags = [
    h(NTag, { size: 'small', type, bordered: false, style: 'margin-right:6px' },
      { default: () => `评议 ${done}/${total}` }),
  ];
  if ((r.makeup_pending ?? 0) > 0) {
    tags.push(h(NTag, { size: 'small', type: 'error', bordered: false, style: 'margin-right:6px' },
      { default: () => `缺席待补 ${r.makeup_pending}` }));
  }
  if ((r.open_alert_count ?? 0) > 0) {
    tags.push(h(NTag, { size: 'small', type: 'error', bordered: false },
      { default: () => `缺勤待办 ${r.open_alert_count}` }));
  }
  return h('div', tags);
}

function renderAvg(r: Inspection) {
  if (r.overall_avg === null || r.overall_avg === undefined) return h(NText, { depth: 3 }, { default: () => '—' });
  const ok = Number(r.overall_avg) >= r.pass_score;
  return h(NText, { type: ok ? 'success' : 'error', strong: true },
    { default: () => `${r.overall_avg} / ${r.pass_score}` });
}

const columns: DataTableColumns<Inspection> = [
  { title: '法名', key: 'dharma_name', width: 90, fixed: 'left', render: (r) => h(NText, { strong: true }, { default: () => r.dharma_name }) },
  {
    title: '状态', key: 'result', width: 90,
    render: (r) => h(NTag, { size: 'small', type: RESULT_TYPE[r.result], bordered: false }, { default: () => RESULT_LABEL[r.result] }),
  },
  { title: '开始', key: 'start_date', width: 105 },
  { title: '考察期满', key: 'expected_end', width: 105 },
  { title: '进度', key: 'days_elapsed', width: 90, render: renderProgress },
  { title: '月度评议', key: 'reviews', width: 200, render: renderReviews },
  { title: '历次均分/达标', key: 'overall_avg', width: 120, render: renderAvg },
  { title: '羯磨日期', key: 'karma_date', width: 105, render: (r) => r.karma_date ?? '—' },
  {
    title: '操作', key: 'actions', width: 230, fixed: 'right',
    render: (r) => h(NSpace, { size: 2, wrap: false }, {
      default: () => {
        const btns = [
          h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => openReviews(r) },
            { default: () => '按月评议' }),
        ];
        if (r.result === 'pending') {
          btns.push(h(NButton, { size: 'small', type: 'primary', quaternary: true, onClick: () => openPass(r) },
            { default: () => '羯磨通过' }));
          btns.push(h(NPopconfirm, { onPositiveClick: () => fail(r) }, {
            trigger: () => h(NButton, { size: 'small', type: 'error', quaternary: true }, { default: () => '不通过' }),
            default: () => `确认 ${r.dharma_name} 考察不通过？将退回挂单身份。`,
          }));
        } else if (r.result === 'passed') {
          btns.push(h(NButton, { size: 'small', quaternary: true, onClick: () => openSnapshot(undefined, r.id) },
            { default: () => '决策快照' }));
        }
        return btns;
      },
    }),
  },
];

onMounted(load);
</script>
