import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: () => import('./pages/DashboardPage.vue'), meta: { title: '客堂总览' } },
    { path: '/guadan', name: 'guadan', component: () => import('./pages/GuadanPage.vue'), meta: { title: '挂单登记' } },
    { path: '/rooms', name: 'rooms', component: () => import('./pages/RoomsPage.vue'), meta: { title: '寮房床位' } },
    { path: '/inspections', name: 'inspections', component: () => import('./pages/InspectionsPage.vue'), meta: { title: '考察与常住' } },
    { path: '/permanent', name: 'permanent', component: () => import('./pages/PermanentPage.vue'), meta: { title: '常住档案' } },
    { path: '/attendance', name: 'attendance', component: () => import('./pages/AttendancePage.vue'), meta: { title: '早晚课考勤' } },
    { path: '/alerts', name: 'alerts', component: () => import('./pages/AlertsPage.vue'), meta: { title: '缺勤提醒' } },
  ],
});

export default router;
