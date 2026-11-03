import { api, type Insights } from './api';
import * as persist from './persist';

// Kept outside Insights.tsx so the Dashboard can invalidate it without importing the
// (lazy-loaded) chart code. The in-memory promise survives tab switches; the persisted
// copy paints instantly on reload while a fresh one loads.
let cache: { key: string; promise: Promise<Insights> } | null = null;

export function persistedInsights(): Insights | null {
  return persist.load<Insights>('insights');
}

// `key` covers everything the result depends on: plan version, activity data version, today
export function loadInsights(key: string): Promise<Insights> {
  if (cache?.key === key) return cache.promise;
  const promise = api.training.insights().then(d => {
    persist.save('insights', d);
    return d;
  });
  cache = { key, promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
  return promise;
}

export function invalidateInsights() {
  cache = null;
  persist.remove('insights');
}
