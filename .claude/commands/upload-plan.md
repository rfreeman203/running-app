You are parsing a running training plan file (PNG, JPEG, or PDF) and writing the extracted data directly to `backend/data/db.json` in the same format produced by `/generate-plan`.

The user will provide a file path as the skill argument. If no argument is given, ask the user for the file path before proceeding. The file may be a PNG or JPEG image (photo or screenshot of a plan) or a PDF (exported or printed plan). The Read tool handles all three formats natively.

## Step 1 — Read the file

Use the Read tool to open the file at the path provided. Examine it carefully and extract everything visible:

- **Plan structure**: number of weeks, week-by-week breakdown
- **Workouts per day**: type of run (easy, tempo, long, intervals, rest, etc.), distance in km or miles (convert miles → km if needed: 1 mile = 1.60934 km), any descriptions or notes per workout
- **Race info**: race date, race distance, goal time or target pace — if visible anywhere in the image
- **Phase labels**: base, build, peak, taper — if labelled
- **Dates**: specific dates if shown, or just week numbers if not

Note anything ambiguous or illegible.

## Step 2 — Identify missing required fields

You need the following to write a complete record. Check what you extracted in Step 1 and identify gaps:

**Required for marathon_overview:**
- `race_date` (YYYY-MM-DD) — ask if not in image
- `distance_km` — ask if not in image (common values: 5 = 5K, 10 = 10K, 21.0975 = half, 42.195 = marathon)
- `goal_time` — ask if not in image; leave as empty string `""` if user doesn't know
- `goal_pace` — derive from goal_time / distance_km if possible; otherwise ask or leave as `""`

**Inferred (don't ask, use best judgement from image):**
- `running_days` — derive from which days have workouts in the plan
- `long_run_day` — the day the long run falls on (most common: Sunday)
- `experience` — infer from volume and workout complexity: `"beginner"` / `"intermediate"` / `"advanced"`
- `training_style` — `"easy"` if mostly easy runs; `"intervals"` if structured interval sessions present
- `weekly_km` — use the first week's total running km as the base

Ask the user for any **required** fields you cannot determine. Ask all questions in one message, then wait for answers before writing.

## Step 3 — Read the database

Read `backend/data/db.json`.

- If there is exactly one user, use that `user_id`.
- If there are multiple users, ask which email to use.

## Step 4 — Map weeks to calendar dates

If the image shows specific dates, use them. If only week numbers are shown:
- Week 1 starts on the Monday on or after today's date
- Each subsequent week starts 7 days later
- `week_end` is always the Sunday of that week (week_start + 6 days)

The final week should contain or immediately precede the race date.

If the image has more weeks than fit before the race date, truncate from the end. If fewer, that is fine — use what is in the plan.

## Step 5 — Structure the data

Map every workout in the image to the schema below. Use these exact type strings:

**Running types:** `"easy"`, `"tempo"`, `"intervals"`, `"long"`, `"marathon_pace"`, `"strides"`, `"race"`
**Cross-training:** `"cycling"`, `"gym"`, `"swim"`, `"cross_training"`

For workout descriptions, write a single actionable sentence if the image doesn't provide one, e.g.:
- `"Easy aerobic run, conversational pace (RPE 3-4)"`
- `"Long run at comfortable effort"`
- If the image has its own description, use it verbatim or cleaned up

Rest days are **not** included in the workouts array — only active training days.

`total_km` = sum of running workout km only (exclude cross-training).

## Step 6 — Write to the database

Read `backend/data/db.json` again immediately before writing to avoid overwriting concurrent changes.

**Replace or insert the `marathon_overview` record for this user:**
```json
{
  "user_id": "<id>",
  "distance_km": <number>,
  "race_date": "<YYYY-MM-DD>",
  "goal_time": "<string or empty string>",
  "goal_pace": "<string or empty string>",
  "weekly_km": <first week total km>,
  "running_days": ["Mon", ...],
  "long_run_day": "<day>",
  "experience": "<beginner|intermediate|advanced>",
  "training_style": "<easy|intervals>",
  "notes": "Imported from uploaded plan image.",
  "created_at": <Date.now() in ms>,
  "updated_at": <Date.now() in ms>
}
```

**Replace all `training_weeks` records for this user:**
```json
[
  {
    "user_id": "<id>",
    "week_number": 1,
    "week_start": "<YYYY-MM-DD>",
    "week_end": "<YYYY-MM-DD>",
    "phase": "<base|build|peak|taper|race>",
    "total_km": <running km only>,
    "workouts": [
      {
        "date": "<YYYY-MM-DD>",
        "day": "<Mon|Tue|Wed|Thu|Fri|Sat|Sun>",
        "type": "<type string>",
        "km": <number>,
        "description": "<string>"
      }
    ]
  }
]
```

Write the full updated JSON back to `backend/data/db.json`.

## Step 7 — Report back

After writing, report:
- Number of weeks imported
- Total workouts across the plan
- Race date and distance used
- Any data that was unclear or assumed
- Confirmation that db.json was updated
