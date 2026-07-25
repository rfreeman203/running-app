import { useEffect, useMemo, useRef, useState } from 'react';
import { api, clearToken, type Activity, type AthleteStats, type RunReview, type User, type Workout } from '../lib/api';
import { useNavigate } from 'react-router-dom';

interface Props {
  user: User;
  onSignOut: () => void;
}

function formatSportType(raw: string) {
  return raw.replace(/([A-Z])/g, ' $1').trim();
}

const RACE_DISTANCES: Record<string, { label: string; km: number }> = {
  '5k':       { label: '5K',            km: 5 },
  '10k':      { label: '10K',           km: 10 },
  'half':     { label: 'Half Marathon', km: 21.0975 },
  'marathon': { label: 'Marathon',      km: 42.195 },
  'custom':   { label: 'Custom',        km: 0 },
};

function parseTimeToSeconds(t: string): number | null {
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN) || parts.length > 3) return null;
  if (parts.length === 1) return parts[0] * 60;               // "45" → 45 min
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60; // "3:45" → 3h 45m
  return parts[0] * 3600 + parts[1] * 60 + parts[2];         // "3:45:30"
}

function parsePaceToSeconds(p: string): number | null {
  const parts = p.replace('/km', '').trim().split(':').map(Number);
  if (parts.some(isNaN) || parts.length > 2) return null;
  if (parts.length === 1) return parts[0] * 60;               // "5" → 5:00 /km
  return parts[0] * 60 + parts[1];                           // "5:20"
}

function fmtGoalTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtGoalPace(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function secondsToTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function GeneratingOverlay({ title, estimateSeconds }: { title: string; estimateSeconds: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(estimateSeconds - elapsed, 3);
  const pct = Math.min(96, Math.round((elapsed / estimateSeconds) * 100));
  return (
    <div style={styles.overlay}>
      <div style={{ ...styles.modal, maxWidth: 380, alignItems: 'center', textAlign: 'center' }}>
        <div className="spinner" />
        <h2 style={styles.modalTitle}>{title}</h2>
        <p style={{ ...styles.modalBody, textAlign: 'center' }}>
          Claude is building your week-by-week schedule. This usually takes under a minute.
        </p>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${pct}%` }} />
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          Estimated time left: ~{remaining}s
        </p>
      </div>
    </div>
  );
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
  const [confirmRecreatePlan, setConfirmRecreatePlan] = useState(false);
  const [editGoalOpen, setEditGoalOpen] = useState(false);
  const [editTime, setEditTime] = useState('');
  const [editPace, setEditPace] = useState('');
  const [revisingGoal, setRevisingGoal] = useState(false);
  const [revisingGoalError, setRevisingGoalError] = useState('');
  const [view, setView] = useState<'overview' | 'calendar'>('overview');
  const [hasPlan, setHasPlan] = useState(false);
  const [uploadedPlan, setUploadedPlan] = useState<File | null>(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [upDistance, setUpDistance] = useState('marathon');
  const [upCustomKm, setUpCustomKm] = useState('');
  const [upDate, setUpDate] = useState('');
  const [upTime, setUpTime] = useState('');
  const [upPace, setUpPace] = useState('');
  const [upUploading, setUpUploading] = useState(false);
  const [upError, setUpError] = useState('');
  const [showGenModal, setShowGenModal] = useState(false);
  const [genDistance, setGenDistance] = useState('marathon');
  const [genCustomKm, setGenCustomKm] = useState('');
  const [genDate, setGenDate] = useState('');
  const [genTime, setGenTime] = useState('');
  const [genPace, setGenPace] = useState('');
  const [genWeeklyKm, setGenWeeklyKm] = useState('');
  const [genRunningDays, setGenRunningDays] = useState<string[]>(['Mon', 'Wed', 'Thu', 'Sat', 'Sun']);
  const [genLongRunDay, setGenLongRunDay] = useState('Sun');
  const [genAdvancedOpen, setGenAdvancedOpen] = useState(false);
  const [genExperience, setGenExperience] = useState('intermediate');
  const [genTrainingStyle, setGenTrainingStyle] = useState('easy');
  const [genNotes, setGenNotes] = useState('');
  const [genGenerating, setGenGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  const [planCreatedAt, setPlanCreatedAt] = useState<number | null>(null);
  const [remainingKm, setRemainingKm] = useState<number | null>(null);
  const [weekSummary, setWeekSummary] = useState<string | null>(null);
  const [planSummary, setPlanSummary] = useState<string | null>(null);
  const [summariesPending, setSummariesPending] = useState(false);
  const [planVersion, setPlanVersion] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const planInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData(attempt = 0) {
    // Plan loading is independent of Strava — load it first so the UI never gets stuck
    const plan = await api.training.getPlan().catch(() => null);
    if (plan) {
      const distKey = Object.keys(RACE_DISTANCES).find(
        k => k !== 'custom' && Math.abs(RACE_DISTANCES[k].km - plan.distance_km) < 0.01
      ) ?? 'custom';
      setGenDistance(distKey);
      if (distKey === 'custom') setGenCustomKm(String(plan.distance_km));
      setGenDate(plan.race_date);
      setGenTime(plan.goal_time);
      setGenPace(plan.goal_pace);
      if (plan.weekly_km != null) setGenWeeklyKm(String(plan.weekly_km));
      if (plan.running_days?.length) setGenRunningDays(plan.running_days);
      else if (plan.days_per_week != null) { /* legacy: no running_days saved */ }
      if (plan.long_run_day) setGenLongRunDay(plan.long_run_day);
      if (plan.experience) setGenExperience(plan.experience);
      if (plan.training_style) setGenTrainingStyle(plan.training_style);
      if (plan.notes) setGenNotes(plan.notes);
      if (plan.week_summary) setWeekSummary(plan.week_summary);
      if (plan.plan_summary) setPlanSummary(plan.plan_summary);
      setPlanCreatedAt(plan.created_at);
      setHasPlan(true);

      const todayKey = dateKey(new Date());
      const raceDistKm = plan.distance_km;
      fetchPlanWorkouts()
        .then(() => {
          if (!planWeeksCache) return;
          let km = raceDistKm;
          for (const week of planWeeksCache) {
            for (const w of week.workouts) {
              if (w.date >= todayKey) km += w.km;
            }
          }
          setRemainingKm(km);
        })
        .catch(() => {});
    }

    try {
      const [acts, st] = await Promise.all([
        api.training.activities(),
        api.training.stats(),
      ]);
      setActivities(acts);
      setStats(st);
      setLoading(false);

      // New-run detection: regenerate AI summaries when the newest activity changed, or once per
      // day regardless (so a missed/unlogged workout still gets acknowledged instead of leaving a
      // stale "on track" summary). Fire-and-forget — the server skips if nothing needs updating.
      const newestId = acts[0] ? String(acts[0].id) : null;
      if (plan && newestId) {
        setSummariesPending(true);
        api.training.updateSummaries({ last_activity_id: newestId })
          .then(r => {
            if (!r.skipped) {
              if (r.week_summary) setWeekSummary(r.week_summary);
              if (r.plan_summary) setPlanSummary(r.plan_summary);
            }
          })
          .catch(() => {})
          .finally(() => setSummariesPending(false));
      }
    } catch (err: any) {
      // Retry once for transient errors, but not for rate limits (429) — retrying makes it worse
      if (attempt === 0 && err.status !== 429) {
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

  const weeksLeft = (() => {
    if (!genDate) return null;
    const [y, m, d] = genDate.split('-').map(Number);
    return Math.max(0, Math.ceil((new Date(y, m - 1, d).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)));
  })();
  const planBadgeText = weeksLeft !== null
    ? `${weeksLeft} week${weeksLeft === 1 ? '' : 's'} left${remainingKm !== null ? ` · ${Math.round(remainingKm)} km` : ''}`
    : '';

  return (
    <div style={styles.page} className="page-root">
      <header style={styles.header} className="header-inner">
        {/* Single row on desktop */}
        <div style={styles.headerTopRow}>
          <div style={styles.headerLeft}>
            <span style={styles.appName}>Marathon Trainer</span>
            {hasPlan && <span style={styles.planBadge} className="plan-badge-desktop">{planBadgeText}</span>}
            {hasPlan && (
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
            )}
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
                  {hasPlan && (
                    <>
                      <button
                        style={styles.dropdownItem}
                        onClick={() => { setMenuOpen(false); setEditTime(genTime); setEditPace(genPace); setEditGoalOpen(true); }}
                      >
                        <span>Edit goal</span>
                      </button>
                      <button
                        style={styles.dropdownItem}
                        onClick={() => { setMenuOpen(false); setConfirmRecreatePlan(true); }}
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
                    </>
                  )}
                  <button style={styles.dropdownItem} onClick={() => { setMenuOpen(false); signOut(); }}>
                    <span>Sign out</span>
                  </button>
                  <div style={styles.divider} />
                  <button style={{ ...styles.dropdownItem, ...styles.dangerItem }} onClick={() => { setMenuOpen(false); setConfirmDisconnect(true); }}>
                    <span>Disconnect Strava</span>
                  </button>
                  {hasPlan && (
                    <button style={{ ...styles.dropdownItem, ...styles.dangerItem }} onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>
                      <span>Delete account</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Mobile-only second row */}
        {hasPlan && (
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
            <span style={styles.navMeta}>{planBadgeText}</span>
          </div>
        )}
      </header>

      <main style={{ ...styles.main, maxWidth: 'none' }} className="main-content">
        {loading && <p style={styles.muted}>Loading your training data…</p>}
        {error && <p style={{ color: '#F87171' }}>{error}</p>}

        {!loading && !hasPlan && (
          <div style={styles.noPlanWrap}>
            <div style={styles.noPlanCard}>
              <div style={styles.noPlanIcon}>🏃</div>
              <h2 style={styles.noPlanTitle}>No training plan yet</h2>
              <p style={styles.noPlanBody}>
                Get started by generating a personalised plan or uploading an existing one.
              </p>
              <div style={styles.noPlanActions}>
                <button style={styles.noPlanGenBtn} onClick={() => {
                  if (!hasPlan && stats) setGenWeeklyKm(String(Math.round(stats.recent_run_totals.distance / 1000 / 4)));
                  setShowGenModal(true);
                }}>
                  Generate a plan
                </button>
                <button style={styles.noPlanUploadBtn} onClick={() => planInputRef.current?.click()}>
                  Upload a plan
                </button>
              </div>
            </div>
          </div>
        )}

        {!loading && hasPlan && view === 'overview' && (
          <div style={ovStyles.grid} className="ov-grid">
            <div style={ovStyles.leftCol} className="ov-left-col">
              <ThisWeek key={planVersion} activities={activities} />
              <PlanProgress
                raceDate={genDate}
                goalTime={genTime}
                distanceKey={genDistance}
                customKm={genCustomKm}
                createdAt={planCreatedAt}
                activities={activities}
                weekSummary={weekSummary}
                planSummary={planSummary}
                summariesPending={summariesPending}
              />
            </div>
            <RecentActivities activities={activities} />
          </div>
        )}

        {!loading && hasPlan && view === 'calendar' && (
          <CalendarView key={planVersion} />
        )}
      </main>

      {confirmRecreatePlan && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>Recreate plan?</h2>
            <p style={styles.modalBody}>
              Your current training plan will be deleted and a new one will be generated.
              This action cannot be undone.
            </p>
            <div style={styles.modalActions}>
              <button style={styles.cancelBtn} onClick={() => setConfirmRecreatePlan(false)}>
                Cancel
              </button>
              <button style={styles.confirmBtn} onClick={() => {
                setConfirmRecreatePlan(false);
                api.training.deletePlan().catch(() => {});
                setHasPlan(false);
                setGenDistance('marathon');
                setGenCustomKm('');
                setGenDate('');
                setGenTime('');
                setGenPace('');
                setGenWeeklyKm(stats ? String(Math.round(stats.recent_run_totals.distance / 1000 / 4)) : '');
                setGenRunningDays(['Mon', 'Wed', 'Thu', 'Sat', 'Sun']);
                setGenLongRunDay('Sun');
                setGenAdvancedOpen(false);
                setGenExperience('intermediate');
                setGenTrainingStyle('easy');
                setGenNotes('');
                setPlanCreatedAt(null);
                setRemainingKm(null);
                setWeekSummary(null);
                setPlanSummary(null);
                planCache = null;
                planWeeksCache = null;
                planInflight = null;
                setPlanVersion(v => v + 1);
              }}>
                Recreate plan
              </button>
            </div>
          </div>
        </div>
      )}

      {editGoalOpen && revisingGoal && (
        <GeneratingOverlay title="Revising your plan…" estimateSeconds={35} />
      )}

      {editGoalOpen && !revisingGoal && (() => {
        const distKm = genDistance === 'custom'
          ? parseFloat(genCustomKm) || 0
          : RACE_DISTANCES[genDistance].km;

        function onEditTimeChange(val: string) {
          setEditTime(val);
          if (!distKm) return;
          const s = parseTimeToSeconds(val);
          if (s !== null) setEditPace(fmtGoalPace(s / distKm));
        }

        function onEditPaceChange(val: string) {
          setEditPace(val);
          if (!distKm) return;
          const ps = parsePaceToSeconds(val);
          if (ps !== null) setEditTime(fmtGoalTime(ps * distKm));
        }

        return (
          <div style={styles.overlay}>
            <div style={{ ...styles.modal, maxWidth: 380 }}>
              <h2 style={styles.modalTitle}>Edit goal</h2>
              <div style={genStyles.field}>
                <label style={genStyles.label}>Goal time &amp; pace <span style={genStyles.linked}>linked</span></label>
                <div style={genStyles.timePaceRow}>
                  <div style={genStyles.timePaceField}>
                    <span style={genStyles.inputLabel}>Time</span>
                    <input
                      style={genStyles.input}
                      type="text"
                      placeholder="h:mm:ss"
                      value={editTime}
                      onChange={e => onEditTimeChange(e.target.value)}
                    />
                  </div>
                  <span style={genStyles.timePaceSep}>/</span>
                  <div style={genStyles.timePaceField}>
                    <span style={genStyles.inputLabel}>Pace (per km)</span>
                    <input
                      style={genStyles.input}
                      type="text"
                      placeholder="mm:ss"
                      value={editPace}
                      onChange={e => onEditPaceChange(e.target.value)}
                    />
                  </div>
                </div>
              </div>
              {revisingGoalError && <p style={{ color: 'var(--red, #dc2626)', fontSize: 13, margin: 0 }}>{revisingGoalError}</p>}
              <div style={styles.modalActions}>
                <button style={styles.cancelBtn} onClick={() => { setEditGoalOpen(false); setRevisingGoalError(''); }}>
                  Cancel
                </button>
                <button
                  style={{ ...styles.confirmBtn, background: 'var(--orange)' }}
                  onClick={async () => {
                    setRevisingGoalError('');
                    setRevisingGoal(true);
                    try {
                      await api.training.reviseGoal(editTime);
                      setGenTime(editTime);
                      setGenPace(editPace);
                      planCache = null;
                      planWeeksCache = null;
                      planInflight = null;
                      setPlanVersion(v => v + 1);
                      setEditGoalOpen(false);
                      loadData();
                    } catch (err: any) {
                      setRevisingGoalError(err.message ?? 'Failed to revise goal. Please try again.');
                    } finally {
                      setRevisingGoal(false);
                    }
                  }}
                >
                  Save goal
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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
        accept="image/png,image/jpeg,.jpg,.pdf"
        style={{ display: 'none' }}
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) {
            setUploadedPlan(file);
            setUpDistance('marathon');
            setUpCustomKm('');
            setUpDate('');
            setUpTime('');
            setUpPace('');
            setUpError('');
            setShowPlanModal(true);
          }
          e.target.value = '';
        }}
      />

      {showPlanModal && uploadedPlan && upUploading && (
        <GeneratingOverlay title="Importing your plan…" estimateSeconds={40} />
      )}

      {showPlanModal && uploadedPlan && !upUploading && (() => {
        const upDistKm = upDistance === 'custom' ? (parseFloat(upCustomKm) || 0) : RACE_DISTANCES[upDistance].km;

        function onUpDistanceChange(val: string) {
          setUpDistance(val);
          const km = val === 'custom' ? (parseFloat(upCustomKm) || 0) : RACE_DISTANCES[val].km;
          if (!km) return;
          if (upTime) {
            const s = parseTimeToSeconds(upTime);
            if (s !== null) setUpPace(fmtGoalPace(s / km));
          }
        }

        function onUpTimeChange(val: string) {
          setUpTime(val);
          if (!upDistKm) return;
          const s = parseTimeToSeconds(val);
          if (s !== null) setUpPace(fmtGoalPace(s / upDistKm));
        }

        function onUpPaceChange(val: string) {
          setUpPace(val);
          if (!upDistKm) return;
          const ps = parsePaceToSeconds(val);
          if (ps !== null) setUpTime(fmtGoalTime(ps * upDistKm));
        }

        const canImport = upDistKm > 0 && upDate && !upUploading;

        function closeModal() {
          setShowPlanModal(false);
          setUploadedPlan(null);
        }

        return (
          <div style={styles.overlay}>
            <div style={{ ...styles.modal, maxWidth: 560 }}>
              <h2 style={styles.modalTitle}>Import plan from file</h2>
              {uploadedPlan.type.startsWith('image/') ? (
                <img
                  src={URL.createObjectURL(uploadedPlan)}
                  alt="Running plan"
                  style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', maxHeight: 260, objectFit: 'contain' }}
                />
              ) : (
                <div style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-2)', fontSize: 13, color: 'var(--text)' }}>
                  📄 {uploadedPlan.name}
                </div>
              )}

              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                Confirm your race details, then Claude will read the file and extract your week-by-week schedule.
              </p>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Race distance</label>
                <div style={genStyles.distRow}>
                  {Object.entries(RACE_DISTANCES).map(([key, { label }]) => (
                    <button
                      key={key}
                      style={{ ...genStyles.distBtn, ...(upDistance === key ? genStyles.distBtnActive : {}) }}
                      onClick={() => onUpDistanceChange(key)}
                    >{label}</button>
                  ))}
                </div>
                {upDistance === 'custom' && (
                  <input
                    style={genStyles.input}
                    type="number"
                    placeholder="Distance in km"
                    value={upCustomKm}
                    onChange={e => { setUpCustomKm(e.target.value); onUpDistanceChange('custom'); }}
                  />
                )}
              </div>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Race date</label>
                <input
                  style={genStyles.input}
                  type="date"
                  value={upDate}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={e => setUpDate(e.target.value)}
                />
              </div>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Goal time &amp; pace <span style={genStyles.linked}>optional, linked</span></label>
                <div style={genStyles.timePaceRow}>
                  <div style={genStyles.timePaceField}>
                    <span style={genStyles.inputLabel}>Time</span>
                    <input
                      style={genStyles.input}
                      type="text"
                      placeholder={upDistKm >= 21 ? 'h:mm:ss' : 'mm:ss'}
                      value={upTime}
                      onChange={e => onUpTimeChange(e.target.value)}
                    />
                  </div>
                  <div style={genStyles.timePaceSep}>↔</div>
                  <div style={genStyles.timePaceField}>
                    <span style={genStyles.inputLabel}>Pace /km</span>
                    <input
                      style={genStyles.input}
                      type="text"
                      placeholder="mm:ss"
                      value={upPace}
                      onChange={e => onUpPaceChange(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {upError && <p style={{ color: 'var(--red, #dc2626)', fontSize: 13, margin: 0 }}>{upError}</p>}
              <div style={styles.modalActions}>
                <button style={styles.cancelBtn} onClick={closeModal} disabled={upUploading}>
                  Cancel
                </button>
                <button
                  style={{ ...styles.confirmBtn, background: canImport ? 'var(--orange)' : 'var(--border)', cursor: canImport ? 'pointer' : 'not-allowed' }}
                  disabled={!canImport}
                  onClick={async () => {
                    setUpError('');
                    setUpUploading(true);
                    try {
                      const image_base64 = await fileToBase64(uploadedPlan);
                      await api.training.uploadPlan({
                        image_base64,
                        media_type: uploadedPlan.type || 'application/pdf',
                        distance_km: upDistKm,
                        race_date: upDate,
                        goal_time: upTime,
                        goal_pace: upPace,
                      });
                      planCache = null;
                      planWeeksCache = null;
                      planInflight = null;
                      setPlanVersion(v => v + 1);
                      closeModal();
                      setHasPlan(true);
                      // Initial "position going in" overview — fire-and-forget so the
                      // plan shows immediately and the summaries fade in when ready
                      setSummariesPending(true);
                      api.training.updateSummaries({ initial: true })
                        .then(r => {
                          if (r.week_summary) setWeekSummary(r.week_summary);
                          if (r.plan_summary) setPlanSummary(r.plan_summary);
                        })
                        .catch(() => {})
                        .finally(() => setSummariesPending(false));
                      loadData();
                    } catch (err: any) {
                      setUpError(err.message ?? 'Failed to import plan. Please try again.');
                    } finally {
                      setUpUploading(false);
                    }
                  }}
                >{upUploading ? 'Importing…' : 'Import plan'}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {showGenModal && genGenerating && (
        <GeneratingOverlay title="Generating your plan…" estimateSeconds={45} />
      )}

      {showGenModal && !genGenerating && (() => {
        const distKm = genDistance === 'custom'
          ? parseFloat(genCustomKm) || 0
          : RACE_DISTANCES[genDistance].km;

        function onDistanceChange(val: string) {
          setGenDistance(val);
          const km = val === 'custom' ? (parseFloat(genCustomKm) || 0) : RACE_DISTANCES[val].km;
          if (!km) return;
          if (genTime) {
            const s = parseTimeToSeconds(genTime);
            if (s !== null) setGenPace(fmtGoalPace(s / km));
          } else if (genPace) {
            const ps = parsePaceToSeconds(genPace);
            if (ps !== null) setGenTime(fmtGoalTime(ps * km));
          }
        }

        function onCustomKmChange(val: string) {
          setGenCustomKm(val);
          const km = parseFloat(val) || 0;
          if (!km) return;
          if (genTime) {
            const s = parseTimeToSeconds(genTime);
            if (s !== null) setGenPace(fmtGoalPace(s / km));
          } else if (genPace) {
            const ps = parsePaceToSeconds(genPace);
            if (ps !== null) setGenTime(fmtGoalTime(ps * km));
          }
        }

        function onTimeChange(val: string) {
          setGenTime(val);
          if (!distKm) return;
          const s = parseTimeToSeconds(val);
          if (s !== null) setGenPace(fmtGoalPace(s / distKm));
        }

        function onPaceChange(val: string) {
          setGenPace(val);
          if (!distKm) return;
          const ps = parsePaceToSeconds(val);
          if (ps !== null) setGenTime(fmtGoalTime(ps * distKm));
        }

        const goalTimeSec = parseTimeToSeconds(genTime);
        const goalTimeValid = goalTimeSec !== null && goalTimeSec > 0;
        const goalTimeInvalid = genTime.trim() !== '' && !goalTimeValid;
        const canGenerate = distKm > 0 && genDate && goalTimeValid;

        return (
          <div style={styles.overlay}>
            <div style={{ ...styles.modal, maxWidth: 520 }}>
              <h2 style={styles.modalTitle}>Create your training plan</h2>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Race distance</label>
                <div style={genStyles.distRow}>
                  {Object.entries(RACE_DISTANCES).map(([key, { label }]) => (
                    <button
                      key={key}
                      style={{ ...genStyles.distBtn, ...(genDistance === key ? genStyles.distBtnActive : {}) }}
                      onClick={() => onDistanceChange(key)}
                    >{label}</button>
                  ))}
                </div>
                {genDistance === 'custom' && (
                  <input
                    style={genStyles.input}
                    type="number"
                    placeholder="Distance in km"
                    value={genCustomKm}
                    onChange={e => onCustomKmChange(e.target.value)}
                  />
                )}
              </div>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Race date</label>
                <input
                  style={genStyles.input}
                  type="date"
                  value={genDate}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={e => setGenDate(e.target.value)}
                />
              </div>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Goal time &amp; pace <span style={genStyles.linked}>linked</span></label>
                <div style={genStyles.timePaceRow}>
                  <div style={genStyles.timePaceField}>
                    <span style={genStyles.inputLabel}>Time</span>
                    <input
                      style={genStyles.input}
                      type="text"
                      placeholder={distKm >= 21 ? 'h:mm:ss' : 'mm:ss'}
                      value={genTime}
                      onChange={e => onTimeChange(e.target.value)}
                    />
                  </div>
                  <div style={genStyles.timePaceSep}>↔</div>
                  <div style={genStyles.timePaceField}>
                    <span style={genStyles.inputLabel}>Pace /km</span>
                    <input
                      style={genStyles.input}
                      type="text"
                      placeholder="mm:ss"
                      value={genPace}
                      onChange={e => onPaceChange(e.target.value)}
                    />
                  </div>
                </div>
                {goalTimeInvalid
                  ? <p style={{ color: 'var(--red, #dc2626)', fontSize: 12, margin: 0 }}>
                      Enter a valid goal time ({distKm >= 21 ? 'h:mm:ss' : 'mm:ss'}).
                    </p>
                  : <p style={genStyles.hint}>Required — enter your target finish time.</p>}
              </div>

              <div style={genStyles.field}>
                <label style={genStyles.label}>
                  Current weekly mileage (km)
                  <span style={genStyles.linked}>{genWeeklyKm && stats ? 'from Strava' : 'enter manually'}</span>
                </label>
                <input
                  style={genStyles.input}
                  type="number"
                  min="0"
                  placeholder="km per week"
                  value={genWeeklyKm}
                  onChange={e => setGenWeeklyKm(e.target.value)}
                />
              </div>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Running days</label>
                <div style={genStyles.distRow}>
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
                    <button
                      key={day}
                      style={{ ...genStyles.distBtn, ...(genRunningDays.includes(day) ? genStyles.distBtnActive : {}) }}
                      onClick={() => {
                        const next = genRunningDays.includes(day)
                          ? genRunningDays.filter(d => d !== day)
                          : [...genRunningDays, day];
                        if (next.length === 0) return;
                        setGenRunningDays(next);
                        if (!next.includes(genLongRunDay)) setGenLongRunDay(next[next.length - 1]);
                      }}
                    >{day}</button>
                  ))}
                </div>
              </div>

              <div style={genStyles.field}>
                <label style={genStyles.label}>Long run day</label>
                <div style={genStyles.distRow}>
                  {genRunningDays.map(day => (
                    <button
                      key={day}
                      style={{ ...genStyles.distBtn, ...(genLongRunDay === day ? genStyles.distBtnActive : {}) }}
                      onClick={() => setGenLongRunDay(day)}
                    >{day}</button>
                  ))}
                </div>
              </div>

              <div style={genStyles.field}>
                <button
                  style={{ ...genStyles.distBtn, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setGenAdvancedOpen(o => !o)}
                >
                  <span style={{ fontSize: 11 }}>{genAdvancedOpen ? '▾' : '▸'}</span> Advanced
                </button>
                {genAdvancedOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 4 }}>
                    <div style={genStyles.field}>
                      <label style={genStyles.label}>Experience level</label>
                      <div style={genStyles.distRow}>
                        {(['beginner', 'intermediate', 'advanced'] as const).map(level => (
                          <button
                            key={level}
                            style={{ ...genStyles.distBtn, ...(genExperience === level ? genStyles.distBtnActive : {}) }}
                            onClick={() => setGenExperience(level)}
                          >{level.charAt(0).toUpperCase() + level.slice(1)}</button>
                        ))}
                      </div>
                    </div>
                    <div style={genStyles.field}>
                      <label style={genStyles.label}>Training style</label>
                      <div style={genStyles.distRow}>
                        {[{ key: 'easy', label: 'Easy-focused' }, { key: 'intervals', label: 'Structured intervals' }].map(({ key, label }) => (
                          <button
                            key={key}
                            style={{ ...genStyles.distBtn, ...(genTrainingStyle === key ? genStyles.distBtnActive : {}) }}
                            onClick={() => setGenTrainingStyle(key)}
                          >{label}</button>
                        ))}
                      </div>
                      <p style={genStyles.hint}>
                        {genTrainingStyle === 'easy'
                          ? 'Polarised training: ~80% of runs are easy/conversational, with 1 moderate quality session per week (tempo or marathon-pace). Best for building aerobic base and reducing injury risk.'
                          : 'Structured sessions targeting specific energy systems: VO₂max intervals for 5K/10K, or lactate threshold repeats for half/marathon. Higher intensity — suits runners comfortable with hard efforts.'}
                      </p>
                    </div>
                    <div style={genStyles.field}>
                      <label style={genStyles.label}>Additional notes</label>
                      <textarea
                        style={genStyles.textarea}
                        placeholder="Injury history, preferences, anything else…"
                        value={genNotes}
                        onChange={e => setGenNotes(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {genError && <p style={{ color: 'var(--red, #dc2626)', fontSize: 13, margin: 0 }}>{genError}</p>}
              <div style={styles.modalActions}>
                <button style={styles.cancelBtn} onClick={() => setShowGenModal(false)} disabled={genGenerating}>Cancel</button>
                <button
                  style={{ ...styles.confirmBtn, background: canGenerate && !genGenerating ? 'var(--orange)' : 'var(--border)', cursor: canGenerate && !genGenerating ? 'pointer' : 'not-allowed' }}
                  disabled={!canGenerate || genGenerating}
                  onClick={async () => {
                    setGenError('');
                    setGenGenerating(true);
                    try {
                      await api.training.savePlan({
                        distance_km: distKm,
                        race_date: genDate,
                        goal_time: genTime,
                        goal_pace: genPace,
                        weekly_km: genWeeklyKm ? parseFloat(genWeeklyKm) : undefined,
                        days_per_week: genRunningDays.length,
                        running_days: genRunningDays,
                        long_run_day: genLongRunDay,
                        experience: genExperience,
                        training_style: genTrainingStyle,
                        notes: genNotes || undefined,
                      });
                      await api.training.generatePlan();
                      planCache = null;
                      planWeeksCache = null;
                      planInflight = null;
                      setPlanVersion(v => v + 1);
                      setPlanCreatedAt(Date.now());
                      setShowGenModal(false);
                      setHasPlan(true);
                      // Initial "position going in" overview — fire-and-forget so the
                      // plan shows immediately and the summaries fade in when ready
                      setSummariesPending(true);
                      api.training.updateSummaries({ initial: true })
                        .then(r => {
                          if (r.week_summary) setWeekSummary(r.week_summary);
                          if (r.plan_summary) setPlanSummary(r.plan_summary);
                        })
                        .catch(() => {})
                        .finally(() => setSummariesPending(false));
                      loadData();
                    } catch (err: any) {
                      setGenError(err.message ?? 'Failed to generate plan. Please try again.');
                    } finally {
                      setGenGenerating(false);
                    }
                  }}
                >{genGenerating ? 'Generating…' : 'Generate plan'}</button>
              </div>
            </div>
          </div>
        );
      })()}

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

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getMondayOfWeek(offset: number): Date {
  const today = new Date();
  const dow = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((dow + 6) % 7) + offset * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function ThisWeek({ activities }: { activities: Activity[] }) {
  const [offset, setOffset] = useState(0);
  const [planByDate, setPlanByDate] = useState<Record<string, Workout>>(planCache ?? {});
  const [weekActivities, setWeekActivities] = useState<Activity[]>(activities);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  useEffect(() => {
    fetchPlanWorkouts()
      .then(map => setPlanByDate(map))
      .catch(() => {});
  }, []);

  // Sync when Dashboard's activities prop arrives (it's [] on first render, populated after loadData)
  useEffect(() => {
    setWeekActivities(activities);
  }, [activities]);

  // When offset changes, load activities for the week's month(s) via the shared calCache
  useEffect(() => {
    let cancelled = false;
    const monday = getMondayOfWeek(offset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    // Unique months for this week (a week can span two months)
    const monthDates = Array.from(
      new Set([calMonthKey(monday), calMonthKey(sunday)])
    ).map(key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1); });

    // Preload adjacent weeks' months in background
    const prevMon = getMondayOfWeek(offset - 1);
    const nextSun = new Date(getMondayOfWeek(offset + 1));
    nextSun.setDate(nextSun.getDate() + 6);
    fetchCalMonth(prevMon).catch(() => {});
    fetchCalMonth(nextSun).catch(() => {});

    Promise.all(monthDates.map(d => fetchCalMonth(d)))
      .then(results => { if (!cancelled) setWeekActivities(results.flat()); })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [offset]);

  const activityDates = useMemo(() => {
    const set = new Set<string>();
    for (const act of weekActivities) {
      const d = new Date(act.start_date);
      set.add(dateKey(d));
    }
    return set;
  }, [weekActivities]);

  const monday = getMondayOfWeek(offset);
  const isCurrentWeek = offset === 0;
  const mondayKey = dateKey(monday);
  const planWeek = planWeeksCache?.find(w => w.week_start === mondayKey) ?? null;
  const totalPlanWeeks = planWeeksCache?.length ?? null;

  const weekDays = DAY_NAMES.map((day, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dk = dateKey(d);
    const isToday = d.getTime() === today.getTime();
    const workout = planByDate[dk] ?? null;
    const done = activityDates.has(dk);
    return { day, date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), isToday, workout, done };
  });

  const weekLabel = (() => {
    const end = new Date(monday);
    end.setDate(monday.getDate() + 6);
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(monday)} – ${fmt(end)}`;
  })();

  return (
    <div style={{ ...ovStyles.card, flex: 'none', overflow: 'visible' }} className="ov-card">
      <div style={ovStyles.weekHeader}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <p style={{ ...ovStyles.cardTitle, margin: 0 }}>
            {offset < 0 ? 'Past Week' : offset > 0 ? 'Future Week' : 'This Week'}
          </p>
          {planWeek && (
            <span style={ovStyles.weekNumBadge}>
              Week {planWeek.week_number}{totalPlanWeeks ? ` of ${totalPlanWeeks}` : ''}
            </span>
          )}
        </div>
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
              ...(d.done ? ovStyles.weekListRowDone : {}),
            }}
          >
            <div style={ovStyles.weekDayCol}>
              <span style={ovStyles.dayName}>{d.day}</span>
              <span style={ovStyles.dayDate}>{d.date}</span>
            </div>
            <div style={ovStyles.weekInfoCol}>
              {d.workout ? (
                <>
                  <span style={ovStyles.dayType}>
                    {d.workout.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                  </span>
                  {d.workout.description && (
                    <span style={ovStyles.dayDesc}>{d.workout.description}</span>
                  )}
                </>
              ) : (
                <span style={ovStyles.dayTypeRest}>Rest</span>
              )}
            </div>
            <div style={ovStyles.weekKmCol}>
              {d.workout && <span style={ovStyles.dayKm}>{d.workout.km} km</span>}
            </div>
            <div style={ovStyles.weekStatusCol}>
              {d.done && <span style={ovStyles.doneBadge}>✓</span>}
              {d.isToday && !d.done && <span style={ovStyles.todayBadge}>Today</span>}
            </div>
          </div>
        ))}
      </div>
      {(() => {
        const totalKm = weekDays.reduce((sum, d) => sum + (d.workout?.km ?? 0), 0);
        return totalKm > 0 ? (
          <div style={ovStyles.weekTotal}>
            <div style={{ width: 48, flexShrink: 0 }} />
            <div style={{ flex: 1 }} />
            <div style={{ ...ovStyles.weekKmCol, width: 'auto', minWidth: 54 }}>
              <span style={ovStyles.weekTotalKm}>{totalKm} km</span>
            </div>
            <div style={{ width: 42, flexShrink: 0 }} />
          </div>
        ) : null;
      })()}
    </div>
  );
}

