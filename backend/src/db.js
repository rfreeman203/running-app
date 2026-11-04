const { Pool, types } = require('pg');
const { track } = require('./timing');

// node-pg returns bigint (OID 20) and numeric (OID 1700) as strings by default.
// All our values are well within 2^53, so parse them back to JS numbers.
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL is not set — database calls will fail until it is configured.');
}

// Neon (and most managed Postgres) require SSL; local Postgres usually doesn't.
const isLocal = /localhost|127\.0\.0\.1|sslmode=disable/.test(connectionString || '');
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
pool.on('error', err => console.error('Postgres pool error:', err.message));
// Count query time toward the request's Server-Timing `db` bucket
const rawQuery = pool.query.bind(pool);
pool.query = (...args) => track('db', () => rawQuery(...args));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      picture TEXT,
      google_id TEXT UNIQUE,
      created_at BIGINT,
      strava_athlete_id BIGINT,
      strava_access_token TEXT,
      strava_refresh_token TEXT,
      strava_token_expires_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS marathon_overview (
      user_id TEXT PRIMARY KEY,
      distance_km DOUBLE PRECISION,
      race_date TEXT,
      goal_time TEXT,
      goal_pace TEXT,
      weekly_km DOUBLE PRECISION,
      days_per_week INTEGER,
      running_days TEXT[],
      long_run_day TEXT,
      experience TEXT,
      training_style TEXT,
      notes TEXT,
      week_summary TEXT,
      plan_summary TEXT,
      last_processed_activity_id TEXT,
      summaries_checked_date TEXT,
      created_at BIGINT,
      updated_at BIGINT
    );
    ALTER TABLE marathon_overview ADD COLUMN IF NOT EXISTS summaries_checked_date TEXT;

    CREATE TABLE IF NOT EXISTS training_weeks (
      user_id TEXT NOT NULL,
      week_number INTEGER NOT NULL,
      week_start TEXT,
      week_end TEXT,
      phase TEXT,
      total_km DOUBLE PRECISION,
      PRIMARY KEY (user_id, week_number)
    );

    CREATE TABLE IF NOT EXISTS workouts (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      week_number INTEGER NOT NULL,
      date TEXT,
      day TEXT,
      type TEXT,
      km DOUBLE PRECISION,
      description TEXT
    );
    CREATE INDEX IF NOT EXISTS workouts_user_week_idx ON workouts (user_id, week_number);

    CREATE TABLE IF NOT EXISTS run_reviews (
      user_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      activity_name TEXT,
      activity_date TEXT,
      summary TEXT,
      review_text TEXT,
      generated_at BIGINT,
      PRIMARY KEY (user_id, activity_id)
    );

    -- Strava activities mirrored locally so reads never wait on Strava. \`summary\` is the
    -- raw /athlete/activities item (returned as-is to keep the API shape); \`detail\` is the
    -- /activities/:id payload, filled lazily the first time a review needs it.
    CREATE TABLE IF NOT EXISTS activities (
      user_id TEXT NOT NULL,
      id BIGINT NOT NULL,
      name TEXT,
      type TEXT,
      sport_type TEXT,
      start_date TEXT,
      start_date_local TEXT,
      local_date TEXT,
      distance DOUBLE PRECISION,
      moving_time INTEGER,
      elapsed_time INTEGER,
      total_elevation_gain DOUBLE PRECISION,
      average_speed DOUBLE PRECISION,
      average_heartrate DOUBLE PRECISION,
      max_heartrate DOUBLE PRECISION,
      summary JSONB NOT NULL,
      detail JSONB,
      synced_at BIGINT,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS activities_user_start_idx ON activities (user_id, start_date DESC);
    CREATE INDEX IF NOT EXISTS activities_user_local_idx ON activities (user_id, local_date);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_synced_at BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_covered_from TEXT;
    -- Bumped whenever a sync changes stored activities; clients drop persisted caches when it moves
    ALTER TABLE users ADD COLUMN IF NOT EXISTS activities_version BIGINT;

    -- Finished/replaced plans. A frozen snapshot (overview row + weeks with workouts) taken
    -- when a new plan replaces the current one; activities and reviews are shared, not copied.
    CREATE TABLE IF NOT EXISTS past_plans (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      overview JSONB NOT NULL,
      weeks JSONB NOT NULL,
      plan_start TEXT,
      plan_end TEXT,
      archived_on TEXT,
      archived_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS past_plans_user_idx ON past_plans (user_id);
  `);
}

