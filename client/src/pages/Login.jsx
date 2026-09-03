import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function Login() {
  const { user, ready, login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!ready) return <div className="boot">Loading…</div>;
  if (user) return <Navigate to="/" replace />;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <span className="login__logo">W</span>
        <h1>WPP Inbox</h1>
        <p className="muted">Sign in to manage your WhatsApp sessions.</p>

        {error ? <p className="error">{error}</p> : null}

        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" required />
        </label>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login__hint">
          No account? <Link to="/signup">Create one</Link>.<br />
          First run seeds <code>admin</code> / <code>admin123</code> — change it with
          <code>ADMIN_PASS</code> before deploying anywhere real.
        </p>
      </form>
    </div>
  );
}
