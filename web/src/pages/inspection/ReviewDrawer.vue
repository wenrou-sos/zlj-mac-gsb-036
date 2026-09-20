<template>
  <n-drawer :show="show" :width="780" @update:show="(v: boolean) => emit('update:show', v)">
    <n-drawer-content closable>
      <template #header>
        <n-space align="center" :size="10">
          <n-text strong style="font-size:16px">按月评议 · {{ inspection?.dharma_name }}</n-text>
          <n-tag size="small" :bordered="false" type="warning" v-if="inspection?.result === 'pending'">考察中</n-tag>
          <n-tag size="small" :bordered="false" type="success" v-else-if="inspection?.result === 'passed'">已转常住</n-tag>
          <n-tag size="small" :bordered="false" type="error" v-else>未通过</n-tag>
        </n-space>
      </template>

      <n-spin :show="loading">
        <!-- 阶段汇总条 -->
        <n-card v-if="summary" size="small" :title="`阶段汇总（${summary.completed}/${summary.required_reviews} 次）`">
          <n-grid :cols="3" :x-gap="12">
            <n-grid-item>
              <n-statistic label="历次月度均分" :value="summary.overall_avg ?? '—'">
                <template #suffix>/ {{ summary.pass_score }} 达标</template>
              </n-statistic>
            </n-grid-item>
            <n-grid-item>
              <n-statistic label="缺席待补评" :value="summary.makeup_pending">
                <template #suffix>席</template>
              </n-statistic>
            </n-grid-item>
            <n-grid-item>
              <n-statistic label="评分修订次数" :value="summary.revisions">
                <template #suffix>次</template>
              </n-statistic>
            </n-grid-item>
          </n-grid>
          <n-divider style="margin:10px 0" />
          <n-text depth="3" style="font-size:13px">阶段总评：</n-text>
          <n-text v-if="summary.stage_summary" style="white-space:pre-wrap">{{ summary.stage_summary }}</n-text>
          <n-text v-else depth="3" style="font-style:italic">末次月度评议汇总时形成</n-text>
        </n-card>

        <n-space style="margin:14px 0" justify="space-between" align="center">
          <n-text strong style="font-size:15px">月度评议会次</n-text>
          <n-button size="small" type="primary" dashed @click="openCreateRound"
                    :disabled="inspection?.result !== 'pending'">
            + 召集下一月评议
          </n-button>
        </n-space>

        <n-empty v-if="rounds.length === 0" description="尚未召集月度评议" style="margin:30px 0" />

        <n-timeline>
          <n-timeline-item
            v-for="r in rounds"
            :key="r.id"
            :type="r.status === 'summarized' ? 'success' : 'warning'"
            :title="`第 ${r.seq_no} 月 · ${r.period_start} 至 ${r.period_end}`"
            :time="`评议会 ${r.meeting_date}`"
          >
            <n-card size="small">
              <template #header>
                <n-space align="center" :size="8">
                  <n-tag size="small" :bordered="false"
                         :type="r.status === 'summarized' ? 'success' : 'warning'">
                    {{ ROUND_STATUS_LABEL[r.status] }}
                  </n-tag>
                  <n-tag v-if="r.conclusion" size="small" :bordered="false"
                         :type="CONCLUSION_TYPE[r.conclusion]">
                    {{ CONCLUSION_LABEL[r.conclusion] }}
                  </n-tag>
                  <n-text v-if="r.average_score !== null" strong>
                    均分 {{ r.average_score }}
                  </n-text>
                  <n-text v-else depth="3" style="font-size:12px">
                    已收 {{ submittedCount(r) }}/{{ r.reviewers.length }} 票
                  </n-text>
                </n-space>
              </template>

              <!-- 执事评分表 -->
              <n-table size="small" :single-line="false" style="margin-bottom:8px">
                <thead>
                  <tr>
                    <th style="width:90px">执事</th>
                    <th style="width:70px">评分</th>
                    <th>评语</th>
                    <th style="width:150px">提交/修订</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="rv in r.reviewers" :key="rv.id">
                    <td>
                      <n-text strong>{{ rv.reviewer_name }}</n-text>
                      <n-text depth="3" style="font-size:12px">
                        {{ rv.reviewer_role ? ` · ${rv.reviewer_role}` : '' }}
                      </n-text>
                    </td>
                    <td>
                      <template v-if="rv.score !== null">
                        <n-text :type="rv.score >= (inspection?.pass_score ?? 75) ? 'success' : 'error'" strong>
                          {{ rv.score }}
                        </n-text>
                      </template>
                      <n-tag v-else size="small" type="error" :bordered="false">缺席待补</n-tag>
                    </td>
                    <td>
                      <div v-if="rv.comment" style="white-space:pre-wrap">{{ rv.comment }}</div>
                      <n-text v-else depth="3" style="font-style:italic">—</n-text>
                      <n-tooltip v-if="rv.submission_type === 'makeup'" trigger="hover">
                        <template #trigger>
                          <n-tag size="tiny" type="warning" style="margin-top:2px">缺席补评</n-tag>
                        </template>
                        {{ rv.absent_reason }}
                      </n-tooltip>
                      <n-button v-if="rv.revisions.length" text size="tiny" type="primary"
                                style="margin-left:6px" @click="openRevisions(rv)">
                        修订 {{ rv.revisions.length }} 次
                      </n-button>
                    </td>
                    <td>
                      <n-space vertical :size="2">
                        <n-button v-if="rv.score_id" size="tiny" quaternary
                                  :disabled="!canEdit(r)"
                                  @click="openRevise(r, rv)">
                          修订评语
                        </n-button>
                        <n-button v-if="!rv.score_id" size="tiny" type="warning" quaternary
                                  :disabled="!canEdit(r)"
                                  @click="openScore(r, rv, true)">
                          缺席补评
                        </n-button>
                        <n-button v-if="rv.score_id" size="tiny" quaternary
                                  :disabled="!canEdit(r)"
                                  @click="openScore(r, rv, false)">
                          修改评分
                        </n-button>
                      </n-space>
                    </td>
                  </tr>
                </tbody>
              </n-table>

              <n-text v-if="r.summary_note" depth="2" style="font-size:13px;white-space:pre-wrap">
                月度小结：{{ r.summary_note }}
              </n-text>

              <n-space style="margin-top:8px">
                <n-button size="small" type="primary"
                          v-if="r.status === 'collecting'"
                          :disabled="!canEdit(r) || submittedCount(r) === 0"
                          @click="openSummarize(r)">
                  阶段汇总
                </n-button>
                <n-button size="small" quaternary
                          v-if="r.status === 'collecting' && submittedCount(r) < r.reviewers.length"
                          @click="openScore(r, null, false)">
                  代执事录分
                </n-button>
                <n-popconfirm v-if="r.status === 'summarized'"
                              @positive-click="reopen(r)">
                  <template #trigger>
                    <n-button size="small" quaternary type="warning"
                              :disabled="inspection?.result !== 'pending'">
                      撤销汇总
                    </n-button>
                  </template>
                  撤销后可继续补录/修订评分，确认？
                </n-popconfirm>
                <n-text v-if="r.status === 'summarized'" depth="3" style="font-size:12px">
                  {{ r.summarized_by }} 于 {{ fmt(r.summarized_at) }} 汇总
                </n-text>
              </n-space>
            </n-card>
          </n-timeline-item>
        </n-timeline>
      </n-spin>
    </n-drawer-content>
  </n-drawer>

  <!-- 召集月度评议 -->
  <n-modal v-model:show="showCreate" preset="card" title="召集月度评议会" style="width:520px">
    <n-form label-placement="left" label-width="86px">
      <n-grid :cols="2">
        <n-grid-item>
          <n-form-item label="区间起">
            <n-date-picker v-model:formatted-value="roundForm.period_start"
                           value-format="yyyy-MM-dd" style="width:100%" />
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item label="区间止">
            <n-date-picker v-model:formatted-value="roundForm.period_end"
                           value-format="yyyy-MM-dd" style="width:100%" />
          </n-form-item>
        </n-grid-item>
      </n-grid>
      <n-form-item label="会议日期">
        <n-date-picker v-model:formatted-value="roundForm.meeting_date"
                       value-format="yyyy-MM-dd" style="width:100%" />
      </n-form-item>
      <n-form-item label="评议执事">
        <n-select v-model:value="roundForm.reviewer_ids" :options="reviewerOptions"
                  multiple filterable placeholder="默认全体在任执事" />
      </n-form-item>
      <n-form-item label="备注">
        <n-input v-model:value="roundForm.note" type="textarea" :autosize="{ minRows: 2 }" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showCreate = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submitCreate">召集</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 评分 / 缺席补评 -->
  <n-modal v-model:show="showScore" preset="card"
           :title="scoreForm.is_makeup ? '缺席补评' : (scoreForm.reviewer_name ? `修改评分 · ${scoreForm.reviewer_name}` : '代执事录分')"
           style="width:480px">
    <n-form label-placement="left" label-width="86px">
      <n-form-item v-if="!scoreForm.reviewer_id" label="执事">
        <n-select v-model:value="scoreForm.reviewer_id"
                  :options="unscoredOptions" filterable placeholder="选择评分执事" />
      </n-form-item>
      <n-form-item label="评分">
        <n-input-number v-model:value="scoreForm.score" :min="0" :max="100" :step="1"
                        style="width:100%">
          <template #suffix>分 / 达标 {{ inspection?.pass_score ?? 75 }}</template>
        </n-input-number>
      </n-form-item>
      <n-form-item label="评语">
        <n-input v-model:value="scoreForm.comment" type="textarea"
                 :autosize="{ minRows: 3 }" placeholder="行持、随众、道心等月内评议" />
      </n-form-item>
      <n-form-item v-if="scoreForm.is_makeup" label="缺席事由">
        <n-input v-model:value="scoreForm.absent_reason" type="textarea"
                 :autosize="{ minRows: 2 }" placeholder="如：评议会当日外出参学，归寺补评" />
      </n-form-item>
      <n-form-item label="登记人">
        <n-input v-model:value="scoreForm.submitted_by" placeholder="知客" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showScore = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submitScore">
          {{ scoreForm.is_makeup ? '补评提交' : '提交评分' }}
        </n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 评语修订（显式缘由） -->
  <n-modal v-model:show="showRevise" preset="card" title="修订评语/评分（留痕）" style="width:480px">
    <n-form label-placement="left" label-width="86px">
      <n-form-item label="执事">
        <n-text strong>{{ reviseTarget?.reviewer_name }}</n-text>
      </n-form-item>
      <n-form-item label="原评分">
        <n-text>{{ reviseTarget?.score }}</n-text>
      </n-form-item>
      <n-form-item label="新评分">
        <n-input-number v-model:value="reviseForm.score" :min="0" :max="100" style="width:100%" />
      </n-form-item>
      <n-form-item label="新评语">
        <n-input v-model:value="reviseForm.comment" type="textarea" :autosize="{ minRows: 3 }" />
      </n-form-item>
      <n-form-item label="修订缘由">
        <n-input v-model:value="reviseForm.reason" type="textarea" :autosize="{ minRows: 2 }"
                 placeholder="必填，计入修订留痕" />
      </n-form-item>
      <n-form-item label="修订人">
        <n-input v-model:value="reviseForm.revised_by" placeholder="知客" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showRevise = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submitRevise">确认修订</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 阶段汇总 -->
  <n-modal v-model:show="showSummarize" preset="card"
           :title="`第 ${summarizeTarget?.seq_no} 月 · 阶段汇总`" style="width:520px">
    <n-alert v-if="pendingMakeups.length" type="warning" style="margin-bottom:10px">
      尚有 {{ pendingMakeups.map((m) => m.reviewer_name).join('、') }} 未评分，
      须先完成缺席补评后方可汇总。
    </n-alert>
    <n-form label-placement="left" label-width="86px">
      <n-form-item label="当月均分">
        <n-text strong>{{ tempAvg ?? '—' }}</n-text>
        <n-text depth="3" style="margin-left:8px">
          （{{ submittedCount(summarizeTarget!) }} 位执事评分自动计算）
        </n-text>
      </n-form-item>
      <n-form-item label="当月结论">
        <n-radio-group v-model:value="summarizeForm.conclusion">
          <n-radio-button value="excellent">优秀</n-radio-button>
          <n-radio-button value="qualified">合格</n-radio-button>
          <n-radio-button value="unqualified">不合格</n-radio-button>
        </n-radio-group>
      </n-form-item>
      <n-form-item label="月度小结">
        <n-input v-model:value="summarizeForm.summary_note" type="textarea"
                 :autosize="{ minRows: 2 }" />
      </n-form-item>
      <n-form-item v-if="isLastRound" label="阶段总评">
        <n-input v-model:value="summarizeForm.stage_summary" type="textarea"
                 :autosize="{ minRows: 3 }"
                 placeholder="末次月度汇总：对全考察期的阶段总评，将进入羯磨决策快照" />
      </n-form-item>
      <n-form-item label="汇总人">
        <n-input v-model:value="summarizeForm.summarized_by" placeholder="知客" />
      </n-form-item>
    </n-form>
    <template #footer>
      <n-space justify="end">
        <n-button @click="showSummarize = false">取消</n-button>
        <n-button type="primary" :loading="saving"
                  :disabled="pendingMakeups.length > 0" @click="submitSummarize">
          锁定月度汇总
        </n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 修订历史 -->
  <n-modal v-model:show="showHistory" preset="card" title="评语修订留痕" style="width:600px">
    <n-timeline>
      <n-timeline-item v-for="v in historyTarget?.revisions ?? []" :key="v.id"
                       :type="v.old_score === null ? 'default' : 'info'"
                       :title="v.old_score === null ? '首次提交' : `修订：${v.old_score} → ${v.new_score}`"
                       :time="`${v.revised_by} · ${fmt(v.revised_at)}`">
        <n-text depth="3" style="font-size:13px;white-space:pre-wrap">
          {{ v.old_comment ? `原评语：${v.old_comment}` : '' }}
        </n-text>
        <div style="white-space:pre-wrap">{{ v.new_comment }}</div>
        <n-text depth="3" style="font-size:12px">缘由：{{ v.reason }}</n-text>
      </n-timeline-item>
    </n-timeline>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NDrawer, NDrawerContent, NSpin, NCard, NGrid, NGridItem, NStatistic, NDivider,
  NText, NSpace, NButton, NTag, NTimeline, NTimelineItem, NTable, NTooltip,
  NModal, NForm, NFormItem, NSelect, NDatePicker, NInputNumber, NInput,
  NRadioGroup, NRadioButton, NPopconfirm, NEmpty, NAlert, useMessage,
} from 'naive-ui';
import type { SelectOption } from 'naive-ui';
import {
  http,
  ROUND_STATUS_LABEL, CONCLUSION_LABEL, CONCLUSION_TYPE,
} from '../../api.js';
import type {
  Inspection, ReviewRound, RoundReviewer, ReviewerOption, StageSummary,
} from '../../types.js';