// Columns each table accepts for merge/insert (excludes primary-key columns).
const USER_COLS = ['email', 'name', 'picture', 'google_id', 'strava_athlete_id', 'strava_access_token', 'strava_refresh_token', 'strava_token_expires_at', 'strava_synced_at', 'strava_covered_from', 'activities_version'];
const OVERVIEW_COLS = ['distance_km', 'race_date', 'goal_time', 'goal_pace', 'weekly_km', 'days_per_week', 'running_days', 'long_run_day', 'experience', 'training_style', 'notes', 'week_summary', 'plan_summary', 'last_processed_activity_id', 'summaries_checked_date'];
const REVIEW_COLS = ['activity_name', 'activity_date', 'summary', 'review_text'];

// Keep only whitelisted keys whose value is defined (null is kept — it's an intentional clear).
function pick(obj, cols) {
  const out = {};
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c];
  return out;
}

// Unix seconds → Strava's start_date format ("2026-10-01T12:00:00Z", no millis), so the
// TEXT column compares correctly against it.
function stravaIso(unixSec) {
  return new Date(unixSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function activitySignature(a) {
  return [a.name, a.sport_type, a.distance, a.moving_time, a.start_date].join('|');
}

// Partial upsert: insert the given columns; on conflict update only those (minus neverUpdate).
async function upsertRow(table, conflictCols, row, neverUpdate = []) {
  const cols = Object.keys(row);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const noUpdate = new Set([...conflictCols, ...neverUpdate]);
  const setCols = cols.filter(c => !noUpdate.has(c));
  const doClause = setCols.length
    ? `DO UPDATE SET ${setCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`
    : 'DO NOTHING';
  await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
     ON CONFLICT (${conflictCols.join(', ')}) ${doClause}`,
    cols.map(c => row[c])
  );
}

const db = {
  init,
  pool,
  stravaIso,
  activitySignature,

  users: {
    async findBy(key, value) {
      const col = ['id', 'google_id', 'email'].includes(key) ? key : null;
      if (!col) return null;
      const { rows } = await pool.query(`SELECT * FROM users WHERE ${col} = $1 LIMIT 1`, [value]);
      return rows[0] ?? null;
    },
    async insert(user) {
      const row = { id: user.id, ...pick(user, USER_COLS), created_at: Date.now() };
      const cols = Object.keys(row);
      const placeholders = cols.map((_, i) => `$${i + 1}`);
      await pool.query(
        `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
        cols.map(c => row[c])
      );
    },
    async update(id, fields) {
      const set = pick(fields, USER_COLS);
      const keys = Object.keys(set);
      if (!keys.length) return;
      const clause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE users SET ${clause} WHERE id = $1`, [id, ...keys.map(k => set[k])]);
    },
    async remove(id) {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    },
  },

  training_weeks: {
    async findByUserId(userId) {
      const { rows: weeks } = await pool.query(
        'SELECT * FROM training_weeks WHERE user_id = $1 ORDER BY week_number',
        [userId]
      );
      const { rows: workouts } = await pool.query(
        'SELECT * FROM workouts WHERE user_id = $1 ORDER BY id',
        [userId]
      );
      const byWeek = {};
      for (const w of workouts) {
        (byWeek[w.week_number] ??= []).push({ date: w.date, day: w.day, type: w.type, km: w.km, description: w.description });
      }
      return weeks.map(wk => ({
        user_id: wk.user_id,
        week_number: wk.week_number,
        week_start: wk.week_start,
        week_end: wk.week_end,
        phase: wk.phase,
        total_km: wk.total_km,
        workouts: byWeek[wk.week_number] ?? [],
      }));
    },
    // Last day of the plan (YYYY-MM-DD), or null when the user has no plan weeks
    async lastWeekEnd(userId) {
      const { rows } = await pool.query(
        'SELECT MAX(week_end) AS week_end FROM training_weeks WHERE user_id = $1',
        [userId]
      );
      return rows[0]?.week_end ?? null;
    },
    async replaceByUserId(userId, weeks) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM workouts WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM training_weeks WHERE user_id = $1', [userId]);
        for (const w of weeks) {
          await client.query(
            'INSERT INTO training_weeks (user_id, week_number, week_start, week_end, phase, total_km) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, w.week_number, w.week_start, w.week_end, w.phase, w.total_km]
          );
          for (const wo of w.workouts ?? []) {
            await client.query(
              'INSERT INTO workouts (user_id, week_number, date, day, type, km, description) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [userId, w.week_number, wo.date, wo.day, wo.type, wo.km, wo.description]
            );
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async removeByUserId(userId) {
      await pool.query('DELETE FROM workouts WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM training_weeks WHERE user_id = $1', [userId]);
    },
  },

  run_reviews: {
    async find(userId, activityId) {
      const { rows } = await pool.query(
        'SELECT * FROM run_reviews WHERE user_id = $1 AND activity_id = $2',
        [userId, String(activityId)]
      );
      return rows[0] ?? null;
    },
    async findByUserId(userId) {
      const { rows } = await pool.query('SELECT * FROM run_reviews WHERE user_id = $1', [userId]);
      return rows;
    },
    async upsert(userId, activityId, fields) {
      const row = {
        user_id: userId,
        activity_id: String(activityId),
        ...pick(fields, REVIEW_COLS),
        generated_at: Date.now(),
      };
      await upsertRow('run_reviews', ['user_id', 'activity_id'], row);
    },
    async removeByUserId(userId) {
      await pool.query('DELETE FROM run_reviews WHERE user_id = $1', [userId]);
    },
  },

  activities: {
    // Upsert a batch of Strava summaries; `detail` is left untouched unless the activity
    // changed on Strava (a rename/edit makes the cached detail stale, so it's cleared).
    async upsertMany(userId, acts) {
      if (!acts.length) return;
      const now = Date.now();
      const values = [];
      const rows = acts.map((a, i) => {
        const base = i * 16;
        values.push(
          userId, a.id, a.name ?? null, a.type ?? null, a.sport_type ?? null,
          a.start_date ?? null, a.start_date_local ?? null,
          (a.start_date_local || a.start_date || '').slice(0, 10) || null,
          a.distance ?? null, a.moving_time ?? null, a.elapsed_time ?? null,
          a.total_elevation_gain ?? null, a.average_speed ?? null,
          a.average_heartrate ?? null, a.max_heartrate ?? null, JSON.stringify(a),
        );
        return `(${Array.from({ length: 16 }, (_, k) => `$${base + k + 1}`).join(', ')}, ${now})`;
      });
      await pool.query(
        `INSERT INTO activities (user_id, id, name, type, sport_type, start_date, start_date_local, local_date,
           distance, moving_time, elapsed_time, total_elevation_gain, average_speed, average_heartrate, max_heartrate,
           summary, synced_at)
         VALUES ${rows.join(', ')}
         ON CONFLICT (user_id, id) DO UPDATE SET
           name = EXCLUDED.name, type = EXCLUDED.type, sport_type = EXCLUDED.sport_type,
           start_date = EXCLUDED.start_date, start_date_local = EXCLUDED.start_date_local, local_date = EXCLUDED.local_date,
           distance = EXCLUDED.distance, moving_time = EXCLUDED.moving_time, elapsed_time = EXCLUDED.elapsed_time,
           total_elevation_gain = EXCLUDED.total_elevation_gain, average_speed = EXCLUDED.average_speed,
           average_heartrate = EXCLUDED.average_heartrate, max_heartrate = EXCLUDED.max_heartrate,
           -- Keep the cached detail unless the activity itself was edited (kudos etc. don't count)
           detail = CASE WHEN activities.name IS NOT DISTINCT FROM EXCLUDED.name
                          AND activities.distance IS NOT DISTINCT FROM EXCLUDED.distance
                          AND activities.moving_time IS NOT DISTINCT FROM EXCLUDED.moving_time
                          AND activities.sport_type IS NOT DISTINCT FROM EXCLUDED.sport_type
                         THEN activities.detail ELSE NULL END,
           summary = EXCLUDED.summary, synced_at = EXCLUDED.synced_at`,
        values
      );
    },
    // Newest first, mirroring Strava's /athlete/activities paging. before/after are unix
    // seconds on start_date (UTC), same semantics as Strava's own params.
    async list(userId, { before, after, limit = 30, offset = 0 } = {}) {
      const params = [userId];
      const where = ['user_id = $1'];
      if (before) { params.push(stravaIso(before)); where.push(`start_date < $${params.length}`); }
      if (after) { params.push(stravaIso(after)); where.push(`start_date > $${params.length}`); }
      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT summary FROM activities WHERE ${where.join(' AND ')}
         ORDER BY start_date DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return rows.map(r => r.summary);
    },
    // Inclusive local-date range (YYYY-MM-DD), newest first
    async between(userId, fromDate, toDate) {
      const { rows } = await pool.query(
        `SELECT summary FROM activities WHERE user_id = $1 AND local_date >= $2 AND local_date <= $3
         ORDER BY start_date DESC`,
        [userId, fromDate, toDate]
      );
      return rows.map(r => r.summary);
    },
    async latestStartDate(userId) {
      const { rows } = await pool.query('SELECT MAX(start_date) AS d FROM activities WHERE user_id = $1', [userId]);
      return rows[0]?.d ?? null;
    },
    async oldestStartDate(userId) {
      const { rows } = await pool.query('SELECT MIN(start_date) AS d FROM activities WHERE user_id = $1', [userId]);
      return rows[0]?.d ?? null;
    },
    // id → fingerprint of the user-editable fields, for spotting edits during a re-sync
    async signatures(userId, fromIso) {
      const { rows } = await pool.query(
        `SELECT id, name, sport_type, distance, moving_time, start_date FROM activities
         WHERE user_id = $1 AND start_date > $2`, [userId, fromIso]);
      return new Map(rows.map(r => [r.id, activitySignature(r)]));
    },
    async newestId(userId) {
      const { rows } = await pool.query(
        'SELECT id FROM activities WHERE user_id = $1 ORDER BY start_date DESC LIMIT 1', [userId]);
      return rows[0]?.id ?? null;
    },
    // Remove activities in a re-fetched window that Strava no longer returns (deleted there)
    async deleteMissing(userId, fromIso, keepIds) {
      const { rowCount } = await pool.query(
        'DELETE FROM activities WHERE user_id = $1 AND start_date > $2 AND NOT (id = ANY($3::bigint[]))',
        [userId, fromIso, keepIds]
      );
      return rowCount;
    },
    async getDetail(userId, id) {
      const { rows } = await pool.query('SELECT detail FROM activities WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0]?.detail ?? null;
    },
    async setDetail(userId, id, detail) {
      await pool.query('UPDATE activities SET detail = $3 WHERE user_id = $1 AND id = $2', [userId, id, JSON.stringify(detail)]);
    },
    async removeByUserId(userId) {
      await pool.query('DELETE FROM activities WHERE user_id = $1', [userId]);
    },
  },

  past_plans: {
    // Clear the current plan to make way for a new one, in one transaction. A finished plan
    // (its last day is before `today`) moves into history; an unfinished one is discarded,
    // along with the run reviews in its date range, which were judged against its workouts.
    // Returns { archived: id } or { deleted: true }, or null when there was no plan.
    async endCurrent(userId, today) {
      const [overview, weeks] = await Promise.all([
        db.marathon_overview.findByUserId(userId),
        db.training_weeks.findByUserId(userId),
      ]);
      if (!overview && !weeks.length) return null;
      const sorted = weeks.slice().sort((a, b) => a.week_start.localeCompare(b.week_start));
      const planStart = sorted[0]?.week_start;
      const planEnd = sorted[sorted.length - 1]?.week_end;
      const finished = !!planEnd && planEnd < today;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let id = null;
        if (finished) {
          const { rows } = await client.query(
            `INSERT INTO past_plans (user_id, overview, weeks, plan_start, plan_end, archived_on, archived_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [userId, JSON.stringify(overview ?? {}), JSON.stringify(sorted), planStart, planEnd, today, Date.now()]
          );
          id = rows[0].id;
        } else if (planStart) {
          await client.query(
            'DELETE FROM run_reviews WHERE user_id = $1 AND LEFT(activity_date, 10) BETWEEN $2 AND $3',
            [userId, planStart, planEnd]
          );
        }
        await client.query('DELETE FROM workouts WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM training_weeks WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM marathon_overview WHERE user_id = $1', [userId]);
        await client.query('COMMIT');
        return finished ? { archived: id } : { deleted: true };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    // Newest first, without the bulky weeks payload
    async list(userId) {
      const { rows } = await pool.query(
        `SELECT id, plan_start, plan_end, archived_on, archived_at,
                (overview->>'distance_km')::float AS distance_km, overview->>'race_date' AS race_date,
                overview->>'goal_time' AS goal_time, overview->>'goal_pace' AS goal_pace
         FROM past_plans WHERE user_id = $1 ORDER BY plan_end DESC, id DESC`,
        [userId]
      );
      return rows;
    },
    async find(userId, id) {
      if (!Number.isSafeInteger(id)) return null;
      const { rows } = await pool.query('SELECT * FROM past_plans WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    async remove(userId, id) {
      if (!Number.isSafeInteger(id)) return false;
      const { rowCount } = await pool.query('DELETE FROM past_plans WHERE user_id = $1 AND id = $2', [userId, id]);
      return rowCount > 0;
    },
    async removeByUserId(userId) {
      await pool.query('DELETE FROM past_plans WHERE user_id = $1', [userId]);
    },
  },

  marathon_overview: {
    async findByUserId(userId) {
      const { rows } = await pool.query('SELECT * FROM marathon_overview WHERE user_id = $1', [userId]);
      return rows[0] ?? null;
    },
    async upsert(userId, fields) {
      const now = Date.now();
      const row = { user_id: userId, ...pick(fields, OVERVIEW_COLS), created_at: now, updated_at: now };
      // created_at is preserved on conflict; updated_at + provided columns are updated.
      await upsertRow('marathon_overview', ['user_id'], row, ['created_at']);
    },
    async removeByUserId(userId) {
      await pool.query('DELETE FROM marathon_overview WHERE user_id = $1', [userId]);
    },
  },
};

module.exports = db;
