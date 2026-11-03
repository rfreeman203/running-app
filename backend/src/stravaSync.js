const axios = require('axios');
const db = require('./db');
const { track } = require('./timing');

// Strava activities are mirrored into the `activities` table so read routes never wait on
// Strava. The frontend calls POST /training/sync once per dashboard load (and on tab
// refocus); that's the only regular path that talks to Strava's activity list.

const STRAVA_API = 'https://www.strava.com/api/v3';
const PAGE_SIZE = 200;      // Strava's max per_page
const MAX_PAGES = 5;        // bound any one sync so a huge account can't burn the rate limit
const RESYNC_DAYS = 7;      // re-check this many days behind the newest run for edits/deletes
const BACKFILL_DAYS = 90;   // first sync reaches back at least this far…
const PRE_PLAN_DAYS = 30;   // …and at least this far before the plan starts
const DEDUPE_MS = 5000;     // absorbs StrictMode double-mounts / double clicks — not a freshness throttle
const HISTORY_EXHAUSTED = '0000-01-01'; // strava_covered_from once the athlete's whole history is stored

async function getFreshStravaToken(userId, { force = false } = {}) {
  const user = await db.users.findBy('id', userId);
  if (!user?.strava_access_token) throw Object.assign(new Error('Strava not connected'), { code: 'NO_STRAVA' });

  const isExpired = force || Math.floor(Date.now() / 1000) > user.strava_token_expires_at - 300;
  if (!isExpired) return user.strava_access_token;

  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: user.strava_refresh_token,
    grant_type: 'refresh_token',
  });

  await db.users.update(userId, {
    strava_access_token: res.data.access_token,
    strava_refresh_token: res.data.refresh_token,
    strava_token_expires_at: res.data.expires_at,
  });

  return res.data.access_token;
}

// Calls fn(token) and retries once with a force-refreshed token on 401
async function withStravaToken(userId, fn) {
  const token = await getFreshStravaToken(userId);
  try {
    return await track('strava', () => fn(token));
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    const fresh = await getFreshStravaToken(userId, { force: true });
    return await track('strava', () => fn(fresh));
  }
}

function listPage(userId, params) {
  return withStravaToken(userId, token =>
    axios.get(`${STRAVA_API}/athlete/activities`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { per_page: PAGE_SIZE, ...params },
    }).then(r => r.data)
  );
}

const unix = iso => Math.floor(Date.parse(iso) / 1000);
const localDate = a => (a.start_date_local || a.start_date || '').slice(0, 10);

function isoDaysAgo(days, from = Date.now()) {
  return new Date(from - days * 86400000).toISOString().slice(0, 10);
}

// First sync: page newest-first back to the backfill start. Newest-first means a capped
// sync still has the most recent runs; coverage then only claims what was actually reached.
async function backfill(userId) {
  const weeks = await db.training_weeks.findByUserId(userId);
  const planStart = weeks.reduce((min, w) => (!min || w.week_start < min ? w.week_start : min), null);
  const preplan = planStart ? isoDaysAgo(PRE_PLAN_DAYS, Date.parse(`${planStart}T00:00:00Z`)) : null;
  const ninety = isoDaysAgo(BACKFILL_DAYS);
  const from = preplan && preplan < ninety ? preplan : ninety;

  let reached = null;
  let complete = false;
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await listPage(userId, { page });
    await db.activities.upsertMany(userId, batch);
    total += batch.length;
    if (batch.length) reached = localDate(batch[batch.length - 1]);
    if (batch.length < PAGE_SIZE) { complete = true; break; }
    if (reached < from) break;
  }
  // Everything from `reached` up to now is stored (all of history if Strava ran out first)
  await db.users.update(userId, { strava_covered_from: complete ? HISTORY_EXHAUSTED : (reached ?? from) });
  return total > 0;
}

