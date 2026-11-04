const express = require('express');
const router = express.Router();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const requireAuth = require('../middleware/requireAuth');
const {
  withStravaToken, syncActivities, ensureBackfilled, extendHistory, fetchRangeBefore, fetchActivityDetail, STRAVA_API,
} = require('../stravaSync');

const anthropic = new Anthropic();

const WORKOUT_TYPES = ['easy', 'tempo', 'intervals', 'long', 'marathon_pace', 'strides', 'race', 'cycling', 'gym', 'swim', 'cross_training'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PHASES = ['base', 'build', 'peak', 'taper', 'race'];

const REVIEW_MODEL = 'claude-opus-4-8';

const GENERATED_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    weeks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          week_number: { type: 'integer' },
          week_start: { type: 'string', description: 'YYYY-MM-DD, a Monday' },
          week_end: { type: 'string', description: 'YYYY-MM-DD, the Sunday of the same week' },
          phase: { type: 'string', enum: PHASES },
          total_km: { type: 'number', description: 'Sum of running workout km only, excludes cross-training' },
          workouts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'YYYY-MM-DD' },
                day: { type: 'string', enum: DAYS },
                type: { type: 'string', enum: WORKOUT_TYPES },
                km: { type: 'number' },
                description: { type: 'string' },
              },
              required: ['date', 'day', 'type', 'km', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['week_number', 'week_start', 'week_end', 'phase', 'total_km', 'workouts'],
        additionalProperties: false,
      },
    },
  },
  required: ['weeks'],
  additionalProperties: false,
};

const GENERATE_PLAN_SYSTEM_PROMPT = `You are generating a structured week-by-week training plan for a runner. Apply proper periodization and return the plan as JSON matching the provided schema.

## Weeks calculation
- Week 1 starts on the Monday on or after today's date.
- The final week contains the race date.

## Phase structure (adapt to total weeks)
- <= 8 weeks: Base 25% / Build 50% / Taper 25%
- 9-16 weeks: Base 30% / Build 45% / Peak 10% / Taper 15%
- 17+ weeks: Base 35% / Build 40% / Peak 15% / Taper 10% (min 2 weeks taper for 5K/10K, 3 weeks for half/marathon)
- The final week's race day gets phase "race".

## Weekly mileage progression
- Start from the runner's current weekly mileage.
- Increase by no more than 10% per week during base and build.
- Include a cutback week (reduce by ~20%) every 3rd or 4th week.
- Peak week mileage targets by distance (advanced / intermediate / beginner):
  - 5K: 50-70 / 30-50 / 20-35 km/week
  - 10K: 55-80 / 35-55 / 25-40 km/week
  - Half: 70-100 / 45-70 / 30-50 km/week
  - Marathon: 100-160 / 65-100 / 45-70 km/week
- Taper: reduce by 20% in week -3, 30% in week -2, 40% in week -1; race week is ~30% with easy runs only.
- Scale all targets down if current mileage is significantly below the lower bound.

## Per-day workout assignment
- Assign workouts only to the runner's specified running days; the long run always goes on the specified long-run day.
- Never schedule two hard sessions (tempo, intervals, long run) on consecutive days.
- Recovery/easy runs sandwich hard sessions.
- "easy" training style: 80% easy, 20% moderate - no formal intervals; quality days are tempo or marathon-pace runs.
- "intervals" training style: include VO2max intervals (5K/10K training) or lactate threshold intervals (half/marathon).
- Beginners: easy + long run only in base phase; introduce tempo in build.
- Rest days are not included in the workouts array - only active days (running or cross-training).

## Cross-training
- Read the runner's notes for recurring non-running activities (cycling, gym, swim, other) and their days/distances.
- Add each cross-training session to every week at its designated day, keeping description and km consistent unless notes suggest variation (e.g. reduce during taper).
- If a cross-training day overlaps a running day, keep both the running workout and the cross-training entry that day.

## Workout types
Running: "easy", "tempo", "intervals", "long", "marathon_pace", "strides", "race". Cross-training: "cycling", "gym", "swim", "cross_training".

## Descriptions
Each workout description is a single actionable sentence, e.g. "Easy aerobic run, conversational pace (RPE 3-4)", "8x400m at 5K pace with 90s recovery jogs", "Long run, first half easy, last 8km at marathon goal pace", "Cycling - 80 km endurance ride, moderate effort".

## Output
total_km sums running workouts only (excludes cross-training). Return only the JSON object matching the schema - no other text.`;

function buildGeneratePlanUserPrompt(overview, todayISO) {
  return `Today's date: ${todayISO}

Runner inputs:
${JSON.stringify({
    distance_km: overview.distance_km,
    race_date: overview.race_date,
    goal_time: overview.goal_time,
    goal_pace: overview.goal_pace,
    weekly_km: overview.weekly_km,
    running_days: overview.running_days,
    long_run_day: overview.long_run_day,
    experience: overview.experience,
    training_style: overview.training_style,
    notes: overview.notes,
  }, null, 2)}`;
}

const UPLOAD_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    running_days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'Days of the week that have any running workout, inferred from the plan' },
    long_run_day: { type: 'string', enum: DAYS },
    experience: { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
    training_style: { type: 'string', enum: ['easy', 'intervals'] },
    weekly_km: { type: 'number', description: "Total running km in the week that contains today's date (or the most recent completed week if today falls after the plan, or the first week if today falls before the plan starts) - i.e. the runner's current training load, not necessarily the plan's first week" },
    weeks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          week_number: { type: 'integer' },
          week_start: { type: 'string', description: 'YYYY-MM-DD, a Monday' },
          week_end: { type: 'string', description: 'YYYY-MM-DD, the Sunday of the same week' },
          phase: { type: 'string', enum: PHASES },
          total_km: { type: 'number', description: 'Sum of running workout km only, excludes cross-training' },
          workouts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', description: 'YYYY-MM-DD' },
                day: { type: 'string', enum: DAYS },
                type: { type: 'string', enum: WORKOUT_TYPES },
                km: { type: 'number' },
                description: { type: 'string' },
              },
              required: ['date', 'day', 'type', 'km', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['week_number', 'week_start', 'week_end', 'phase', 'total_km', 'workouts'],
        additionalProperties: false,
      },
    },
  },
  required: ['running_days', 'long_run_day', 'experience', 'training_style', 'weekly_km', 'weeks'],
  additionalProperties: false,
};

