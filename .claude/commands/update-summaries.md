You are updating the AI training summaries for the running app. You will generate a `week_summary` and a `plan_summary` and write them to `backend/data/db.json`.

## Step 1 — Read the database

Read `backend/data/db.json`.

- Identify the user (if multiple, use the first one).
- Find their `marathon_overview` record. Extract:
  - `user_id`, `race_date`, `goal_time`, `goal_pace`, `distance_km`
  - `created_at` (plan start timestamp)
- Find their `training_weeks` array. Identify:
  - The current week's record (whose `week_start` ≤ today ≤ `week_end`)
  - Total number of weeks in the plan
  - How many weeks have passed (week_number of current week)
  - The current week's planned workouts and total_km

## Step 2 — Fetch recent Strava activities

Use the `mcp__claude_ai_Strava__list_activities` tool to fetch the athlete's recent activities. Request enough to cover this week and the past 2–3 weeks (per_page: 30 is sufficient).

From the results, identify:
- Activities that fall within the current week (Monday–Sunday). Note their distance (in metres), type, and date.
- Total km run this week (sum distances / 1000, round to 1 decimal).
- Which planned workout types were completed (match activity dates to planned workout dates).
- How many planned workouts were completed vs missed so far this week.

Also look at the past 2–3 weeks of activities to get a sense of recent training consistency.

## Step 3 — Generate the summaries

Using the data above, write two short summaries. Be direct and specific — reference actual numbers. Tone: encouraging but honest, like a coach giving a quick check-in. Each summary is 2–3 sentences max.

### week_summary
Assess this week's progress against the plan. Mention:
- How many km done vs planned so far
- Whether the week is on track, ahead, or behind
- One concrete observation or encouragement based on the data

Example style: "You've run 14 of your planned 26 km so far this week with your long run still to come on Saturday — right on track. Three of five sessions are logged and you haven't missed anything critical. Keep the long run easy and the week is in good shape."

### plan_summary
Assess overall plan progress toward the race. Mention:
- Where in the plan they are (e.g. "Week 3 of 16, base phase")
- How overall volume has been tracking
- One forward-looking observation about the weeks ahead or goal time

Example style: "You're 3 weeks into a 16-week build toward a 3:15 marathon on Oct 18 — still in the base phase where consistency matters most. Volume has been steady and the progression is on schedule. The first tempo sessions arrive in week 6, so keep the current easy efforts truly easy to arrive there fresh."

**Revised goal time suggestion (use sparingly):** Only when training performance is clearly and consistently diverging from what the current `goal_time`/`goal_pace` implies — e.g. recent runs (especially tempo, long runs, or race-pace efforts) are significantly faster or slower than goal pace over multiple sessions, not just one outlier. This should NOT appear most weeks — only when the evidence is strong (very well or very poorly), typically not before several weeks of data exist. If triggered, append one sentence to the end of `plan_summary` proposing a specific adjusted goal time (and pace) and briefly why. If training is roughly on pace with the goal, do not mention goal time revision at all.

Example (performing much better than goal): "...The first tempo sessions arrive in week 6, so keep the current easy efforts truly easy to arrive there fresh. Your recent long runs have been consistently 15-20 sec/km faster than goal pace with low effort, so a 3:05 finish may be more realistic than 3:15 — worth reassessing in a few weeks."

Example (performing much worse than goal): "...Volume has dipped and the last three key sessions came in well off goal pace. If this trend continues, a more achievable target might be closer to 3:30 than 3:15 — no need to decide now, but worth watching."

## Step 4 — Write the summaries to the database

Read `backend/data/db.json` again immediately before writing to get the latest state.

In the `marathon_overview` record for this user, set:
```json
{
  "week_summary": "<your week_summary text>",
  "plan_summary": "<your plan_summary text>",
  "updated_at": <current unix timestamp in milliseconds>
}
```

Merge these fields into the existing record — do not remove any other fields. Write the full updated JSON back to `backend/data/db.json`.

## Step 5 — Report back

Print both summaries so the user can see what was written, then confirm the file was updated.
