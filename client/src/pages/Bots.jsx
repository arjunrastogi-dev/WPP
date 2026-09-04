import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../SessionContext';
import Modal from '../components/Modal';

/**
 * The bots list.
 *
 * Deliberately thin: everything interesting happens on the canvas inside one
 * bot. This screen only owns the settings that live outside the flow — what
 * starts it, where it answers, and when it gives up.
 */

const TRIGGERS = [
  { value: 'contains', label: 'contains the word' },
  { value: 'equals', label: 'is exactly' },
  { value: 'starts', label: 'starts with' },
  { value: 'regex', label: 'matches the pattern' },
  { value: 'any', label: 'is anything at all' },
];

export default function Bots() {
  const { sessions } = useSession();
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.bots().then(setList).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const blank = {
    name: '', session: '', triggerType: 'contains', triggerText: 'hi',
    fallback: '', maxRetries: 2, timeoutMinutes: 30, allowGroups: false, entryKey: 'start',
  };

  /** Load an existing bot's settings into the same form used to create one. */
  const editSettings = (b) => setEditing({
    id: b.id,
    name: b.name,
    session: b.session ?? '',
    triggerType: b.trigger_type,
    triggerText: b.trigger_text,
    fallback: b.fallback ?? '',
    maxRetries: b.max_retries,
    timeoutMinutes: b.timeout_minutes,
    allowGroups: b.allow_groups,
    entryKey: b.entry_key,
  });

  const save = () => act(async () => {
    const payload = { ...editing, session: editing.session || null };
    if (editing.id) await api.botUpdate(editing.id, payload);
    else await api.botCreate(payload);
    setEditing(null);
  });

  return (
    <div className="page">
      <header className="page__head">
        <h1>Bot Builder</h1>
        <p className="muted">
          A bot holds a conversation instead of answering one message. It asks a question,
          remembers which one it asked, and reads the reply as an answer — so someone can
          work through a menu by typing "2".
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="card">
        <div className="row row--between">
          <h2>{list.length} bot{list.length === 1 ? '' : 's'}</h2>
          <div className="row">
            <button onClick={() => act(() => api.botExample())} disabled={busy}>
              Add the example bot
            </button>
            <button className="primary" onClick={() => setEditing({ ...blank })}>New bot</button>
          </div>
        </div>
        <p className="muted">
          The example is a working recruitment flow with a branch and a spreadsheet step — the
          quickest way to see how the pieces fit is to open one that already runs.
        </p>

        {list.length === 0 ? <p className="muted">No bots yet.</p> : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Starts when</th><th>Steps</th><th>Where</th><th>State</th><th /></tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id} className={b.enabled ? '' : 'is-off'}>
                  <td>
                    <Link to={`/bots/${b.id}`}><strong>{b.name}</strong></Link>
                    <br /><span className="muted">gives up after {b.max_retries} misunderstandings</span>
                  </td>
                  <td>
                    a message {TRIGGERS.find((t) => t.value === b.trigger_type)?.label}
                    {b.trigger_type !== 'any' ? <> <code>{b.trigger_text}</code></> : null}
                  </td>
                  <td>{b.steps === 0 ? <span className="error">none yet</span> : b.steps}</td>
                  <td>
                    {b.session ?? <span className="muted">every session</span>}
                    {b.allow_groups ? <><br /><span className="muted">groups too</span></> : null}
                  </td>
                  <td><span className={`pill ${b.enabled ? 'pill--on' : ''}`}>
                    {b.enabled ? 'Active' : 'Paused'}
                  </span></td>
                  <td className="row">
                    <Link to={`/bots/${b.id}`}><button className="primary">Open builder</button></Link>
                    <button onClick={() => editSettings(b)}>Settings</button>
                    <button onClick={() => act(() => api.botToggle(b.id, !b.enabled))} disabled={busy}>
                      {b.enabled ? 'Pause' : 'Enable'}
                    </button>
                    <button className="danger" disabled={busy}
                      onClick={() => { if (confirm(`Delete "${b.name}" and everything it has said?`)) act(() => api.botDelete(b.id)); }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing ? (
        <Modal size="lg" onClose={() => setEditing(null)}
          title={editing.id ? `Settings — ${editing.name}` : 'New bot'}>
          <div className="formgrid">
            <label>Name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Recruitment FAQ" />
            </label>
            <label>Answers on
              <select value={editing.session}
                onChange={(e) => setEditing({ ...editing, session: e.target.value })}>
                <option value="">Every session</option>
                {sessions.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          </div>

          <div className="formgrid">
            <label>Start when a message
              <select value={editing.triggerType}
                onChange={(e) => setEditing({ ...editing, triggerType: e.target.value })}>
                {TRIGGERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            {editing.triggerType !== 'any' ? (
              <label>This
                <input value={editing.triggerText}
                  onChange={(e) => setEditing({ ...editing, triggerText: e.target.value })} />
              </label>
            ) : null}
            <label>First step
              <input value={editing.entryKey}
                onChange={(e) => setEditing({ ...editing, entryKey: e.target.value })} />
            </label>
          </div>

          <label>What to say when it gives up
            <textarea rows={2} value={editing.fallback}
              onChange={(e) => setEditing({ ...editing, fallback: e.target.value })}
              placeholder="Sorry, I didn't catch that. Someone will reply to you shortly." />
          </label>

          <div className="formgrid">
            <label>Give up after
              <input type="number" min="0" max="5" value={editing.maxRetries}
                onChange={(e) => setEditing({ ...editing, maxRetries: Number(e.target.value) })} />
            </label>
            <label>Forget an idle chat after (minutes)
              <input type="number" min="1" value={editing.timeoutMinutes}
                onChange={(e) => setEditing({ ...editing, timeoutMinutes: Number(e.target.value) })} />
            </label>
            <label className="row">
              <input type="checkbox" checked={editing.allowGroups}
                onChange={(e) => setEditing({ ...editing, allowGroups: e.target.checked })} />
              Answer in group chats
            </label>
          </div>
          <p className="muted">
            Groups are left alone by default — a bot that replies to every "hi" in a busy group
            is the fastest way to be muted by everyone in it.
          </p>

          <div className="row row--between modal__actions">
            <button className="primary" onClick={save} disabled={busy || !editing.name.trim()}>
              {editing.id ? 'Save settings' : 'Create, then draw the flow'}
            </button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