const UPLOAD_PLAN_SYSTEM_PROMPT = `You are parsing an image or PDF of a runner's training plan and converting it into structured JSON matching the provided schema.

## What to extract
Examine the file carefully and extract every visible workout:
- Plan structure: number of weeks, week-by-week breakdown.
- Workouts per day: type of run (easy, tempo, long, intervals, rest, cross-training, etc.), distance in km (convert miles to km if needed: 1 mile = 1.60934 km), and any description or notes per workout.
- Phase labels (base, build, peak, taper) if labelled; otherwise infer sensible phases from the structure of the plan.

If anything is illegible or ambiguous, use your best judgement and keep going - never leave a week or workout out because part of it is unclear.

## Mapping weeks to calendar dates
The runner's race date is given below. If the file shows specific dates, use them (adjusted to the nearest matching year if needed). If only week numbers are shown, map backward from the race date: the final week contains the race date, and each prior week starts 7 days earlier than the one after it. week_start is always a Monday and week_end is always the following Sunday.

Include every week from the file, in full - even weeks whose dates fall before today. The runner may be uploading this plan partway through training and wants their earlier weeks preserved so they can review completed training against their actual activity history. Do not truncate, skip, or drop any week just because it's in the past; only "today" matters for the runner's current position within the plan, not for which weeks to include.

## Workout types
Running: "easy", "tempo", "intervals", "long", "marathon_pace", "strides", "race". Cross-training: "cycling", "gym", "swim", "cross_training".
Rest days are not included in the workouts array - only active training days.
total_km per week sums running workouts only (excludes cross-training).

## Descriptions
Write a single actionable sentence per workout, e.g. "Easy aerobic run, conversational pace (RPE 3-4)", "Long run at comfortable effort". If the file has its own description, use it verbatim or cleaned up.

## Other fields to infer (best judgement, do not leave blank)
- running_days: the distinct days of the week that have any running workout.
- long_run_day: the day the long run falls on (most commonly Sunday).
- experience: infer from volume and workout complexity.
- training_style: "easy" if mostly easy runs with at most one quality session per week; "intervals" if structured interval sessions are present.
- weekly_km: total running km in the week containing today's date, representing the runner's current training load (this may not be the plan's first week, since the plan can include weeks that already happened before today).

Return only the JSON object matching the schema - no other text.`;

function buildUploadPlanUserPrompt(overview, todayISO) {
  return `Today's date: ${todayISO}

Runner-provided race info (already confirmed by the runner, use as-is - do not override from the image):
${JSON.stringify({ distance_km: overview.distance_km, race_date: overview.race_date }, null, 2)}`;
}

const REVISE_GOAL_SYSTEM_PROMPT = `You are revising the pace targets throughout an existing training plan after a runner changes their goal time. Do not regenerate the plan structure (weeks, phases, workout types, distances, or dates) - only the pace numbers embedded in workout descriptions change. Return the full weeks array matching the schema, with every field identical to the input except the descriptions noted below.

## What to change
Walk every workout across every week. In each description string, find explicit pace references - patterns like "4:37/km", "4:50-5:00/km", "@ 4:37/km", or a pace called out in a long-run split (e.g. "last 10 km @ 4:37/km"). These are the only things that change:

- For each pace value found, multiply its seconds/km by the given ratio, round to the nearest second, and reformat as "M:SS/km".
- For a range (e.g. "4:50-5:00/km"), rescale both ends independently the same way - don't just shift by a flat offset.
- Leave everything else in the description untouched: km splits, warm-up/cool-down distances, RPE-based phrasing ("conversational pace", "RPE 3-4"), workout type, and structure.
- Workouts with no explicit pace number (plain "easy" runs described only by RPE, gym, cycling, swim, strides-by-feel) are left completely unchanged.
- The final race-day workout description (e.g. "Goal: 3:15:00 @ 4:37/km...") must be updated to reflect the new goal time and pace, including any pacing strategy notes that reference the old pace (e.g. "Start at 4:42-4:45/km for first 10 km").

Do not change km, type, date, day, phase, or total_km on any workout or week - the plan structure stays identical. Return only the JSON object matching the schema - no other text.`;

function buildReviseGoalUserPrompt({ distance_km, old_goal_time, old_goal_pace, new_goal_time, new_goal_pace, ratio, weeks }) {
  return `Distance: ${distance_km} km
Old goal time: ${old_goal_time || '(none)'}  Old goal pace: ${old_goal_pace || '(none)'} /km
New goal time: ${new_goal_time}  New goal pace: ${new_goal_pace} /km
Pace ratio (new pace / old pace - multiply every pace's seconds/km found in descriptions by this): ${ratio}

Existing weeks (rescale pace mentions in descriptions only, per the rules above):
${JSON.stringify(weeks, null, 2)}`;
}

