<template>
  <n-config-provider :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-dialog-provider>
        <n-layout has-sider class="app-layout">
          <n-layout-sider
            bordered
            show-trigger="bar"
            collapse-mode="width"
            :collapsed-width="64"
            :width="220"
            :collapsed="collapsed"
            @collapse="collapsed = true"
            @expand="collapsed = false"
          >
            <div class="brand" :class="{ collapsed }">
              <span class="brand-seal">禪</span>
              <span v-if="!collapsed" class="brand-text">
                僧众挂单<br /><small>与常住管理</small>
              </span>
            </div>
            <n-menu
              :collapsed="collapsed"
              :collapsed-width="64"
              :collapsed-icon-size="20"
              :options="menuOptions"
              :value="activeKey"
              @update:value="go"
            />
          </n-layout-sider>

          <n-layout>
            <n-layout-header bordered class="app-header">
              <div class="header-title">{{ currentTitle }}</div>
              <n-badge :value="openAlerts" :max="99" :show="openAlerts > 0" type="error">
                <n-button quaternary circle @click="router.push('/alerts')">
                  <template #icon><n-icon :component="NotificationsOutline" :size="20" /></template>
                </n-button>
              </n-badge>
            </n-layout-header>
            <n-layout-content class="app-content" content-style="padding: 20px 24px 40px;">
              <router-view />
            </n-layout-content>
          </n-layout>
        </n-layout>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import type { Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NConfigProvider, NMessageProvider, NDialogProvider, NLayout, NLayoutSider, NLayoutHeader,
  NLayoutContent, NMenu, NButton, NBadge, NIcon, zhCN, dateZhCN,
} from 'naive-ui';
import type { MenuOption } from 'naive-ui';
import {
  HomeOutline, DocumentTextOutline, BedOutline, TimerOutline, PeopleOutline,
  CalendarNumberOutline, NotificationsOutline,
} from '@vicons/ionicons5';
import { http } from './api.js';

const router = useRouter();
const route = useRoute();
const collapsed = ref(false);
const openAlerts = ref(0);
let timer: number | undefined;

async function fetchOpenCount() {
  try {
    const { data } = await http.get<{ n: number }>('/alerts/open-count');
    openAlerts.value = data.n;
  } catch {
    /* 忽略轮询错误 */
  }
}

onMounted(() => {
  fetchOpenCount();
  timer = window.setInterval(fetchOpenCount, 30_000);
});
onUnmounted(() => window.clearInterval(timer));

const icon = (component: Component) => () => h(NIcon, null, { default: () => h(component) });

const menuOptions = computed<MenuOption[]>(() => [
  { label: '客堂总览', key: '/', icon: icon(HomeOutline) },
  { label: '挂单登记', key: '/guadan', icon: icon(DocumentTextOutline) },
  { label: '寮房床位', key: '/rooms', icon: icon(BedOutline) },
  { label: '考察与常住', key: '/inspections', icon: icon(TimerOutline) },
  { label: '常住档案', key: '/permanent', icon: icon(PeopleOutline) },
  { label: '早晚课考勤', key: '/attendance', icon: icon(CalendarNumberOutline) },
  {
    label: () =>
      h('span', { style: 'display:flex;align-items:center;gap:8px;' }, [
        h('span', '缺勤提醒'),
        openAlerts.value > 0
          ? h(NBadge, { value: openAlerts.value, max: 99, type: 'error', size: 'small' })
          : null,
      ]),
    key: '/alerts',
    icon: icon(NotificationsOutline),
  },
]);

const activeKey = computed(() => route.path);
const currentTitle = computed(() => (route.meta.title as string) ?? '');

function go(key: string) {
  router.push(key);
}

const themeOverrides = {
  common: {
    primaryColor: '#8c5a2e',
    primaryColorHover: '#a67141',
    primaryColorPressed: '#704621',
    primaryColorSuppl: '#8c5a2e',
    borderRadius: '6px',
    fontFamily:
      '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif',
  },
  Layout: { color: '#f7f4ee', siderColor: '#2e241c', headerColor: '#fffdf8' },
  Menu: {
    itemTextColor: '#d8cbb8',
    itemIconColor: '#d8cbb8',
    itemColorActive: '#4a3a2c',
    itemTextColorActive: '#f3e6d2',
    itemColorActiveHover: '#564535',
    itemColorHover: '#3a2f25',
    itemTextColorHover: '#f3e6d2',
    itemIconColorHover: '#f3e6d2',
    borderRadius: '6px',
  },
};
</script>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}
.app-layout {
  height: 100vh;
}
.brand {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  color: #f3e6d2;
}
.brand.collapsed {
  padding: 0 20px;
}
.brand-seal {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 6px;
  background: linear-gradient(135deg, #b08a54, #8c5a2e);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  color: #fff8ea;
}
.brand-text {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
}
.brand-text small {
  font-weight: 400;
  font-size: 11px;
  opacity: 0.75;
}
.app-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
}
.header-title {
  font-size: 17px;
  font-weight: 600;
  color: #3a2f25;
}
.app-content {
  height: calc(100vh - 56px);
}
</style>
