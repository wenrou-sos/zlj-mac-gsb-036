<template>
  <n-modal
    :show="show"
    preset="card"
    :title="participant ? `安排 / 调换床位 — ${participant.dharma_name}` : '安排床位'"
    style="width:480px"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div v-if="participant">
      <n-descriptions :column="2" size="small" bordered style="margin-bottom:14px">
        <n-descriptions-item label="分组">{{ participant.group_code ?? '—' }}</n-descriptions-item>
        <n-descriptions-item label="候补序号">{{ participant.waitlist_seq ?? '—' }}</n-descriptions-item>
        <n-descriptions-item label="到寺">{{ participant.arrive_date }}</n-descriptions-item>
        <n-descriptions-item label="离寺">{{ participant.leave_date }}</n-descriptions-item>
        <n-descriptions-item label="特殊需求" :span="2">
          {{ participant.special_need || '无' }}
        </n-descriptions-item>
        <n-descriptions-item label="现床位" :span="2">
          {{ participant.room_no ? `${participant.room_no} · ${participant.bed_no}床` : '未安排' }}
          <n-tag v-if="participant.stay_status === 'held'" size="tiny" type="warning" style="margin-left:6px">
            待知客确认
          </n-tag>
        </n-descriptions-item>
      </n-descriptions>
      <n-form label-placement="left" label-width="72px">
        <n-form-item label="床位">
          <n-select
            v-model:value="bedId"
            :options="bedOptions"
            filterable
            placeholder="选择区间内可用床位"
            :loading="loadingBeds"
          />
        </n-form-item>
        <n-form-item label="入住区间">
          <n-date-picker
            v-model:formatted-value="stayStart"
            value-format="yyyy-MM-dd"
            type="date"
            :is-date-disabled="(d: number) => !inRange(d)"
            style="width:calc(50% - 4px)"
          />
          <span style="margin:0 4px">~</span>
          <n-date-picker
            v-model:formatted-value="stayEnd"
            value-format="yyyy-MM-dd"
            type="date"
            :is-date-disabled="(d: number) => !inRange(d)"
            style="width:calc(50% - 4px)"
          />
        </n-form-item>
      </n-form>
      <n-text depth="3" style="font-size:12px">
        仅显示现有常住/挂单未入住、且与其他临时人员区间不重叠的床位；候补人员手工分床后仍需在名册中确认。
      </n-text>
    </div>
    <template #footer>
      <n-space justify="end">
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submit">确定</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  NModal, NDescriptions, NDescriptionsItem, NForm, NFormItem, NSelect,
  NDatePicker, NButton, NSpace, NTag,
} from 'naive-ui';
import type { SelectOption } from 'naive-ui';
import { http } from '../../api.js';
import type { AvailableCeremonyBed, CeremonyParticipant } from '../../types.js';

const props = defineProps<{ show: boolean; ceremonyId: string; participant: CeremonyParticipant | null }>();
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'saved'): void }>();

const bedId = ref<string | null>(null);
const stayStart = ref<string | null>(null);
const stayEnd = ref<string | null>(null);
const bedOptions = ref<SelectOption[]>([]);
const loadingBeds = ref(false);
const saving = ref(false);

function inRange(d: number) {
  if (!props.participant) return true;
  const day = new Date(d).toISOString().slice(0, 10);
  return day >= props.participant.arrive_date && day <= props.participant.leave_date;
}

watch(
  () => [props.show, props.participant],
  async ([s]) => {
    if (!s || !props.participant) return;
    bedId.value = null;
    stayStart.value = props.participant.arrive_date;
    stayEnd.value = props.participant.leave_date;
    loadingBeds.value = true;
    try {
      const { data } = await http.get<AvailableCeremonyBed[]>(
        `/ceremonies/${props.ceremonyId}/available-beds`,
        { params: { start: props.participant.arrive_date, end: props.participant.leave_date } },
      );
      bedOptions.value = data.map((b) => ({
        label: `${b.room_no} · ${b.bed_no} 床`,
        value: b.id,
      }));
    } finally {
      loadingBeds.value = false;
    }
  },
);

async function submit() {
  if (!bedId.value || !stayStart.value || !stayEnd.value) return;
  saving.value = true;
  try {
    await http.put(`/ceremonies/${props.ceremonyId}/participants/${props.participant!.id}/bed`, {
      bed_id: bedId.value,
      stay_start: stayStart.value,
      stay_end: stayEnd.value,
    });
    emit('update:show', false);
    emit('saved');
  } finally {
    saving.value = false;
  }
}
</script>