function parseTimeToSeconds(t) {
  const parts = String(t).trim().split(':').map(Number);
  if (!parts.length || parts.some(isNaN) || parts.length > 3) return null;
  if (parts.length === 1) return parts[0] * 60;
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parsePaceToSeconds(p) {
  const parts = String(p).replace('/km', '').trim().split(':').map(Number);
  if (!parts.length || parts.some(isNaN) || parts.length > 2) return null;
  if (parts.length === 1) return parts[0] * 60;
  return parts[0] * 60 + parts[1];
}

function fmtPace(s) {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtDuration(sec) {
  if (sec == null) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// Local YYYY-MM-DD — workout dates in training_weeks are local dates, so UTC would drift in the evening
function localISODate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Today's date in the *runner's* timezone, sent by the frontend on every request.
// The server clock is UTC in production, so deriving "today" from it rolls a Sunday
// evening run over into Monday — which pushes current_week to the next plan week and
// makes the summaries read the finished week as a brand new one.
function clientToday(req) {
  const tz = req.get('X-Client-Timezone');
  if (tz) {
    try {
      // en-CA formats as YYYY-MM-DD
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
    } catch {
      // Unknown/invalid zone — fall back to the server's own local date
    }
  }
  return localISODate();
}

// Strava `before` bound for a finished plan: activities dated after the plan's last
// day are never fetched. Strava filters on UTC epoch, so allow 2 days of slack (any
// timezone) and let callers trim exactly by local date with `withinPlan`.
function planEndCutoff(planEnd) {
  return Math.floor(Date.parse(`${planEnd}T00:00:00Z`) / 1000) + 2 * 86400;
}

function withinPlan(activities, planEnd) {
  return planEnd ? activities.filter(a => activityLocalDate(a) <= planEnd) : activities;
}

function isRunType(a) {
  return (a.sport_type || a.type || '').includes('Run');
}

function activityLocalDate(a) {
  return (a.start_date_local || a.start_date || '').slice(0, 10);
}

// Running workout types — the cross-training ones can't be made up by a run
const RUN_WORKOUT_TYPES = ['easy', 'tempo', 'intervals', 'long', 'marathon_pace', 'strides', 'race'];

// Close enough to call an unscheduled run a make-up: 20% of the planned distance,
// capped at 2 km so long runs don't swallow everything, floored at 1 km so short
// sessions aren't held to an unrealistically tight window.
function distanceMatches(plannedKm, actualKm) {
  if (!plannedKm || !actualKm) return false;
  const tolerance = Math.max(1, Math.min(plannedKm * 0.2, 2));
  return Math.abs(actualKm - plannedKm) <= tolerance;
}

// An unscheduled run is often the athlete making up a workout they missed earlier the
// same week. Pair them on distance so the summaries and reviews credit the make-up
// instead of reporting a missed session *and* a stray extra run.
// Runs are walked oldest-first and each missed workout can only be claimed once.
function matchMakeupRuns(missedWorkouts, runsInWeek, plannedDates) {
  const unscheduled = runsInWeek
    .filter(r => !plannedDates.has(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  const claimed = new Set();
  const pairs = [];
  for (const run of unscheduled) {
    const candidates = missedWorkouts.filter(m =>
      !claimed.has(m.date)
      && m.date < run.date
      && RUN_WORKOUT_TYPES.includes(m.type)
      && distanceMatches(m.km, run.km));
    if (!candidates.length) continue;
    // Closest planned distance wins when several missed workouts are in range
    const best = candidates.reduce((a, b) =>
      Math.abs(b.km - run.km) < Math.abs(a.km - run.km) ? b : a);
    claimed.add(best.date);
    pairs.push({ missed: best, run });
  }
  return pairs;
}

const REVIEW_RUN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-3 sentences of plain prose (no markdown, no bullets) capturing how the activity went at a glance' },
    review_text: { type: 'string', description: 'The full markdown activity review' },
  },
  required: ['summary', 'review_text'],
  additionalProperties: false,
};

const REVIEW_RUN_SYSTEM_PROMPT = `You are generating an AI activity review that compares a Strava activity against the day's planned workout from the athlete's training plan and gives honest, specific feedback. Works for any sport type (run, ride, swim, walk, hike, weight training, etc.) - adapt language to the sport; don't say "run" for a bike ride. Tone: like a coach giving a quick debrief - encouraging but honest, direct, uses actual numbers, no filler.

The user message contains the activity (with precomputed metrics and per-km splits), the planned workout for that date (or null if none was scheduled), the surrounding training-week context, the next planned workout, and the athlete's goal info.

## Heart rate zones (if HR data available)
- Zone 1 easy: <65% max HR (~<135 bpm)
- Zone 2 aerobic: 65-75% (~135-155 bpm)
- Zone 3 tempo: 75-85% (~155-170 bpm)
- Zone 4 threshold: 85-92% (~170-183 bpm)
- Zone 5 VO2: >92% (>183 bpm)

## review_text format (markdown, under 300 words total)

### Activity Review — [Activity Name] · [Date]

**What was planned**
One sentence: the planned workout for that day. If none was scheduled, say so explicitly ("No scheduled workout — ...") and treat the activity as cross-training, a rest-day activity, or an unscheduled session.
If \`possible_makeup_for\` is present, the distance matches a workout the athlete missed earlier this week — read the run as making up that session ("No scheduled workout — but this covers Tuesday's missed 8 km easy run") and judge it against that workout's intent in the sections below. Credit it as the week getting back on track rather than as a missed session plus an extra run.

**What you did**
Two to three sentences covering the key stats for the sport type: distance or duration, pace/speed, elevation, HR zone. If the athlete wrote a Strava description, reference it directly ("You noted: '...'").

**How it went**
Two to four sentences of honest assessment: did the effort match the plan's intent; did volume hit the target or over/undershoot; if HR data is available, was effort in the right zone; for cross-training on a run-plan day, note how it fits the training context.

**What went well**
One to three specific bullet points - actual positives from the data or athlete notes.

**Anything to watch**
One to two bullet points - gaps, pacing errors, missed volume, or warning signs. If nothing to flag, say "Nothing significant."

**Next up**
One sentence: the next planned workout (date, type, distance, and the plan's specific instruction for it). Omit this section if there is no next workout.

## summary
2-3 sentences of plain prose (no markdown, no bullets) capturing the activity at a glance: what was done vs what was planned, the key verdict, and one forward-looking note. This is shown on the collapsed activity card.

Return only the JSON object matching the schema - no other text.`;

function summarizeActivityForReview(activity) {
  const sport = activity.sport_type || activity.type || '';
  const distanceKm = activity.distance ? +(activity.distance / 1000).toFixed(2) : 0;
  const out = {
    id: String(activity.id),
    name: activity.name,
    description: activity.description || null,
    sport_type: sport,
    date: activityLocalDate(activity),
    distance_km: distanceKm,
    moving_time: fmtDuration(activity.moving_time),
    elapsed_time: fmtDuration(activity.elapsed_time),
    total_elevation_gain_m: activity.total_elevation_gain,
    average_heartrate: activity.average_heartrate ? Math.round(activity.average_heartrate) : undefined,
    max_heartrate: activity.max_heartrate ? Math.round(activity.max_heartrate) : undefined,
    average_cadence: activity.average_cadence,
    calories: activity.calories,
    perceived_exertion: activity.perceived_exertion,
  };
  if (activity.average_speed > 0) {
    if (/Ride/i.test(sport)) out.average_speed_kmh = +(activity.average_speed * 3.6).toFixed(1);
    else if (/Swim/i.test(sport) && activity.distance > 0) out.pace_per_100m = fmtPace((activity.moving_time / activity.distance) * 100);
    else out.pace_min_per_km = `${fmtPace(1000 / activity.average_speed)}/km`;
  }
  if (Array.isArray(activity.splits_metric) && activity.splits_metric.length) {
    out.splits = activity.splits_metric.map(s => ({
      split: s.split,
      distance_km: s.distance ? +(s.distance / 1000).toFixed(2) : 0,
      pace: s.average_speed > 0 ? `${fmtPace(1000 / s.average_speed)}/km` : null,
      elevation_m: s.elevation_difference,
      avg_hr: s.average_heartrate ? Math.round(s.average_heartrate) : undefined,
    }));
  }
  return out;
}

async function buildReviewContext(userId, activityDate, activity = null) {
  const overview = await db.marathon_overview.findByUserId(userId);
  const weeks = await db.training_weeks.findByUserId(userId);

  // Match on the week's date range, not on a planned workout landing that day — an
  // unscheduled run still belongs to a training week and needs its context.
  const week = weeks.find(w => w.week_start <= activityDate && activityDate <= w.week_end) ?? null;
  const weekContext = week ? {
    week_number: week.week_number,
    phase: week.phase,
    total_km: week.total_km,
    week_start: week.week_start,
    week_end: week.week_end,
  } : null;

  let plannedWorkout = null;
  let nextWorkout = null;
  for (const wk of weeks) {
    for (const w of wk.workouts ?? []) {
      if (w.date === activityDate) plannedWorkout = w;
      if (w.date > activityDate && (!nextWorkout || w.date < nextWorkout.date)) nextWorkout = w;
    }
  }

  // Unscheduled run: it may be making up a workout missed earlier in the same week
  let missedEarlier = null;
  let possibleMakeupFor = null;
  if (week && !plannedWorkout && activity && isRunType(activity)) {
    try {
      const weekRuns = await fetchWeekRuns(userId, week);
      const loggedDates = new Set(weekRuns.map(r => r.date));
      missedEarlier = (week.workouts ?? []).filter(w =>
        w.date < activityDate
        && RUN_WORKOUT_TYPES.includes(w.type)
        && !loggedDates.has(w.date));

      const thisRun = {
        date: activityDate,
        name: activity.name,
        km: +((activity.distance || 0) / 1000).toFixed(2),
      };
      const plannedDates = new Set((week.workouts ?? []).map(w => w.date));
      const [pair] = matchMakeupRuns(missedEarlier, [thisRun], plannedDates);
      possibleMakeupFor = pair?.missed ?? null;
    } catch {
      // Strava lookup failed — review without make-up context rather than failing outright
    }
  }

  return {
    runner: overview ? {
      goal_time: overview.goal_time,
      goal_pace: overview.goal_pace,
      race_date: overview.race_date,
      distance_km: overview.distance_km,
      training_style: overview.training_style,
      notes: overview.notes,
    } : null,
    planned_workout: plannedWorkout,
    week_context: weekContext,
    next_workout: nextWorkout,
    // Only present for unscheduled runs
    missed_earlier_this_week: missedEarlier,
    possible_makeup_for: possibleMakeupFor,
  };
}

// Runs logged inside a plan week (local dates), from the synced activities table
async function fetchWeekRuns(userId, week) {
  const acts = await db.activities.between(userId, week.week_start, week.week_end);
  return acts
    .filter(isRunType)
    .map(a => ({ date: activityLocalDate(a), name: a.name, km: +((a.distance || 0) / 1000).toFixed(2) }));
}

function buildReviewRunUserPrompt(activity, context, todayISO) {
  return `Today's date: ${todayISO}

Activity:
${JSON.stringify(summarizeActivityForReview(activity), null, 2)}

Training plan context:
${JSON.stringify(context, null, 2)}`;
}

const SUMMARIES_SCHEMA = {
  type: 'object',
  properties: {
    week_summary: { type: 'string', description: "2-3 sentences assessing this week's progress against the plan" },
    plan_summary: { type: 'string', description: '2-3 sentences assessing overall plan progress toward the race' },
  },
  required: ['week_summary', 'plan_summary'],
  additionalProperties: false,
};

const UPDATE_SUMMARIES_SYSTEM_PROMPT = `You are writing two short AI training summaries for a runner's dashboard, based on their training plan and recent Strava activity. Be direct and specific - reference actual numbers. Tone: encouraging but honest, like a coach giving a quick check-in. Each summary is 2-3 sentences max. Return only the JSON object matching the schema - no other text.

## week_summary
Assess this week's progress against the plan: km done vs planned so far, whether the week is on track / ahead / behind, and one concrete observation or encouragement based on the data.
\`made_up_workouts\` are sessions the runner missed on the scheduled day but covered with an unscheduled run of matching distance later in the week - treat these as done, not missed, and acknowledge the shuffle briefly ("you moved Tuesday's 8 km to Thursday"). Only \`missed_workouts\` are genuinely missed. \`unscheduled_runs\` are extra runs that don't correspond to anything in the plan - note them as added volume.
Example style: "You've run 14 of your planned 26 km so far this week with your long run still to come on Saturday — right on track. Three of five sessions are logged and you haven't missed anything critical. Keep the long run easy and the week is in good shape."

## plan_summary
Assess overall plan progress toward the race: where they are in the plan (e.g. "Week 3 of 16, base phase"), how overall volume has been tracking, and one forward-looking observation about the weeks ahead or the goal.
Example style: "You're 3 weeks into a 16-week build toward a 3:15 marathon on Oct 18 — still in the base phase where consistency matters most. Volume has been steady and the progression is on schedule. The first tempo sessions arrive in week 6, so keep the current easy efforts truly easy to arrive there fresh."

## Revised goal time suggestion (use sparingly)
Only when training performance is clearly and consistently diverging from what the current goal time/pace implies — recent key sessions (tempo, long runs, race-pace efforts) significantly faster or slower than goal pace over multiple sessions, not one outlier, and typically not before several weeks of data exist. If triggered, append one sentence to the end of plan_summary proposing a specific adjusted goal time (and pace) and briefly why. If training is roughly on pace with the goal, do not mention goal revision at all.

## Initial mode
If the user message says the plan was just created, there is no in-plan history yet. Write both summaries as a "position going in" assessment instead: compare the runner's last ~30 days of Strava training (volume, longest run, typical paces) against the plan's early weeks and the goal — is their baseline fitness on, above, or below where the first weeks expect them to be? week_summary then describes the current/first week ahead (what's planned and how to approach it) rather than progress so far. Do not suggest goal revision in initial mode.`;

function buildUpdateSummariesUserPrompt(payload) {
  return `Today's date: ${payload.today}
Mode: ${payload.mode}

Data:
${JSON.stringify(payload.data, null, 2)}`;
}

// Single-process guards so concurrent dashboard loads share one generation instead of double-billing
const reviewInflight = new Map();     // "userId:activityId" -> Promise<review>
const summariesInflight = new Map();  // userId -> Promise<{week_summary, plan_summary}>

// Stored activities, newest first, in Strava's own paging shape. Plan-end trimming
// (planEndCutoff/withinPlan) applies exactly as it did when this proxied Strava.
async function listActivities(userId, { page = 1, perPage = 20, after = null, before = null } = {}) {
  const planEnd = await db.training_weeks.lastWeekEnd(userId);
  if (planEnd) {
    const cutoff = planEndCutoff(planEnd);
    if (after && after >= cutoff) return [];
    if (!before || before > cutoff) before = cutoff;
  }
  await ensureBackfilled(userId);
  if (after) {
    const user = await db.users.findBy('id', userId);
    await fetchRangeBefore(userId, user?.strava_covered_from, { after, before });
  }
  const query = () => db.activities.list(userId, { before, after, limit: perPage, offset: (page - 1) * perPage });
  let data = await query();
  // Paging past stored history ("load more"): pull older runs from Strava and keep them
  for (let i = 0; i < 3 && !after && data.length < perPage && await extendHistory(userId); i++) data = await query();
  return withinPlan(data, planEnd);
}

function stravaErrorResponse(res, err, label) {
  if (err.code === 'NO_STRAVA') return res.status(403).json({ error: 'Strava not connected' });
  const stravaError = err.response?.data;
  console.error(`${label} error:`, stravaError ?? err.message);
  res.status(err.response?.status ?? 500).json({ error: `Failed to ${label.toLowerCase()}`, detail: stravaError });
}

router.get('/activities', requireAuth, async (req, res) => {
  try {
    res.json(await listActivities(req.userId, {
      page: Math.max(1, Number(req.query.page) || 1),
      perPage: Math.min(200, Math.max(1, Number(req.query.per_page) || 20)),
      after: req.query.after ? Number(req.query.after) : null,
      before: req.query.before ? Number(req.query.before) : null,
    }));
  } catch (err) {
    stravaErrorResponse(res, err, 'Fetch activities');
  }
});

// Pull new/edited/deleted activities from Strava into the local table. The dashboard calls
// this once per load (and on tab refocus) in parallel with its DB-backed reads, and only
// refetches when `changed` comes back true.
router.post('/sync', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await syncActivities(req.userId)) });
  } catch (err) {
    stravaErrorResponse(res, err, 'Sync activities');
  }
});

