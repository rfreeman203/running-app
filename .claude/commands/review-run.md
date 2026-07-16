You are generating an AI activity overview that compares a recent Strava activity against the day's planned workout and gives the athlete honest, specific feedback. Works for any sport type: running, cycling, swimming, walking, hiking, weight training, etc. Generated reviews are cached in the database so they don't need to be regenerated on each visit.

## Step 1 — Read the database

Read `backend/data/db.json`.

- Identify the user (if multiple, ask which email).
- Extract from `marathon_overview`:
  - `goal_time`, `goal_pace`, `race_date`, `distance_km`, `training_style`, `notes`
- Extract all `training_weeks` for this user — you'll need them to match workouts by date.
- Note the `run_reviews` array (may be absent or empty).

## Step 2 — Fetch the activity

Use `mcp__claude_ai_Strava__list_activities` with `first: 1` to get the athlete's most recent activity.

If the user passed an activity ID as an argument (e.g. `/review-run 13456789012`), use that ID instead — call `list_activities` with a small `first` and match by id, or use the id directly in later calls.

From the result, capture:
- `id` — the Strava activity ID (store as a string)
- `name` — the activity title the athlete gave it
- `description` — any notes the athlete wrote in Strava (may be empty)
- `sport_type` — e.g. Run, Ride, Swim, Walk, Hike, WeightTraining, etc.
- `start_date_local` — extract YYYY-MM-DD date
- `distance` (metres → km, round to 2 decimal places; may be 0 for gym activities)
- `moving_time` (seconds)
- `elapsed_time`
- `total_elevation_gain`
- `average_speed` (m/s)

## Step 3 — Check the cache

Look in the `run_reviews` array in `db.json` for an entry where `activity_id === String(activity.id)` and `user_id` matches.

**If a cached review exists:** Output the stored `review_text` directly and stop. Tell the user: "Showing cached review (generated [generated_at date]). Run `/review-run [activity_id] --refresh` to regenerate."

**If the user passed `--refresh` as an argument:** Skip the cache and regenerate regardless.

**If no cached review exists:** Continue to Step 4.

## Step 4 — Get performance detail

Call `mcp__claude_ai_Strava__get_activity_performance` with the activity's `id`.

Capture:
- `average_heartrate`, `max_heartrate`
- `average_cadence`
- `calories`
- `perceived_exertion` (if set — scale 1–10)
- `laps` — note each lap's distance, pace/speed, and heart rate if available
- `best_efforts` — pick out relevant ones for the sport type

## Step 5 — Match to the training plan

Using the activity's date (YYYY-MM-DD), find the matching workout in `training_weeks`:

- Look through all weeks for a workout whose `date` matches the activity date.
- If found, extract: `type`, `km` (planned distance), `description`.
- Also note the week's `phase`, `week_number`, and `total_km` target.
- If no workout is planned for that date, note it explicitly — the activity may be a cross-training bonus, rest day activity, or unscheduled session.

Also find the **next planned workout** (next date in the plan after the activity date) — for "next steps."

## Step 6 — Calculate key metrics

Adapt metrics to the sport type:

**Running / Walking / Hiking:**
- Pace (min/km): `1000 / average_speed / 60`
- Distance delta vs plan

**Cycling:**
- Speed (km/h): `average_speed * 3.6`
- Power (watts) if available
- Distance covered

**Swimming:**
- Pace per 100m: `(moving_time / distance) * 100 / 60` (min/100m)

**Weight training / gym:**
- Duration and calories are the primary metrics; note perceived exertion if set

**All sports — Heart rate zones (if HR available):**
- Zone 1 easy: <65% max HR (~<135 bpm)
- Zone 2 aerobic: 65–75% (~135–155 bpm)
- Zone 3 tempo: 75–85% (~155–170 bpm)
- Zone 4 threshold: 85–92% (~170–183 bpm)
- Zone 5 VO2: >92% (>183 bpm)

## Step 7 — Generate the overview

Write a structured activity review. Be direct, specific, and use actual numbers. Adapt language to the sport — don't say "run" for a bike ride. Tone: like a coach giving a quick debrief — encouraging but honest. Do not pad with filler.

Format:

---

### Activity Review — [Activity Name] · [Date]

**What was planned**
One sentence: the planned workout for that day (or "No scheduled workout — [context]" if none).

**What you did**
Two to three sentences covering the key stats for the sport type: distance or duration, speed/pace, elevation, HR zone. If the athlete wrote a Strava description, reference it directly ("You noted: '...'").

**How it went**
Two to four sentences of honest assessment:
- Did the effort match the plan's intent?
- Did volume (distance/duration) hit the target or over/undershoot?
- If HR data is available, was effort in the right zone?
- Reference athlete notes from Strava if relevant.
- For cross-training (cycling, gym, swim on a run-plan day), note how it fits the training context.

**What went well**
One to three specific bullet points — actual positives from the data or athlete notes.

**Anything to watch**
One to two bullet points — gaps, pacing errors, missed volume, or warning signs. If nothing to flag, say "Nothing significant."

**Next up**
One sentence: the next planned workout (date, type, distance, and the plan's specific instruction for it).

---

Keep the whole output under 300 words.

## Step 7.5 — Generate the short summary

After writing the full review, write a `summary`: 2–3 sentences of plain prose (no markdown, no bullets) that capture how the activity went at a glance. This is shown on the activity card in collapsed state. Cover: what was done vs what was planned, the key verdict, and one forward-looking note. Be direct and specific — use actual numbers. Adapt language to the sport type.

## Step 8 — Save to the database

Read `backend/data/db.json` again immediately before writing to get the latest state.

Add or update the entry in the `run_reviews` array:

```json
{
  "user_id": "<user_id>",
  "activity_id": "<String(activity.id)>",
  "activity_name": "<activity name>",
  "activity_date": "<YYYY-MM-DD>",
  "summary": "<the 2–3 sentence plain prose summary from Step 7.5>",
  "review_text": "<the full markdown text generated in Step 7>",
  "generated_at": <Date.now() equivalent — current unix ms>
}
```

Match on `user_id` + `activity_id`. If an entry already exists for this pair, replace it. If not, append it. Write the full updated JSON back to `backend/data/db.json`.

After saving, confirm: "Review saved to database (activity ID: [id])."
