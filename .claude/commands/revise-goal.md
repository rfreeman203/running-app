You are revising the pace targets throughout an existing training plan after the user changes their goal time. This is invoked only from the app's Settings → "Edit goal" action — the user has just entered a new goal time for the same race. Do not regenerate the plan structure (weeks, phases, workout types, distances, or dates) — only the pace numbers embedded in workout descriptions change.

The new goal time is passed as the skill argument (e.g. `3:20:00`). If no argument is given, ask the user for the new goal time before proceeding.

## Step 1 — Read the database

Read `backend/data/db.json`.

- If there is exactly one user, use that `user_id`. If there are multiple, ask which email to use.
- Find the `marathon_overview` record for that `user_id`. Extract the **current** (pre-edit) `goal_time`, `goal_pace`, and `distance_km`.
- Find all `training_weeks` records for that `user_id`.

If `goal_time`/`goal_pace` are empty strings, there is nothing to rescale relative to — write the new goal_time, derive goal_pace from `new_goal_time / distance_km`, leave all workout descriptions untouched, and report that no paces needed adjusting.

## Step 2 — Compute the pace ratio

- `old_pace_sec_per_km` = old `goal_pace` converted to seconds (or derived from `old goal_time / distance_km` if `goal_pace` is missing/empty).
- `new_pace_sec_per_km` = new goal_time / `distance_km`, converted to seconds/km.
- `ratio = new_pace_sec_per_km / old_pace_sec_per_km`.
- Format the new goal_pace back as `"M:SS"` per km (matching the existing field's format, e.g. `"4:37"`).

## Step 3 — Rescale pace targets in workout descriptions

Walk every workout across every week in `training_weeks`. In each `description` string, find explicit pace references — patterns like `"4:37/km"`, `"4:50–5:00/km"`, `"@ 4:37/km"`, or a pace called out in a long-run split (e.g. "last 10 km @ 4:37/km"). These are the only things that change:

- For each pace value found, multiply its seconds/km by `ratio`, round to the nearest second, and reformat as `M:SS/km`.
- For a range (e.g. `4:50–5:00/km`), rescale both ends independently the same way — don't just shift by a flat offset.
- Leave everything else in the description untouched: km splits, warm-up/cool-down distances, RPE-based phrasing ("conversational pace", "RPE 3-4"), workout type, and structure.
- Workouts with no explicit pace number (plain "easy" runs described only by RPE, gym, cycling, swim, strides-by-feel) are left completely unchanged.
- The final race-day workout description (e.g. "Goal: 3:15:00 @ 4:37/km...") must be updated to reflect the new goal time and pace, including any pacing strategy notes that reference the old pace (e.g. "Start at 4:42–4:45/km for first 10 km").

Do not change `km`, `type`, `date`, `day`, `phase`, or `total_km` on any workout or week — the plan structure stays identical.

## Step 4 — Write to the database

Read `backend/data/db.json` again immediately before writing to avoid overwriting concurrent changes.

- Update the `marathon_overview` record: set `goal_time` to the new value, `goal_pace` to the recomputed value, and `updated_at` to the current unix ms timestamp. Leave every other field (including `week_summary`/`plan_summary`) as-is.
- Replace the `training_weeks` array for this `user_id` with the same records, only `description` fields changed as computed in Step 3.

Write the full updated JSON back to `backend/data/db.json`.

## Step 5 — Report back

Report:
- Old goal time/pace → new goal time/pace
- A short table or list of every workout description that changed (week number, date, old pace → new pace) — if there are many, group by workout type (e.g. "all 6 tempo sessions", "all 4 marathon-pace sessions", "long runs in weeks 15 and 17") rather than listing every single one
- Confirmation that `db.json` was updated, and that no other plan structure (dates, distances, phases) was touched
