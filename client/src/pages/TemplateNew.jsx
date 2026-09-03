import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

const BLANK = { templateKey: '', name: '', description: '', body: '' };

export default function TemplateNew() {
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createTemplate({
        templateKey: form.templateKey.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        body: form.body,
      });
      navigate(`/templates/${created.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>Add Template</h1>
        <p className="muted">
          Wrap values in double braces. Every placeholder becomes a required variable.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <form className="card" onSubmit={submit}>
        <div className="formgrid">
          <label>Key <small className="muted">(the CMS uses this)</small>
            <input value={form.templateKey} onChange={set('templateKey')}
              placeholder="booking_confirm" pattern="[a-z0-9_]{2,64}" required />
          </label>
          <label>Name
            <input value={form.name} onChange={set('name')} placeholder="Appointment confirmed" required />
          </label>
        </div>
        <label>Description <small className="muted">(optional)</small>
          <input value={form.description} onChange={set('description')}
            placeholder="Sent when a patient books an appointment." />
        </label>
        <label>Message
          <textarea value={form.body} onChange={set('body')} rows={5} required
            placeholder={'Hi {{patient}}, your appointment with {{doctor}} is confirmed for {{date}} at {{time}}.'} />
        </label>
        <div className="card__actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Add template'}
          </button>
          <button type="button" onClick={() => navigate('/templates')}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
