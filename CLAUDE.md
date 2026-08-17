# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

Both processes must run simultaneously. Start each in a separate terminal from the repo root:

```bash
# Backend (port 3000)
cd backend && npm run dev

# Frontend (port 5173)
cd frontend && npm run dev
```

The frontend Vite dev server proxies `/auth` and `/training` to `http://localhost:3000`, so there is no CORS issue in development. The `.env` file lives at the **repo root** and is read by both processes.

The backend talks to **Postgres** (see `db.js` below), so `DATABASE_URL` must be set in `.env` even for local dev — point it at your Neon instance (or any Postgres). Tables are created automatically on boot.

Build the frontend for production:
```bash
cd frontend && npm run build
```

There are no tests.

## Production / deployment

Deployed as a **single service** (currently Render, free tier): the Express backend also serves the built React app (`frontend/dist`) so frontend and backend are one origin — this is why `api.ts` uses root-relative paths and there's no `VITE_API_URL`. Data lives in **Neon Postgres** (managed, external), so the host itself is stateless.

- Build command: `npm --prefix frontend install && npm --prefix frontend run build && npm --prefix backend install`
- Start command: `node backend/src/index.js`
- In production, set `BACKEND_URL` and `FRONTEND_URL` to the **same** deployed URL. Google's OAuth client needs that URL as an Authorized JavaScript origin; Strava needs it as the Authorization Callback Domain.
- One-time data import: `cd backend && npm run migrate` copies `backend/data/db.json` into Postgres (drops + recreates tables, so it also rebuilds the schema).

## Environment variables

Copy `.env.example` to `.env` at the repo root. Required vars:
- `DATABASE_URL` — Postgres connection string (Neon pooled URL, includes `?sslmode=require`)
- `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` — from Strava API settings
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
- `JWT_SECRET` — any long random string
- `BACKEND_URL` / `FRONTEND_URL` — used for OAuth redirect URIs (defaults: `http://localhost:3000` / `http://localhost:5173`)
- `VITE_GOOGLE_CLIENT_ID` — same value as `GOOGLE_CLIENT_ID`; Vite exposes only `VITE_`-prefixed vars to the browser. Baked in at **build** time, so it must be present when `vite build` runs
- `ANTHROPIC_API_KEY` — the backend calls the Anthropic API for plan generation, run reviews, and training summaries

## Architecture

### Auth flow
1. User signs in with Google (`@react-oauth/google` on the frontend, `google-auth-library` on the backend). The backend verifies the Google ID token and returns a JWT stored in `localStorage`.
2. User connects Strava via OAuth. The backend initiates the redirect at `/auth/strava-start?token=<jwt>` (token in query param because browser redirects can't set headers). After Strava calls back to `/auth/strava/callback`, tokens are saved to the DB and the browser is redirected to `/strava-connected`.
3. All subsequent API calls carry the JWT as `Authorization: Bearer <token>`. The `requireAuth` middleware verifies it and sets `req.userId`.

### Backend (`backend/src/`)
- `index.js` — Express entry point; runs `db.init()` (creates tables) before listening, mounts `/auth` and `/training` routers, then serves `frontend/dist` with an SPA fallback (mounted **after** the API routers so they take precedence)
- `routes/auth.js` — Google sign-in, Strava OAuth connect/disconnect, account delete, `/auth/me`
- `routes/training.js` — proxies Strava's `/athlete/activities` and `/athletes/:id/stats` (auto token refresh via `withStravaToken`), the plan CRUD/AI routes, and the AI generation routes (see AI features below). Prompt constants and JSON schemas live at the top of the file
- `middleware/requireAuth.js` — JWT verification (no DB access)
- `db.js` — **Postgres** access layer via the `pg` `Pool`. Fully normalized schema (a column per field): `users`, `marathon_overview`, `training_weeks`, `workouts` (child table — each week's workouts array is exploded here and reassembled on read), `run_reviews`. `running_days` is a `TEXT[]`; node-pg type parsers make bigint/numeric come back as JS numbers. **Every method is async** — all route call sites `await` them. Upserts merge only the provided columns (partial updates); `db.init()` runs `CREATE TABLE IF NOT EXISTS` on boot. Stores user records including Strava tokens.

### AI features (Anthropic)
The backend calls the Anthropic API (`claude-opus-4-8`, JSON-schema-constrained output) for:
- **Plan generation / revision / upload** — `POST /training/generate-plan`, `/revise-goal`, `/upload-plan` build the `training_weeks`.
- **Per-run reviews** — `POST /training/review/:activityId/generate` fetches the Strava activity detail, matches it to that day's planned workout, and writes a `run_reviews` row (`summary` + markdown `review_text`). Cached; `?refresh=1` regenerates. The dashboard auto-generates reviews for recent in-plan runs via a module-level queue in `Dashboard.tsx` (`enqueueReview`/`pumpReviewQueue`, concurrency 1); out-of-scope runs get a manual "Generate AI review" button.
- **Make-up detection** — an unscheduled run is paired against workouts missed earlier the *same* week when the distances match (`matchMakeupRuns`/`distanceMatches` in `training.js`; tolerance is 20% of planned km, capped at 2 km, floored at 1 km). Only running workout types are matchable, each missed workout can be claimed once, and the run must post-date the miss. Feeds `made_up_workouts` in the summaries payload and `possible_makeup_for` in the run-review context, so neither reports a missed session *and* a stray extra run.
- **Training summaries** — `POST /training/update-summaries` writes `week_summary`/`plan_summary` onto `marathon_overview`. Triggered on dashboard load when the newest activity id differs from the stored `last_processed_activity_id`, and in `{ initial: true }` mode right after a plan is created (a "position going in" baseline). In-flight + id guards keep concurrent loads from double-generating.

### Frontend (`frontend/src/`)
- `lib/api.ts` — single `api` object used everywhere; all fetch calls go through `request()` which attaches the JWT. The `activities()` call accepts `{ page, per_page, before, after }` where `before`/`after` are Unix timestamps (used for month-scoped calendar fetches).
- `App.tsx` — routing and top-level auth state. `AuthGuard` redirects unauthenticated users to `/login` and Strava-less users to `/connect-strava`.
- `pages/Dashboard.tsx` — the entire post-login UI: overview tab and calendar tab. Renders the AI training summaries (`PlanProgress`) and per-run reviews (`RecentActivities` list + calendar `ActivityDetail`), and hosts the module-level auto-review queue. All styles are inline (`React.CSSProperties` objects at the bottom of the file).

### Calendar data loading
`CalendarView` in `Dashboard.tsx` fetches its own Strava data independently of the overview. Two module-level objects (`calCache`, `calInflight`) act as a persistent cache keyed by `"YYYY-MM"`:
- `calInflight` stores in-flight promises so multiple callers for the same month share one request
- On each month navigation, adjacent months are preloaded in the background and today's month is always kept warm
- A `cancelled` flag in the `useEffect` cleanup prevents stale fetches from overwriting state after the user has navigated away