const props = defineProps<{ show: boolean; inspection: Inspection | null }>();
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'changed'): void;
}>();

const message = useMessage();
const loading = ref(false);
const saving = ref(false);
const rounds = ref<ReviewRound[]>([]);
const summary = ref<StageSummary | null>(null);
const reviewers = ref<ReviewerOption[]>([]);

const showCreate = ref(false);
const showScore = ref(false);
const showRevise = ref(false);
const showSummarize = ref(false);
const showHistory = ref(false);

const roundForm = ref({
  period_start: '',
  period_end: '',
  meeting_date: new Date().toISOString().slice(0, 10),
  reviewer_ids: [] as string[],
  note: '',
});
const reviewerOptions = ref<SelectOption[]>([]);

const scoreTargetRound = ref<ReviewRound | null>(null);
const scoreForm = ref({
  reviewer_id: null as string | null,
  reviewer_name: '' as string,
  score: 80,
  comment: '',
  is_makeup: false,
  absent_reason: '',
  submitted_by: '知客',
});
const unscoredOptions = computed<SelectOption[]>(() =>
  (scoreTargetRound.value?.reviewers ?? [])
    .filter((rv) => !rv.score_id)
    .map((rv) => ({ label: `${rv.reviewer_name}${rv.reviewer_role ? `（${rv.reviewer_role}）` : ''}`, value: rv.reviewer_id })),
);