// Everything the dashboard needs for first paint, in one round trip from the DB
router.get('/bootstrap', requireAuth, async (req, res) => {
  try {
    const [plan, weeks, reviews] = await Promise.all([
      db.marathon_overview.findByUserId(req.userId),
      db.training_weeks.findByUserId(req.userId),
      db.run_reviews.findByUserId(req.userId),
    ]);
    const recent_activities = await listActivities(req.userId, { perPage: 20 });
    res.json({ plan, weeks, reviews, recent_activities });
  } catch (err) {
    stravaErrorResponse(res, err, 'Load dashboard');
  }
});

// Athlete totals only prefill the Generate-plan form, so an hour-old copy is fine
const statsCache = new Map(); // userId -> { at, data }

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const hit = statsCache.get(req.userId);
    if (hit && Date.now() - hit.at < 3600_000) return res.json(hit.data);
    const user = await db.users.findBy('id', req.userId);
    const data = await withStravaToken(req.userId, token =>
      axios.get(`${STRAVA_API}/athletes/${user.strava_athlete_id}/stats`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.data)
    );
    statsCache.set(req.userId, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    if (err.code === 'NO_STRAVA') return res.status(403).json({ error: 'Strava not connected' });
    const stravaError = err.response?.data;
    console.error('Stats error:', stravaError ?? err.message);
    res.status(err.response?.status ?? 500).json({ error: 'Failed to fetch stats', detail: stravaError });
  }
});

