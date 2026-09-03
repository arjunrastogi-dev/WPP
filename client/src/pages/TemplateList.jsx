import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import Empty from '../components/Empty';
import Modal from '../components/Modal';

const BLANK = { templateKey: '', name: '', description: '', body: '' };

/** Highlight {{placeholders}} inside a message body. */
function Body({ text }) {
  const parts = String(text).split(/(\{\{\s*[a-zA-Z0-9_]+\s*\}\})/g);
  return (
    <span className="tmpl__inline">
      {parts.map((part, i) =>
        /^\{\{/.test(part) ? <em key={i} className="tmpl__var">{part}</em> : part)}
    </span>
  );
}

export default function TemplateList() {
  const [templates, setTemplates] = useState([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  // One dialog covers create and edit — the only difference is whether the key
  // is editable, and that is fixed once a template exists.
  const [form, setForm] = useState(null); // null = closed, {} = creating, {id} = editing
  const [confirmDelete, setConfirmDelete] = useState(null);

  const navigate = useNavigate();

  const load = useCallback(
    () => api.templates().then(setTemplates).catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm({ ...BLANK }); setError(null); };
  const openEdit = (t) => {
    setForm({
      id: t.id,
      templateKey: t.template_key,
      name: t.name,
      description: t.description ?? '',
      body: t.body,
    });
    setError(null);
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (form.id) {
        await api.updateTemplate(form.id, {
          name: form.name.trim(),
          description: form.description.trim() || null,
          body: form.body,
        });
        setNotice(`“${form.name.trim()}” saved.`);
      } else {
        const created = await api.createTemplate({
          templateKey: form.templateKey.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          body: form.body,
        });
        setNotice(`“${created.name}” added.`);
      }
      setForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (t) => {
    setError(null);
    try {
      await api.toggleTemplate(t.id, !t.enabled);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteTemplate(confirmDelete.id);
      setNotice(`“${confirmDelete.name}” deleted.`);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const visible = search
    ? templates.filter((t) =>
        t.name.toLowerCase().includes(search.toLowerCase())
        || t.template_key.includes(search.toLowerCase())
        || t.body.toLowerCase().includes(search.toLowerCase()))
    : templates;

  return (
    <div className="page">
      <header className="page__head page__head--row">
        <div>
          <h1>Template List</h1>
          <p className="muted">
            The clinic system asks for a message by its key. Editing the wording here
            changes what goes out next — no redeploy.
          </p>
        </div>
        <button className="primary" onClick={openCreate}>Add template</button>
      </header>

      {error && !form ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}

      <input className="search" value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name, key or wording" />

      {visible.length === 0 ? (
        <Empty icon="📝" title={templates.length === 0 ? 'No templates yet' : 'Nothing matches'}
          hint={templates.length === 0 ? 'Add one, then call it from the CMS by its key.' : 'Try a different search.'} />
      ) : (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Key</th><th>Message</th><th>Variables</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr key={t.id} className={t.enabled ? '' : 'is-off'}>
                <td>
                  <button className="linky" onClick={() => navigate(`/templates/${t.id}`)}>{t.name}</button>
                  {t.description ? <div className="muted">{t.description}</div> : null}
                </td>
                <td><code>{t.template_key}</code></td>
                <td className="tmpl__cell"><Body text={t.body} /></td>
                <td>
                  {t.variables.length
                    ? t.variables.map((v) => <em key={v} className="tag">{v}</em>)
                    : <em className="muted">none</em>}
                </td>
                <td>{t.enabled ? 'Enabled' : 'Disabled'}</td>
                <td className="row-actions">
                  <button onClick={() => openEdit(t)}>Edit</button>
                  <button onClick={() => toggle(t)}>{t.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="danger" onClick={() => setConfirmDelete(t)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ------------------------- create / edit ------------------------- */}
      <Modal open={Boolean(form)} title={form?.id ? 'Edit template' : 'Add template'}
        onClose={() => setForm(null)}>
        {form ? (
          <form className="stack" onSubmit={save}>
            {error ? <p className="error">{error}</p> : null}

            <div className="formgrid">
              <label>Key {form.id ? <small className="muted">(cannot change)</small> : null}
                <input value={form.templateKey} onChange={set('templateKey')}
                  placeholder="booking_confirm" pattern="[a-z0-9_]{2,64}"
                  disabled={Boolean(form.id)} required />
              </label>
              <label>Name
                <input value={form.name} onChange={set('name')}
                  placeholder="Appointment confirmed" required />
              </label>
            </div>

            <label>Description <small className="muted">(optional)</small>
              <input value={form.description} onChange={set('description')}
                placeholder="Sent when a patient books an appointment." />
            </label>

            <label>Message
              <textarea value={form.body} onChange={set('body')} rows={6} required
                placeholder={'Hi {{patient}}, your appointment with {{doctor}} is confirmed for {{date}} at {{time}}.'} />
            </label>

            <p className="muted">
              Wrap values in <code>{'{{double braces}}'}</code>. Every placeholder becomes a
              required variable — adding one the clinic system does not send will make those
              messages fail until it does.
            </p>

            <div className="card__actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : form.id ? 'Save changes' : 'Add template'}
              </button>
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* ---------------------------- delete ---------------------------- */}
      <Modal open={Boolean(confirmDelete)} title="Delete template"
        onClose={() => setConfirmDelete(null)}>
        {confirmDelete ? (
          <div className="stack">
            <p>
              Delete <strong>{confirmDelete.name}</strong> (<code>{confirmDelete.template_key}</code>)?
            </p>
            <p className="muted">
              Anything still asking for this key will start failing with
              <code> TEMPLATE_NOT_FOUND</code>. Disabling it instead keeps the record.
            </p>
            <div className="card__actions">
              <button className="danger" onClick={remove} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
              <button onClick={() => setConfirmDelete(null)}>Keep it</button>
            </div>
          </div>
        ) : null}
      </Modal>

      <p className="muted">
        Need the exact API call? Open a template to see it, or read the{' '}
        <Link to="/templates/new">add form</Link>.
      </p>
    </div>
  );
}