const reviseTargetRound = ref<ReviewRound | null>(null);
const reviseTarget = ref<RoundReviewer | null>(null);
const reviseForm = ref({ score: 80, comment: '', reason: '', revised_by: '知客' });

const summarizeTarget = ref<ReviewRound | null>(null);
const summarizeForm = ref({
  conclusion: 'qualified' as 'excellent' | 'qualified' | 'unqualified',
  summary_note: '',
  stage_summary: '',
  summarized_by: '知客',
});
const tempAvg = ref<number | null>(null);

const historyTarget = ref<RoundReviewer | null>(null);

const isLastRound = computed(() =>
  summarizeTarget.value !== null &&
  summarizeTarget.value.seq_no >= (props.inspection?.required_reviews ?? 0),
);
const pendingMakeups = computed<RoundReviewer[]>(() =>
  (summarizeTarget.value?.reviewers ?? []).filter((rv) => !rv.score_id),
);

function canEdit(r: ReviewRound) {
  return props.inspection?.result === 'pending' && r.status === 'collecting';
}
function submittedCount(r: ReviewRound) {
  return r.reviewers.filter((rv) => rv.score_id).length;
}
function fmt(t: string | null) {
  return t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '';
}

async function load() {
  if (!props.inspection) return;
  loading.value = true;
  try {
    const [r1, r2, r3] = await Promise.all([
      http.get<ReviewRound[]>(`/reviews/inspections/${props.inspection.id}/rounds`),
      http.get<StageSummary>(`/reviews/inspections/${props.inspection.id}/summary`),
      http.get<ReviewerOption[]>('/reviews/reviewers'),
    ]);
    rounds.value = r1.data;
    summary.value = r2.data;
    reviewers.value = r3.data;
    reviewerOptions.value = r3.data.map((m) => ({
      label: `${m.dharma_name}（${m.current_post ?? '执事'}）`,
      value: m.id,
    }));
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.show, props.inspection?.id] as const,
  ([s]) => {
    if (s) load();
  },
);

