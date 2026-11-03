import type { Activity } from './api';

// Per-user localStorage snapshots so a reload paints instantly from the last session,
// then revalidates. Purely a speed-up: every read tolerates missing/blocked storage.
const PREFIX = 'mt:v1:';
let ns: string | null = null;

export function initPersist(userId: string) {
  ns = `${PREFIX}${userId}:`;
}

export function load<T>(key: string): T | null {
  if (!ns) return null;
  try {
    const raw = localStorage.getItem(ns + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown) {
  if (!ns) return;
  try {
    localStorage.setItem(ns + key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage blocked — the in-memory caches still work
  }
}

export function remove(key: string) {
  if (!ns) return;
  try { localStorage.removeItem(ns + key); } catch { /* ignore */ }
}

// Sign-out / disconnect / account delete: drop every user's snapshots
export function clearAll() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
  ns = null;
}

// Strava summaries carry polylines and other fields the UI never reads; keep only the
// Activity fields so the snapshots stay small.
export function slimActivity(a: Activity): Activity {
  return {
    id: a.id, name: a.name, type: a.type, sport_type: a.sport_type,
    distance: a.distance, moving_time: a.moving_time, total_elevation_gain: a.total_elevation_gain,
    start_date: a.start_date, start_date_local: a.start_date_local,
    average_heartrate: a.average_heartrate, average_speed: a.average_speed,
  };
}
