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

export const CEREMONY_STATUS_LABEL: Record<string, string> = {
  preparing: '筹备中',
  active: '进行中',
  closed: '已圆满',
};

export const CEREMONY_STATUS_TYPE: Record<string, 'default' | 'success' | 'info'> = {
  preparing: 'default',
  active: 'success',
  closed: 'info',
};

export const PARTICIPANT_STATUS_LABEL: Record<string, string> = {
  registered: '已登记',
  waitlisted: '候补中',
  proposed: '待确认',
  checked_in: '已签到',
  late: '迟到',
  no_show: '未到',
  early_left: '提前离寺',
  left: '已离寺',
  cancelled: '已取消',
};

export const PARTICIPANT_STATUS_TYPE: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  registered: 'info',
  waitlisted: 'warning',
  proposed: 'warning',
  checked_in: 'success',
  late: 'warning',
  no_show: 'error',
  early_left: 'default',
  left: 'default',
  cancelled: 'default',
};
