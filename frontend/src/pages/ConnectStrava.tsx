import { useState } from 'react';
import { clearToken, getToken, type User } from '../lib/api';
import { useNavigate } from 'react-router-dom';

interface Props {
  user: User;
  onConnected: (user: User) => void;
}

export default function ConnectStrava({ user, onConnected }: Props) {
  const navigate = useNavigate();

  function connectStrava() {
    const token = getToken();
    // Navigate to the backend's Strava auth endpoint; the JWT in the Authorization
    // header won't work via redirect, so we pass it in a short-lived query param.
    // The backend reads it from the Authorization header set by requireAuth middleware,
    // so we open a new tab to the backend with the token in the query.
    window.location.href = `/auth/strava-start?token=${token}`;
  }

  function signOut() {
    clearToken();
    navigate('/login');
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <span style={{ fontSize: 64 }}>🔗</span>
        <h1 style={styles.title}>Connect Strava</h1>
        <p style={styles.body}>
          Link your Strava account to sync your training runs and get marathon insights.
        </p>

        <button style={styles.stravaBtn} onClick={connectStrava}>
          <StravaIcon />
          Connect with Strava
        </button>

        <button style={styles.signOut} onClick={signOut}>Sign out</button>
      </div>
    </div>
  );
}

function StravaIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
      <path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.17" />
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 100%)',
    padding: 24,
  },
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 20,
    padding: '48px 40px',
    width: '100%',
    maxWidth: 420,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 20,
    textAlign: 'center',
  },
  title: { fontSize: 28, fontWeight: 800, color: 'var(--text)' },
  body: { fontSize: 16, color: 'var(--text-muted)', lineHeight: 1.6 },
  stravaBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'var(--strava)',
    color: '#fff',
    padding: '14px 28px',
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 16,
    width: '100%',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  signOut: {
    background: 'none',
    color: 'var(--text-muted)',
    fontSize: 14,
    cursor: 'pointer',
    padding: '8px 16px',
  },
};
