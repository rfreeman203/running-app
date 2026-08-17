import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { api, clearToken, getToken, type User } from './lib/api';
import Login from './pages/Login';
import ConnectStrava from './pages/ConnectStrava';
import Dashboard from './pages/Dashboard';
import StravaCallback from './pages/StravaCallback';

function AuthGuard({ user, children }: { user: User | null; children: React.ReactNode }) {
  if (!user) return <Navigate to="/login" replace />;
  if (!user.hasStrava) return <Navigate to="/connect-strava" replace />;
  return <>{children}</>;
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    const token = getToken();
    if (!token) { setUser(null); return; }

    // Guard against a late `me()` result clobbering a newer session: the effect
    // runs twice under StrictMode, and if the user signs in while an earlier
    // call is still in flight its rejection would knock them back to /login.
    let cancelled = false;
    const stale = () => cancelled || getToken() !== token;

    api.auth.me()
      .then(u => { if (!stale()) setUser(u); })
      .catch(() => {
        if (stale()) return;
        clearToken(); // the token is invalid/expired — don't retry it on reload
        setUser(null);
      });

    return () => { cancelled = true; };
  }, []);

  if (user === undefined) return <Splash />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={setUser} />} />
        <Route path="/connect-strava" element={
          !user ? <Navigate to="/login" replace /> : <ConnectStrava user={user} onConnected={setUser} />
        } />
        <Route path="/strava-connected" element={<StravaCallback />} />
        <Route path="/strava-error" element={<Navigate to="/connect-strava" replace />} />
        <Route path="/" element={
          <AuthGuard user={user ?? null}>
            <Dashboard user={user!} onSignOut={() => setUser(null)} />
          </AuthGuard>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function Splash() {
  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
  );
}