// Later syncs: everything since a week before the newest stored run. Anything stored in
// that window that Strava no longer returns was deleted there.
async function incremental(userId, latestIso) {
  const after = unix(latestIso) - RESYNC_DAYS * 86400;
  const windowIso = db.stravaIso(after);
  const before = await db.activities.signatures(userId, windowIso);

  const fetched = [];
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await listPage(userId, { after, page });
    fetched.push(...batch);
    if (batch.length < PAGE_SIZE) { complete = true; break; }
  }
  await db.activities.upsertMany(userId, fetched);

  let changed = fetched.some(a => before.get(a.id) !== db.activitySignature(a));
  if (complete) {
    const deleted = await db.activities.deleteMissing(userId, windowIso, fetched.map(a => a.id));
    if (deleted > 0) changed = true;
  }
  return changed;
}

async function runSync(userId) {
  const user = await db.users.findBy('id', userId);
  const latest = await db.activities.latestStartDate(userId);
  const changed = (!user?.strava_covered_from || !latest)
    ? await backfill(userId)
    : await incremental(userId, latest);
  const version = changed || !user?.activities_version ? Date.now() : user.activities_version;
  await db.users.update(userId, { strava_synced_at: Date.now(), activities_version: version });
  const newest = await db.activities.newestId(userId);
  return { changed, version, newest_id: newest != null ? String(newest) : null };
}

const syncInflight = new Map(); // userId -> Promise
const lastSync = new Map();     // userId -> { at, result }

// Bring the local mirror up to date with Strava. Concurrent callers share one sync.
function syncActivities(userId) {
  const recent = lastSync.get(userId);
  if (recent && Date.now() - recent.at < DEDUPE_MS) return Promise.resolve({ ...recent.result, changed: false });
  if (syncInflight.has(userId)) return syncInflight.get(userId);
  const promise = runSync(userId)
    .then(result => { lastSync.set(userId, { at: Date.now(), result }); return result; })
    .finally(() => syncInflight.delete(userId));
  syncInflight.set(userId, promise);
  return promise;
}

// Read routes call this; only a user who has never synced waits on Strava
async function ensureBackfilled(userId) {
  const user = await db.users.findBy('id', userId);
  if (!user?.strava_covered_from) await syncActivities(userId);
}

// Older history (Recent Activities "load more" past the backfill): fetch the next page
// below the oldest stored run, store it, and widen coverage. Returns false once exhausted.
async function extendHistory(userId) {
  const user = await db.users.findBy('id', userId);
  if (user?.strava_covered_from === HISTORY_EXHAUSTED) return false;
  const oldest = await db.activities.oldestStartDate(userId);
  const batch = await listPage(userId, { page: 1, ...(oldest ? { before: unix(oldest) } : {}) });
  await db.activities.upsertMany(userId, batch);
  await db.users.update(userId, {
    strava_covered_from: batch.length < PAGE_SIZE ? HISTORY_EXHAUSTED : localDate(batch[batch.length - 1]),
  });
  return batch.length > 0;
}

// A date range older than what's stored (e.g. calendar navigated before the backfill):
// read through to Strava and keep what comes back.
async function fetchRangeBefore(userId, coveredFrom, { after, before }) {
  if (!after || coveredFrom === HISTORY_EXHAUSTED) return;
  if (db.stravaIso(after).slice(0, 10) >= coveredFrom) return;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await listPage(userId, { after, ...(before ? { before } : {}), page });
    await db.activities.upsertMany(userId, batch);
    if (batch.length < PAGE_SIZE) break;
  }
}

// Detailed activity (description, splits, laps). Cached in the row; edits clear it on sync.
async function fetchActivityDetail(userId, activityId, { fresh = false } = {}) {
  if (!fresh) {
    const cached = await db.activities.getDetail(userId, activityId);
    if (cached) return cached;
  }
  const detail = await withStravaToken(userId, token =>
    axios.get(`${STRAVA_API}/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.data)
  );
  await db.activities.setDetail(userId, activityId, detail);
  return detail;
}

function clearUserState(userId) {
  syncInflight.delete(userId);
  lastSync.delete(userId);
}

module.exports = {
  withStravaToken,
  syncActivities,
  ensureBackfilled,
  extendHistory,
  fetchRangeBefore,
  fetchActivityDetail,
  clearUserState,
  STRAVA_API,
};
