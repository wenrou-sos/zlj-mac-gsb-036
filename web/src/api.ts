import axios from 'axios';
import { createDiscreteApi } from 'naive-ui';

const { message } = createDiscreteApi(['message']);

export const http = axios.create({ baseURL: '/api', timeout: 15000 });

http.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err.response?.data?.message ?? err.message ?? '请求失败';
    message.error(msg);
    return Promise.reject(err);
  },
);

// ---- 字典常量 ----
export const MONK_STATUS_LABEL: Record<string, string> = {
  guadan: '挂单',
  inspection: '考察期',
  permanent: '常住',
  left: '已离寺',
};

export const MONK_STATUS_TYPE: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  guadan: 'info',
  inspection: 'warning',
  permanent: 'success',
  left: 'default',
};

export const ATTENDANCE_LABEL: Record<string, string> = {
  present: '随众',
  absent: '缺勤',
  leave: '请假',
};

export const ATTENDANCE_TYPE: Record<string, 'success' | 'error' | 'warning'> = {
  present: 'success',
  absent: 'error',
  leave: 'warning',
};

export const POSTS = ['方丈', '首座', '西堂', '后堂', '堂主', '知客', '维那', '典座', '僧值', '寮元', '书记', '衣钵', '汤药', '悦众'];

export const SESSION_LABEL: Record<string, string> = {
  morning: '早课',
  evening: '晚课',
};

export const ROUND_STATUS_LABEL: Record<string, string> = {
  collecting: '收评分中',
  summarized: '已阶段汇总',
};

export const SUBMISSION_LABEL: Record<string, string> = {
  normal: '按期评议',
  makeup: '缺席补评',
};

export const CONCLUSION_LABEL: Record<string, string> = {
  excellent: '优秀',
  qualified: '合格',
  unqualified: '不合格',
};

export const CONCLUSION_TYPE: Record<string, 'success' | 'warning' | 'error'> = {
  excellent: 'success',
  qualified: 'warning',
  unqualified: 'error',
};

// ---- 法会 ----
export const CEREMONY_STATUS_LABEL: Record<string, string> = {
  preparing: '备会中',
  ongoing: '进行中',
  closed: '已圆满',
};

export const CEREMONY_STATUS_TYPE: Record<string, 'default' | 'info' | 'success'> = {
  preparing: 'default',
  ongoing: 'success',
  closed: 'info',
};

export const PARTICIPANT_STATUS_LABEL: Record<string, string> = {
  registered: '已登记',
  waitlisted: '候补中',
  bed_offered: '待确认床位',
  confirmed: '已分床',
  checked_in: '已签到',
  early_left: '提前离寺',
  checked_out: '已离寺',
  no_show: '未到',
  cancelled: '已取消',
};

export const PARTICIPANT_STATUS_TYPE: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  registered: 'default',
  waitlisted: 'warning',
  bed_offered: 'warning',
  confirmed: 'info',
  checked_in: 'success',
  early_left: 'error',
  checked_out: 'default',
  no_show: 'error',
  cancelled: 'default',
};

export const IMPORT_STATUS_LABEL: Record<string, string> = {
  accepted: '已登记',
  waitlisted: '满员候补',
  duplicate: '重复',
  conflict: '撞期',
  invalid: '格式错误',
};

export const IMPORT_STATUS_TYPE: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
  accepted: 'success',
  waitlisted: 'warning',
  duplicate: 'error',
  conflict: 'error',
  invalid: 'info',
};

export const CEREMONY_EVENT_LABEL: Record<string, string> = {
  create: '创建法会',
  import: '表格导入',
  allocate: '自动分床',
  bed_change: '调床',
  waitlist_promote: '候补递补',
  offer_confirm: '确认递补',
  offer_reject: '谢绝递补',
  checkin: '签到',
  no_show: '标记未到',
  early_leave: '提前离寺',
  checkout: '离寺',
  release: '释放床位',
  release_all: '批量释放',
  cancel: '取消登记',
  close: '圆满结束',
};
