You are generating a structured week-by-week training plan and writing it directly to the app's flat-file database at `backend/data/db.json`.

## Step 1 — Read the database

Read `backend/data/db.json`.

- If there is exactly one user, use that `user_id`. If there are multiple users, ask which email to use.
- Find the `marathon_overview` record for that `user_id`. This record contains all the plan inputs saved from the UI.
- If no `marathon_overview` record exists for the user, tell the user to fill in their plan details in the app first, then stop.

Extract the following fields from the record:
- `distance_km` — race distance in km
- `race_date` — YYYY-MM-DD
- `goal_time` — target finish time (may be empty string)
- `goal_pace` — per-km pace (may be empty string)
- `weekly_km` — current weekly running mileage base
- `running_days` — array of day abbreviations e.g. `["Mon","Wed","Thu","Sat","Sun"]`; fall back to deriving from `days_per_week` (default 5 days: Mon/Wed/Thu/Sat/Sun) if missing
- `long_run_day` — e.g. `"Sun"`
- `experience` — `"beginner"`, `"intermediate"`, or `"advanced"`
- `training_style` — `"easy"` or `"intervals"`
- `notes` — free text (may be empty)

### Parsing cross-training from notes

Read the `notes` field carefully and extract any recurring non-running activities the user mentions. Examples to look for:
- Cycling/biking: "bike 80km every Thursday", "cycle on Tues", "spin class Wednesday"
- Gym/strength: "gym on Monday", "strength training Fri", "weights Tuesday and Friday"
- Swimming: "swim Tue", "swimming on Monday mornings"
- Any other sport or workout activity on a specific day

Build a `cross_training` list from these mentions. Each entry has:
- `day` — e.g. `"Thu"`
- `activity` — `"cycling"`, `"gym"`, `"swim"`, or `"other"`
- `description` — a short description parsed from the notes, e.g. `"Cycling — 80 km"`
- `km` — estimated km equivalent for cycling (use the stated distance); for gym/swim/other, use 0

If the user's notes mention a cross-training day that overlaps with a `running_days` entry, keep the running workout AND add the cross-training as a separate entry on that day. If no overlap, the cross-training day is scheduled alongside the running days.

## Step 2 — Generate the plan

Using the fields above, generate the full training plan. Apply proper periodization.

### Weeks calculation
- Week 1 starts on the Monday on or after today's date
- The final week contains the race date
- Count total weeks available

### Phase structure (adapt to total weeks):
- **≤ 8 weeks**: Base 25% / Build 50% / Taper 25%
- **9–16 weeks**: Base 30% / Build 45% / Peak 10% / Taper 15%
- **17+ weeks**: Base 35% / Build 40% / Peak 15% / Taper 10% (min 2 weeks taper for 5K/10K, 3 weeks for half/marathon)

### Weekly mileage progression:
- Start from the user's current weekly mileage (`weekly_km`)
- Increase by no more than 10% per week during base and build
- Include a cutback week (reduce by ~20%) every 3rd or 4th week
- Peak week mileage targets by distance:
  - 5K: 50–70 km/week (advanced), 30–50 (intermediate), 20–35 (beginner)
  - 10K: 55–80 / 35–55 / 25–40
  - Half: 70–100 / 45–70 / 30–50
  - Marathon: 100–160 / 65–100 / 45–70
- Taper: reduce by 20% in week -3, 30% in week -2, 40% in week -1, race week is ~30% with easy runs only
- Scale all targets down if current mileage is significantly below the lower bound

### Per-day workout assignment:
For each week, assign workouts to the days in `running_days`. Rules:
- The long run always goes on `long_run_day`
- Never schedule two hard sessions (tempo, intervals, long run) on consecutive days
- Recovery/easy runs sandwich hard sessions
- For `"easy"` style: 80% easy, 20% moderate — no formal intervals; quality days are tempo or marathon-pace runs
- For `"intervals"` style: include VO2max intervals (5K/10K training) or lactate threshold intervals (half/marathon)
- Beginner: easy + long run only in base phase; introduce tempo in build
- Rest days are not included in the workouts array — only active days (running or cross-training)

### Cross-training workouts:
After placing all running workouts, add each cross-training session from the parsed list into **every week** of the plan at its designated day. Cross-training sessions are fixed — they don't change week to week unless you have a specific reason (e.g. cut back slightly during taper weeks). Keep the description and km consistent unless the notes suggest variation.

### Workout types:
Use these exact type strings:
- **Running**: `"easy"`, `"tempo"`, `"intervals"`, `"long"`, `"marathon_pace"`, `"strides"`, `"race"`
- **Cross-training**: `"cycling"`, `"gym"`, `"swim"`, `"cross_training"`

### Description format:
Each workout description should be a single actionable sentence, e.g.:
- `"Easy aerobic run, conversational pace (RPE 3-4)"`
- `"8×400m at 5K pace with 90s recovery jogs"`
- `"Long run, first half easy, last 8km at marathon goal pace"`
- `"Cycling — 80 km endurance ride, moderate effort"`
- `"Gym — strength and conditioning, focus on legs and core"`
- `"Swim — 2 km easy aerobic"`

## Step 3 — Write to the database

Read the current `backend/data/db.json` again immediately before writing to avoid overwriting concurrent changes.

**marathon_overview record** — update only the `updated_at` timestamp; leave all other fields as they are:
```json
{ "updated_at": <Date.now() equivalent — current unix ms> }
```

**training_weeks table** — replace all records for this user_id:
```json
[
  {
    "user_id": "<id>",
    "week_number": 1,
    "week_start": "<YYYY-MM-DD Monday>",
    "week_end": "<YYYY-MM-DD Sunday>",
    "phase": "<base|build|peak|taper|race>",
    "total_km": <number, sum of running workout distances only>,
    "workouts": [
      {
        "date": "<YYYY-MM-DD>",
        "day": "<Mon|Tue|...|Sun>",
        "type": "<easy|tempo|intervals|long|marathon_pace|strides|race|cycling|gym|swim|cross_training>",
        "km": <number — use 0 for gym; use actual distance for cycling/swim if known>,
        "description": "<string>"
      }
    ]
  }
]
```

Note: `total_km` counts only running workouts. Cross-training entries are included in the `workouts` array but excluded from `total_km`.

Write the updated JSON back to `backend/data/db.json` with the `training_weeks` array added (or replaced) alongside `users` and `marathon_overview`.

## Step 4 — Summary

After writing, report back:
- Total weeks in the plan
- Phase breakdown (weeks per phase)
- Peak weekly running mileage
- Any cross-training activities detected and how they were scheduled
- First week's workouts as a sample (including cross-training)
- Confirmation that db.json was updated
