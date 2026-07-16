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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
    stats: () => request<AthleteStats>('/training/stats'),
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
    deletePlan: () => request<{ ok: boolean }>('/training/plan', { method: 'DELETE' }),
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
    updateSummaries: (body: { initial?: boolean; last_activity_id?: string | number; force?: boolean } = {}) =>
      request<{ ok: boolean; skipped?: boolean; week_summary?: string; plan_summary?: string }>(
        '/training/update-summaries', { method: 'POST', body: JSON.stringify(body) }),
  },
};
