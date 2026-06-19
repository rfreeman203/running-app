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
  average_heartrate?: number;
  average_speed: number;
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
  },
};
