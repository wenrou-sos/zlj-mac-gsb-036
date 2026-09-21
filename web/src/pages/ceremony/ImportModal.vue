<template>
  <n-modal
    :show="show"
    preset="card"
    title="表格批量导入临时僧众"
    style="width:860px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <n-space vertical size="small">
      <n-text depth="3" style="font-size:13px">
        列格式（首行表头可保留）：<n-text code>法名</n-text>、
        <n-text code>出家寺庙</n-text>、<n-text code>戒牒编号</n-text>、
        <n-text code>联系方式</n-text>、<n-text code>特殊需求</n-text>、
        <n-text code>到寺日期</n-text>、<n-text code>离寺日期</n-text>；
        支持从 Excel 直接粘贴（Tab 分隔）。日期须在法会期间。
      </n-text>
      <n-space>
        <n-button size="small" @click="fillSample">填入示例</n-button>
        <n-button size="small" @click="text = ''">清空</n-button>
        <n-text depth="3" style="font-size:12px;align-self:center">
          逐行校验：重复 / 现有挂单撞期 / 其他法会撞期 / 超接待上限（自动候补）
        </n-text>
      </n-space>
      <n-input
        v-model:value="text"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 12 }"
        placeholder="法名	出家寺庙	戒牒编号	联系方式	特殊需求	到寺日期	离寺日期"
        style="font-family:monospace;font-size:13px"
      />
      <n-space v-if="!result" justify="end">
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="loading" @click="submit">导入</n-button>
      </n-space>

      <div v-if="result">
        <n-divider style="margin:8px 0" />
        <n-space style="margin-bottom:8px">
          <n-tag type="success">已登记 {{ result.accepted_count }}</n-tag>
          <n-tag type="warning">自动候补 {{ result.waitlisted_count }}</n-tag>
          <n-tag type="error">重复 {{ result.duplicate_count }}</n-tag>
          <n-tag type="error">撞期 {{ result.conflict_count }}</n-tag>
          <n-tag type="info">格式错误 {{ result.invalid_count }}</n-tag>
          <n-text depth="3">共 {{ result.total_rows }} 行</n-text>
        </n-space>
        <n-data-table
          :columns="columns"
          :data="result.row_results"
          :row-key="(r: ImportRowResult) => r.row_no"
          :max-height="320"
          :pagination="false"
          size="small"
          striped
        />
        <n-space justify="end" style="margin-top:12px">
          <n-button @click="reset">继续导入</n-button>
          <n-button type="primary" @click="finish">完成</n-button>
        </n-space>
      </div>
    </n-space>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NModal, NSpace, NText, NButton, NInput, NTag, NDataTable, NDivider,
  useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { h } from 'vue';
import { http, IMPORT_STATUS_LABEL, IMPORT_STATUS_TYPE } from '../../api.js';
import type { ImportBatch, ImportRowResult } from '../../types.js';

const props = defineProps<{ show: boolean; ceremonyId: string }>();
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'imported'): void;
}>();
const message = useMessage();
const text = ref('');
const loading = ref(false);
const result = ref<ImportBatch | null>(null);

const columns = computed<DataTableColumns<ImportRowResult>>(() => [
  { title: '行', key: 'row_no', width: 48 },
  { title: '法名', key: 'dharma_name', width: 90 },
  { title: '戒牒编号', key: 'ordination_no', width: 120 },
  { title: '到寺', key: 'arrive_date', width: 105 },
  { title: '离寺', key: 'leave_date', width: 105 },
  {
    title: '结果',
    key: 'status',
    width: 90,
    render: (r) => h(NTag, { size: 'small', type: IMPORT_STATUS_TYPE[r.status], bordered: false }, { default: () => IMPORT_STATUS_LABEL[r.status] }),
  },
  { title: '说明', key: 'message' },
]);

// 简单 CSV/TSV 解析：支持引号包裹与引号内逗号/Tab
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i += 1; } else inQ = !inQ;
    } else if ((ch === '\t' || ch === ',') && !inQ) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseRows(): Record<string, string>[] {
  const lines = text.value.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = parseLine(lines[0]).map((h) => h.replace(/\s/g, ''));
  const hasHeader = /法名/.test(header[0]) || /姓名/.test(header[0]);
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const c = parseLine(line);
    return {
      dharma_name: c[0] ?? '',
      home_monastery: c[1] ?? '',
      ordination_no: c[2] ?? '',
      contact: c[3] ?? '',
      special_need: c[4] ?? '',
      arrive_date: c[5] ?? '',
      leave_date: c[6] ?? '',
    };
  });
}

async function submit() {
  const rows = parseRows();
  if (rows.length === 0) {
    message.warning('请粘贴导入数据');
    return;
  }
  loading.value = true;
  try {
    const { data } = await http.post<ImportBatch>(`/ceremonies/${props.ceremonyId}/import`, {
      file_name: `粘贴导入 ${new Date().toLocaleString('zh-CN')}`,
      rows,
    });
    result.value = data;
    emit('imported');
  } finally {
    loading.value = false;
  }
}

function reset() {
  result.value = null;
  text.value = '';
}

function finish() {
  result.value = null;
  text.value = '';
  emit('update:show', false);
}

function fillSample() {
  text.value = [
    '法名\t出家寺庙\t戒牒编号\t联系方式\t特殊需求\t到寺日期\t离寺日期',
    '圆持\t宁波天童寺\tJD20260901\t13900000001\t\t2026-09-25\t2026-09-27',
    '妙安\t天台国清寺\tJD20260902\t13900000002\t病弱，需下铺\t2026-09-25\t2026-09-27',
    '广钦\t厦门南普陀寺\t\t13900000003\t\t2026-09-26\t2026-09-27',
  ].join('\n');
}
</script>
