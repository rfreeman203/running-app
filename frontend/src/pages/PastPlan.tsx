import { useEffect, useState } from 'react';
import { api, type PastPlan as PastPlanData, type PastPlanSummary } from '../lib/api';
import { distanceLabel, fmtPlanDate } from '../lib/plans';
import Insights from './Insights';

// Read-only view of a finished plan: its details, final AI summary and insights
export default function PastPlan({ plan, dataVersion, hasCurrentPlan, onBack, onDeleted }: {
  plan: PastPlanSummary;
  dataVersion: number;
  hasCurrentPlan: boolean;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<PastPlanData | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    api.training.pastPlan(plan.id).then(d => { if (!cancelled) setDetail(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [plan.id]);

  async function remove() {
    setDeleting(true);
    setError('');
    try {
      await api.training.deletePastPlan(plan.id);
      onDeleted();
    } catch (err: any) {
      setError(err.message);
      setDeleting(false);
    }
  }

  const ov = detail?.overview;
  const facts = [
    plan.race_date && `Race ${fmtPlanDate(plan.race_date)}`,
    plan.goal_time && `Goal ${plan.goal_time}${plan.goal_pace ? ` (${plan.goal_pace} /km)` : ''}`,
    `${fmtPlanDate(plan.plan_start)} – ${fmtPlanDate(plan.plan_end)}`,
  ].filter(Boolean);

  const header = (
    <>
      <div style={s.bar}>
        <button style={s.backBtn} onClick={onBack}>‹ {hasCurrentPlan ? 'Current plan' : 'Back'}</button>
        {confirmDelete ? (
          <div style={s.confirm}>
            <span style={s.confirmText}>Delete this plan from history?</span>
            <button style={s.ghostBtn} onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
            <button style={s.dangerBtn} onClick={remove} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete'}</button>
          </div>
        ) : (
          <button style={s.ghostBtn} onClick={() => setConfirmDelete(true)}>Delete plan</button>
        )}
      </div>
      {error && <p style={{ color: '#F87171', margin: 0 }}>{error}</p>}
      <section style={s.card}>
        <div style={s.titleRow}>
          <h2 style={s.title}>{distanceLabel(plan.distance_km)}</h2>
          <span style={s.badge}>Completed</span>
        </div>
        <p style={s.facts}>{facts.join(' · ')}</p>
        {ov?.plan_summary && <p style={s.summary}>{ov.plan_summary}</p>}
      </section>
    </>
  );

  return <Insights planVersion={0} dataVersion={dataVersion} planId={plan.id} header={header} />;
}

const s: Record<string, React.CSSProperties> = {
  bar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  backBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8,
    padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  ghostBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 8,
    padding: '6px 12px', fontSize: 13, cursor: 'pointer',
  },
  dangerBtn: {
    background: '#7F1D1D', border: '1px solid #B91C1C', color: '#FECACA', borderRadius: 8,
    padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  confirm: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  confirmText: { fontSize: 13, color: 'var(--text-muted)' },
  card: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
    padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 8,
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text)' },
  badge: {
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px',
  },
  facts: { margin: 0, fontSize: 13, color: 'var(--text-muted)' },
  summary: { margin: '4px 0 0', fontSize: 14, color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap' },
};
