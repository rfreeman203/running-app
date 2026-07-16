// One-time importer: copies backend/data/db.json into the normalized Postgres tables.
// It DROPS and recreates the tables, then inserts every record into real columns
// (original created_at/updated_at/generated_at and Strava tokens preserved), exploding
// each week's workouts into the child `workouts` table. Idempotent — safe to re-run.
// Usage:  DATABASE_URL=... node scripts/migrate-json-to-pg.js   (or: npm run migrate)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const fs = require('fs');
const db = require('../src/db'); // reads DATABASE_URL at load — dotenv must run first
const pool = db.pool;

const DB_FILE = path.join(__dirname, '../data/db.json');

const USER_COLS = ['id', 'email', 'name', 'picture', 'google_id', 'created_at', 'strava_athlete_id', 'strava_access_token', 'strava_refresh_token', 'strava_token_expires_at'];
const OVERVIEW_COLS = ['user_id', 'distance_km', 'race_date', 'goal_time', 'goal_pace', 'weekly_km', 'days_per_week', 'running_days', 'long_run_day', 'experience', 'training_style', 'notes', 'week_summary', 'plan_summary', 'last_processed_activity_id', 'created_at', 'updated_at'];
const WEEK_COLS = ['user_id', 'week_number', 'week_start', 'week_end', 'phase', 'total_km'];
const WORKOUT_COLS = ['user_id', 'week_number', 'date', 'day', 'type', 'km', 'description'];
const REVIEW_COLS = ['user_id', 'activity_id', 'activity_name', 'activity_date', 'summary', 'review_text', 'generated_at'];

function pick(obj, cols) {
  const out = {};
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c];
  return out;
}

async function insertRow(table, obj) {
  const cols = Object.keys(obj);
  if (!cols.length) return;
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    cols.map(c => obj[c])
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it (or add it to the repo-root .env) and retry.');
    process.exit(1);
  }
  if (!fs.existsSync(DB_FILE)) {
    console.error(`No JSON DB found at ${DB_FILE} — nothing to migrate.`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

  // Rebuild the schema fresh so re-running always yields the current normalized layout.
  await pool.query('DROP TABLE IF EXISTS workouts, run_reviews, training_weeks, marathon_overview, users CASCADE');
  await db.init();

  const users = data.users ?? [];
  const overviews = data.marathon_overview ?? [];
  const weeks = data.training_weeks ?? [];
  const reviews = data.run_reviews ?? [];

  for (const u of users) await insertRow('users', pick(u, USER_COLS));
  for (const o of overviews) await insertRow('marathon_overview', pick(o, OVERVIEW_COLS));

  let workoutCount = 0;
  for (const w of weeks) {
    await insertRow('training_weeks', pick(w, WEEK_COLS));
    for (const wo of w.workouts ?? []) {
      await insertRow('workouts', pick({ ...wo, user_id: w.user_id, week_number: w.week_number }, WORKOUT_COLS));
      workoutCount++;
    }
  }

  for (const r of reviews) {
    await insertRow('run_reviews', pick({ ...r, activity_id: String(r.activity_id) }, REVIEW_COLS));
  }

  console.log(`Migrated: ${users.length} users, ${overviews.length} overviews, ${weeks.length} weeks, ${workoutCount} workouts, ${reviews.length} reviews.`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
