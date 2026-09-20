// 与后端接口对应的类型定义（snake_case 与数据库一致）

export type MonkStatus = 'guadan' | 'inspection' | 'permanent' | 'left';
export type AttendanceStatus = 'present' | 'absent' | 'leave';
export type SessionType = 'morning' | 'evening';
export type InspectionResult = 'pending' | 'passed' | 'failed';
export type RoundStatus = 'collecting' | 'summarized';
export type SubmissionType = 'normal' | 'makeup';
export type ReviewConclusion = 'excellent' | 'qualified' | 'unqualified';

export interface Monk {
  id: string;
  dharma_name: string;
  home_monastery: string | null;
  ordination_no: string | null;
  generation: string | null;
  tonsure_master: string | null;
  ordination_date: string | null;
  ordination_place: string | null;
  current_post: string | null;
  note: string | null;
  status: MonkStatus;
  created_at: string;
  updated_at: string;
  room_no?: string | null;
  bed_no?: string | null;
}

export interface Guadan {
  id: string;
  monk_id: string;
  arrive_date: string;
  expected_days: number;
  bed_id: string | null;
  status: 'active' | 'closed';
  leave_date: string | null;
  note: string | null;
  dharma_name: string;
  home_monastery: string | null;
  ordination_no: string | null;
  monk_status: MonkStatus;
  room_no: string | null;
  bed_no: string | null;
  expected_leave: string;
}

export interface Bed {
  id: string;
  room_id: string;
  bed_no: string;
  monk_id: string | null;
  dharma_name: string | null;
  monk_status: MonkStatus | null;
}

export interface Room {
  id: string;
  room_no: string;
  capacity: number;
  note: string | null;
  bed_count: number;
  occupied_count: number;
  beds: Bed[];
}

export interface AvailableBed {
  id: string;
  bed_no: string;
  room_id: string;
  room_no: string;
}

export interface Inspection {
  id: string;
  monk_id: string;
  guadan_id: string;
  start_date: string;
  expected_end: string;
  result: InspectionResult;
  required_reviews: number;
  pass_score: number;
  stage_summary: string | null;
  karma_date: string | null;
  decided_at: string | null;
  note: string | null;
  dharma_name: string;
  ordination_no: string | null;
  days_elapsed: number;
  days_left?: number;
  completed_rounds?: number;
  total_rounds?: number;
  overall_avg?: number | null;
  makeup_pending?: number;
  open_alert_count?: number;
}

export interface ReviewerOption {
  id: string;
  dharma_name: string;
  current_post: string | null;
}

export interface ScoreRevision {
  id: string;
  score_id: string;
  round_id: string;
  reviewer_id: string;
  reviewer_name: string;
  old_score: number | null;
  new_score: number;
  old_comment: string | null;
  new_comment: string | null;
  reason: string;
  revised_by: string;
  revised_at: string;
  seq_no?: number;
}

export interface RoundReviewer {
  id: string;
  reviewer_id: string;
  reviewer_name: string;
  reviewer_role: string | null;
  seat_no: number;
  score_id: string | null;
  score: number | null;
  comment: string | null;
  submission_type: SubmissionType | null;
  absent_reason: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  updated_at: string | null;
  revisions: ScoreRevision[];
}

export interface ReviewRound {
  id: string;
  inspection_id: string;
  seq_no: number;
  period_start: string;
  period_end: string;
  meeting_date: string;
  status: RoundStatus;
  average_score: number | null;
  conclusion: ReviewConclusion | null;
  summary_note: string | null;
  note: string | null;
  summarized_by: string | null;
  summarized_at: string | null;
  score_count?: number;
  reviewers: RoundReviewer[];
}

export interface EligibilityCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Eligibility {
  inspection_id: string;
  result: InspectionResult;
  required_reviews: number;
  completed_reviews: number;
  total_rounds: number;
  overall_avg: number | null;
  pass_score: number;
  open_alert_count: number;
  makeup_pending: number;
  missing_reviewers: { round_id: string; seq_no: number; reviewer_name: string; reviewer_role: string | null }[];
  checks: EligibilityCheck[];
  eligible: boolean;
}

