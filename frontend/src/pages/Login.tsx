import { GoogleLogin } from '@react-oauth/google';
import { useState } from 'react';
import { api, saveToken, type User } from '../lib/api';

interface Props {
  onLogin: (user: User) => void;
}

export default function Login({ onLogin }: Props) {
  const [error, setError] = useState('');

  async function handleCredential(credential: string) {
    setError('');
    try {
      const { token, user } = await api.auth.googleSignIn(credential);
      saveToken(token);
      onLogin(user);
    } catch (err: any) {
      setError(err.message ?? 'Sign in failed');
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Marathon Trainer</h1>
        <p style={styles.subtitle}>Train smarter. Run faster.</p>

        <div style={styles.googleWrap}>
          <GoogleLogin
            onSuccess={(res) => res.credential && handleCredential(res.credential)}
            onError={() => setError('Google sign in failed. Please try again.')}
            width={320}
            theme="filled_black"
            shape="pill"
            size="large"
            text="continue_with"
          />
        </div>

        {error && <p style={styles.error}>{error}</p>}
      </div>
    </div>
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
    gap: 16,
  },
  title: { fontSize: 32, fontWeight: 800, color: 'var(--text)' },
  subtitle: { fontSize: 16, color: 'var(--text-muted)', marginBottom: 8 },
  googleWrap: { width: '100%', display: 'flex', justifyContent: 'center' },
  error: { color: '#F87171', fontSize: 14, textAlign: 'center' },
};
