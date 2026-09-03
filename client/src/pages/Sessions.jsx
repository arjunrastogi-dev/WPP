import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../SessionContext';
import StatusPill from '../components/StatusPill';

export default function SessionsPage() {
  const { sessions, refresh, active, setActive, qr, status } = useSession();
  const [name, setName] = useState('');
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (active) api.sessionStats(active).then(setStats).catch(() => setStats(null));
  }, [active, status]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); await refresh(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const create = (event) => {
    event.preventDefault();
    run(async () => {
      await api.createSession(name.trim());
      setActive(name.trim());
      setName('');
    });
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>Sessions</h1>
        <p className="muted">
          Each session is a separate WhatsApp number, with its own browser and login.
          Signing out of this app never stops a session — only Disconnect does.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <form className="card card--inline" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)}
          placeholder="New session name, e.g. sales" />
        <button className="primary" type="submit" disabled={busy || !name.trim()}>Create session</button>
      </form>

      <div className="grid">
        {sessions.map((s) => (
          <article key={s.name} className={`card${s.name === active ? ' card--active' : ''}`}>
            <header className="card__head">
              <strong>{s.name}</strong>
              <StatusPill status={s.status} />
            </header>

            {s.me?.pushname ? <p className="muted">{s.me.pushname} · {s.me.id}</p> : null}
            <p className="muted">
              Owner: {s.ownerName ?? 'unclaimed'}
              {s.wanted ? <em className="tag">kept running</em> : null}
            </p>

            <div className="card__actions">
              <button onClick={() => setActive(s.name)} disabled={s.name === active}>
                {s.name === active ? 'Selected' : 'Select'}
              </button>
              <button onClick={() => run(() => api.startSession(s.name))}
                disabled={busy || s.status === 'CONNECTED' || s.status === 'STARTING'}>Start</button>
              <button onClick={() => run(() => api.stopSession(s.name, {}))}
                disabled={busy || s.status === 'DISCONNECTED'}
                title="Closes the browser to free memory. The session comes back on restart.">
                Pause
              </button>
              <button className="danger"
                onClick={() => run(() => api.stopSession(s.name, { disconnect: true }))}
                disabled={busy || (!s.wanted && s.status === 'DISCONNECTED')}
                title="Stops the session for good. It will not come back until you start it again.">
                Disconnect
              </button>
              <button className="danger"
                onClick={() => run(() => api.stopSession(s.name, { logout: true, disconnect: true }))}
                disabled={busy || s.status !== 'CONNECTED'}
                title="Unpairs the device from WhatsApp — a new QR scan will be needed.">
                Log out of WhatsApp
              </button>
              <button className="danger" onClick={() => run(() => api.deleteSession(s.name))}
                disabled={busy}>Delete</button>
            </div>
          </article>
        ))}
      </div>

      {qr && status === 'WAITING_QR' ? (
        <div className="card card--qr">
          <h2>Scan to connect “{active}”</h2>
          <img className="qrcode" src={qr} alt="WhatsApp QR code" width={264} height={264} />
          <p className="muted">WhatsApp → Settings → Linked devices → Link a device.</p>
        </div>
      ) : null}

      {stats ? (
        <div className="statrow">
          <div className="stat"><span>{stats.chats}</span><small>Conversations</small></div>
          <div className="stat"><span>{stats.inbound}</span><small>Received</small></div>
          <div className="stat"><span>{stats.outbound}</span><small>Sent</small></div>
          <div className="stat"><span>{stats.total}</span><small>Total messages</small></div>
        </div>
      ) : null}
    </div>
  );
}
