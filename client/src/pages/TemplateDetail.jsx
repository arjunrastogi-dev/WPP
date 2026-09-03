import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, API_URL } from '../api';

/** Highlight {{placeholders}} inside the message body. */
function Body({ text }) {
  const parts = String(text).split(/(\{\{\s*[a-zA-Z0-9_]+\s*\}\})/g);
  return (
    <p className="tmpl__body">
      {parts.map((part, i) =>
        /^\{\{/.test(part) ? <em key={i} className="tmpl__var">{part}</em> : part)}
    </p>
  );
}

export default function TemplateDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [template, setTemplate] = useState(null);
  const [values, setValues] = useState({});
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', body: '' });
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const t = await api.template(id);
    setTemplate(t);
    // Seed the preview form with the placeholder names, so the shape is obvious.
    setValues((v) => (Object.keys(v).length
      ? v
      : Object.fromEntries(t.variables.map((name) => [name, '']))));
  }, [id]);

  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const filled = Object.fromEntries(
        template.variables.map((name) => [name, values[name]?.trim() || `<${name}>`]),
      );
      setPreview(await api.previewTemplate(template.id, filled));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const startEditing = () => {
    setDraft({
      name: template.name,
      description: template.description ?? '',
      body: template.body,
    });
    setSaved(false);
    setEditing(true);
  };

  const saveEdits = async () => {
    if (!draft.name.trim() || !draft.body.trim()) {
      return setError('A template needs a name and a message');
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateTemplate(template.id, {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        body: draft.body,
      });
      setEditing(false);
      setSaved(true);
      setPreview(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    await api.toggleTemplate(template.id, !template.enabled);
    load();
  };

  const remove = async () => {
    await api.deleteTemplate(template.id);
    navigate('/templates');
  };

  if (error && !template) {
    return (
      <div className="page">
        <p className="error">{error}</p>
        <Link className="btn-link" to="/templates">Back to template list</Link>
      </div>
    );
  }
  if (!template) return <div className="page"><p className="muted">Loading template…</p></div>;

  const sample = Object.fromEntries(
    template.variables.map((name) => [name, values[name]?.trim() || `<${name}>`]),
  );

  return (
    <div className="page">
      <header className="page__head page__head--row">
        <div>
          <h1>{template.name}</h1>
          <p className="muted">
            <code>{template.template_key}</code>
            {template.enabled ? null : <em className="tag"> disabled</em>}
          </p>
        </div>
        <Link className="btn-link" to="/templates">Back to list</Link>
      </header>

      {error ? <p className="error">{error}</p> : null}

      {saved ? <p className="notice">Template saved. New messages use the updated wording.</p> : null}

      <section className="card">
        {editing ? (
          <>
            <h2>Edit message</h2>
            <div className="formgrid">
              <label>Name
                <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} required />
              </label>
              <label>Key <small className="muted">(cannot change)</small>
                <input value={template.template_key} disabled />
              </label>
            </div>
            <label>Description
              <input value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
            </label>
            <label>Message
              <textarea rows={6} value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} required />
            </label>
            <p className="muted">
              Placeholders in <code>{'{{double braces}}'}</code> become required variables.
              Removing one that the clinic system still sends is harmless; adding one it
              does not send will make those messages fail until it does.
            </p>
            <div className="card__actions">
              <button className="primary" onClick={saveEdits} disabled={busy}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <button onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <h2>Message</h2>
            {template.description ? <p className="muted">{template.description}</p> : null}
            <Body text={template.body} />
            <p className="muted">
              Variables: {template.variables.length
                ? template.variables.map((v) => <em key={v} className="tag">{v}</em>)
                : <em>none</em>}
            </p>
            <div className="card__actions">
              <button className="primary" onClick={startEditing}>Edit</button>
              <button onClick={toggle}>{template.enabled ? 'Disable' : 'Enable'}</button>
              <button className="danger" onClick={remove}>Delete</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Preview</h2>
        <p className="muted">Fill in values to see exactly what the patient receives.</p>
        {template.variables.length > 0 ? (
          <div className="formgrid">
            {template.variables.map((name) => (
              <label key={name}>{name}
                <input value={values[name] ?? ''} placeholder={`<${name}>`}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} />
              </label>
            ))}
          </div>
        ) : null}
        <button className="primary" onClick={runPreview} disabled={busy}>
          {busy ? 'Rendering…' : 'Preview message'}
        </button>
        {preview ? <pre className="snippet">{preview.text}</pre> : null}
      </section>

      <section className="card">
        <h2>How the CMS calls this</h2>
        <pre className="snippet">{`POST ${API_URL}/api/v1/send-template
X-API-Key: <your API key>
Content-Type: application/json

${JSON.stringify({
  session: 'support',
  template: template.template_key,
  to: '918860924275',
  variables: sample,
}, null, 2)}`}</pre>
        <p className="muted">
          The key goes in the body, not the URL — adding a template never means adding
          an endpoint. The server prints the API key on startup.
        </p>
      </section>
    </div>
  );
}