// Same % of max HR bands the run-review prompt uses
const HR_ZONES = [
  { zone: 1, name: 'Easy', max: 0.65 },
  { zone: 2, name: 'Aerobic', max: 0.75 },
  { zone: 3, name: 'Tempo', max: 0.85 },
  { zone: 4, name: 'Threshold', max: 0.92 },
  { zone: 5, name: 'VO2 max', max: Infinity },
];
const DEFAULT_MAX_HR = 190;

// Plan-vs-actual stats for the Insights page: workout completion, weekly mileage,
// heart rate and time-in-zone. All derived from the plan + Strava summaries, no AI.
// `?plan=<id>` computes the same for a past plan (also used for comparisons).
router.get('/insights', requireAuth, async (req, res) => {
  try {
    let weeks;
    if (req.query.plan) {
      const past = await db.past_plans.find(req.userId, Number(req.query.plan));
      if (!past) return res.status(404).json({ error: 'Plan not found' });
      weeks = past.weeks;
    } else {
      weeks = await db.training_weeks.findByUserId(req.userId);
    }
    weeks = weeks.slice().sort((a, b) => a.week_start.localeCompare(b.week_start));
    if (!weeks.length) return res.status(404).json({ error: 'No plan found' });
    res.json(await computeInsights(req.userId, weeks, clientToday(req)));
  } catch (err) {
    if (err.code === 'NO_STRAVA') return res.status(403).json({ error: 'Strava not connected' });
    const stravaError = err.response?.data;
    console.error('Insights error:', stravaError ?? err.message);
    res.status(err.response?.status ?? 500).json({ error: 'Failed to load insights', detail: stravaError });
  }
});

