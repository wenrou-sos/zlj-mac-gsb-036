<template>
  <n-spin :show="loading">
    <n-space align="center" justify="space-between" style="margin-bottom:16px">
      <n-text depth="3">云水寮与寮房一览，床位可记录在寺僧人入住情况</n-text>
      <n-button type="primary" @click="openAdd">
        <template #icon><n-icon :component="AddOutline" /></template>
        新增寮房
      </n-button>
    </n-space>

    <n-grid :cols="4" :x-gap="16" :y-gap="16" item-responsive responsive="screen">
      <n-grid-item v-for="room in rooms" :key="room.id" span="4 m:2 l:1">
        <n-card :title="room.room_no" size="small">
          <template #header-extra>
            <n-tag size="small" :type="room.occupied_count >= room.bed_count ? 'error' : 'success'" :bordered="false">
              {{ room.occupied_count }}/{{ room.bed_count }}
            </n-tag>
          </template>
          <div v-if="room.note" class="room-note">{{ room.note }}</div>
          <div class="bed-grid">
            <div
              v-for="bed in room.beds"
              :key="bed.id"
              class="bed-item"
              :class="{ occupied: bed.monk_id }"
            >
              <div class="bed-no">{{ bed.bed_no }}床</div>
              <div class="bed-who">
                <template v-if="bed.dharma_name">
                  <n-tag
                    size="small"
                    :type="MONK_STATUS_TYPE[bed.monk_status ?? '']"
                    :bordered="false"
                    style="margin-right:4px"
                  >
                    {{ MONK_STATUS_LABEL[bed.monk_status ?? ''] }}
                  </n-tag>
                  {{ bed.dharma_name }}
                </template>
                <n-text v-else depth="3">空闲</n-text>
              </div>
            </div>
          </div>
          <template #footer v-if="room.occupied_count === 0">
            <n-popconfirm @positive-click="removeRoom(room.id)">
              <template #trigger>
                <n-button size="tiny" quaternary type="error">删除空房</n-button>
              </template>
              确认删除寮房 {{ room.room_no }}？
            </n-popconfirm>
          </template>
        </n-card>
      </n-grid-item>
    </n-grid>

    <n-modal v-model:show="showAdd" preset="card" title="新增寮房" style="width: 400px">
      <n-form ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="80px">
        <n-form-item label="房间号" path="room_no">
          <n-input v-model:value="form.room_no" placeholder="例：东单3号 / 静修楼205" />
        </n-form-item>
        <n-form-item label="床位数" path="capacity">
          <n-input-number v-model:value="form.capacity" :min="1" :max="20" style="width:100%" />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="form.note" placeholder="例：云水寮 / 寮元安排" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showAdd = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitAdd">建立</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-spin>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  NSpin, NGrid, NGridItem, NCard, NButton, NIcon, NTag, NText, NModal, NForm,
  NFormItem, NInput, NInputNumber, NSpace, NPopconfirm, useMessage,
} from 'naive-ui';
import type { FormInst, FormRules } from 'naive-ui';
import { AddOutline } from '@vicons/ionicons5';
import { http, MONK_STATUS_LABEL, MONK_STATUS_TYPE } from '../api.js';
import type { Room } from '../types.js';

const message = useMessage();
const rooms = ref<Room[]>([]);
const loading = ref(false);
const showAdd = ref(false);
const saving = ref(false);
const formRef = ref<FormInst | null>(null);
const form = ref({ room_no: '', capacity: 2, note: '' });
const rules: FormRules = {
  room_no: { required: true, message: '请填写房间号', trigger: 'blur' },
  capacity: { required: true, type: 'number', min: 1, message: '至少 1 个床位', trigger: 'blur' },
};

async function load() {
  loading.value = true;
  try {
    const { data } = await http.get<Room[]>('/rooms');
    rooms.value = data;
  } finally {
    loading.value = false;
  }
}

function openAdd() {
  form.value = { room_no: '', capacity: 2, note: '' };
  showAdd.value = true;
}

async function submitAdd() {
  await formRef.value?.validate();
  saving.value = true;
  try {
    await http.post('/rooms', form.value);
    message.success('寮房已建立，床位已自动生成');
    showAdd.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

async function removeRoom(id: string) {
  await http.delete(`/rooms/${id}`);
  message.success('已删除');
  load();
}

onMounted(load);
</script>

<style scoped>
.room-note {
  font-size: 12px;
  color: #9b8f80;
  margin-bottom: 10px;
}
.bed-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bed-item {
  border: 1px dashed #d8cbb8;
  border-radius: 6px;
  padding: 8px 10px;
  background: #fdfbf6;
  font-size: 13px;
}
.bed-item.occupied {
  border-style: solid;
  border-color: #c9b28f;
  background: #f6ecdc;
}
.bed-no {
  font-size: 12px;
  color: #9b8f80;
}
.bed-who {
  margin-top: 2px;
}
</style>