export interface StageSummary {
  required_reviews: number;
  pass_score: number;
  stage_summary: string | null;
  completed: number;
  overall_avg: number | null;
  makeup_pending: number;
  revisions: number;
  rounds: {
    seq_no: number;
    meeting_date: string;
    period_start: string;
    period_end: string;
    status: RoundStatus;
    average_score: number | null;
    conclusion: ReviewConclusion | null;
    summary_note: string | null;
    summarized_by: string | null;
    summarized_at: string | null;
    score_count: number;
    roster_count: number;
  }[];
}

export interface KarmaSnapshot {
  id: string;
  inspection_id: string;
  monk_id: string;
  monk_name: string;
  karma_date: string;
  current_post: string | null;
  required_reviews: number;
  completed_reviews: number;
  overall_avg_score: number;
  pass_score: number;
  open_alert_count: number;
  makeup_pending: number;
  stage_summary: string | null;
  rounds: unknown;
  eligibility: EligibilityCheck[];
  decided_by: string;
  note: string | null;
  created_at: string;
}

export interface AttendanceRow {
  monk_id: string;
  dharma_name: string;
  monk_status: MonkStatus;
  current_post: string | null;
  id: string | null;
  status: AttendanceStatus | null;
  note: string | null;
  recorded_by: string | null;
  updated_at: string | null;
}

export interface AttendanceSummary {
  monk_id: string;
  dharma_name: string;
  monk_status: MonkStatus;
  current_post: string | null;
  absent_count: number;
  leave_count: number;
  present_count: number;
  last_absence: string | null;
  has_open_alert: boolean;
}

export interface AbsenceAlert {
  id: string;
  monk_id: string;
  window_days: number;
  absence_count: number;
  last_absence: string;
  status: 'open' | 'acknowledged';
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
  dharma_name: string;
  monk_status: MonkStatus;
  current_post: string | null;
  room_no: string | null;
  bed_no: string | null;
}

export interface Dashboard {
  status_counts: { status: MonkStatus; n: number }[];
  attendance_today: Record<string, number>;
  open_alerts: number;
  expiring_guadan: {
    id: string; dharma_name: string; expected_leave: string; days_left: number;
  }[];
  pending_inspections: Inspection[];
  bed_usage: { total: number; occupied: number };
  today: string;
}

// ---------------- 大型法会 ----------------
export type CeremonyStatus = 'preparing' | 'active' | 'closed';
export type ParticipantStatus =
  | 'registered' | 'waitlisted' | 'proposed'
  | 'checked_in' | 'late' | 'no_show' | 'early_left' | 'left' | 'cancelled';

export interface Ceremony {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  daily_capacity: number;
  note: string | null;
  status: CeremonyStatus;
  closed_at: string | null;
  final_stats: CeremonyStats | null;
  created_at: string;
  updated_at: string;
  admitted_count?: number;
  waitlist_count?: number;
  checkedin_count?: number;
}

export interface Participant {
  id: string;
  ceremony_id: string;
  monk_id: string | null;
  dharma_name: string;
  home_monastery: string | null;
  ordination_no: string | null;
  group_key: string;
  arrive_date: string;
  leave_date: string;
  actual_leave_date: string | null;
  special_need: string | null;
  status: ParticipantStatus;
  checkin_at: string | null;
  note: string | null;
  room_no: string | null;
  bed_no: string | null;
}

export interface ImportResultRow {
  line_no: number;
  dharma_name: string;
  ordination_no: string | null;
  arrive_date: string;
  leave_date: string;
  participant_id?: string;
  result: 'ok' | 'waitlisted' | 'error';
  code?: 'duplicate' | 'conflict' | 'capacity' | 'invalid';
  message: string;
}

export interface ImportResponse {
  batch_no: number;
  total: number;
  imported: number;
  waitlisted: number;
  errors: number;
  results: ImportResultRow[];
}

export interface CeremonyStats {
  admitted: number;
  arrived: number;
  no_show: number;
  waitlisted: number;
  arrival_rate: number;
  bed_peak: number;
  daily: { day: string; present: number; admitted: number; beds_used: number }[];
}

export interface CeremonyLog {
  id: string;
  ceremony_id: string;
  participant_id: string | null;
  batch_no: number | null;
  action: string;
  detail: Record<string, unknown>;
  operator: string;
  created_at: string;
  dharma_name: string | null;
}

export interface CeremonyBed {
  bed_id: string;
  bed_no: string;
  room_id: string;
  room_no: string;
}