function openCreateRound() {
  const base = rounds.value.length
    ? addDays(rounds.value[rounds.value.length - 1].period_end, 1)
    : props.inspection?.start_date ?? new Date().toISOString().slice(0, 10);
  const monthEnd = addDays(addMonths(base, 1), -1);
  roundForm.value = {
    period_start: base,
    period_end: monthEnd,
    meeting_date: monthEnd,
    reviewer_ids: reviewers.value.map((r) => r.id),
    note: '',
  };
  showCreate.value = true;
}

function addDays(d: string, n: number) {
  const dt = new Date(d + 'T00:00:00');
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}
function addMonths(d: string, n: number) {
  const dt = new Date(d + 'T00:00:00');
  dt.setMonth(dt.getMonth() + n);
  return dt.toISOString().slice(0, 10);
}

async function submitCreate() {
  if (!roundForm.value.period_start || !roundForm.value.period_end || !roundForm.value.meeting_date) {
    message.warning('请完整填写区间与会议日期');
    return;
  }
  saving.value = true;
  try {
    await http.post(`/reviews/inspections/${props.inspection?.id}/rounds`, roundForm.value);
    message.success('月度评议会已召集');
    showCreate.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

function openScore(r: ReviewRound, rv: RoundReviewer | null, makeup: boolean) {
  scoreTargetRound.value = r;
  scoreForm.value = rv
    ? {
        reviewer_id: rv.reviewer_id,
        reviewer_name: rv.reviewer_name,
        score: rv.score ?? 80,
        comment: rv.comment ?? '',
        is_makeup: makeup,
        absent_reason: rv.absent_reason ?? '',
        submitted_by: '知客',
      }
    : {
        reviewer_id: null,
        reviewer_name: '',
        score: 80,
        comment: '',
        is_makeup: false,
        absent_reason: '',
        submitted_by: '知客',
      };
  showScore.value = true;
}

async function submitScore() {
  if (!scoreForm.value.reviewer_id) {
    message.warning('请选择执事');
    return;
  }
  if (scoreForm.value.is_makeup && !scoreForm.value.absent_reason.trim()) {
    message.warning('缺席补评须填写缺席事由');
    return;
  }
  saving.value = true;
  try {
    await http.post(`/reviews/rounds/${scoreTargetRound.value?.id}/scores`, {
      reviewer_id: scoreForm.value.reviewer_id,
      score: scoreForm.value.score,
      comment: scoreForm.value.comment || null,
      submission_type: scoreForm.value.is_makeup ? 'makeup' : 'normal',
      absent_reason: scoreForm.value.is_makeup ? scoreForm.value.absent_reason : null,
      submitted_by: scoreForm.value.submitted_by || '知客',
    });
    message.success(scoreForm.value.is_makeup ? '缺席补评已记录' : '评分已提交');
    showScore.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

function openRevise(r: ReviewRound, rv: RoundReviewer) {
  reviseTargetRound.value = r;
  reviseTarget.value = rv;
  reviseForm.value = {
    score: rv.score ?? 80,
    comment: rv.comment ?? '',
    reason: '',
    revised_by: '知客',
  };
  showRevise.value = true;
}

async function submitRevise() {
  if (!reviseForm.value.reason.trim()) {
    message.warning('修订缘由必填');
    return;
  }
  saving.value = true;
  try {
    await http.put(`/reviews/scores/${reviseTarget.value?.score_id}/revisions`, reviseForm.value);
    message.success('评语已修订，留痕可查');
    showRevise.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

function openSummarize(r: ReviewRound) {
  summarizeTarget.value = r;
  const scored = r.reviewers.filter((rv) => rv.score !== null);
  tempAvg.value = scored.length
    ? Math.round((scored.reduce((s, rv) => s + (rv.score ?? 0), 0) / scored.length) * 100) / 100
    : null;
  summarizeForm.value = {
    conclusion: (tempAvg.value ?? 0) >= (props.inspection?.pass_score ?? 75) ? 'qualified' : 'unqualified',
    summary_note: r.summary_note ?? '',
    stage_summary: summary.value?.stage_summary ?? '',
    summarized_by: '知客',
  };
  showSummarize.value = true;
}

async function submitSummarize() {
  saving.value = true;
  try {
    await http.post(`/reviews/rounds/${summarizeTarget.value?.id}/summarize`, summarizeForm.value);
    message.success('月度阶段汇总已锁定');
    showSummarize.value = false;
    await load();
    emit('changed');
  } finally {
    saving.value = false;
  }
}

async function reopen(r: ReviewRound) {
  await http.post(`/reviews/rounds/${r.id}/reopen`);
  message.info('已撤销汇总，可继续补录/修订');
  await load();
  emit('changed');
}

function openRevisions(rv: RoundReviewer) {
  historyTarget.value = rv;
  showHistory.value = true;
}

defineExpose({ reload: load });
</script>
