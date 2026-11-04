import type { PastPlanSummary } from './api';

const NAMED: [number, string][] = [[42.195, 'Marathon'], [21.0975, 'Half marathon'], [10, '10K'], [5, '5K']];

export function distanceLabel(km: number | null | undefined) {
  if (!km) return 'Plan';
  return NAMED.find(([d]) => Math.abs(d - km) < 0.01)?.[1] ?? `${+km.toFixed(1)} km`;
}

export function fmtPlanDate(iso: string | null | undefined, withYear = true) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}

// "Marathon · Oct 18, 2026" — the race identifies a plan better than its start date
export function pastPlanLabel(p: Pick<PastPlanSummary, 'distance_km' | 'race_date' | 'plan_end'>) {
  return `${distanceLabel(p.distance_km)} · ${fmtPlanDate(p.race_date || p.plan_end)}`;
}
