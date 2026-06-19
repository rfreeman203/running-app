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

Build the frontend for production:
```bash
cd frontend && npm run build
```

There are no tests.

## Environment variables

Copy `.env.example` to `.env` at the repo root. Required vars:
- `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` — from Strava API settings
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
- `JWT_SECRET` — any long random string
- `BACKEND_URL` / `FRONTEND_URL` — used for OAuth redirect URIs (defaults: `http://localhost:3000` / `http://localhost:5173`)
- `VITE_GOOGLE_CLIENT_ID` — same value as `GOOGLE_CLIENT_ID`; Vite exposes only `VITE_`-prefixed vars to the browser

## Architecture

### Auth flow
1. User signs in with Google (`@react-oauth/google` on the frontend, `google-auth-library` on the backend). The backend verifies the Google ID token and returns a JWT stored in `localStorage`.
2. User connects Strava via OAuth. The backend initiates the redirect at `/auth/strava-start?token=<jwt>` (token in query param because browser redirects can't set headers). After Strava calls back to `/auth/strava/callback`, tokens are saved to the DB and the browser is redirected to `/strava-connected`.
3. All subsequent API calls carry the JWT as `Authorization: Bearer <token>`. The `requireAuth` middleware verifies it and sets `req.userId`.

### Backend (`backend/src/`)
- `index.js` — Express entry point; mounts `/auth` and `/training` routers
- `routes/auth.js` — Google sign-in, Strava OAuth connect/disconnect, account delete, `/auth/me`
- `routes/training.js` — proxies Strava's `/athlete/activities` and `/athletes/:id/stats`; handles token refresh automatically before each request
- `middleware/requireAuth.js` — JWT verification
- `db.js` — flat-file JSON database at `backend/data/db.json`; reads and writes the entire file on every operation. Stores user records including Strava tokens.

### Frontend (`frontend/src/`)
- `lib/api.ts` — single `api` object used everywhere; all fetch calls go through `request()` which attaches the JWT. The `activities()` call accepts `{ page, per_page, before, after }` where `before`/`after` are Unix timestamps (used for month-scoped calendar fetches).
- `App.tsx` — routing and top-level auth state. `AuthGuard` redirects unauthenticated users to `/login` and Strava-less users to `/connect-strava`.
- `pages/Dashboard.tsx` — the entire post-login UI: overview tab and calendar tab. All styles are inline (`React.CSSProperties` objects at the bottom of the file).

### Calendar data loading
`CalendarView` in `Dashboard.tsx` fetches its own Strava data independently of the overview. Two module-level objects (`calCache`, `calInflight`) act as a persistent cache keyed by `"YYYY-MM"`:
- `calInflight` stores in-flight promises so multiple callers for the same month share one request
- On each month navigation, adjacent months are preloaded in the background and today's month is always kept warm
- A `cancelled` flag in the `useEffect` cleanup prevents stale fetches from overwriting state after the user has navigated away
