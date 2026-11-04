const TOKEN_KEY = 'mt_token';

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

const clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // The server clock is UTC in production; "today" must be resolved in the
      // runner's zone so an evening run doesn't land on the next training day.
      'X-Client-Timezone': clientTimezone,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json();
}

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  hasStrava: boolean;
}

export interface Activity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  total_elevation_gain: number;
  start_date: string;
  start_date_local?: string;
  average_heartrate?: number;
  average_speed: number;
}

export interface MarathonPlan {
  user_id: string;
  distance_km: number;
  race_date: string;
  goal_time: string;
  goal_pace: string;
  weekly_km?: number;
  days_per_week?: number;
  running_days?: string[];
  long_run_day?: string;
  experience?: string;
  training_style?: string;
  notes?: string;
  week_summary?: string;
  plan_summary?: string;
  last_processed_activity_id?: string;
  created_at: number;
  updated_at: number;
}

export interface Workout {
  date: string;
  day: string;
  type: string;
  km: number;
  description: string;
}

export interface TrainingWeek {
  user_id: string;
  week_number: number;
  week_start: string;
  week_end: string;
  phase: string;
  total_km: number;
  workouts: Workout[];
}

export interface RunReview {
  user_id: string;
  activity_id: string;
  activity_name?: string;
  activity_date?: string;
  summary?: string;
  review_text: string;
  generated_at: number;
}

export interface AthleteStats {
  recent_run_totals: { count: number; distance: number; moving_time: number };
  ytd_run_totals: { count: number; distance: number; moving_time: number };
  all_run_totals: { count: number; distance: number; moving_time: number };
}

export interface InsightsRun {
  id: string;
  date: string;
  name: string;
  km: number;
  moving_time: number;
  pace_sec: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_m: number;
  planned_type: string | null;
}

export interface Insights {
  today: string;
  plan_start: string;
  plan_end: string;
  total_weeks: number;
  workouts: { done: number; made_up: number; missed: number; left: number };
  by_type: { type: string; due: number; completed: number }[];
  weekly: { week_number: number; week_start: string; phase: string; planned_km: number; actual_km: number | null; runs: number | null }[];
  runs: InsightsRun[];
  max_hr: number;
  max_hr_source: 'observed' | 'default';
  zones: { zone: number; name: string; min_bpm: number | null; max_bpm: number | null; seconds: number; runs: number }[];
}

// A finished or replaced plan, as listed (GET /training/past-plans)
export interface PastPlanSummary {
  id: number;
  distance_km: number | null;
  race_date: string | null;
  goal_time: string | null;
  goal_pace: string | null;
  plan_start: string;
  plan_end: string;
  archived_on: string | null;
  archived_at: number;
}

export interface PastPlan {
  id: number;
  overview: Partial<MarathonPlan>;
  weeks: TrainingWeek[];
  plan_start: string;
  plan_end: string;
  archived_on: string | null;
  archived_at: number;
}

export interface Bootstrap {
  plan: MarathonPlan | null;
  weeks: TrainingWeek[];
  reviews: RunReview[];
  recent_activities: Activity[];
}

export interface SyncResult {
  ok: boolean;
  changed: boolean;
  version: number;
  newest_id: string | null;
}

export const api = {
  auth: {
    googleSignIn: (credential: string) =>
      request<{ token: string; user: User }>('/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential }),
      }),
    me: () => request<User>('/auth/me'),
    disconnectStrava: () => request<void>('/auth/strava', { method: 'DELETE' }),
    deleteAccount: () => request<void>('/auth/account', { method: 'DELETE' }),
  },
  training: {
    activities: (params: { page?: number; per_page?: number; before?: number; after?: number } = {}) => {
      const q = new URLSearchParams({ page: String(params.page ?? 1), per_page: String(params.per_page ?? 20) });
      if (params.before) q.set('before', String(params.before));
      if (params.after) q.set('after', String(params.after));
      return request<Activity[]>(`/training/activities?${q}`);
    },
    bootstrap: () => request<Bootstrap>('/training/bootstrap'),
    sync: () => request<SyncResult>('/training/sync', { method: 'POST' }),
    stats: () => request<AthleteStats>('/training/stats'),
    insights: (planId?: number) =>
      request<Insights>(`/training/insights${planId != null ? `?plan=${planId}` : ''}`),
    pastPlans: () => request<PastPlanSummary[]>('/training/past-plans'),
    pastPlan: (id: number) => request<PastPlan>(`/training/past-plans/${id}`),
    deletePastPlan: (id: number) => request<{ ok: boolean }>(`/training/past-plans/${id}`, { method: 'DELETE' }),
    getPlan: () => request<MarathonPlan>('/training/plan'),
    savePlan: (body: { distance_km: number; race_date: string; goal_time: string; goal_pace: string; weekly_km?: number; days_per_week?: number; running_days?: string[]; long_run_day?: string; experience?: string; training_style?: string; notes?: string }) =>
      request<{ ok: boolean }>('/training/plan', { method: 'POST', body: JSON.stringify(body) }),
    generatePlan: () =>
      request<{ ok: boolean; weeks: number }>('/training/generate-plan', { method: 'POST' }),
    reviseGoal: (goal_time: string) =>
      request<{ ok: boolean; weeks: number }>('/training/revise-goal', { method: 'POST', body: JSON.stringify({ goal_time }) }),
    uploadPlan: (body: { image_base64: string; media_type: string; distance_km: number; race_date: string; goal_time?: string; goal_pace?: string }) =>
      request<{ ok: boolean; weeks: number }>('/training/upload-plan', { method: 'POST', body: JSON.stringify(body) }),
    saveSummaries: (body: { week_summary?: string; plan_summary?: string }) =>
      request<{ ok: boolean }>('/training/plan', { method: 'PATCH', body: JSON.stringify(body) }),
    // Clears the current plan for a new one: finished → Past plans, unfinished → deleted
    endPlan: () =>
      request<{ ok: boolean; archived: number | null; deleted: boolean }>('/training/plan/end', { method: 'POST' }),
    weeks: () => request<TrainingWeek[]>('/training/weeks'),
    getReview: (activityId: number | string) =>
      request<RunReview>(`/training/review/${activityId}`),
    saveReview: (activityId: number | string, body: { review_text: string; activity_name?: string; activity_date?: string }) =>
      request<{ ok: boolean }>(`/training/review/${activityId}`, { method: 'POST', body: JSON.stringify(body) }),
    allReviews: () => request<RunReview[]>('/training/reviews'),
    generateReview: (activityId: number | string, opts: { refresh?: boolean } = {}) =>
      request<{ ok: boolean; cached?: boolean; review: RunReview }>(
        `/training/review/${activityId}/generate${opts.refresh ? '?refresh=1' : ''}`,
        { method: 'POST' }),
    updateSummaries: (body: { initial?: boolean; force?: boolean } = {}) =>
      request<{ ok: boolean; skipped?: boolean; week_summary?: string; plan_summary?: string }>(
        '/training/update-summaries', { method: 'POST', body: JSON.stringify(body) }),
  },
};
