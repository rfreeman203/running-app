import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function StravaCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    // The Strava flow is always a full-page redirect, so App.tsx has already
    // fetched the fresh user (with hasStrava: true) before this mounts.
    // Just navigate to "/" and let AuthGuard route accordingly.
    navigate('/', { replace: true });
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
      <span style={{ fontSize: 48 }}>✅</span>
      <p style={{ color: 'var(--text-muted)' }}>Strava connected! Loading your training…</p>
    </div>
  );
}
