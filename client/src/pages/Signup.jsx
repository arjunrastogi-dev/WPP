import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function Signup() {
  const { user, ready, register } = useAuth();
  const [form, setForm] = useState({ username: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!ready) return <div className="boot">Loading…</div>;
  if (user) return <Navigate to="/" replace />;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    // Catch the mismatch here rather than making the server reject a password
    // it was never going to see twice.
    if (form.password !== form.confirm) return setError('Those passwords do not match');
    if (form.password.length < 8) return setError('Password must be at least 8 characters');

    setBusy(true);
    setError(null);
    try {
      await register(form.username, form.password);
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
        <h1>Create an account</h1>
        <p className="muted">Your WhatsApp sessions will belong to you alone.</p>

        {error ? <p className="error">{error}</p> : null}

        <label>
          Username
          <input value={form.username} onChange={set('username')}
            autoComplete="username" pattern="[a-zA-Z0-9_.\-]{3,32}" required />
        </label>
        <label>
          Password
          <input type="password" value={form.password} onChange={set('password')}
            autoComplete="new-password" minLength={8} required />
        </label>
        <label>
          Confirm password
          <input type="password" value={form.confirm} onChange={set('confirm')}
            autoComplete="new-password" required />
        </label>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>

        <p className="login__hint">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
