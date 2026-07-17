const { Pool, types } = require('pg');

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
  `);
}

// Columns each table accepts for merge/insert (excludes primary-key columns).
const USER_COLS = ['email', 'name', 'picture', 'google_id', 'strava_athlete_id', 'strava_access_token', 'strava_refresh_token', 'strava_token_expires_at'];
const OVERVIEW_COLS = ['distance_km', 'race_date', 'goal_time', 'goal_pace', 'weekly_km', 'days_per_week', 'running_days', 'long_run_day', 'experience', 'training_style', 'notes', 'week_summary', 'plan_summary', 'last_processed_activity_id', 'summaries_checked_date'];
const REVIEW_COLS = ['activity_name', 'activity_date', 'summary', 'review_text'];

// Keep only whitelisted keys whose value is defined (null is kept — it's an intentional clear).
function pick(obj, cols) {
  const out = {};
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c];
  return out;
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