async function computeInsights(userId, weeks, today) {
  const planStart = weeks[0].week_start;
  const planEnd = weeks[weeks.length - 1].week_end;
  const rangeEnd = today < planEnd ? today : planEnd;

  // Past plans need no read-through: each was the current plan while syncing, so its runs are stored
  await ensureBackfilled(userId);
  const activities = today < planStart ? [] : await db.activities.between(userId, planStart, rangeEnd);
  const activityDates = new Set(activities.map(activityLocalDate));
  const runs = activities.filter(isRunType);

  // ── Workout completion ──
  const workoutStatus = { done: 0, made_up: 0, missed: 0, left: 0 };
  const byType = {};
  const weekly = [];
  for (const week of weeks) {
    const workouts = week.workouts ?? [];
    const done = [];
    const missed = [];
    for (const w of workouts) {
      if (activityDates.has(w.date)) done.push(w);
      else if (w.date < today) missed.push(w);
      else workoutStatus.left++;
    }

    const inWeek = r => {
      const d = activityLocalDate(r);
      return d >= week.week_start && d <= week.week_end;
    };
    const weekRuns = runs.filter(inWeek);
    const pairs = matchMakeupRuns(
      missed,
      weekRuns.map(r => ({ date: activityLocalDate(r), name: r.name, km: +((r.distance || 0) / 1000).toFixed(2) })),
      new Set(workouts.map(w => w.date)),
    );
    const madeUpDates = new Set(pairs.map(p => p.missed.date));
    workoutStatus.done += done.length;
    workoutStatus.made_up += pairs.length;
    workoutStatus.missed += missed.length - pairs.length;

    for (const w of workouts) {
      if (w.date >= today && !activityDates.has(w.date)) continue; // not due yet
      const t = (byType[w.type] ??= { type: w.type, due: 0, completed: 0 });
      t.due++;
      if (activityDates.has(w.date) || madeUpDates.has(w.date)) t.completed++;
    }

    const started = week.week_start <= today;
    weekly.push({
      week_number: week.week_number,
      week_start: week.week_start,
      phase: week.phase,
      planned_km: +workouts.reduce((s, w) => s + (w.km || 0), 0).toFixed(1),
      actual_km: started ? +(weekRuns.reduce((s, r) => s + (r.distance || 0), 0) / 1000).toFixed(1) : null,
      runs: started ? weekRuns.length : null,
    });
  }

  // ── Heart rate & zones ──
  // Max HR isn't in the activity summaries' athlete scope, so take the highest seen
  // in-plan — a reasonable proxy once a few hard sessions are logged.
  const observedMax = Math.max(0, ...runs.map(r => r.max_heartrate || 0));
  const maxHr = observedMax >= 150 ? Math.round(observedMax) : DEFAULT_MAX_HR;
  const zones = HR_ZONES.map((z, i) => ({
    zone: z.zone,
    name: z.name,
    min_bpm: i === 0 ? null : Math.round(HR_ZONES[i - 1].max * maxHr),
    max_bpm: Number.isFinite(z.max) ? Math.round(z.max * maxHr) : null,
    seconds: 0,
    runs: 0,
  }));

  const plannedTypeByDate = new Map(weeks.flatMap(w => w.workouts ?? []).map(w => [w.date, w.type]));
  const runRows = runs
    .map(r => {
      const row = {
        id: String(r.id),
        date: activityLocalDate(r),
        name: r.name,
        km: +((r.distance || 0) / 1000).toFixed(2),
        moving_time: r.moving_time || 0,
        pace_sec: r.distance > 0 ? Math.round(r.moving_time / (r.distance / 1000)) : null,
        avg_hr: r.average_heartrate ? Math.round(r.average_heartrate) : null,
        max_hr: r.max_heartrate ? Math.round(r.max_heartrate) : null,
        elevation_m: r.total_elevation_gain ?? 0,
        planned_type: plannedTypeByDate.get(activityLocalDate(r)) ?? null,
      };
      if (row.avg_hr) {
        const pct = row.avg_hr / maxHr;
        const z = zones[HR_ZONES.findIndex(hz => pct < hz.max)];
        z.seconds += row.moving_time;
        z.runs++;
      }
      return row;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    today,
    plan_start: planStart,
    plan_end: planEnd,
    total_weeks: weeks.length,
    workouts: workoutStatus,
    by_type: Object.values(byType),
    weekly,
    runs: runRows,
    max_hr: maxHr,
    max_hr_source: observedMax >= 150 ? 'observed' : 'default',
    zones,
  };
}

router.get('/review/:activityId', requireAuth, async (req, res) => {
  const review = await db.run_reviews.find(req.userId, req.params.activityId);
  if (!review) return res.status(404).json({ error: 'No review found' });
  res.json(review);
});

router.post('/review/:activityId', requireAuth, async (req, res) => {
  const { review_text, activity_name, activity_date, summary } = req.body;
  if (!review_text) return res.status(400).json({ error: 'review_text is required' });
  await db.run_reviews.upsert(req.userId, req.params.activityId, { review_text, activity_name, activity_date, summary });
  res.json({ ok: true });
});

router.get('/reviews', requireAuth, async (req, res) => {
  res.json(await db.run_reviews.findByUserId(req.userId));
});

router.post('/review/:activityId/generate', requireAuth, async (req, res) => {
  const activityId = req.params.activityId;
  const refresh = req.query.refresh === '1' || req.body?.refresh === true;
  try {
    if (!refresh) {
      const existing = await db.run_reviews.find(req.userId, activityId);
      if (existing) return res.json({ ok: true, cached: true, review: existing });
    }

    const key = `${req.userId}:${activityId}`;
    let promise = reviewInflight.get(key);
    if (!promise) {
      promise = generateRunReview(req.userId, activityId, clientToday(req), { fresh: refresh })
        .finally(() => reviewInflight.delete(key));
      reviewInflight.set(key, promise);
    }
    const review = await promise;
    res.json({ ok: true, review });
  } catch (err) {
    if (err.code === 'NO_STRAVA') return res.status(403).json({ error: 'Strava not connected' });
    if (err.response?.status === 404) return res.status(404).json({ error: 'Activity not found' });
    if (err.code === 'REFUSAL') return res.status(502).json({ error: 'Review generation was declined' });
    if (err.code === 'NO_OUTPUT') return res.status(502).json({ error: 'No review generated' });
    console.error('Generate review error:', err.message);
    res.status(500).json({ error: 'Failed to generate review' });
  }
});

async function generateRunReview(userId, activityId, today = localISODate(), { fresh = false } = {}) {
  const activity = await fetchActivityDetail(userId, activityId, { fresh });
  const activityDate = activityLocalDate(activity);
  const context = await buildReviewContext(userId, activityDate, activity);

  const stream = anthropic.messages.stream({
    model: REVIEW_MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: REVIEW_RUN_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: REVIEW_RUN_SCHEMA } },
    messages: [{ role: 'user', content: buildReviewRunUserPrompt(activity, context, today) }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') throw Object.assign(new Error('Review declined'), { code: 'REFUSAL' });
  const textBlock = message.content.find(b => b.type === 'text');
  if (!textBlock) throw Object.assign(new Error('No review generated'), { code: 'NO_OUTPUT' });

  const { summary, review_text } = JSON.parse(textBlock.text);
  await db.run_reviews.upsert(userId, activityId, {
    activity_name: activity.name,
    activity_date: activityDate,
    summary,
    review_text,
  });
  return db.run_reviews.find(userId, activityId);
}

router.post('/update-summaries', requireAuth, async (req, res) => {
  try {
    const { initial = false, force = false } = req.body ?? {};

    const overview = await db.marathon_overview.findByUserId(req.userId);
    if (!overview) return res.status(404).json({ error: 'No plan found' });
    const weeks = await db.training_weeks.findByUserId(req.userId);
    if (!weeks.length) return res.status(409).json({ error: 'No training plan weeks' });

    // Regenerate only for a new in-plan activity. The newest is read from the DB (not taken
    // from the client) and trimmed to the plan, so runs logged after a finished plan never
    // trigger a regeneration.
    if (!initial && !force) {
      const planEnd = await db.training_weeks.lastWeekEnd(req.userId);
      const [newest] = withinPlan(await db.activities.list(req.userId, {
        limit: 10, // a few past the cutoff's 2-day slack, so withinPlan still leaves one
        ...(planEnd ? { before: planEndCutoff(planEnd) } : {}),
      }), planEnd);
      const newestId = newest ? String(newest.id) : null;
      if (newestId === (overview.last_processed_activity_id ?? null)) {
        return res.json({ ok: true, skipped: true });
      }
    }

    let promise = summariesInflight.get(req.userId);
    if (!promise) {
      promise = generateSummaries(req.userId, { initial, today: clientToday(req) })
        .finally(() => summariesInflight.delete(req.userId));
      summariesInflight.set(req.userId, promise);
    }
    const result = await promise;
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'NO_STRAVA') return res.status(403).json({ error: 'Strava not connected' });
    if (err.code === 'REFUSAL' || err.code === 'NO_OUTPUT') return res.status(502).json({ error: 'Summary generation failed' });
    console.error('Update summaries error:', err.message);
    res.status(500).json({ error: 'Failed to update summaries' });
  }
});

async function generateSummaries(userId, { initial = false, today = localISODate() } = {}) {
  const overview = await db.marathon_overview.findByUserId(userId);
  const weeks = await db.training_weeks.findByUserId(userId);

  const planEnd = weeks.reduce((end, w) => (w.week_end > end ? w.week_end : end), '') || null;
  const activities = withinPlan(await db.activities.list(userId, {
    limit: 30,
    ...(planEnd ? { before: planEndCutoff(planEnd) } : {}),
  }), planEnd);

  const currentWeek = weeks.find(w => w.week_start <= today && today <= w.week_end) ?? null;

  const activityDatesSet = new Set(activities.map(activityLocalDate));
  let thisWeek = null;
  if (currentWeek) {
    const inWeek = a => {
      const d = activityLocalDate(a);
      return d >= currentWeek.week_start && d <= currentWeek.week_end;
    };
    const kmRunSoFar = +(activities.filter(a => isRunType(a) && inWeek(a))
      .reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)).toFixed(1);
    const completed = [];
    const missed = [];
    for (const w of currentWeek.workouts ?? []) {
      if (w.date >= today) continue;
      (activityDatesSet.has(w.date) ? completed : missed).push({ date: w.date, day: w.day, type: w.type, km: w.km });
    }

    // Credit unscheduled runs that make up a workout missed earlier in the week
    const plannedDates = new Set((currentWeek.workouts ?? []).map(w => w.date));
    const runsInWeek = activities.filter(a => isRunType(a) && inWeek(a)).map(a => ({
      date: activityLocalDate(a),
      name: a.name,
      km: +((a.distance || 0) / 1000).toFixed(2),
    }));
    const pairs = matchMakeupRuns(missed, runsInWeek, plannedDates);
    const madeUpDates = new Set(pairs.map(p => p.missed.date));

    thisWeek = {
      km_run_so_far: kmRunSoFar,
      completed_workouts: completed,
      missed_workouts: missed.filter(m => !madeUpDates.has(m.date)),
      made_up_workouts: pairs.map(({ missed: m, run }) => ({
        ...m,
        made_up_by: { date: run.date, name: run.name, km: run.km },
      })),
      unscheduled_runs: runsInWeek
        .filter(r => !plannedDates.has(r.date) && !pairs.some(p => p.run.date === r.date)),
    };
  }

  const payload = {
    today,
    mode: initial
      ? 'initial — the plan was just created; write a "position going in" assessment per the system prompt'
      : 'progress check-in',
    data: {
      runner: {
        race_date: overview.race_date,
        goal_time: overview.goal_time,
        goal_pace: overview.goal_pace,
        distance_km: overview.distance_km,
        experience: overview.experience,
        training_style: overview.training_style,
      },
      plan: {
        total_weeks: weeks.length,
        current_week: currentWeek,
        first_weeks: initial
          ? weeks.slice(0, 3).map(w => ({ week_number: w.week_number, phase: w.phase, week_start: w.week_start, total_km: w.total_km }))
          : undefined,
      },
      this_week: thisWeek,
      recent_activities: activities.map(a => ({
        date: activityLocalDate(a),
        sport_type: a.sport_type || a.type,
        name: a.name,
        km: a.distance ? +(a.distance / 1000).toFixed(2) : 0,
        moving_time: fmtDuration(a.moving_time),
        pace: isRunType(a) && a.average_speed > 0 ? `${fmtPace(1000 / a.average_speed)}/km` : undefined,
        avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : undefined,
      })),
    },
  };

  const stream = anthropic.messages.stream({
    model: REVIEW_MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: UPDATE_SUMMARIES_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: SUMMARIES_SCHEMA } },
    messages: [{ role: 'user', content: buildUpdateSummariesUserPrompt(payload) }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') throw Object.assign(new Error('Summaries declined'), { code: 'REFUSAL' });
  const textBlock = message.content.find(b => b.type === 'text');
  if (!textBlock) throw Object.assign(new Error('No summaries generated'), { code: 'NO_OUTPUT' });

  const { week_summary, plan_summary } = JSON.parse(textBlock.text);
  await db.marathon_overview.upsert(userId, {
    week_summary,
    plan_summary,
    // Stamp the newest fetched activity so the next dashboard load's detection call skips
    ...(activities[0] ? { last_processed_activity_id: String(activities[0].id) } : {}),
    summaries_checked_date: today,
  });
  return { week_summary, plan_summary };
}

router.get('/weeks', requireAuth, async (req, res) => {
  const weeks = await db.training_weeks.findByUserId(req.userId);
  res.json(weeks);
});

router.get('/plan', requireAuth, async (req, res) => {
  const plan = await db.marathon_overview.findByUserId(req.userId);
  if (!plan) return res.status(404).json({ error: 'No plan found' });
  res.json(plan);
});

router.post('/plan', requireAuth, async (req, res) => {
  const { distance_km, race_date, goal_time, goal_pace, weekly_km, days_per_week, running_days, long_run_day, experience, training_style, notes } = req.body;
  if (!distance_km || !race_date) return res.status(400).json({ error: 'distance_km and race_date are required' });
  // This starts a new plan: never overwrite an existing one in place (finished → history, else discarded)
  await db.past_plans.endCurrent(req.userId, clientToday(req));
  await db.marathon_overview.upsert(req.userId, { distance_km, race_date, goal_time, goal_pace, weekly_km, days_per_week, running_days, long_run_day, experience, training_style, notes });
  res.json({ ok: true });
});

router.post('/generate-plan', requireAuth, async (req, res) => {
  try {
    const overview = await db.marathon_overview.findByUserId(req.userId);
    if (!overview) return res.status(404).json({ error: 'No plan overview found' });

    const todayISO = clientToday(req);

    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      system: GENERATE_PLAN_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: GENERATED_PLAN_SCHEMA } },
      messages: [{ role: 'user', content: buildGeneratePlanUserPrompt(overview, todayISO) }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      return res.status(502).json({ error: 'Plan generation was declined' });
    }
    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No plan generated' });

    const { weeks } = JSON.parse(textBlock.text);
    await db.training_weeks.replaceByUserId(req.userId, weeks);
    await db.marathon_overview.upsert(req.userId, {});

    res.json({ ok: true, weeks: weeks.length });
  } catch (err) {
    console.error('Generate plan error:', err.message);
    res.status(500).json({ error: 'Failed to generate plan' });
  }
});

