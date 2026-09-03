import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../SessionContext';
import { parseRows, placeholdersIn } from '../lib/recipients';

/**
 * Send one template to many people.
 *
 * Deliberately a three-step flow — paste, preview, send — because the mistake
 * this screen can make (200 wrong messages, or a banned number) is not one you
 * can take back.
 */

export default function Bulk() {
  const { sessions, active } = useSession();
  const [templates, setTemplates] = useState([]);
  const [mode, setMode] = useState('template'); // template | custom
  const [templateKey, setTemplateKey] = useState('');
  const [custom, setCustom] = useState('');
  const [session, setSession] = useState(active ?? '');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [openBatch, setOpenBatch] = useState(null);

  useEffect(() => { api.templates().then(setTemplates).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (active && !session) setSession(active); }, [active, session]);

  const template = templates.find((t) => t.template_key === templateKey);

  /*
   * Whichever mode, the first column is the phone number and the rest map to
   * the placeholders in order. A custom message honours {{placeholders}} too,
   * so a one-off can still be personalised without saving a template first.
   */
  const columns = mode === 'template' ? (template?.variables ?? []) : placeholdersIn(custom);
  const rows = parseRows(text, columns);

  // Enough to work with? A template must be chosen; a custom message just needs text.
  const ready = mode === 'template' ? Boolean(template) : custom.trim().length > 0;
  const payload = mode === 'template' ? { template: templateKey } : { message: custom };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await api.bulkPreview({ ...payload, recipients: rows }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bulkSend({ session, ...payload, recipients: rows });
      setResult(res);
      setPreview(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const refreshProgress = useCallback(async () => {
    if (!session) return;
    try {
      setProgress(await api.bulkProgress(session));
    } catch { /* the panel simply doesn't update */ }
  }, [session]);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.bulkHistory(session));
    } catch { /* history is nice to have, not worth an error banner */ }
  }, [session]);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const openDetail = async (ref) => {
    setOpenBatch(openBatch?.batch_ref === ref ? null : await api.bulkBatch(ref));
  };

  useEffect(() => {
    if (!result) return undefined;
    refreshProgress();
    refreshHistory();
    const timer = setInterval(() => { refreshProgress(); refreshHistory(); }, 5000);
    return () => clearInterval(timer);
  }, [result, refreshProgress, refreshHistory]);

  const cancelPending = async () => {
    setBusy(true);
    try {
      const res = await api.bulkCancel(session);
      setError(`Cancelled ${res.cancelled} message(s) that had not gone out yet.`);
      await refreshProgress();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>Bulk send</h1>
        <p className="muted">
          One message, many recipients — from a saved template or written here. Everything
          goes through the same queue and is spaced ~10 seconds apart, so a batch takes a
          while on purpose.
        </p>
      </header>

      <div className="card card--warn">
        <strong>Read this before your first batch.</strong>
        <p className="muted">
          Bulk messaging is what gets WhatsApp numbers banned, and this is an unofficial
          automation with no appeal process. Message people who asked to hear from you,
          keep batches small, and never use a number you cannot afford to lose.
        </p>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <section className="card">
        <h2>1 · Who and what</h2>
        <div className="formgrid">
          <label>Session
            <select value={session} onChange={(e) => setSession(e.target.value)}>
              <option value="">Select a session</option>
              {sessions.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}{s.status === 'CONNECTED' ? '' : ` — ${s.status.toLowerCase()}`}
                </option>
              ))}
            </select>
          </label>
          <label>What to send
            <select value={mode} onChange={(e) => { setMode(e.target.value); setPreview(null); }}>
              <option value="template">A saved template</option>
              <option value="custom">A custom message</option>
            </select>
          </label>
        </div>

        {mode === 'template' ? (
          <label>Template
            <select value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setPreview(null); }}>
              <option value="">Select a template</option>
              {templates.filter((t) => t.enabled).map((t) => (
                <option key={t.id} value={t.template_key}>{t.name} ({t.template_key})</option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label>Message
              <textarea rows={5} value={custom}
                onChange={(e) => { setCustom(e.target.value); setPreview(null); }}
                placeholder={'Hi {{name}}, the clinic is closed this Saturday.'} />
            </label>
            <p className="muted">
              Sent as written, once per recipient. Use <code>{'{{placeholders}}'}</code> if you want
              to personalise it — they become columns below. This message is not saved; if you will
              send it again, make it a template instead.
            </p>
          </>
        )}

        {ready ? (
          <>
            <p className="muted">
              One recipient per line. First value is the phone number, then{' '}
              {columns.length ? <>one value per variable in this order: {columns.map((v) => <em key={v} className="tag">{v}</em>)}</> : 'nothing else — there are no placeholders to fill'}.
            </p>
            <pre className="snippet">{`918860924275${columns.map((c) => `, ${c} value`).join('')}`}</pre>
          </>
        ) : null}

        <label>Recipients
          <textarea rows={8} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }}
            placeholder={'918860924275, Asha, Dr Rao\n919876543210, Ravi, Dr Nair'} disabled={!ready} />
        </label>
        <p className="muted">{rows.length} row{rows.length === 1 ? '' : 's'} parsed.</p>
      </section>

      <section className="card">
        <h2>2 · Check it</h2>
        <button className="primary" onClick={runPreview}
          disabled={busy || !ready || rows.length === 0}>
          {busy ? 'Rendering…' : 'Preview all'}
        </button>

        {preview ? (
          <>
            <p className="muted">
              {preview.ready} ready · {preview.problems} with problems ·
              roughly {preview.estimatedMinutes} minute(s) to send
            </p>
            <table className="table">
              <thead><tr><th>To</th><th>Message</th></tr></thead>
              <tbody>
                {preview.rows.slice(0, 25).map((r) => (
                  <tr key={r.index} className={r.ok ? '' : 'is-off'}>
                    <td><code>{r.to}</code></td>
                    <td>{r.ok ? <span className="tmpl__inline">{r.preview}</span>
                      : <span className="error">{r.error}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length > 25 ? <p className="muted">…and {preview.rows.length - 25} more.</p> : null}
          </>
        ) : null}
      </section>

      <section className="card">
        <h2>3 · Send</h2>
        <button className="primary" onClick={send}
          disabled={busy || !session || !preview || preview.problems > 0}>
          {busy ? 'Queueing…' : `Queue ${rows.length} message(s)`}
        </button>
        {preview?.problems > 0
          ? <p className="muted">Fix the {preview.problems} problem row(s) first — nothing is sent until every row renders.</p>
          : null}

        {result ? (
          <p className="notice">
            {result.queued} message(s) queued, finishing in about {result.estimatedMinutes} minute(s).
          </p>
        ) : null}

        {progress ? (
          <>
            <p className="muted">
              {Object.entries(progress.counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}
            </p>
            <button className="danger" onClick={cancelPending} disabled={busy}>
              Cancel anything not yet sent
            </button>
          </>
        ) : null}
      </section>

      {/*
        * The log outlives the queue. Queue rows get pruned, cancelled and
        * retried; this stays, so "what did we send on Tuesday, and who sent it"
        * still has an answer next month.
        */}
      <section className="card">
        <h2>Sent batches</h2>
        {history.length === 0 ? (
          <p className="muted">Nothing sent in bulk yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>When</th><th>What</th><th>By</th><th>Outcome</th><th /></tr>
            </thead>
            <tbody>
              {history.map((b) => (
                <tr key={b.batch_ref} className={b.failed > 0 ? 'is-off' : ''}>
                  <td>{new Date(Number(b.created_at)).toLocaleString()}</td>
                  <td>
                    {b.source === 'template'
                      ? <code>{b.template_key}</code>
                      : <span className="tmpl__inline">{(b.body ?? '').slice(0, 60)}{(b.body ?? '').length > 60 ? '…' : ''}</span>}
                    <br /><span className="muted">{b.session} · {b.total} recipient(s)</span>
                  </td>
                  <td>{b.created_by_name ?? '—'}</td>
                  <td>
                    {b.sent} sent
                    {b.pending ? <> · {b.pending} waiting</> : null}
                    {b.failed ? <> · <span className="error">{b.failed} failed</span></> : null}
                    {b.cancelled ? <> · {b.cancelled} cancelled</> : null}
                    {b.expired ? <> · {b.expired} expired</> : null}
                  </td>
                  <td>
                    <button onClick={() => openDetail(b.batch_ref)}>
                      {openBatch?.batch_ref === b.batch_ref ? 'Hide' : 'View'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {openBatch ? (
          <>
            <h3>{openBatch.batch_ref}</h3>
            <table className="table">
              <thead><tr><th>To</th><th>Message as sent</th><th>Status</th></tr></thead>
              <tbody>
                {openBatch.recipients.map((r, i) => (
                  <tr key={`${r.chat_id}-${i}`}>
                    <td><code>{r.chat_id}</code></td>
                    <td><span className="tmpl__inline">{r.body}</span></td>
                    <td>{r.status ?? 'gone'}{r.last_error ? <><br /><span className="error">{r.last_error}</span></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </section>
    </div>
  );
}
