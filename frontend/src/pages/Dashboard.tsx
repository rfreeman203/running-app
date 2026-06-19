import { useEffect, useMemo, useRef, useState } from 'react';
import { api, clearToken, type Activity, type AthleteStats, type User } from '../lib/api';
import { useNavigate } from 'react-router-dom';

interface Props {
  user: User;
  onSignOut: () => void;
}

function secondsToTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function metersToKm(m: number) { return (m / 1000).toFixed(1); }
function pacePerKm(distanceM: number, seconds: number) {
  const km = distanceM / 1000;
  if (km === 0) return '—';
  const secs = seconds / km;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')} /km`;
}

export default function Dashboard({ user, onSignOut }: Props) {
  const navigate = useNavigate();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [stats, setStats] = useState<AthleteStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [view, setView] = useState<'overview' | 'calendar'>('overview');
  const [uploadedPlan, setUploadedPlan] = useState<File | null>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const planInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData(attempt = 0) {
    try {
      const [acts, st] = await Promise.all([api.training.activities(), api.training.stats()]);
      setActivities(acts);
      setStats(st);
      setLoading(false);
    } catch (err: any) {
      // Strava tokens can be briefly unresponsive right after OAuth — retry once
      if (attempt === 0) {
        setTimeout(() => loadData(1), 2000);
      } else {
        setError(err.message);
        setLoading(false);
      }
    }
  }

  // Close menu when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function signOut() {
    clearToken();
    onSignOut();
    navigate('/login');
  }

  function disconnectAndSignOut() {
    api.auth.disconnectStrava().finally(() => {
      clearToken();
      onSignOut();
      navigate('/login');
    });
  }

  function deleteAccount() {
    api.auth.deleteAccount().finally(() => {
      clearToken();
      onSignOut();
      navigate('/login');
    });
  }

  const runs = activities.filter(a => a.sport_type === 'Run' || a.type === 'Run');

  return (
    <div style={styles.page} className="page-root">
      <header style={styles.header} className="header-inner">
        {/* Single row on desktop */}
        <div style={styles.headerTopRow}>
          <div style={styles.headerLeft}>
            <span style={styles.appName}>Marathon Trainer</span>
            <span style={styles.planBadge} className="plan-badge-desktop">12 weeks left · 480 km</span>
            <nav style={styles.nav} className="nav-desktop">
              <button
                style={{ ...styles.navLink, ...(view === 'overview' ? styles.navLinkActive : {}) }}
                onClick={() => setView('overview')}
              >Overview</button>
              <button
                style={{ ...styles.navLink, ...(view === 'calendar' ? styles.navLinkActive : {}) }}
                onClick={() => setView('calendar')}
              >Calendar</button>
            </nav>
          </div>
          <div style={styles.headerRight}>
            {user.picture && (
              <img src={user.picture} alt={user.name} style={styles.avatar} referrerPolicy="no-referrer" />
            )}
            <span style={styles.userName} className="user-name">{user.name}</span>

            <div style={styles.menuWrap} ref={menuRef}>
              <button
                style={{ ...styles.iconBtn, background: menuOpen ? 'var(--surface-2)' : 'none' }}
                onClick={() => setMenuOpen(o => !o)}
                aria-label="Settings"
              >
                <SettingsIcon />
              </button>

              {menuOpen && (
                <div style={styles.dropdown}>
                  <button
                    style={styles.dropdownItem}
                    onClick={() => { setMenuOpen(false); }}
                  >
                    <span>Recreate plan</span>
                  </button>
                  <button
                    style={styles.dropdownItem}
                    onClick={() => { setMenuOpen(false); planInputRef.current?.click(); }}
                  >
                    <span>Upload running plan</span>
                  </button>
                  <div style={styles.divider} />
                  <button style={styles.dropdownItem} onClick={() => { setMenuOpen(false); signOut(); }}>
                    <span>Sign out</span>
                  </button>
                  <div style={styles.divider} />
                  <button style={{ ...styles.dropdownItem, ...styles.dangerItem }} onClick={() => { setMenuOpen(false); setConfirmDisconnect(true); }}>
                    <span>Disconnect Strava</span>
                  </button>
                  <button style={{ ...styles.dropdownItem, ...styles.dangerItem }} onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>
                    <span>Delete account</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Mobile-only second row */}
        <div style={styles.navRow} className="nav-row-mobile">
          <nav style={styles.nav}>
            <button
              style={{ ...styles.navLink, ...(view === 'overview' ? styles.navLinkActive : {}) }}
              onClick={() => setView('overview')}
            >Overview</button>
            <button
              style={{ ...styles.navLink, ...(view === 'calendar' ? styles.navLinkActive : {}) }}
              onClick={() => setView('calendar')}
            >Calendar</button>
          </nav>
          <span style={styles.navMeta}>12 weeks left · 480 km</span>
        </div>
      </header>

      <main style={{ ...styles.main, maxWidth: 'none' }} className="main-content">
        {loading && <p style={styles.muted}>Loading your training data…</p>}
        {error && <p style={{ color: '#F87171' }}>{error}</p>}

        {view === 'overview' && !loading && (
          <div style={ovStyles.grid} className="ov-grid">
            <div style={ovStyles.leftCol} className="ov-left-col">
              <ThisWeek />
              <PlanProgress />
            </div>
            <RecentRuns runs={runs} />
          </div>
        )}

        {view === 'calendar' && !loading && (
          <CalendarView />
        )}
      </main>

      {confirmDelete && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>Delete account?</h2>
            <p style={styles.modalBody}>
              This will permanently delete your account and all associated data.
              This action cannot be undone.
            </p>
            <div style={styles.modalActions}>
              <button style={styles.cancelBtn} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button style={styles.confirmBtn} onClick={deleteAccount}>
                Delete account
              </button>
            </div>
          </div>
        </div>
      )}

      <input
        ref={planInputRef}
        type="file"
        accept="image/png"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) { setUploadedPlan(file); setShowPlanModal(true); }
          e.target.value = '';
        }}
      />

      {showPlanModal && uploadedPlan && (
        <div style={styles.overlay}>
          <div style={{ ...styles.modal, maxWidth: 560 }}>
            <h2 style={styles.modalTitle}>Running plan uploaded</h2>
            <p style={styles.modalBody}>{uploadedPlan.name}</p>
            <img
              src={URL.createObjectURL(uploadedPlan)}
              alt="Running plan"
              style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', maxHeight: 400, objectFit: 'contain' }}
            />
            <div style={styles.modalActions}>
              <button style={styles.cancelBtn} onClick={() => { setShowPlanModal(false); setUploadedPlan(null); }}>
                Remove
              </button>
              <button style={{ ...styles.confirmBtn, background: 'var(--orange)' }} onClick={() => setShowPlanModal(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDisconnect && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>Disconnect Strava?</h2>
            <p style={styles.modalBody}>
              This will remove your Strava connection and sign you out of your account.
              You can reconnect at any time.
            </p>
            <div style={styles.modalActions}>
              <button style={styles.cancelBtn} onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </button>
              <button style={styles.confirmBtn} onClick={disconnectAndSignOut}>
                Disconnect &amp; sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Overview sections ────────────────────────────────────────────────────────

const CURRENT_WEEK_PLAN: Record<string, { type: string; km: number; done: boolean }> = {
  Mon: { type: 'Easy Run',  km: 8,  done: true  },
  Tue: { type: 'Rest',      km: 0,  done: true  },
  Wed: { type: 'Tempo Run', km: 6,  done: true  },
  Thu: { type: 'Long Run',  km: 18, done: false },
  Fri: { type: 'Rest',      km: 0,  done: false },
  Sat: { type: 'Easy Run',  km: 10, done: false },
  Sun: { type: 'Rest',      km: 0,  done: false },
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getMondayOfWeek(offset: number): Date {
  const today = new Date();
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((dow + 6) % 7) + offset * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function ThisWeek() {
  const [offset, setOffset] = useState(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const monday = getMondayOfWeek(offset);
  const isCurrentWeek = offset === 0;

  const weekDays = DAY_NAMES.map((day, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const isToday = d.getTime() === today.getTime();
    const plan = isCurrentWeek ? CURRENT_WEEK_PLAN[day] : null;
    return { day, date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), isToday, plan };
  });

  const weekLabel = (() => {
    const end = new Date(monday);
    end.setDate(monday.getDate() + 6);
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(monday)} – ${fmt(end)}`;
  })();

  return (
    <div style={ovStyles.card} className="ov-card">
      <div style={ovStyles.weekHeader}>
        <p style={{ ...ovStyles.cardTitle, margin: 0 }}>
          {offset < 0 ? 'Past Week' : offset > 0 ? 'Future Week' : 'This Week'}
        </p>
        <div style={ovStyles.weekNav}>
          <button style={ovStyles.weekNavBtn} onClick={() => setOffset(o => o - 1)}>&#8249;</button>
          <span style={ovStyles.weekRangeLabel}>{weekLabel}</span>
          <button style={ovStyles.weekNavBtn} onClick={() => setOffset(o => o + 1)}>&#8250;</button>
          <button
            style={{ ...ovStyles.currentWeekBtn, visibility: isCurrentWeek ? 'hidden' : 'visible' }}
            className="current-week-btn"
            onClick={() => setOffset(0)}
          >Current week</button>
        </div>
      </div>
      <div style={ovStyles.weekList}>
        {weekDays.map(d => (
          <div
            key={d.day}
            style={{
              ...ovStyles.weekListRow,
              ...(d.isToday ? ovStyles.weekListRowToday : {}),
              ...(d.plan?.done ? ovStyles.weekListRowDone : {}),
            }}
          >
            <div style={ovStyles.weekDayCol}>
              <span style={ovStyles.dayName}>{d.day}</span>
              <span style={ovStyles.dayDate}>{d.date}</span>
            </div>
            <div style={ovStyles.weekInfoCol}>
              {d.plan ? (
                <>
                  <span style={{ ...ovStyles.dayType, ...(d.plan.type === 'Rest' ? ovStyles.dayTypeRest : {}) }}>
                    {d.plan.type}
                  </span>
                  {d.plan.km > 0 && <span style={ovStyles.dayKm}>{d.plan.km} km</span>}
                </>
              ) : (
                <span style={ovStyles.dayTypeRest}>—</span>
              )}
            </div>
            <div style={ovStyles.weekStatusCol}>
              {d.plan?.done && <span style={ovStyles.doneBadge}>✓</span>}
              {d.isToday && !d.plan?.done && <span style={ovStyles.todayBadge}>Today</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanProgress() {
  const totalWeeks = 16;
  const doneWeeks = 8;
  const totalKm = 650;
  const doneKm = 312;
  const pct = Math.round((doneKm / totalKm) * 100);
  const weekTarget = 42;
  const weekDone = 14;
  const weekPct = Math.round((weekDone / weekTarget) * 100);

  return (
    <div style={ovStyles.card} className="ov-card">
      <p style={ovStyles.cardTitle}>Plan Progress</p>
      <div style={ovStyles.progressSection}>
        <div style={ovStyles.progressHeader}>
          <span style={ovStyles.progressLabel}>Overall — week {doneWeeks} of {totalWeeks}</span>
          <span style={ovStyles.progressPct}>{pct}%</span>
        </div>
        <div style={ovStyles.progressTrack}>
          <div style={{ ...ovStyles.progressFill, width: `${pct}%` }} />
        </div>
        <div style={ovStyles.progressSub}>{doneKm} km done · {totalKm - doneKm} km remaining</div>
      </div>

      <div style={ovStyles.progressSection}>
        <div style={ovStyles.progressHeader}>
          <span style={ovStyles.progressLabel}>This week — target {weekTarget} km</span>
          <span style={ovStyles.progressPct}>{weekDone} km</span>
        </div>
        <div style={ovStyles.progressTrack}>
          <div style={{ ...ovStyles.progressFill, width: `${Math.min(weekPct, 100)}%` }} />
        </div>
        <div style={ovStyles.progressSub}>{weekTarget - weekDone} km to go</div>
      </div>

      <div style={ovStyles.planStatRow}>
        <div style={ovStyles.planStat}>
          <span style={ovStyles.planStatVal}>Apr 26</span>
          <span style={ovStyles.planStatLbl}>Race date</span>
        </div>
        <div style={ovStyles.planStat}>
          <span style={ovStyles.planStatVal}>London</span>
          <span style={ovStyles.planStatLbl}>Marathon</span>
        </div>
        <div style={ovStyles.planStat}>
          <span style={ovStyles.planStatVal}>3:45</span>
          <span style={ovStyles.planStatLbl}>Goal time</span>
        </div>
      </div>
    </div>
  );
}

function RecentRuns({ runs }: { runs: Activity[] }) {
  return (
    <div style={{ ...ovStyles.card, ...ovStyles.runsCard }} className="ov-card runs-card">
      <p style={ovStyles.cardTitle}>Recent Runs</p>
      <div style={ovStyles.runsList} className="runs-list">
        {runs.length === 0 && <p style={ovStyles.empty}>No runs yet</p>}
        {runs.map(a => {
          const date = new Date(a.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return (
            <div key={a.id} style={ovStyles.runRow}>
              <div style={ovStyles.runLeft}>
                <span style={ovStyles.runDate}>{date}</span>
                <span style={ovStyles.runName}>{a.name}</span>
              </div>
              <div style={ovStyles.runRight}>
                <span style={ovStyles.runKm}>{metersToKm(a.distance)} km</span>
                <span style={ovStyles.runMeta}>{secondsToTime(a.moving_time)}</span>
                <span style={ovStyles.runMeta}>{pacePerKm(a.distance, a.moving_time)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ovStyles: Record<string, React.CSSProperties> = {
  grid: {
    flex: 1, minHeight: 0,
    display: 'flex', gap: 16,
  },
  leftCol: {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16,
  },
  card: {
    flex: 1, minHeight: 0,
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 12, padding: '20px 24px',
    display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden',
  },
  runsCard: {
    flex: 1, minHeight: 0, overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  },
  cardTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  weekHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const },
  weekNav: { display: 'flex', alignItems: 'center', gap: 6 },
  weekNavBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
    borderRadius: 6, width: 26, height: 26, cursor: 'pointer', fontSize: 18,
    display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
  },
  weekRangeLabel: { fontSize: 12, color: 'var(--text-muted)', minWidth: 120, textAlign: 'center' as const },
  currentWeekBtn: {
    background: 'none', border: '1px solid var(--orange)', color: 'var(--orange)',
    borderRadius: 6, height: 26, padding: '0 10px', cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  weekList: { display: 'flex', flexDirection: 'column', gap: 2 },
  weekListRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 10px', borderRadius: 8,
    borderLeft: '2px solid transparent',
  },
  weekListRowToday: {
    borderLeft: '2px solid var(--orange)',
    background: 'rgba(249,115,22,0.06)',
  },
  weekListRowDone: { opacity: 0.55 },
  weekDayCol: { display: 'flex', flexDirection: 'column', gap: 1, width: 48, flexShrink: 0 },
  weekInfoCol: { flex: 1, display: 'flex', alignItems: 'center', gap: 10 },
  weekStatusCol: { display: 'flex', alignItems: 'center', width: 42, flexShrink: 0, justifyContent: 'flex-end' },
  dayName: { fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase' as const },
  dayDate: { fontSize: 11, color: 'var(--text-muted)' },
  dayType: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  dayTypeRest: { color: 'var(--text-muted)', fontWeight: 400 },
  dayKm: { fontSize: 13, fontWeight: 700, color: 'var(--orange)' },
  doneBadge: { fontSize: 12, color: '#4ade80', fontWeight: 700 },
  todayBadge: { fontSize: 11, color: 'var(--orange)', fontWeight: 600 },
  progressSection: { display: 'flex', flexDirection: 'column', gap: 6 },
  progressHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  progressLabel: { fontSize: 13, color: 'var(--text-muted)' },
  progressPct: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  progressTrack: { height: 6, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--orange)', borderRadius: 99, transition: 'width 0.4s ease' },
  progressSub: { fontSize: 12, color: 'var(--border)' },
  planStatRow: { display: 'flex', gap: 0, borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 },
  planStat: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' },
  planStatVal: { fontSize: 16, fontWeight: 700, color: 'var(--text)' },
  planStatLbl: { fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' as const },
  runsList: { flex: 1, overflowY: 'auto' as const, display: 'flex', flexDirection: 'column', gap: 2 },
  empty: { color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 24 },
  runRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 12px', borderRadius: 8, gap: 12,
    borderBottom: '1px solid var(--border)',
  },
  runLeft: { display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 },
  runDate: { fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 },
  runName: { fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  runRight: { display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 },
  runKm: { fontSize: 13, fontWeight: 700, color: 'var(--orange)' },
  runMeta: { fontSize: 12, color: 'var(--text-muted)' },
};

// ── Calendar ──────────────────────────────────────────────────────────────────

// Module-level cache so it survives CalendarView unmounting (e.g. switching tabs)
const calCache: Record<string, Activity[]> = {};
const calInflight: Record<string, Promise<Activity[]>> = {};

function calMonthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fetchCalMonth(d: Date): Promise<Activity[]> {
  const key = calMonthKey(d);
  if (calCache[key]) return Promise.resolve(calCache[key]);
  if (calInflight[key]) return calInflight[key];
  const year = d.getFullYear();
  const month = d.getMonth();
  const after = Math.floor(new Date(year, month, 1).getTime() / 1000);
  const before = Math.floor(new Date(year, month + 1, 1).getTime() / 1000);
  const promise = api.training.activities({ after, before, per_page: 100 })
    .then(acts => {
      const runs = acts.filter(a => a.sport_type === 'Run' || a.type === 'Run');
      calCache[key] = runs;
      delete calInflight[key];
      return runs;
    })
    .catch(err => { delete calInflight[key]; throw err; });
  calInflight[key] = promise;
  return promise;
}

function CalendarView() {
  const todayStart = (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); })();
  const [current, setCurrent] = useState(todayStart);
  const [selectedRun, setSelectedRun] = useState<Activity | null>(null);
  const [monthActivities, setMonthActivities] = useState<Activity[]>([]);
  const [monthLoading, setMonthLoading] = useState(false);

  useEffect(() => {
    setSelectedRun(null);
    let cancelled = false;
    const key = calMonthKey(current);
    if (calCache[key]) {
      setMonthActivities(calCache[key]);
    } else {
      setMonthLoading(true);
      fetchCalMonth(current)
        .then(runs => { if (!cancelled) setMonthActivities(runs); })
        .catch(() => { if (!cancelled) setMonthActivities([]); })
        .finally(() => { if (!cancelled) setMonthLoading(false); });
    }
    // Preload adjacent months and always keep today's month warm
    const prev = new Date(current.getFullYear(), current.getMonth() - 1, 1);
    const next = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    fetchCalMonth(prev).catch(() => {});
    fetchCalMonth(next).catch(() => {});
    fetchCalMonth(todayStart).catch(() => {});
    return () => { cancelled = true; };
  }, [current]);

  const runsByDate = useMemo(() => {
    const map: Record<string, Activity[]> = {};
    for (const run of monthActivities) {
      const d = new Date(run.start_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!map[key]) map[key] = [];
      map[key].push(run);
    }
    return map;
  }, [monthActivities]);

  const year = current.getFullYear();
  const month = current.getMonth();
  const today = new Date();

  const rawFirstDay = new Date(year, month, 1).getDay();
  const firstDayMon = (rawFirstDay + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (number | null)[] = [
    ...Array(firstDayMon).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = current.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const isCurrentMonth = calMonthKey(current) === calMonthKey(todayStart);

  function prev() { setCurrent(new Date(year, month - 1, 1)); }
  function next() { setCurrent(new Date(year, month + 1, 1)); }

  return (
    <div>
      <div style={calStyles.header}>
        <button style={calStyles.navBtn} onClick={prev}>&#8249;</button>
        <span style={calStyles.monthLabel}>{monthLabel}</span>
        <button style={calStyles.navBtn} onClick={next}>&#8250;</button>
        {!isCurrentMonth && (
          <button style={calStyles.todayBtn} onClick={() => setCurrent(todayStart)}>Today</button>
        )}
        {monthLoading && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>Loading…</span>}
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }} className="cal-layout">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={calStyles.grid}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <div key={d} style={calStyles.dayHeader} className="cal-cell">{d}</div>
            ))}

            {cells.map((day, i) => {
              if (!day) return <div key={`e-${i}`} style={calStyles.emptyCell} className="cal-cell" />;
              const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const dayRuns = runsByDate[key] ?? [];
              const cellDate = new Date(year, month, day);
              const isToday = today.toDateString() === cellDate.toDateString();
              const isFuture = cellDate > today;
              return (
                <div key={key} style={{ ...calStyles.cell, ...(isFuture ? calStyles.futureCell : {}) }} className="cal-cell">
                  <span style={{ ...calStyles.dayNum, ...(isToday ? calStyles.todayNum : {}) }}>{day}</span>
                  <div className="cal-runs">
                    {dayRuns.map(run => (
                      <div
                        key={run.id}
                        style={{ ...calStyles.runPill, ...(selectedRun?.id === run.id ? calStyles.runPillActive : {}) }}
                        className={`cal-run-pill${selectedRun?.id === run.id ? ' cal-run-pill-active' : ''}`}
                        onClick={() => setSelectedRun(run)}
                        onDoubleClick={() => setSelectedRun(null)}
                      >
                        <span style={calStyles.runDist} className="cal-run-dist">{metersToKm(run.distance)} km</span>
                        <span style={calStyles.runName} className="cal-run-name">{run.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {selectedRun && (
          <RunDetail run={selectedRun} onClose={() => setSelectedRun(null)} />
        )}
      </div>
    </div>
  );
}

function RunDetail({ run, onClose }: { run: Activity; onClose: () => void }) {
  const date = new Date(run.start_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const rows: { label: string; value: string }[] = [
    { label: 'Distance', value: `${metersToKm(run.distance)} km` },
    { label: 'Time', value: secondsToTime(run.moving_time) },
    { label: 'Pace', value: pacePerKm(run.distance, run.moving_time) },
    { label: 'Elevation', value: `${Math.round(run.total_elevation_gain)} m` },
    ...(run.average_heartrate ? [{ label: 'Avg HR', value: `${Math.round(run.average_heartrate)} bpm` }] : []),
  ];

  return (
    <div style={calStyles.detailPanel} className="cal-detail-panel">
      <div style={calStyles.detailHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={calStyles.detailDate}>{date}</p>
          <p style={calStyles.detailName}>{run.name}</p>
        </div>
        <button style={calStyles.closeBtn} onClick={onClose} aria-label="Close">&#10005;</button>
      </div>

      <div style={calStyles.detailStats}>
        {rows.map(r => (
          <div key={r.label} style={calStyles.detailRow}>
            <span style={calStyles.detailLabel}>{r.label}</span>
            <span style={calStyles.detailValue}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const calStyles: Record<string, React.CSSProperties> = {
  wrap: { marginTop: 8 },
  header: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 },
  monthLabel: { fontSize: 18, fontWeight: 700, color: 'var(--text)', minWidth: 200, textAlign: 'center' },
  navBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
    borderRadius: 6, width: 32, height: 32, cursor: 'pointer', fontSize: 20,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  todayBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text)',
    borderRadius: 6, height: 32, padding: '0 12px', cursor: 'pointer',
    fontSize: 13, fontWeight: 500,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
    gap: 1,
    background: 'var(--border)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  dayHeader: {
    background: 'var(--surface)', padding: '8px 0',
    fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
    textAlign: 'center',
  },
  emptyCell: { background: 'var(--bg)', minHeight: 120 },
  cell: {
    background: 'var(--surface)', minHeight: 120,
    padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4,
    minWidth: 0, overflow: 'hidden',
  },
  futureCell: { background: 'var(--bg)' },
  dayNum: {
    fontSize: 13, fontWeight: 600, color: 'var(--text-muted)',
    alignSelf: 'flex-end', lineHeight: 1,
  },
  todayNum: {
    background: 'var(--orange)', color: '#fff',
    borderRadius: '50%', width: 22, height: 22,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  runPill: {
    background: 'rgba(249,115,22,0.15)', borderRadius: 4,
    padding: '3px 6px', display: 'flex', flexDirection: 'column', gap: 1,
    cursor: 'pointer',
  },
  runPillActive: {
    background: 'rgba(249,115,22,0.35)', outline: '1px solid var(--orange)',
  },
  runDist: { fontSize: 12, fontWeight: 700, color: 'var(--orange)' },
  runName: {
    fontSize: 11, color: 'var(--text-muted)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  detailPanel: {
    width: 280, flexShrink: 0,
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 12, padding: '20px',
    display: 'flex', flexDirection: 'column', gap: 20,
  },
  detailHeader: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  detailDate: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 },
  detailName: { fontSize: 16, fontWeight: 700, color: 'var(--text)' },
  closeBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)',
    borderRadius: 6, width: 28, height: 28, cursor: 'pointer', fontSize: 12,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  detailStats: { display: 'flex', flexDirection: 'column', gap: 12 },
  detailRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  detailLabel: { fontSize: 13, color: 'var(--text-muted)' },
  detailValue: { fontSize: 15, fontWeight: 700, color: 'var(--text)' },
};

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}


const styles: Record<string, React.CSSProperties> = {
  page: { height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' },
  header: {
    display: 'flex', flexDirection: 'column', gap: 0,
    padding: '0 32px', borderBottom: '1px solid var(--border)', background: 'var(--surface)',
  },
  headerTopRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '16px 0',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const },
  planBadge: {
    fontSize: 13, fontWeight: 600, color: 'var(--text-muted)',
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 20, padding: '4px 12px',
  },
  navRow: {
    alignItems: 'center', justifyContent: 'space-between',
    marginTop: 4, paddingTop: 8, paddingBottom: 10,
  },
  nav: { display: 'flex', gap: 2 },
  navMeta: {
    fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
    paddingRight: 4,
  },
  navLink: {
    fontSize: 13, fontWeight: 500, color: 'var(--text-muted)',
    background: 'none', border: 'none', borderRadius: 6,
    padding: '5px 12px', cursor: 'pointer', transition: 'background 0.15s, color 0.15s',
  },
  navLinkActive: {
    color: 'var(--text)', background: 'var(--surface-2)',
    fontWeight: 600,
  },
  appName: { fontSize: 18, fontWeight: 700, color: 'var(--orange)' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  avatar: { width: 32, height: 32, borderRadius: '50%' },
  userName: { fontSize: 14, color: 'var(--text-muted)' },
  menuWrap: { position: 'relative' },
  iconBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 36, height: 36, borderRadius: 8, color: 'var(--text-muted)',
    cursor: 'pointer', transition: 'background 0.15s',
    border: '1px solid var(--border)',
  },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 8px)', right: 0,
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 10, minWidth: 220, zIndex: 100,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    overflow: 'hidden',
  },
  dropdownItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', padding: '12px 16px', background: 'none',
    color: 'var(--text)', fontSize: 14, cursor: 'pointer', textAlign: 'left',
    transition: 'background 0.15s',
  },
  dangerItem: { color: '#F87171' },
  divider: { height: 1, background: 'var(--border)', margin: '0 8px' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', padding: '16px 24px', overflow: 'hidden', minHeight: 0 },
  muted: { color: 'var(--text-muted)', textAlign: 'center', padding: 40 },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 200, padding: 24,
  },
  modal: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 16, padding: '32px 28px', maxWidth: 400, width: '100%',
    display: 'flex', flexDirection: 'column', gap: 16,
  },
  modalTitle: { fontSize: 20, fontWeight: 700, color: 'var(--text)' },
  modalBody: { fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.6, textAlign: 'justify' },
  modalActions: { display: 'flex', gap: 10, marginTop: 8 },
  cancelBtn: {
    flex: 1, padding: '10px 20px', borderRadius: 8, background: 'none',
    border: '1px solid var(--border)', color: 'var(--text-muted)',
    fontSize: 14, fontWeight: 500, cursor: 'pointer',
  },
  confirmBtn: {
    padding: '10px 20px', borderRadius: 8, background: '#F87171',
    border: 'none', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
};
