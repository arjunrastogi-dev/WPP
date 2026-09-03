import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../SessionContext';
import Empty from '../components/Empty';

const MATCH_TYPES = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'is exactly' },
  { value: 'starts', label: 'starts with' },
  { value: 'regex', label: 'matches regex' },
];

const BLANK = { name: '', matchType: 'contains', pattern: '', reply: '', scope: '' };

export default function RulesPage() {
  const { sessions } = useSession();
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.rules().then(setRules).catch((err) => setError(err.message));
  useEffect(() => { load(); }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const create = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createRule({
        name: form.name.trim(),
        matchType: form.matchType,
        pattern: form.pattern,
        reply: form.reply,
        session: form.scope || null,
      });
      setForm(BLANK);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule) => {
    await api.toggleRule(rule.id, !rule.enabled);
    load();
  };

  const remove = async (rule) => {
    await api.deleteRule(rule.id);
    load();
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>Auto-replies</h1>
        <p className="muted">
          When an incoming message matches, the reply is queued like any other message —
          so a burst of traffic can't turn into a burst of sends.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <form className="card" onSubmit={create}>
        <div className="formgrid">
          <label>Rule name
            <input value={form.name} onChange={set('name')} placeholder="Greeting" required />
          </label>
          <label>Applies to
            <select value={form.scope} onChange={set('scope')}>
              <option value="">All sessions</option>
              {sessions.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          </label>
          <label>When the message
            <select value={form.matchType} onChange={set('matchType')}>
              {MATCH_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label>Pattern
            <input value={form.pattern} onChange={set('pattern')} placeholder="hi" required />
          </label>
        </div>
        <label>Reply
          <textarea value={form.reply} onChange={set('reply')} rows={2}
            placeholder="Hi {{name}}, thanks for reaching out! We'll reply shortly." required />
        </label>
        <p className="muted">
          Placeholders: <code>{'{{name}}'}</code> the sender's name, <code>{'{{body}}'}</code> their message.
        </p>
        <button className="primary" type="submit" disabled={busy}>Add rule</button>
      </form>

      {rules.length === 0 ? (
        <Empty icon="⚡" title="No auto-replies yet" hint="Add one above to answer common questions automatically." />
      ) : (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Scope</th><th>Condition</th><th>Reply</th><th /></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'is-off'}>
                <td>{r.name}</td>
                <td>{r.session ?? <em className="muted">all</em>}</td>
                <td><code>{r.match_type} “{r.pattern}”</code></td>
                <td className="truncate">{r.reply}</td>
                <td className="row-actions">
                  <button onClick={() => toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
