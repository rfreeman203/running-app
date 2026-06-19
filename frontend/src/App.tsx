import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api, getToken, type User } from './lib/api';
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
    if (!getToken()) { setUser(null); return; }
    api.auth.me()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <Splash />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={setUser} />} />
        <Route path="/connect-strava" element={
          !user ? <Navigate to="/login" replace /> : <ConnectStrava user={user} onConnected={setUser} />
        } />
        <Route path="/strava-connected" element={<StravaCallback onDone={setUser} />} />
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
