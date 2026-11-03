import { useCallback, useEffect, useRef, useState } from 'react';
import { type Insights, type InsightsRun } from '../lib/api';
import { loadInsights, persistedInsights } from '../lib/insightsCache';
import Splash from '../components/Splash';

// Chart palette — validated (dataviz validate_palette.js) against the card surface #1E293B.
// Planned is always blue and actual always orange, so the two read the same on every chart.
const C = {
  planned: '#3987e5',
  actual: '#d95926',
  done: '#3987e5',
  missed: '#d03b3b',
  left: '#475569',
  grid: '#2c3a4f',
  axis: '#475569',
  surface: '#1E293B',
  // Ordinal ramp for HR zones: Z1 dimmest → Z5 brightest
  zones: ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
};

function fmtPace(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function roundKm(km: number) {
  return Math.round(km * 10) / 10;
}

function titleCase(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Round an axis max up to a clean tick step
function niceScale(max: number, ticks = 4) {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(n => n * mag).find(s => s >= raw)!;
  return { max: step * Math.ceil(max / step), step };
}

// Callback ref so the observer follows the element across remounts (e.g. chart ↔ table toggle)
function useWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    observer.current = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    observer.current.observe(el);
  }, []);
  return [ref, width] as const;
}

export default function Insights({ planVersion, dataVersion }: { planVersion: number; dataVersion: number }) {
  // Last session's copy paints immediately; the fresh one replaces it when it lands
  const [data, setData] = useState<Insights | null>(() => persistedInsights());
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const today = new Date().toDateString(); // missed/left counts roll over daily
    loadInsights(`${planVersion}:${dataVersion}:${today}`)
      .then(d => { if (!cancelled) { setData(d); setError(''); } })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [planVersion, dataVersion]);

  if (error && !data) return <p style={{ color: '#F87171' }}>{error}</p>;
  if (!data) return <Splash message="Crunching your training insights…" />;

  return (
    <div style={s.page}>
      <SummaryTiles data={data} />
      <div style={s.row} className="insights-row">
        <Card title="Workouts" style={{ flex: '1 1 300px' }}>
          <WorkoutDonut data={data} />
        </Card>
        <Card title="Weekly mileage vs plan" style={{ flex: '3 1 480px' }}>
          <MileageChart weekly={data.weekly} />
        </Card>
      </div>
      <div style={s.row} className="insights-row">
        <Card title="Heart rate" style={{ flex: '3 1 480px' }}>
          <RunTrendChart
            runs={data.runs.filter(r => r.avg_hr != null)}
            value={r => r.avg_hr!}
            format={v => `${Math.round(v)} bpm`}
            empty="No heart-rate data on your runs yet."
            caption="Average heart rate per run"
          />
        </Card>
        <Card title="Training zones" style={{ flex: '2 1 320px' }}>
          <ZoneChart data={data} />
        </Card>
      </div>
      <div style={s.row} className="insights-row">
        <Card title="Pace" style={{ flex: '3 1 480px' }}>
          <RunTrendChart
            runs={data.runs.filter(r => r.pace_sec != null && r.km >= 1)}
            value={r => r.pace_sec!}
            format={v => `${fmtPace(v)} /km`}
            invert
            empty="No runs logged yet."
            caption="Average pace per run (faster is higher)"
          />
        </Card>
        <Card title="Completion by workout type" style={{ flex: '2 1 320px' }}>
          <TypeCompliance byType={data.by_type} />
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children, style }: { title: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ ...s.card, ...style }}>
      <p style={s.cardTitle}>{title}</p>
      {children}
    </section>
  );
}

// ── Headline numbers ──────────────────────────────────────────────────────────