interface PlanProgressProps {
  raceDate: string;
  goalTime: string;
  distanceKey: string;
  customKm: string;
  createdAt: number | null;
  activities: Activity[];
  weekSummary?: string | null;
  planSummary?: string | null;
  summariesPending?: boolean;
}

function PlanProgress({ raceDate, goalTime, distanceKey, customKm, createdAt, activities, weekSummary, planSummary, summariesPending }: PlanProgressProps) {
  const [tab, setTab] = useState<'week' | 'plan'>('week');

  const raceDateMs = (() => {
    if (!raceDate) return null;
    const [y, m, d] = raceDate.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  })();
  const now = Date.now();

  const monday = getMondayOfWeek(0);
  const mondayKey = dateKey(monday);

  // Use actual plan structure for week counts (falls back to timestamp arithmetic if cache not ready)
  const totalWeeks = planWeeksCache
    ? planWeeksCache.length
    : ((raceDateMs && createdAt)
      ? Math.max(1, Math.round((raceDateMs - createdAt) / (7 * 24 * 3600 * 1000)))
      : null);
  const doneWeeks = planWeeksCache
    ? planWeeksCache.filter(w => w.week_start < mondayKey).length
    : ((createdAt && totalWeeks !== null)
      ? Math.min(totalWeeks, Math.max(0, Math.round((now - createdAt) / (7 * 24 * 3600 * 1000))))
      : null);
  const planPct = (totalWeeks && doneWeeks !== null) ? Math.round((doneWeeks / totalWeeks) * 100) : 0;

  const todayKey = dateKey(new Date());
  const raceKm = distanceKey === 'custom' ? parseFloat(customKm) || 0 : RACE_DISTANCES[distanceKey]?.km ?? 0;

  // Overall km from the plan
  const totalKm = planWeeksCache
    ? planWeeksCache.reduce((sum, w) => sum + w.workouts.reduce((s, wk) => s + wk.km, 0), raceKm)
    : null;
  // Planned km that sits in the past (proxy for "done" when no activity matching)
  const plannedDoneKm = planWeeksCache
    ? planWeeksCache.reduce((sum, w) => sum + w.workouts.filter(wk => wk.date < todayKey).reduce((s, wk) => s + wk.km, 0), 0)
    : null;

  // This week from the plan
  const sundayKey = (() => { const s = new Date(monday); s.setDate(monday.getDate() + 6); return dateKey(s); })();
  const weekTarget = planWeeksCache
    ? (planWeeksCache.find(w => w.week_start === mondayKey)?.workouts.reduce((s, wk) => s + wk.km, 0) ?? 0)
    : null;
  // Actual km run this week from Strava activities
  const weekDone = Math.round(
    activities
      .filter(a => { const dk = dateKey(new Date(a.start_date)); return dk >= mondayKey && dk <= sundayKey && a.distance > 0 && (a.sport_type || a.type || '').includes('Run'); })
      .reduce((sum, a) => sum + a.distance / 1000, 0)
  );
  const weekPct = weekTarget ? Math.round((weekDone / weekTarget) * 100) : 0;

  const raceDateLabel = raceDateMs
    ? new Date(raceDateMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';

  const distanceLabel = distanceKey === 'custom'
    ? (customKm ? `${customKm} km` : '—')
    : (RACE_DISTANCES[distanceKey]?.label ?? '—');

  return (
    <div style={ovStyles.card} className="ov-card">
      <div style={ovStyles.progressCardHeader}>
        <p style={{ ...ovStyles.cardTitle, margin: 0 }}>Plan Progress</p>
        <div style={ovStyles.progressTabs}>
          <button
            style={{ ...ovStyles.progressTab, ...(tab === 'week' ? ovStyles.progressTabActive : {}) }}
            onClick={() => setTab('week')}
          >This Week</button>
          <button
            style={{ ...ovStyles.progressTab, ...(tab === 'plan' ? ovStyles.progressTabActive : {}) }}
            onClick={() => setTab('plan')}
          >Overall</button>
        </div>
      </div>

      {tab === 'week' && (
        <div style={ovStyles.progressSection}>
          <div style={ovStyles.progressHeader}>
            <span style={ovStyles.progressLabel}>
              {totalWeeks !== null && doneWeeks !== null ? `Week ${doneWeeks} of ${totalWeeks} · ` : ''}
              {weekTarget !== null ? `target ${weekTarget} km` : 'loading…'}
            </span>
            <span style={ovStyles.progressPct}>
              {weekTarget !== null ? `${weekDone} / ${weekTarget} km` : '—'}
            </span>
          </div>
          <div style={ovStyles.progressTrack}>
            <div style={{ ...ovStyles.progressFill, width: `${Math.min(weekPct, 100)}%` }} />
          </div>
          <div style={ovStyles.progressSub}>
            {weekTarget !== null ? `${Math.max(0, weekTarget - weekDone)} km to go this week` : ''}
          </div>
          {weekSummary
            ? <p style={ovStyles.aiSummary}>{weekSummary}</p>
            : summariesPending && <p style={{ ...ovStyles.aiSummary, fontStyle: 'italic', opacity: 0.6 }}>Generating your training summary…</p>}
        </div>
      )}

      {tab === 'plan' && (
        <div style={ovStyles.progressSection}>
          <div style={ovStyles.progressHeader}>
            <span style={ovStyles.progressLabel}>
              {totalWeeks !== null && doneWeeks !== null ? `Week ${doneWeeks} of ${totalWeeks} complete` : 'Overall progress'}
            </span>
            <span style={ovStyles.progressPct}>{planPct}%</span>
          </div>
          <div style={ovStyles.progressTrack}>
            <div style={{ ...ovStyles.progressFill, width: `${planPct}%` }} />
          </div>
          <div style={ovStyles.progressSub}>
            {plannedDoneKm !== null && totalKm !== null
              ? `${Math.round(plannedDoneKm)} km done · ${Math.round(totalKm - plannedDoneKm)} km remaining`
              : 'loading…'}
          </div>
          {planSummary
            ? <p style={ovStyles.aiSummary}>{planSummary}</p>
            : summariesPending && <p style={{ ...ovStyles.aiSummary, fontStyle: 'italic', opacity: 0.6 }}>Generating your training summary…</p>}
        </div>
      )}

      <div style={ovStyles.planStatRow}>
        <div style={ovStyles.planStat}>
          <span style={ovStyles.planStatVal}>{raceDateLabel}</span>
          <span style={ovStyles.planStatLbl}>Race date</span>
        </div>
        <div style={ovStyles.planStat}>
          <span style={ovStyles.planStatVal}>{distanceLabel}</span>
          <span style={ovStyles.planStatLbl}>Distance</span>
        </div>
        <div style={ovStyles.planStat}>
          <span style={ovStyles.planStatVal}>{goalTime || '—'}</span>
          <span style={ovStyles.planStatLbl}>Goal time</span>
        </div>
      </div>
    </div>
  );
}


function ReviewText({ text, skipHeading = false }: { text: string; skipHeading?: boolean }) {
  const elements: React.ReactNode[] = [];
  const lines = text.split('\n');
  let bullets: string[] = [];

  const flushBullets = (key: string) => {
    if (!bullets.length) return;
    elements.push(
      <ul key={key} style={{ margin: '2px 0 6px', paddingLeft: 16, listStyle: 'disc' }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{b}</li>
        ))}
      </ul>
    );
    bullets = [];
  };

  lines.forEach((line, i) => {
    const key = String(i);
    if (line === '---') {
      flushBullets(key);
    } else if (line.startsWith('### ')) {
      flushBullets(key);
      if (!skipHeading) elements.push(
        <p key={key} style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', margin: '8px 0 4px 0' }}>
          {line.slice(4)}
        </p>
      );
    } else if (/^\*\*.+\*\*$/.test(line)) {
      flushBullets(key);
      elements.push(
        <p key={key} style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: '8px 0 2px 0', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {line.slice(2, -2)}
        </p>
      );
    } else if (line.startsWith('- ')) {
      bullets.push(line.slice(2));
    } else if (line.trim()) {
      flushBullets(key);
      elements.push(
        <p key={key} style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0', lineHeight: 1.6 }}>
          {line}
        </p>
      );
    } else {
      flushBullets(key);
    }
  });
  flushBullets('end');

  return <div style={{ paddingTop: 4 }}>{elements}</div>;
}

