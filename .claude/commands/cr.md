Review the current git diff (staged + unstaged) for correctness issues specific to this codebase. Run `git diff HEAD` to get the diff. If no diff, say so and stop.

Check each of the following areas and report findings grouped by severity: **Bug** (will break at runtime), **Security** (auth/token/data exposure), **Warning** (likely wrong or fragile).

Only report findings you are confident about. Skip areas where no relevant changes were made.

---

## Auth & middleware

- Every new Express route that returns user data or calls Strava must use the `requireAuth` middleware. Check that no protected route is missing it.
- Strava tokens must always be obtained via `getFreshStravaToken(userId)` in `training.js`. Never read `strava_access_token` directly from `db.users.findBy()` and use it without checking expiry.
- JWT signing uses `process.env.JWT_SECRET`. Any new token minting must use `{ expiresIn }` — tokens without expiry are a bug.
- The Strava OAuth initiation route (`/auth/strava-start`) takes the JWT as a query param (not a header) because it's a browser redirect. New OAuth-style routes should follow this same pattern.

## Database (flat-file JSON)

- `db.js` reads and writes the entire `backend/data/db.json` file on every call. Any loop that calls `db.users.findBy`, `db.users.update`, etc. inside an iteration is an N×file-read bug.
- Never store plaintext secrets in user records beyond what's already there (`strava_access_token`, `strava_refresh_token`). The `/auth/me` handler strips these before responding — any new endpoint returning user objects must do the same.

## Frontend API calls

- All fetch calls must go through `api.*` in `lib/api.ts`, which attaches the JWT automatically. Raw `fetch('/some/path')` calls without the Authorization header will get 401s on protected routes.
- The `activities()` function accepts `{ page, per_page, before, after }`. `before`/`after` are Unix timestamps (seconds, not milliseconds). Passing `Date.getTime()` directly (milliseconds) is a bug — must divide by 1000.
- Strava's `per_page` max is 200. Values above that will be silently clamped or errored by Strava.

## Calendar cache

- `calCache` and `calInflight` are module-level objects in `Dashboard.tsx`. They persist across `CalendarView` mounts/unmounts. Any change that clears or mutates them outside of `fetchCalMonth` is likely wrong.
- `calInflight` stores promises keyed by `"YYYY-MM"`. If a new code path awaits `fetchCalMonth` and catches the rejection, make sure it also handles the case where `calInflight[key]` was already deleted by a prior rejection.
- The `cancelled` flag in the `useEffect` cleanup prevents stale fetch results from updating state. Any new async operation inside the same effect must also check `cancelled` before calling `setState`.

## Environment variables

- The `.env` file lives at the repo root, not inside `frontend/` or `backend/`. Backend reads it via `dotenv.config({ path: path.join(__dirname, '../../.env') })`.
- Only `VITE_`-prefixed variables are exposed to the browser by Vite. A variable like `GOOGLE_CLIENT_ID` used in frontend code without the prefix will be `undefined` at runtime.

## React / frontend

- All styles are inline `React.CSSProperties` objects. No CSS modules, no Tailwind. New components should follow this pattern — don't introduce a new styling system.
- New pages added to `App.tsx` that require authentication need to be wrapped with `<AuthGuard>`, which enforces both Google sign-in and Strava connection.

## Strava API surface

- The backend proxies two Strava endpoints: `GET /athlete/activities` and `GET /athletes/:id/stats`. Adding a new Strava call requires a corresponding route in `backend/src/routes/training.js` — the frontend cannot call Strava directly (no CORS, and tokens must stay server-side).

---

After listing findings, give a one-line overall verdict: **Ready**, **Ready with warnings**, or **Needs fixes**.
