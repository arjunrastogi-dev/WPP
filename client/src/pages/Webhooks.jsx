import { useEffect, useState } from 'react';
import { api } from '../api';
import Empty from '../components/Empty';

const EVENTS = ['message', 'ack', 'status'];

export default function WebhooksPage() {
  const [hooks, setHooks] = useState([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState(['message']);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.webhooks().then(setHooks).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);

  const toggleEvent = (event) =>
    setEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createWebhook({ url: url.trim(), events, secret: secret.trim() || null });
      setUrl('');
      setSecret('');
      setEvents(['message']);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>Webhooks</h1>
        <p className="muted">
          Forward WhatsApp events to another system. Each delivery is signed with
          <code>X-Wpp-Signature</code> (HMAC-SHA256) when a secret is set.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <form className="card" onSubmit={create}>
        <div className="formgrid">
          <label>Endpoint URL
            <input value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/whatsapp-hook" required />
          </label>
          <label>Signing secret <small className="muted">(optional)</small>
            <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="shared secret" />
          </label>
        </div>

        <fieldset className="checks">
          <legend>Events</legend>
          {EVENTS.map((ev) => (
            <label key={ev} className="check">
              <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
              {ev}
            </label>
          ))}
        </fieldset>

        <button className="primary" type="submit" disabled={busy || !url.trim() || events.length === 0}>
          Add webhook
        </button>
      </form>

      {hooks.length === 0 ? (
        <Empty icon="🔗" title="No webhooks yet"
          hint="Point one at your CRM, an automation tool, or your own backend." />
      ) : (
        <table className="table">
          <thead>
            <tr><th>URL</th><th>Events</th><th>Signed</th><th>Last result</th><th /></tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.id} className={h.enabled ? '' : 'is-off'}>
                <td className="truncate">{h.url}</td>
                <td>{h.events.map((e) => <em key={e} className="tag">{e}</em>)}</td>
                <td>{h.secret ? 'yes' : 'no'}</td>
                <td>
                  {h.last_status ?? <em className="muted">never called</em>}
                  {h.last_attempt_at ? <small className="muted"> · {new Date(h.last_attempt_at).toLocaleString()}</small> : null}
                </td>
                <td className="row-actions">
                  <button onClick={async () => { await api.toggleWebhook(h.id, !h.enabled); load(); }}>
                    {h.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="danger" onClick={async () => { await api.deleteWebhook(h.id); load(); }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