router.post('/revise-goal', requireAuth, async (req, res) => {
  try {
    const { goal_time } = req.body;
    if (!goal_time) return res.status(400).json({ error: 'goal_time is required' });

    const overview = await db.marathon_overview.findByUserId(req.userId);
    if (!overview) return res.status(404).json({ error: 'No plan overview found' });

    const distanceKm = overview.distance_km;
    const newTimeSec = parseTimeToSeconds(goal_time);
    if (newTimeSec == null || !distanceKm) return res.status(400).json({ error: 'Invalid goal time' });

    const newPaceSec = newTimeSec / distanceKm;
    const newGoalPace = fmtPace(newPaceSec);

    const oldTimeSec = overview.goal_time ? parseTimeToSeconds(overview.goal_time) : null;
    const oldPaceSec = overview.goal_pace
      ? parsePaceToSeconds(overview.goal_pace)
      : (oldTimeSec != null ? oldTimeSec / distanceKm : null);

    const weeks = await db.training_weeks.findByUserId(req.userId);

    if (oldPaceSec == null || !weeks.length) {
      await db.marathon_overview.upsert(req.userId, { goal_time, goal_pace: newGoalPace });
      return res.json({ ok: true, weeks: 0 });
    }

    const ratio = newPaceSec / oldPaceSec;

    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      system: REVISE_GOAL_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: GENERATED_PLAN_SCHEMA } },
      messages: [{
        role: 'user',
        content: buildReviseGoalUserPrompt({
          distance_km: distanceKm,
          old_goal_time: overview.goal_time,
          old_goal_pace: overview.goal_pace,
          new_goal_time: goal_time,
          new_goal_pace: newGoalPace,
          ratio: ratio.toFixed(4),
          weeks,
        }),
      }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      return res.status(502).json({ error: 'Goal revision was declined' });
    }
    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No revised plan generated' });

    const { weeks: revisedWeeks } = JSON.parse(textBlock.text);
    await db.training_weeks.replaceByUserId(req.userId, revisedWeeks);
    await db.marathon_overview.upsert(req.userId, { goal_time, goal_pace: newGoalPace });

    res.json({ ok: true, weeks: revisedWeeks.length });
  } catch (err) {
    console.error('Revise goal error:', err.message);
    res.status(500).json({ error: 'Failed to revise goal' });
  }
});