function SummaryTiles({ data }: { data: Insights }) {
  const { workouts: w, weekly, runs } = data;
  const due = w.done + w.made_up + w.missed;
  const completion = due ? Math.round(((w.done + w.made_up) / due) * 100) : null;

  // Planned km up to today: whole past weeks plus the current week's full target
  const startedWeeks = weekly.filter(x => x.actual_km != null);
  const plannedToDate = startedWeeks.reduce((sum, x) => sum + x.planned_km, 0);
  const actualToDate = startedWeeks.reduce((sum, x) => sum + (x.actual_km ?? 0), 0);

  // Weeks on target: finished weeks that hit ≥ 90% of planned km (current week excluded — still in progress)
  const finished = weekly.filter(x => x.actual_km != null && x.week_start <= data.today && addDays(x.week_start, 6) < data.today);
  const onTarget = finished.filter(x => x.planned_km === 0 || (x.actual_km ?? 0) >= x.planned_km * 0.9).length;

  const longest = runs.reduce<InsightsRun | null>((best, r) => (!best || r.km > best.km ? r : best), null);
  const totalSec = runs.reduce((sum, r) => sum + r.moving_time, 0);
  const totalKm = runs.reduce((sum, r) => sum + r.km, 0);
  const hrRuns = runs.filter(r => r.avg_hr != null);
  const avgHr = hrRuns.length ? Math.round(hrRuns.reduce((sum, r) => sum + r.avg_hr!, 0) / hrRuns.length) : null;

  const tiles = [
    { label: 'Workouts completed', value: completion != null ? `${completion}%` : '—', sub: `${w.done + w.made_up} of ${due} due` },
    { label: 'Km run in plan', value: `${Math.round(actualToDate)}`, sub: `${Math.round(plannedToDate)} km planned to date` },
    { label: 'Weeks on target', value: finished.length ? `${onTarget}/${finished.length}` : '—', sub: '≥ 90% of planned km' },
    { label: 'Longest run', value: longest ? `${longest.km.toFixed(1)} km` : '—', sub: longest ? fmtDate(longest.date) : 'no runs yet' },
    { label: 'Average pace', value: totalKm ? fmtPace(totalSec / totalKm) : '—', sub: `per km · ${runs.length} runs` },
    { label: 'Average HR', value: avgHr ? `${avgHr}` : '—', sub: avgHr ? `bpm · max ${data.max_hr}` : 'no HR data' },
  ];

  return (
    <div style={s.tiles}>
      {tiles.map(t => (
        <div key={t.label} style={s.tile}>
          <span style={s.tileLabel}>{t.label}</span>
          <span style={s.tileValue}>{t.value}</span>
          <span style={s.tileSub}>{t.sub}</span>
        </div>
      ))}
    </div>
  );
}

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// ── Workouts done / missed / left ─────────────────────────────────────────────

