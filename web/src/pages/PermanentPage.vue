<template>
  <n-card size="small">
    <n-space align="center">
      <n-input
        v-model:value="keyword"
        placeholder="搜法名 / 戒牒 / 职务 / 剃度师"
        clearable
        style="width: 280px"
        @keyup.enter="load"
        @clear="load"
      >
        <template #prefix><n-icon :component="SearchOutline" /></template>
      </n-input>
      <n-button @click="load">查询</n-button>
      <n-text depth="3" style="margin-left:8px">共 {{ monks.length }} 位常住</n-text>
    </n-space>
  </n-card>

  <n-grid :cols="3" :x-gap="16" :y-gap="16" item-responsive responsive="screen" style="margin-top:16px">
    <n-grid-item v-for="m in monks" :key="m.id" span="3 m:1 l:1">
      <n-card hoverable size="small" class="monk-card" @click="openEdit(m)">
        <div class="monk-head">
          <div class="monk-seal">{{ m.dharma_name.slice(0, 1) }}</div>
          <div>
            <div class="monk-name">
              {{ m.dharma_name }}
              <n-tag v-if="m.current_post" size="small" type="primary" :bordered="false" style="margin-left:6px">
                {{ m.current_post }}
              </n-tag>
            </div>
            <div class="monk-sub">字辈：{{ m.generation ?? '—' }}</div>
          </div>
        </div>
        <n-descriptions label-placement="left" :column="1" size="small" class="monk-desc">
          <n-descriptions-item label="剃度师">{{ m.tonsure_master ?? '—' }}</n-descriptions-item>
          <n-descriptions-item label="受戒">
            {{ m.ordination_date ?? '—' }}<template v-if="m.ordination_place"> · {{ m.ordination_place }}</template>
          </n-descriptions-item>
          <n-descriptions-item label="戒牒">{{ m.ordination_no ?? '—' }}</n-descriptions-item>
          <n-descriptions-item label="出家寺庙">{{ m.home_monastery ?? '—' }}</n-descriptions-item>
        </n-descriptions>
      </n-card>
    </n-grid-item>
  </n-grid>

  <n-drawer v-model:show="showEdit" :width="520">
    <n-drawer-content :title="`常住档案 · ${editForm.dharma_name || ''}`" closable>
      <n-form :model="editForm" label-placement="left" label-width="88px">
        <n-form-item label="法名">
          <n-input v-model:value="editForm.dharma_name" />
        </n-form-item>
        <n-grid :cols="2">
          <n-grid-item>
            <n-form-item label="字辈">
              <n-input v-model:value="editForm.generation" placeholder="例：智 / 慧" />
            </n-form-item>
          </n-grid-item>
          <n-grid-item>
            <n-form-item label="担任职务">
              <n-select
                v-model:value="editForm.current_post"
                :options="postOptions"
                filterable
                tag
                clearable
              />
            </n-form-item>
          </n-grid-item>
        </n-grid>
        <n-form-item label="剃度师">
          <n-input v-model:value="editForm.tonsure_master" placeholder="例：上圆下拙" />
        </n-form-item>
        <n-form-item label="出家寺庙">
          <n-input v-model:value="editForm.home_monastery" />
        </n-form-item>
        <n-grid :cols="2">
          <n-grid-item>
            <n-form-item label="受戒时间">
              <n-date-picker
                v-model:formatted-value="editForm.ordination_date"
                value-format="yyyy-MM-dd"
                type="date"
                clearable
                style="width:100%"
              />
            </n-form-item>
          </n-grid-item>
          <n-grid-item>
            <n-form-item label="戒场">
              <n-input v-model:value="editForm.ordination_place" placeholder="例：宝华山隆昌寺" />
            </n-form-item>
          </n-grid-item>
        </n-grid>
        <n-form-item label="戒牒编号">
          <n-input v-model:value="editForm.ordination_no" />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="editForm.note" type="textarea" :autosize="{ minRows: 3 }" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space>
          <n-button @click="showEdit = false">关闭</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存档案</n-button>
        </n-space>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  NCard, NSpace, NInput, NButton, NIcon, NGrid, NGridItem, NTag, NDescriptions,
  NDescriptionsItem, NDrawer, NDrawerContent, NForm, NFormItem,
  NDatePicker, NSelect, useMessage,
} from 'naive-ui';
import type { SelectOption } from 'naive-ui';
import { SearchOutline } from '@vicons/ionicons5';
import { http, POSTS } from '../api.js';
import type { Monk } from '../types.js';

const message = useMessage();
const monks = ref<Monk[]>([]);
const keyword = ref('');
const saving = ref(false);
const showEdit = ref(false);
const editingId = ref('');
const postOptions: SelectOption[] = POSTS.map((p) => ({ label: p, value: p }));

const editForm = ref({
  dharma_name: '',
  generation: null as string | null,
  current_post: null as string | null,
  tonsure_master: null as string | null,
  home_monastery: null as string | null,
  ordination_date: null as string | null,
  ordination_place: null as string | null,
  ordination_no: null as string | null,
  note: null as string | null,
});

async function load() {
  const params: Record<string, string> = { status: 'permanent' };
  if (keyword.value.trim()) params.q = keyword.value.trim();
  const { data } = await http.get<Monk[]>('/monks', { params });
  monks.value = data;
}

function openEdit(m: Monk) {
  editingId.value = m.id;
  editForm.value = {
    dharma_name: m.dharma_name,
    generation: m.generation,
    current_post: m.current_post,
    tonsure_master: m.tonsure_master,
    home_monastery: m.home_monastery,
    ordination_date: m.ordination_date,
    ordination_place: m.ordination_place,
    ordination_no: m.ordination_no,
    note: m.note,
  };
  showEdit.value = true;
}

async function save() {
  saving.value = true;
  try {
    await http.put(`/monks/${editingId.value}`, editForm.value);
    message.success('档案已保存');
    showEdit.value = false;
    load();
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.monk-card {
  cursor: pointer;
}
.monk-head {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 10px;
}
.monk-seal {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  background: linear-gradient(135deg, #b08a54, #8c5a2e);
  color: #fff8ea;
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.monk-name {
  font-size: 16px;
  font-weight: 600;
  color: #3a2f25;
}
.monk-sub {
  font-size: 12px;
  color: #9b8f80;
  margin-top: 2px;
}
.monk-desc {
  --n-merged-label-padding: 0 8px 0 0;
}
</style>