const UPLOAD_MEDIA_TYPES = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'application/pdf': 'document',
};

router.post('/upload-plan', requireAuth, async (req, res) => {
  try {
    const { image_base64, media_type, distance_km, race_date, goal_time, goal_pace } = req.body;
    if (!image_base64 || !media_type) return res.status(400).json({ error: 'image_base64 and media_type are required' });
    const blockType = UPLOAD_MEDIA_TYPES[media_type];
    if (!blockType) return res.status(400).json({ error: 'Unsupported file type. Use PNG, JPEG, or PDF.' });
    if (!distance_km || !race_date) return res.status(400).json({ error: 'distance_km and race_date are required' });

    const todayISO = clientToday(req);
    const overview = { distance_km, race_date };

    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      system: UPLOAD_PLAN_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: UPLOAD_PLAN_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: blockType, source: { type: 'base64', media_type, data: image_base64 } },
          { type: 'text', text: buildUploadPlanUserPrompt(overview, todayISO) },
        ],
      }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      return res.status(502).json({ error: 'Plan extraction was declined' });
    }
    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No plan extracted from the file' });

    const { running_days, long_run_day, experience, training_style, weekly_km, weeks } = JSON.parse(textBlock.text);
    if (!weeks?.length) return res.status(502).json({ error: 'Could not find any workouts in the file' });

    await db.past_plans.endCurrent(req.userId, todayISO);
    await db.marathon_overview.upsert(req.userId, {
      distance_km, race_date, goal_time: goal_time || '', goal_pace: goal_pace || '',
      weekly_km, running_days, long_run_day, experience, training_style,
      notes: 'Imported from uploaded plan image.',
    });
    await db.training_weeks.replaceByUserId(req.userId, weeks);

    res.json({ ok: true, weeks: weeks.length });
  } catch (err) {
    console.error('Upload plan error:', err.message);
    res.status(500).json({ error: 'Failed to extract plan from file' });
  }
});

router.patch('/plan', requireAuth, async (req, res) => {
  const existing = await db.marathon_overview.findByUserId(req.userId);
  if (!existing) return res.status(404).json({ error: 'No plan found' });
  const { week_summary, plan_summary } = req.body;
  await db.marathon_overview.upsert(req.userId, { week_summary, plan_summary });
  res.json({ ok: true });
});

// "Start a new plan": a finished plan moves to Past plans (its run reviews stay, they're keyed
// by activity); an unfinished one is deleted with its reviews
router.post('/plan/end', requireAuth, async (req, res) => {
  const result = await db.past_plans.endCurrent(req.userId, clientToday(req));
  res.json({ ok: true, archived: result?.archived ?? null, deleted: !!result?.deleted });
});

router.get('/past-plans', requireAuth, async (req, res) => {
  res.json(await db.past_plans.list(req.userId));
});

router.get('/past-plans/:id', requireAuth, async (req, res) => {
  const plan = await db.past_plans.find(req.userId, Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json(plan);
});

router.delete('/past-plans/:id', requireAuth, async (req, res) => {
  const removed = await db.past_plans.remove(req.userId, Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Plan not found' });
  res.json({ ok: true });
});

module.exports = router;