function WorkoutDonut({ data }: { data: Insights }) {
  const { done, made_up, missed, left } = data.workouts;
  const [hover, setHover] = useState<number | null>(null);
  const slices = [
    { label: 'Done', value: done + made_up, color: C.done, note: made_up ? `incl. ${made_up} made up later in the week` : null },
    { label: 'Missed', value: missed, color: C.missed, note: null },
    { label: 'Left', value: left, color: C.left, note: null },
  ];
  const total = slices.reduce((sum, x) => sum + x.value, 0);
  const due = done + made_up + missed;
  const pct = due ? Math.round(((done + made_up) / due) * 100) : 0;

  const size = 180, r = 74, stroke = 22, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const gap = total > 1 ? 2 : 0; // 2px surface gap between segments
  let offset = 0;

  return (
    <div style={s.donutWrap}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${done + made_up} done, ${missed} missed, ${left} left`}>
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {slices.map((sl, i) => {
            if (!sl.value) return null;
            const len = (sl.value / total) * circ;
            const seg = (
              <circle
                key={sl.label}
                cx={cx} cy={cy} r={r} fill="none"
                stroke={sl.color}
                strokeWidth={hover === i ? stroke + 4 : stroke}
                strokeDasharray={`${Math.max(len - gap, 0.5)} ${circ}`}
                strokeDashoffset={-offset}
                style={{ cursor: 'default', transition: 'stroke-width 0.15s' }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            );
            offset += len;
            return seg;
          })}
        </g>
        <text x={cx} y={cy - 2} textAnchor="middle" style={s.donutValue}>
          {hover != null ? slices[hover].value : `${pct}%`}
        </text>
        <text x={cx} y={cy + 18} textAnchor="middle" style={s.donutLabel}>
          {hover != null ? slices[hover].label.toLowerCase() : 'completed'}
        </text>
      </svg>
      <div style={s.legendCol}>
        {slices.map((sl, i) => (
          <div key={sl.label} style={{ ...s.legendRow, opacity: hover == null || hover === i ? 1 : 0.5 }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span style={{ ...s.swatch, background: sl.color }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={s.legendText}>
                <strong style={{ color: 'var(--text)' }}>{sl.value}</strong> {sl.label.toLowerCase()}
              </span>
              {sl.note && <span style={s.legendNote}>{sl.note}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Weekly mileage: actual vs plan ────────────────────────────────────────────

function MileageChart({ weekly }: { weekly: Insights['weekly'] }) {
  // One selector: picking Weekly or Cumulative always returns to the chart
  const [view, setView] = useState<'weekly' | 'cumulative' | 'table'>('weekly');
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();

  let cumP = 0, cumA = 0;
  const rows = weekly.map(w => {
    cumP += w.planned_km;
    if (w.actual_km != null) cumA += w.actual_km;
    return { ...w, cum_planned: roundKm(cumP), cum_actual: w.actual_km != null ? roundKm(cumA) : null };
  });
  const points = rows.map(w => view === 'cumulative'
    ? { ...w, p: w.cum_planned, a: w.cum_actual }
    : { ...w, p: w.planned_km, a: w.actual_km });

  const height = 240;
  const pad = { top: 16, right: 16, bottom: 28, left: 40 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const yMax = Math.max(1, ...points.map(p => Math.max(p.p, p.a ?? 0)));
  const { max, step } = niceScale(yMax);
  const n = points.length;
  const x = (i: number) => pad.left + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  const line = (key: 'p' | 'a') => points
    .map((p, i) => (p[key] == null ? null : `${x(i)},${y(p[key] as number)}`))
    .filter(Boolean)
    .join(' ');
  const lastActual = points.reduce((last, p, i) => (p.a != null ? i : last), -1);
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(innerW / 36)));

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  }

  const hp = hover != null ? points[hover] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={s.chartToolbar}>
        <div style={s.legendInline}>
          <span style={s.legendItem}><span style={{ ...s.lineKey, background: C.planned }} />Planned</span>
          <span style={s.legendItem}><span style={{ ...s.lineKey, background: C.actual }} />Actual</span>
        </div>
        <div style={s.tabs}>
          {(['weekly', 'cumulative', 'table'] as const).map(v => (
            <button key={v} style={{ ...s.tab, ...(view === v ? s.tabActive : {}) }} onClick={() => setView(v)}>
              {v === 'weekly' ? 'Weekly' : v === 'cumulative' ? 'Cumulative' : 'Table'}
            </button>
          ))}
        </div>
      </div>

      {view === 'table' ? (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Week</th><th style={s.th}>Phase</th>
                <th style={s.thNum}>Planned km</th><th style={s.thNum}>Actual km</th>
                <th style={s.thNum}>Cum. planned</th><th style={s.thNum}>Cum. actual</th>
                <th style={s.thNum}>Runs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(w => (
                <tr key={w.week_number}>
                  <td style={s.td}>{w.week_number} · {fmtDate(w.week_start)}</td>
                  <td style={s.td}>{titleCase(w.phase)}</td>
                  <td style={s.tdNum}>{w.planned_km}</td>
                  <td style={s.tdNum}>{w.actual_km ?? '—'}</td>
                  <td style={s.tdNum}>{w.cum_planned}</td>
                  <td style={s.tdNum}>{w.cum_actual ?? '—'}</td>
                  <td style={s.tdNum}>{w.runs ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} style={{ position: 'relative', width: '100%' }}>
          {width > 0 && (
            <svg width={width} height={height} role="img" aria-label="Planned and actual km per plan week">
              {Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step).map(v => (
                <g key={v}>
                  <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? C.axis : C.grid} strokeWidth={1} />
                  <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" style={s.axisText}>{v}</text>
                </g>
              ))}
              {points.map((p, i) => (i % labelEvery === 0 || i === n - 1) && (
                <text key={p.week_number} x={x(i)} y={height - 8} textAnchor="middle" style={s.axisText}>W{p.week_number}</text>
              ))}

              <polyline points={line('p')} fill="none" stroke={C.planned} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <polyline points={line('a')} fill="none" stroke={C.actual} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {lastActual >= 0 && (
                <circle cx={x(lastActual)} cy={y(points[lastActual].a!)} r={4.5} fill={C.actual} stroke={C.surface} strokeWidth={2} />
              )}

              {hp && hover != null && (
                <g pointerEvents="none">
                  <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke={C.axis} strokeWidth={1} />
                  <circle cx={x(hover)} cy={y(hp.p)} r={4.5} fill={C.planned} stroke={C.surface} strokeWidth={2} />
                  {hp.a != null && <circle cx={x(hover)} cy={y(hp.a)} r={4.5} fill={C.actual} stroke={C.surface} strokeWidth={2} />}
                </g>
              )}
              <rect x={pad.left} y={pad.top} width={innerW} height={innerH} fill="transparent"
                onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
            </svg>
          )}
          {hp && hover != null && (
            <Tooltip x={x(hover)} containerWidth={width} top={pad.top}>
              <div style={s.ttTitle}>Week {hp.week_number} · {titleCase(hp.phase)}</div>
              <div style={s.ttSub}>{fmtDate(hp.week_start)}</div>
              <TtRow color={C.planned} label="Planned" value={`${hp.p.toFixed(1)} km`} />
              <TtRow color={C.actual} label="Actual" value={hp.a != null ? `${hp.a.toFixed(1)} km` : 'upcoming'} />
              {hp.a != null && hp.p > 0 && (
                <div style={s.ttSub}>{Math.round((hp.a / hp.p) * 100)}% of plan</div>
              )}
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-run trend (HR / pace) ─────────────────────────────────────────────────

function RunTrendChart({ runs, value, format, invert = false, empty, caption }: {
  runs: InsightsRun[];
  value: (r: InsightsRun) => number;
  format: (v: number) => string;
  invert?: boolean; // pace: lower is better, so draw it higher
  empty: string;
  caption: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();

  if (!runs.length) return <p style={s.empty}>{empty}</p>;

  const height = 200;
  const pad = { top: 16, right: 16, bottom: 28, left: 52 };
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const vals = runs.map(value);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  // Round ticks: bpm in 5/10s, pace in 15/30/60 s so labels read as clean minutes
  const steps = invert ? [5, 10, 15, 30, 60] : [2, 5, 10, 20];
  const step = steps.find(st => (hi - lo) / st <= 4) ?? steps[steps.length - 1];
  const min = Math.floor(lo / step) * step - (lo % step === 0 ? step : 0);
  const max = Math.ceil(hi / step) * step + (hi % step === 0 ? step : 0);

  // Time-based x so gaps between runs read as gaps
  const t = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const t0 = t(runs[0].date), t1 = t(runs[runs.length - 1].date);
  const x = (i: number) => pad.left + (t1 > t0 ? ((t(runs[i].date) - t0) / (t1 - t0)) * innerW : innerW / 2);
  const y = (v: number) => {
    const frac = (v - min) / (max - min);
    return pad.top + (invert ? frac : 1 - frac) * innerH;
  };
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => min + i * step);

  // 5-run rolling mean smooths out one-off efforts
  const rolling = vals.map((_, i) => {
    const win = vals.slice(Math.max(0, i - 4), i + 1);
    return win.reduce((a, b) => a + b, 0) / win.length;
  });

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = pad.left + ((e.clientX - box.left) / box.width) * innerW;
    let best = 0;
    for (let i = 1; i < runs.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  }

  const hr = hover != null ? runs[hover] : null;
  const dateTicks = [0, Math.floor((runs.length - 1) / 2), runs.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={s.chartToolbar}>
        <div style={s.legendInline}>
          <span style={s.legendItem}><span style={{ ...s.dotKey, background: C.actual }} />Each run</span>
          <span style={s.legendItem}><span style={{ ...s.lineKey, background: C.planned }} />5-run average</span>
        </div>
        <span style={s.caption}>{caption}</span>
      </div>
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={caption}>
            {ticks.map(v => (
              <g key={v}>
                <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} stroke={C.grid} strokeWidth={1} />
                <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" style={s.axisText}>{format(v).replace(/ (bpm|\/km)$/, '')}</text>
              </g>
            ))}
            {dateTicks.map(i => (
              <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === runs.length - 1 ? 'end' : 'middle'} style={s.axisText}>
                {fmtDate(runs[i].date)}
              </text>
            ))}
            <polyline
              points={rolling.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
              fill="none" stroke={C.planned} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
            />
            {runs.map((r, i) => (
              <circle key={r.id} cx={x(i)} cy={y(vals[i])} r={hover === i ? 6 : 4} fill={C.actual} stroke={C.surface} strokeWidth={2} />
            ))}
            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke={C.axis} strokeWidth={1} pointerEvents="none" />
            )}
            <rect x={pad.left} y={pad.top} width={innerW} height={innerH} fill="transparent"
              onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
          </svg>
        )}
        {hr && hover != null && (
          <Tooltip x={x(hover)} containerWidth={width} top={pad.top}>
            <div style={s.ttTitle}>{hr.name}</div>
            <div style={s.ttSub}>{fmtDate(hr.date)}{hr.planned_type ? ` · ${titleCase(hr.planned_type)}` : ' · unscheduled'}</div>
            <TtRow color={C.actual} label="This run" value={format(vals[hover])} />
            <TtRow color={C.planned} label="5-run avg" value={format(rolling[hover])} />
            <div style={s.ttSub}>{hr.km.toFixed(1)} km{hr.max_hr ? ` · max HR ${hr.max_hr}` : ''}</div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ── Time in HR zone ───────────────────────────────────────────────────────────

function ZoneChart({ data }: { data: Insights }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.zones.reduce((sum, z) => sum + z.seconds, 0);
  if (!total) return <p style={s.empty}>No heart-rate data on your runs yet.</p>;
  const maxSec = Math.max(...data.zones.map(z => z.seconds));
  const easyShare = Math.round(((data.zones[0].seconds + data.zones[1].seconds) / total) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.zones.map((z, i) => {
          const pct = Math.round((z.seconds / total) * 100);
          const range = z.min_bpm == null ? `< ${z.max_bpm}` : z.max_bpm == null ? `> ${z.min_bpm}` : `${z.min_bpm}–${z.max_bpm}`;
          return (
            <div key={z.zone} style={{ ...s.zoneRow, opacity: hover == null || hover === i ? 1 : 0.55 }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              title={`${z.runs} run${z.runs === 1 ? '' : 's'} · ${fmtDuration(z.seconds)}`}>
              <div style={s.zoneLabel}>
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>Z{z.zone} {z.name}</span>
                <span style={s.zoneRange}>{range} bpm</span>
              </div>
              <div style={s.zoneTrack}>
                <div style={{ ...s.zoneFill, width: `${(z.seconds / maxSec) * 100}%`, background: C.zones[i] }} />
              </div>
              <span style={s.zoneVal}>{hover === i ? fmtDuration(z.seconds) : `${pct}%`}</span>
            </div>
          );
        })}
      </div>
      <p style={s.note}>
        <strong style={{ color: 'var(--text)' }}>{easyShare}%</strong> of your run time was in Z1–Z2.
        {easyShare < 70 ? ' Most plans aim for ~80% easy — consider slowing your easy days.' : ' That’s a healthy easy/hard balance.'}
      </p>
      <p style={s.footnote}>
        Each run is placed by its average HR, with zones as % of max HR ({data.max_hr} bpm
        {data.max_hr_source === 'observed' ? ', the highest recorded in this plan' : ', a default — log a hard effort to calibrate'}).
      </p>
    </div>
  );
}

// ── Completion by workout type ────────────────────────────────────────────────

function TypeCompliance({ byType }: { byType: Insights['by_type'] }) {
  const rows = byType.filter(t => t.due > 0).sort((a, b) => b.due - a.due);
  if (!rows.length) return <p style={s.empty}>No workouts due yet.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map(t => {
        const pct = Math.round((t.completed / t.due) * 100);
        return (
          <div key={t.type} style={s.zoneRow} title={`${t.completed} of ${t.due} completed`}>
            <div style={s.zoneLabel}>
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{titleCase(t.type)}</span>
              <span style={s.zoneRange}>{t.completed} of {t.due}</span>
            </div>
            <div style={s.zoneTrack}>
              <div style={{ ...s.zoneFill, width: `${pct}%`, background: C.done }} />
            </div>
            <span style={s.zoneVal}>{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tooltip({ x, containerWidth, top, children }: { x: number; containerWidth: number; top: number; children: React.ReactNode }) {
  // Flip to the left of the crosshair when it would run off the right edge
  const flip = x > containerWidth - 190;
  return (
    <div style={{ ...s.tooltip, top, ...(flip ? { right: containerWidth - x + 12 } : { left: x + 12 }) }}>
      {children}
    </div>
  );
}

function TtRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={s.ttRow}>
      <span style={{ ...s.swatch, width: 8, height: 8, background: color }} />
      <span style={{ color: 'var(--text-muted)', flex: 1 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24, paddingRight: 4 },
  row: { display: 'flex', gap: 16, flexWrap: 'wrap' },
  card: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
    padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0,
  },
  cardTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 },
  tile: {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
    padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4,
  },
  tileLabel: { fontSize: 12, color: 'var(--text-muted)' },
  tileValue: { fontSize: 26, fontWeight: 600, color: 'var(--text)', lineHeight: 1.15 },
  tileSub: { fontSize: 12, color: 'var(--text-muted)' },
  donutWrap: { display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap', justifyContent: 'center', flex: 1 },
  donutValue: { fontSize: 30, fontWeight: 600, fill: 'var(--text)' },
  donutLabel: { fontSize: 12, fill: 'var(--text-muted)' },
  legendCol: { display: 'flex', flexDirection: 'column', gap: 12 },
  legendRow: { display: 'flex', alignItems: 'flex-start', gap: 10, transition: 'opacity 0.15s' },
  legendText: { fontSize: 14, color: 'var(--text-muted)' },
  legendNote: { fontSize: 11, color: 'var(--text-muted)', opacity: 0.8 },
  swatch: { width: 10, height: 10, borderRadius: 3, flexShrink: 0, marginTop: 4, display: 'inline-block' },
  chartToolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  legendInline: { display: 'flex', gap: 16, flexWrap: 'wrap' },
  legendItem: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' },
  lineKey: { width: 14, height: 2, borderRadius: 1, display: 'inline-block' },
  dotKey: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
  caption: { fontSize: 12, color: 'var(--text-muted)' },
  tabs: {
    display: 'flex', background: 'var(--surface-2)', borderRadius: 8,
    padding: 3, gap: 2, border: '1px solid var(--border)',
  },
  tab: {
    background: 'none', border: 'none', color: 'var(--text-muted)',
    fontSize: 12, fontWeight: 500, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
  },
  tabActive: { background: 'var(--surface)', color: 'var(--text)', fontWeight: 600 },
  axisText: { fontSize: 11, fill: '#94A3B8', fontVariantNumeric: 'tabular-nums' },
  tooltip: {
    position: 'absolute', pointerEvents: 'none', zIndex: 5, minWidth: 170, maxWidth: 240,
    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8,
    padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4,
    boxShadow: '0 6px 20px rgba(0,0,0,0.35)', fontSize: 12,
  },
  ttTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  ttSub: { fontSize: 11, color: 'var(--text-muted)' },
  ttRow: { display: 'flex', alignItems: 'center', gap: 6 },
  zoneRow: { display: 'flex', alignItems: 'center', gap: 12, transition: 'opacity 0.15s' },
  zoneLabel: { width: 118, flexShrink: 0, display: 'flex', flexDirection: 'column', fontSize: 13 },
  zoneRange: { fontSize: 11, color: 'var(--text-muted)' },
  zoneTrack: { flex: 1, height: 12, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' },
  zoneFill: { height: '100%', borderRadius: '0 4px 4px 0', transition: 'width 0.4s ease' },
  zoneVal: { width: 52, textAlign: 'right', fontSize: 13, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' },
  note: { fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 },
  footnote: { fontSize: 11, color: 'var(--text-muted)', opacity: 0.8, lineHeight: 1.5, margin: 0 },
  empty: { color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 24 },
  tableWrap: { maxHeight: 260, overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', padding: '6px 8px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)' },
  thNum: { textAlign: 'right', color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', padding: '6px 8px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)' },
  td: { padding: '6px 8px', color: 'var(--text)', borderBottom: '1px solid var(--surface-2)' },
  tdNum: { padding: '6px 8px', color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid var(--surface-2)' },
};