function RecentActivities({ activities: initialActivities }: { activities: Activity[] }) {
  const [reviews, setReviews] = useState<Record<string, RunReview>>({});
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [manualFailed, setManualFailed] = useState<Set<string>>(new Set());
  const [planRange, setPlanRange] = useState<{ start: string; end: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [allActivities, setAllActivities] = useState<Activity[]>(initialActivities);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Sync initial activities when prop arrives (Dashboard loads them asynchronously)
  useEffect(() => {
    setAllActivities(initialActivities);
    setPage(1);
    setHasMore(true);
  }, [initialActivities]);

  useEffect(() => {
    api.training.allReviews().then(list => {
      const map: Record<string, RunReview> = {};
      list.forEach(r => { map[r.activity_id] = r; reviewDone.add(r.activity_id); });
      setReviews(map);
      setReviewsLoaded(true);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchPlanWorkouts().then(() => {
      if (!planWeeksCache?.length) return;
      let start = planWeeksCache[0].week_start;
      let end = planWeeksCache[0].week_end;
      for (const w of planWeeksCache) {
        if (w.week_start < start) start = w.week_start;
        if (w.week_end > end) end = w.week_end;
      }
      setPlanRange({ start, end });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    notifyReviewUpdate = (id, review) => {
      setGenerating(prev => { const n = new Set(prev); n.delete(id); return n; });
      if (review) setReviews(prev => ({ ...prev, [id]: review }));
    };
    return () => { notifyReviewUpdate = null; };
  }, []);

  // Auto-enqueue eligible runs; must wait for reviews so cached ones never re-generate
  useEffect(() => {
    if (!reviewsLoaded || !planRange) return;
    const pending: string[] = [];
    for (const a of allActivities) {
      const id = String(a.id);
      if (reviewDone.has(id) || !isAutoReviewEligible(a, planRange.start, planRange.end)) continue;
      enqueueReview(id);
      // Queued now or already in flight from a previous mount — either way show the spinner
      if (reviewCurrent === id || reviewQueue.includes(id)) pending.push(id);
      if (pending.length >= 10) break; // safety valve per load
    }
    if (pending.length) setGenerating(prev => { const n = new Set(prev); pending.forEach(i => n.add(i)); return n; });
  }, [allActivities, reviewsLoaded, planRange]);

  function generateManually(actId: string) {
    setManualFailed(prev => { const n = new Set(prev); n.delete(actId); return n; });
    setGenerating(prev => new Set(prev).add(actId));
    api.training.generateReview(actId)
      .then(r => { reviewDone.add(actId); setReviews(prev => ({ ...prev, [actId]: r.review })); })
      .catch(() => setManualFailed(prev => new Set(prev).add(actId)))
      .finally(() => setGenerating(prev => { const n = new Set(prev); n.delete(actId); return n; }));
  }

  function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    api.training.activities({ page: nextPage, per_page: 20 })
      .then(acts => {
        if (acts.length === 0) {
          setHasMore(false);
        } else {
          setAllActivities(prev => {
            const ids = new Set(prev.map(a => a.id));
            return [...prev, ...acts.filter(a => !ids.has(a.id))];
          });
          setPage(nextPage);
          if (acts.length < 20) setHasMore(false);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }

  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;
    const list = listEl;
    function onListScroll() {
      if (list.scrollHeight - list.scrollTop - list.clientHeight < 150) loadMore();
    }
    function onWindowScroll() {
      const rect = list.getBoundingClientRect();
      if (rect.bottom - window.innerHeight < 150) loadMore();
    }
    list.addEventListener('scroll', onListScroll);
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    return () => {
      list.removeEventListener('scroll', onListScroll);
      window.removeEventListener('scroll', onWindowScroll);
    };
  });

  const visibleActivities = allActivities;

  return (
    <div style={{ ...ovStyles.card, ...ovStyles.runsCard }} className="ov-card runs-card">
      <div className="runs-card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <p style={{ ...ovStyles.cardTitle, margin: 0 }}>Recent Activities</p>
        <button
          style={ovStyles.backToTopBtn}
          onClick={() => {
            listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          ↑ Top
        </button>
      </div>
      <div style={ovStyles.runsList} className="runs-list" ref={listRef}>
        {allActivities.length === 0 && <p style={ovStyles.empty}>No activities yet</p>}
        {visibleActivities.map(a => {
          const date = new Date(a.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          const sportLabel = formatSportType(a.sport_type || a.type || 'Activity');
          const hasDistance = a.distance > 0;
          const actId = String(a.id);
          const review = reviews[actId];
          const isOpen = expanded === actId;
          return (
            <div key={a.id} style={ovStyles.runCard}>
              <div style={ovStyles.runCardHeader}>
                <div style={ovStyles.runCardMeta}>
                  <span style={ovStyles.activityType}>{sportLabel}</span>
                  <span style={ovStyles.runDate}>{date}</span>
                </div>
                {review && (
                  <button
                    onClick={() => setExpanded(isOpen ? null : actId)}
                    style={ovStyles.reviewToggle}
                    aria-label={isOpen ? 'Collapse review' : 'Expand review'}
                  >
                    {isOpen ? '▲' : '▼'}
                  </button>
                )}
              </div>
              <p style={ovStyles.runName}>{a.name}</p>
              <div style={ovStyles.runStats}>
                {hasDistance && (
                  <div style={ovStyles.runStat}>
                    <span style={ovStyles.runStatVal}>{metersToKm(a.distance)}</span>
                    <span style={ovStyles.runStatLbl}>km</span>
                  </div>
                )}
                <div style={ovStyles.runStat}>
                  <span style={ovStyles.runStatVal}>{secondsToTime(a.moving_time)}</span>
                  <span style={ovStyles.runStatLbl}>time</span>
                </div>
                {hasDistance && (
                  <div style={ovStyles.runStat}>
                    <span style={ovStyles.runStatVal}>{pacePerKm(a.distance, a.moving_time)}</span>
                    <span style={ovStyles.runStatLbl}>pace</span>
                  </div>
                )}
                {a.total_elevation_gain > 0 && (
                  <div style={ovStyles.runStat}>
                    <span style={ovStyles.runStatVal}>{Math.round(a.total_elevation_gain)} m</span>
                    <span style={ovStyles.runStatLbl}>elev gain</span>
                  </div>
                )}
                {a.average_heartrate && (
                  <div style={ovStyles.runStat}>
                    <span style={ovStyles.runStatVal}>{Math.round(a.average_heartrate)}</span>
                    <span style={ovStyles.runStatLbl}>avg bpm</span>
                  </div>
                )}
              </div>
              {review && !isOpen && review.summary && (
                <p style={{ ...ovStyles.aiSummary, fontSize: 15 }}>{review.summary}</p>
              )}
              {review && isOpen && (
                <div style={ovStyles.reviewBody}>
                  <ReviewText text={review.review_text} skipHeading />
                </div>
              )}
              {!review && generating.has(actId) && (
                <p style={{ ...ovStyles.aiSummary, fontSize: 14, fontStyle: 'italic', opacity: 0.6 }}>Generating AI review…</p>
              )}
              {!review && !generating.has(actId) && (
                <button style={ovStyles.genReviewBtn} onClick={() => generateManually(actId)}>
                  {manualFailed.has(actId) ? 'Review failed — retry' : 'Generate AI review'}
                </button>
              )}
            </div>
          );
        })}
        {loadingMore && (
          <p style={{ ...ovStyles.empty, padding: '12px 0' }}>Loading…</p>
        )}
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
  weekInfoCol: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  weekKmCol: { width: 54, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
  dayDesc: { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 },
  weekStatusCol: { display: 'flex', alignItems: 'center', width: 42, flexShrink: 0, justifyContent: 'flex-end' },
  dayName: { fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase' as const },
  dayDate: { fontSize: 11, color: 'var(--text-muted)' },
  dayType: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  dayTypeRest: { color: 'var(--text-muted)', fontWeight: 400 },
  dayKm: { fontSize: 13, fontWeight: 700, color: 'var(--orange)' },
  doneBadge: { fontSize: 12, color: '#4ade80', fontWeight: 700 },
  todayBadge: { fontSize: 11, color: 'var(--orange)', fontWeight: 600 },
  progressCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  progressTabs: {
    display: 'flex', background: 'var(--surface-2)', borderRadius: 8,
    padding: 3, gap: 2, border: '1px solid var(--border)',
  },
  progressTab: {
    background: 'none', border: 'none', color: 'var(--text-muted)',
    fontSize: 12, fontWeight: 500, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
  },
  progressTabActive: {
    background: 'var(--surface)', color: 'var(--text)', fontWeight: 600,
  },
  progressSection: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 },
  progressHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  progressLabel: { fontSize: 13, color: 'var(--text-muted)' },
  progressPct: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  progressTrack: { height: 6, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--orange)', borderRadius: 99, transition: 'width 0.4s ease' },
  progressSub: { fontSize: 12, color: 'var(--border)' },
  aiSummary: { fontSize: 16, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, padding: '12px 0 0', flex: 1 },
  planStatRow: { display: 'flex', gap: 0, borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 },
  planStat: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' },
  planStatVal: { fontSize: 16, fontWeight: 700, color: 'var(--text)', textAlign: 'center' as const },
  planStatLbl: { fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' as const },
  runsList: { flex: 1, overflowY: 'auto' as const, display: 'flex', flexDirection: 'column', gap: 10, paddingRight: 10 },
  empty: { color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: 24 },
  runCard: {
    background: 'var(--surface-2)', borderRadius: 10, padding: '14px 16px',
    display: 'flex', flexDirection: 'column', gap: 8,
    border: '1px solid var(--border)',
  },
  runCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  runCardMeta: { display: 'flex', alignItems: 'center', gap: 10 },
  runDate: { fontSize: 12, color: 'var(--text-muted)' },
  activityType: { fontSize: 11, fontWeight: 700, color: 'var(--orange)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  runName: { fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: 0 },
  runStats: { display: 'flex', gap: 20, flexWrap: 'wrap' as const, paddingTop: 4, borderTop: '1px solid var(--border)' },
  runStat: { display: 'flex', flexDirection: 'column', gap: 2 },
  runStatVal: { fontSize: 14, fontWeight: 700, color: 'var(--text)' },
  runStatLbl: { fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  reviewToggle: {
    fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none',
    cursor: 'pointer', padding: '2px 4px', lineHeight: 1,
  },
  reviewBody: {
    borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 2,
  },
  weekNumBadge: { fontSize: 12, fontWeight: 600, color: 'var(--orange)', opacity: 0.85 },
  weekTotal: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 10px 2px', marginTop: 8, borderTop: '1px solid var(--border)' },
  weekTotalKm: { fontSize: 13, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' as const },
  backToTopBtn: {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)',
    borderRadius: 6, height: 26, padding: '0 10px', cursor: 'pointer',
    fontSize: 12, fontWeight: 500, flexShrink: 0,
  },
  genReviewBtn: {
    alignSelf: 'flex-start', background: 'none', border: '1px solid var(--border)',
    color: 'var(--orange)', borderRadius: 6, height: 26, padding: '0 10px',
    cursor: 'pointer', fontSize: 12, fontWeight: 500,
  },
};

// ── Calendar ──────────────────────────────────────────────────────────────────

// Module-level cache so it survives CalendarView unmounting (e.g. switching tabs)
const calCache: Record<string, Activity[]> = {};
const calInflight: Record<string, Promise<Activity[]>> = {};
const calFailed: Record<string, number> = {}; // key → timestamp; prevents hammering on rate-limit
const calFailedBackoff: Record<string, number> = {}; // key → backoff duration for that failure

function calMonthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fetchCalMonth(d: Date): Promise<Activity[]> {
  const key = calMonthKey(d);
  if (calCache[key]) return Promise.resolve(calCache[key]);
  if (key in calInflight) return calInflight[key];
  if (calFailed[key] && Date.now() - calFailed[key] < (calFailedBackoff[key] ?? 15_000))
    return Promise.reject(new Error('rate limited'));
  const year = d.getFullYear();
  const month = d.getMonth();
  const monthStart = new Date(year, month, 1);
  if (monthStart.getTime() > Date.now()) {
    calCache[key] = [];
    return Promise.resolve([]);
  }
  const after = Math.floor(monthStart.getTime() / 1000);
  const before = Math.floor(new Date(year, month + 1, 1).getTime() / 1000);
  const promise = api.training.activities({ after, before, per_page: 100 })
    .then(acts => {
      calCache[key] = acts;
      delete calInflight[key];
      delete calFailed[key];
      delete calFailedBackoff[key];
      return acts;
    })
    .catch(err => {
      calFailed[key] = Date.now();
      // Real rate-limit responses need a much longer cooldown than a one-off network blip,
      // otherwise the retry just gets rate-limited again and the UI keeps flipping.
      calFailedBackoff[key] = err?.status === 429 ? 5 * 60_000 : 15_000;
      delete calInflight[key];
      throw err;
    });
  calInflight[key] = promise;
  return promise;
}

let planCache: Record<string, Workout> | null = null;
let planWeeksCache: import('../lib/api').TrainingWeek[] | null = null;
let planInflight: Promise<Record<string, Workout>> | null = null;

function fetchPlanWorkouts(): Promise<Record<string, Workout>> {
  if (planCache) return Promise.resolve(planCache);
  if (planInflight) return planInflight;
  planInflight = api.training.weeks().then(weeks => {
    planWeeksCache = weeks;
    const map: Record<string, Workout> = {};
    for (const w of weeks) for (const wk of w.workouts) map[wk.date] = wk;
    planCache = map;
    planInflight = null;
    return map;
  }).catch(err => { planInflight = null; throw err; });
  return planInflight;
}

function dateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Auto AI review queue ──────────────────────────────────────────────────────
// Module-level so tab switches / remounts don't re-request. Concurrency 1: each
// generation is a Strava fetch + LLM call, so sequential keeps rate limits safe
// while never blocking screen load.
const reviewDone = new Set<string>();
const reviewFailedAt: Record<string, number> = {}; // id → ts; no auto-retry for 10 min
const reviewQueue: string[] = [];
let reviewCurrent: string | null = null;
let notifyReviewUpdate: ((id: string, review: RunReview | null) => void) | null = null;

function pumpReviewQueue() {
  if (reviewCurrent) return;
  const id = reviewQueue.shift();
  if (!id) return;
  reviewCurrent = id;
  api.training.generateReview(id)
    .then(r => { reviewDone.add(id); notifyReviewUpdate?.(id, r.review); })
    .catch(() => { reviewFailedAt[id] = Date.now(); notifyReviewUpdate?.(id, null); })
    .finally(() => { reviewCurrent = null; pumpReviewQueue(); });
}

function enqueueReview(id: string) {
  if (reviewDone.has(id) || reviewCurrent === id || reviewQueue.includes(id)) return;
  if (reviewFailedAt[id] && Date.now() - reviewFailedAt[id] < 600_000) return;
  reviewQueue.push(id);
  pumpReviewQueue();
}

// Auto-review scope: runs inside the plan's date range from the last 30 days.
// Everything else gets a manual "Generate AI review" button instead.
function isAutoReviewEligible(a: Activity, planStart: string | null, planEnd: string | null): boolean {
  if (!(a.sport_type || a.type || '').includes('Run')) return false;
  if (!planStart || !planEnd) return false;
  const d = (a.start_date_local || a.start_date).slice(0, 10);
  if (d < planStart || d > planEnd) return false;
  return Date.now() - new Date(a.start_date).getTime() < 30 * 86_400_000;
}

function icsEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function generateICS(weeks: import('../lib/api').TrainingWeek[]): string {
  const calId = `marathon-training-${Date.now()}@marathon-trainer`;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Marathon Trainer//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Marathon Training Plan',
    'X-WR-CALDESC:Your personalised marathon training plan from Marathon Trainer',
    'X-APPLE-CALENDAR-COLOR:#F97316',
    `X-WR-RELCALID:${calId}`,
  ];
  for (const week of weeks) {
    for (const workout of week.workouts) {
      const [y, m, d] = workout.date.split('-').map(Number);
      const dtStart = `${String(y)}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
      const nextDay = new Date(y, m - 1, d + 1);
      const dtEnd = `${nextDay.getFullYear()}${String(nextDay.getMonth() + 1).padStart(2, '0')}${String(nextDay.getDate()).padStart(2, '0')}`;
      const typeLabel = workout.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      lines.push(
        'BEGIN:VEVENT',
        `DTSTART;VALUE=DATE:${dtStart}`,
        `DTEND;VALUE=DATE:${dtEnd}`,
        `SUMMARY:${icsEscape(`${typeLabel} — ${workout.km} km`)}`,
        ...(workout.description ? [`DESCRIPTION:${icsEscape(workout.description)}`] : []),
        `CATEGORIES:Marathon Training`,
        `UID:mt-${workout.date}-${workout.type}@marathon-trainer`,
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function CalendarView() {
  const todayStart = (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); })();
  const [current, setCurrent] = useState(todayStart);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);
  const [selectedWorkout, setSelectedWorkout] = useState<Workout | null>(null);
  const [monthActivities, setMonthActivities] = useState<Activity[]>([]);
  const [prevActivities, setPrevActivities] = useState<Activity[]>([]);
  const [nextActivities, setNextActivities] = useState<Activity[]>([]);
  const [monthLoadFailed, setMonthLoadFailed] = useState(false);
  const [prevLoadFailed, setPrevLoadFailed] = useState(false);
  const [nextLoadFailed, setNextLoadFailed] = useState(false);
  const [planByDate, setPlanByDate] = useState<Record<string, Workout>>(planCache ?? {});
  const [showExportModal, setShowExportModal] = useState(false);
  const [monthLoading, setMonthLoading] = useState(false);

  useEffect(() => {
    setSelectedActivity(null);
    let cancelled = false;

    const prev = new Date(current.getFullYear(), current.getMonth() - 1, 1);
    const next = new Date(current.getFullYear(), current.getMonth() + 1, 1);

    // Sync adjacent months from cache immediately so overflow cells are correct right away
    setPrevActivities(calCache[calMonthKey(prev)] ?? []);
    setNextActivities(calCache[calMonthKey(next)] ?? []);
    setPrevLoadFailed(false);
    setNextLoadFailed(false);

    const key = calMonthKey(current);
    if (calCache[key]) {
      setMonthActivities(calCache[key]);
      setMonthLoadFailed(false);
    } else {
      setMonthLoading(true);
      setMonthLoadFailed(false);
      fetchCalMonth(current)
        .then(acts => { if (!cancelled) setMonthActivities(acts); })
        .catch(() => { if (!cancelled) { setMonthActivities([]); setMonthLoadFailed(true); } })
        .finally(() => { if (!cancelled) setMonthLoading(false); });
    }
    fetchPlanWorkouts()
      .then(map => { if (!cancelled) setPlanByDate(map); })
      .catch(() => {});
    // Preload adjacent months (fetch if not cached, then update state)
    fetchCalMonth(prev).then(acts => { if (!cancelled) setPrevActivities(acts); }).catch(() => { if (!cancelled) setPrevLoadFailed(true); });
    fetchCalMonth(next).then(acts => { if (!cancelled) setNextActivities(acts); }).catch(() => { if (!cancelled) setNextLoadFailed(true); });
    // Preload one extra month in each direction so overflow cells are cached before the user navigates there
    fetchCalMonth(new Date(current.getFullYear(), current.getMonth() - 2, 1)).catch(() => {});
    fetchCalMonth(new Date(current.getFullYear(), current.getMonth() + 2, 1)).catch(() => {});
    fetchCalMonth(todayStart).catch(() => {});
    return () => { cancelled = true; };
  }, [current]);

  const activitiesByDate = useMemo(() => {
    const seen = new Set<number>();
    const map: Record<string, Activity[]> = {};
    for (const act of [...prevActivities, ...monthActivities, ...nextActivities]) {
      if (seen.has(act.id)) continue;
      seen.add(act.id);
      const d = new Date(act.start_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!map[key]) map[key] = [];
      map[key].push(act);
    }
    return map;
  }, [prevActivities, monthActivities, nextActivities]);

  const year = current.getFullYear();
  const month = current.getMonth();
  const today = new Date();

  const rawFirstDay = new Date(year, month, 1).getDay();
  const firstDayMon = (rawFirstDay + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  type CalCell = { day: number; offset: -1 | 0 | 1 };
  const cells: CalCell[] = [
    ...Array.from({ length: firstDayMon }, (_, i) => ({
      day: daysInPrevMonth - firstDayMon + 1 + i,
      offset: -1 as const,
    })),
    ...Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, offset: 0 as const })),
  ];
  let nextDay = 1;
  while (cells.length % 7 !== 0) cells.push({ day: nextDay++, offset: 1 as const });

  const monthLabel = current.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const isCurrentMonth = calMonthKey(current) === calMonthKey(todayStart);

  function prev() { setCurrent(new Date(year, month - 1, 1)); }
  function next() { setCurrent(new Date(year, month + 1, 1)); }

  function exportToCalendar() {
    fetchPlanWorkouts().then(() => {
      if (!planWeeksCache?.length) return;
      const ics = generateICS(planWeeksCache);
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'running-plan.ics';
      a.click();
      URL.revokeObjectURL(url);
      setShowExportModal(true);
    });
  }

  return (
    <>
    <div>
      <div style={calStyles.header} className="cal-header">
        <button style={calStyles.navBtn} onClick={prev}>&#8249;</button>
        <span style={calStyles.monthLabel} className="cal-month-label">{monthLabel}</span>
        <button style={calStyles.navBtn} onClick={next}>&#8250;</button>
        {!isCurrentMonth && (
          <button style={calStyles.todayBtn} onClick={() => setCurrent(todayStart)}>Today</button>
        )}
        {monthLoading && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>Loading…</span>}
        {monthLoadFailed && !monthLoading && (
          <span style={{ fontSize: 12, color: 'var(--red, #dc2626)', marginLeft: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            Couldn't load activities
            <button
              style={{ ...calStyles.todayBtn, padding: '2px 8px' }}
              onClick={() => {
                delete calFailed[calMonthKey(current)];
                setMonthLoading(true);
                fetchCalMonth(current)
                  .then(acts => { setMonthActivities(acts); setMonthLoadFailed(false); })
                  .catch(() => setMonthLoadFailed(true))
                  .finally(() => setMonthLoading(false));
              }}
            >
              Retry
            </button>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button style={calStyles.uploadCalBtn} onClick={exportToCalendar} className="cal-export-btn">
          Export to calendar
        </button>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }} className="cal-layout">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={calStyles.grid}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <div key={d} style={calStyles.dayHeader} className="cal-cell">
                <span className="cal-day-full">{d}</span>
                <span className="cal-day-abbr">{d[0]}</span>
              </div>
            ))}

            {cells.map(({ day, offset }, i) => {
              if (offset !== 0) {
                const adjDate = new Date(year, month + offset, day);
                const adjKey = `${adjDate.getFullYear()}-${String(adjDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const adjActivities = activitiesByDate[adjKey] ?? [];
                const adjWorkout = planByDate[adjKey];
                const adjIsPast = adjDate < today;
                const adjLoadFailed = offset === -1 ? prevLoadFailed : nextLoadFailed;
                const adjMissed = adjIsPast && adjActivities.length === 0 && !adjLoadFailed;
                return (
                  <div key={adjKey} style={calStyles.overflowCell} className="cal-cell">
                    <span style={calStyles.overflowDayNum}>{day}</span>
                    <div className="cal-runs" style={{ opacity: 0.5 }}>
                      {adjWorkout && (
                        <div
                          className={['cal-plan-pill', adjIsPast && adjActivities.length > 0 ? 'cal-plan-pill-done' : '', adjMissed ? 'cal-plan-pill-missed' : ''].filter(Boolean).join(' ')}
                          style={{
                            ...calStyles.planPill,
                            ...(adjIsPast && adjActivities.length > 0 ? calStyles.planPillDone : {}),
                            ...(adjMissed ? calStyles.planPillMissed : {}),
                          }}
                          onClick={() => { setSelectedWorkout(adjWorkout); setSelectedActivity(null); }}
                        >
                          <span style={calStyles.planType} className="cal-plan-type">{adjWorkout.type}</span>
                          <span style={calStyles.planKm} className="cal-plan-km">{adjWorkout.km} km</span>
                        </div>
                      )}
                      {adjActivities.map(act => (
                        <div
                          key={act.id}
                          style={{ ...calStyles.runPill, ...(selectedActivity?.id === act.id ? calStyles.runPillActive : {}) }}
                          className={`cal-run-pill${selectedActivity?.id === act.id ? ' cal-run-pill-active' : ''}`}
                          onClick={() => { setSelectedActivity(act); setSelectedWorkout(null); }}
                          onDoubleClick={() => setSelectedActivity(null)}
                        >
                          <span style={calStyles.runDist} className="cal-run-dist">
                            {act.distance > 0 ? `${metersToKm(act.distance)} km` : formatSportType(act.sport_type || act.type || 'Activity')}
                          </span>
                          <span style={calStyles.runName} className="cal-run-name">{act.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const dayActivities = activitiesByDate[key] ?? [];
              const plannedWorkout = planByDate[key];
              const cellDate = new Date(year, month, day);
              const isToday = today.toDateString() === cellDate.toDateString();
              const isFuture = cellDate > today;
              const isPast = cellDate < today && !isToday;
              const isMissed = isPast && dayActivities.length === 0 && !monthLoadFailed;
              return (
                <div key={key} style={{ ...calStyles.cell, ...(isFuture ? calStyles.futureCell : {}) }} className="cal-cell">
                  <span style={{ ...calStyles.dayNum, ...(isToday ? calStyles.todayNum : {}) }}>{day}</span>
                  <div className="cal-runs">
                    {plannedWorkout && (
                      <div
                        className={['cal-plan-pill', isPast && dayActivities.length > 0 ? 'cal-plan-pill-done' : '', isMissed ? 'cal-plan-pill-missed' : ''].filter(Boolean).join(' ')}
                        style={{
                          ...calStyles.planPill,
                          ...(selectedWorkout?.date === plannedWorkout.date ? calStyles.planPillActive : {}),
                          ...(isPast && dayActivities.length > 0 ? calStyles.planPillDone : {}),
                          ...(isMissed ? calStyles.planPillMissed : {}),
                        }}
                        onClick={() => { setSelectedWorkout(plannedWorkout); setSelectedActivity(null); }}
                      >
                        <span style={calStyles.planType} className="cal-plan-type">{plannedWorkout.type}</span>
                        <span style={calStyles.planKm} className="cal-plan-km">{plannedWorkout.km} km</span>
                      </div>
                    )}
                    {dayActivities.map(act => (
                      <div
                        key={act.id}
                        style={{ ...calStyles.runPill, ...(selectedActivity?.id === act.id ? calStyles.runPillActive : {}) }}
                        className={`cal-run-pill${selectedActivity?.id === act.id ? ' cal-run-pill-active' : ''}`}
                        onClick={() => { setSelectedActivity(act); setSelectedWorkout(null); }}
                        onDoubleClick={() => setSelectedActivity(null)}
                      >
                        <span style={calStyles.runDist} className="cal-run-dist">
                          {act.distance > 0 ? `${metersToKm(act.distance)} km` : formatSportType(act.sport_type || act.type || 'Activity')}
                        </span>
                        <span style={calStyles.runName} className="cal-run-name">{act.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {selectedWorkout && (
          <WorkoutDetail workout={selectedWorkout} onClose={() => setSelectedWorkout(null)} />
        )}
        {selectedActivity && !selectedWorkout && (
          <ActivityDetail activity={selectedActivity} onClose={() => setSelectedActivity(null)} />
        )}
      </div>
    </div>

    {showExportModal && (
      <div style={styles.overlay}>
        <div style={{ ...styles.modal, maxWidth: 420 }}>
          <h2 style={styles.modalTitle}>Plan downloaded</h2>
          <p style={{ ...styles.modalBody, marginBottom: 12 }}>
            Open <strong>running-plan.ics</strong> in your calendar app:
          </p>
          <div style={calStyles.importSteps}>
            {[
              { name: 'Apple Calendar', steps: 'Double-click the file' },
              { name: 'Google Calendar', steps: 'Settings → Import → select the file' },
              { name: 'Outlook (new)', steps: null, link: { href: 'https://outlook.live.com/calendar/', label: 'outlook.live.com/calendar', after: ' → Add calendar → Upload from file' } },
              { name: 'Outlook (classic)', steps: 'File → Open & Export → Import/Export' },
            ].map(item => (
              <div key={item.name} style={calStyles.importItem}>
                <span style={calStyles.importName}>{item.name}</span>
                <span style={calStyles.importDesc}>
                  {item.link ? (
                    <><a href={item.link.href} target="_blank" rel="noreferrer" style={calStyles.importLink}>{item.link.label}</a>{item.link.after}</>
                  ) : item.steps}
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '12px 0 0' }}>
            To remove all events later, delete the "Marathon Training Plan" calendar that gets created on import.
          </p>
          <div style={styles.modalActions}>
            <button style={{ ...styles.confirmBtn, background: 'var(--orange)' }} onClick={() => setShowExportModal(false)}>
              Got it
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function WorkoutDetail({ workout, onClose }: { workout: Workout; onClose: () => void }) {
  const [year, mon, day] = workout.date.split('-').map(Number);
  const date = new Date(year, mon - 1, day).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const typeLabel = workout.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div style={calStyles.detailPanel} className="cal-detail-panel">
      <div style={calStyles.detailHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={calStyles.detailDate}>{date}</p>
          <p style={calStyles.detailName}>{typeLabel} · {workout.km} km</p>
        </div>
        <button style={calStyles.closeBtn} onClick={onClose} aria-label="Close">&#10005;</button>
      </div>
      <div style={calStyles.detailStats}>
        <div style={calStyles.detailRow}>
          <span style={calStyles.detailLabel}>Type</span>
          <span style={calStyles.detailValue}>{typeLabel}</span>
        </div>
        <div style={calStyles.detailRow}>
          <span style={calStyles.detailLabel}>Distance</span>
          <span style={calStyles.detailValue}>{workout.km} km</span>
        </div>
        <div style={{ ...calStyles.detailRow, flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span style={calStyles.detailLabel}>Instructions</span>
          <span style={{ ...calStyles.detailValue, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)' }}>{workout.description}</span>
        </div>
      </div>
    </div>
  );
}

function ActivityDetail({ activity: run, onClose }: { activity: Activity; onClose: () => void }) {
  const [review, setReview] = useState<RunReview | null>(null);
  const [genState, setGenState] = useState<'idle' | 'generating' | 'error'>('idle');

  useEffect(() => {
    setReview(null);
    setGenState('idle');
    api.training.getReview(run.id).then(setReview).catch(() => {});
  }, [run.id]);

  function generateReview() {
    setGenState('generating');
    api.training.generateReview(run.id)
      .then(r => { setReview(r.review); setGenState('idle'); })
      .catch(() => setGenState('error'));
  }

  const date = new Date(run.start_date).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const sportLabel = run.sport_type || run.type || 'Activity';

  const rows: { label: string; value: string }[] = [
    { label: 'Type', value: sportLabel },
    ...(run.distance > 0 ? [{ label: 'Distance', value: `${metersToKm(run.distance)} km` }] : []),
    { label: 'Time', value: secondsToTime(run.moving_time) },
    ...(run.distance > 0 ? [{ label: 'Pace', value: pacePerKm(run.distance, run.moving_time) }] : []),
    ...(run.total_elevation_gain > 0 ? [{ label: 'Elevation', value: `${Math.round(run.total_elevation_gain)} m` }] : []),
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

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 4 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--orange)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 2px' }}>AI Review</p>
        {review ? (
          <>
            {review.summary && <p style={{ ...ovStyles.aiSummary, fontSize: 15, padding: 0 }}>{review.summary}</p>}
            <ReviewText text={review.review_text} skipHeading />
          </>
        ) : genState === 'generating' ? (
          <p style={{ ...ovStyles.aiSummary, fontSize: 14, fontStyle: 'italic', opacity: 0.6, padding: 0 }}>Generating review…</p>
        ) : (
          <button style={{ ...ovStyles.genReviewBtn, marginTop: 4 }} onClick={generateReview}>
            {genState === 'error' ? 'Review failed — retry' : 'Generate AI review'}
          </button>
        )}
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
  uploadCalBtn: {
    height: 32, padding: '0 14px', borderRadius: 6, fontSize: 13, fontWeight: 500,
    background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  importSteps: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  importItem: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  importName: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  importDesc: { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 },
  importLink: { color: 'var(--orange)', textDecoration: 'none' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  dayHeader: {
    background: 'var(--surface)', padding: '8px 0',
    fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
    textAlign: 'center',
    borderRight: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
  },
  overflowCell: {
    background: 'var(--bg)', minHeight: 120,
    padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4,
    minWidth: 0, overflow: 'hidden',
    borderRight: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
  },
  overflowDayNum: {
    fontSize: 13, fontWeight: 500, color: 'var(--border)',
    alignSelf: 'flex-end', lineHeight: 1,
  },
  cell: {
    background: 'var(--surface)', minHeight: 120,
    padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4,
    minWidth: 0, overflow: 'hidden',
    borderRight: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
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
  planPill: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px dashed var(--border)',
    borderRadius: 4,
    padding: '2px 6px',
    marginBottom: 2,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  planPillActive: {
    background: 'rgba(255,255,255,0.10)',
    borderColor: 'var(--text-muted)',
  },
  planPillDone: {
    borderColor: '#4caf50',
    color: '#4caf50',
  },
  planPillMissed: {
    borderColor: '#e53935',
    color: '#e53935',
    opacity: 0.7,
  },
  planType: { textTransform: 'capitalize' as const, fontWeight: 600 },
  planKm: {},
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
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    zIndex: 200, padding: 24, overflowY: 'auto',
  },
  modal: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 16, padding: '32px 28px', maxWidth: 400, width: '100%',
    display: 'flex', flexDirection: 'column', gap: 16,
    maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', margin: 'auto',
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
  noPlanWrap: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  noPlanCard: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 16, padding: '48px 40px', maxWidth: 440, width: '100%',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center',
  },
  noPlanIcon: { fontSize: 48, lineHeight: 1 },
  noPlanTitle: { fontSize: 22, fontWeight: 700, color: 'var(--text)', margin: 0 },
  noPlanBody: { fontSize: 15, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 },
  noPlanActions: { display: 'flex', gap: 12, marginTop: 8, width: '100%' },
  noPlanGenBtn: {
    flex: 1, padding: '12px 0', borderRadius: 10, background: 'var(--orange)',
    border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer',
  },
  noPlanUploadBtn: {
    flex: 1, padding: '12px 0', borderRadius: 10, background: 'none',
    border: '1px solid var(--border)', color: 'var(--text)', fontSize: 15, fontWeight: 500, cursor: 'pointer',
  },
  progressTrack: {
    width: '100%', height: 6, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden',
  },
  progressFill: {
    height: '100%', background: 'var(--orange)', transition: 'width 0.6s ease',
  },
};

const genStyles: Record<string, React.CSSProperties> = {
  field: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' },
  label: { fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  linked: { fontSize: 11, fontWeight: 500, color: 'var(--orange)', textTransform: 'none', letterSpacing: 0, marginLeft: 6 },
  distRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  distBtn: {
    padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
    background: 'none', border: '1px solid var(--border)', color: 'var(--text)', transition: 'all 0.15s',
  },
  distBtnActive: {
    background: 'var(--orange)', border: '1px solid var(--orange)', color: '#fff', fontWeight: 600,
  },
  input: {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
    fontSize: 14, outline: 'none', boxSizing: 'border-box',
  },
  timePaceRow: { display: 'flex', alignItems: 'flex-end', gap: 10 },
  timePaceField: { flex: 1, display: 'flex', flexDirection: 'column', gap: 6 },
  timePaceSep: { fontSize: 18, color: 'var(--text-muted)', paddingBottom: 10, flexShrink: 0 },
  inputLabel: { fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 },
  hint: { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 },
  textarea: {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
    fontSize: 14, outline: 'none', boxSizing: 'border-box' as const,
    height: 80, resize: 'vertical' as const, fontFamily: 'inherit',
  },
};
