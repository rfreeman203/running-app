import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, saveToken, type User } from '../lib/api';

interface Props {
  onDone: (user: User) => void;
}

export default function StravaCallback({ onDone }: Props) {
  const navigate = useNavigate();

  useEffect(() => {
    api.auth.me()
      .then((user) => {
        onDone(user);
        navigate('/', { replace: true });
      })
      .catch(() => navigate('/login', { replace: true }));
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
      <span style={{ fontSize: 48 }}>✅</span>
      <p style={{ color: 'var(--text-muted)' }}>Strava connected! Loading your training…</p>
    </div>
  );
}
