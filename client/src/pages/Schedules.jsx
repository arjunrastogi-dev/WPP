import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../SessionContext';
import { parseRows, placeholdersIn, toText } from '../lib/recipients';

/**
 * Recurring messages.
 *
 * The screen is built around one idea: you should be able to see exactly when
 * a schedule will next fire *before* you save it. A timetable that is subtly
 * wrong fails silently — nobody is watching at 09:00 to notice that nothing
 * went out — so the next five firings are shown while you are still editing.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const when = (ms) => new Date(Number(ms)).toLocaleString(undefined, {
  weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

const BLANK = {
  name: '', session: '', kind: 'daily', timeOfDay: '09:00',
  days: {}, dayOfMonth: 1, runAt: '', mode: 'custom', template: '', message: '', text: '',
};

export default function Schedules() {
  const { sessions, active } = useSession();
  const [list, setList] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState({ ...BLANK });
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.schedules().then(setList).catch((e) => setError(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.templates().then(setTemplates).catch(() => {}); }, []);
  useEffect(() => { if (active && !form.session) setForm((f) => ({ ...f, session: active })); }, [active, form.session]);

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setPreview(null); };

  const template = templates.find((t) => t.template_key === form.template);
  const columns = form.mode === 'template' ? (template?.variables ?? []) : placeholdersIn(form.message);
  const rows = parseRows(form.text, columns);

  /** The shape the API wants, from the shape the form holds. */
  const payload = () => ({
    name: form.name,
    session: form.session,
    kind: form.kind,
    timeOfDay: form.timeOfDay,
    // Only the ticked days travel, each with its own time.
    slots: Object.entries(form.days)
      .filter(([, v]) => v)
      .map(([day, v]) => ({ day: Number(day), time: typeof v === 'string' ? v : form.timeOfDay })),
    dayOfMonth: Number(form.dayOfMonth),
    runAt: form.runAt ? new Date(form.runAt).getTime() : null,
    template: form.mode === 'template' ? form.template : null,
    message: form.mode === 'template' ? null : form.message,
    recipients: rows,
  });

  const check = async () => {
    setBusy(true); setError(null);
    try {
      setPreview(await api.schedulePreview(payload()));
    } catch (e) { setError(e.message); setPreview(null); } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (editing) await api.scheduleUpdate(editing, payload());
      else await api.scheduleCreate(payload());
      setForm({ ...BLANK, session: form.session });
      setEditing(null); setOpen(false); setPreview(null);
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  /** Load an existing schedule back into the form. */
  const edit = (s) => {
    const cols = s.source === 'template'
      ? (templates.find((t) => t.template_key === s.template_key)?.variables ?? [])
      : placeholdersIn(s.body);

    setForm({
      name: s.name,
      session: s.session,
      kind: s.kind,
      timeOfDay: s.time_of_day ?? '09:00',
      days: Object.fromEntries((s.slots ?? []).map((x) => [x.day, x.time])),
      dayOfMonth: s.day_of_month ?? 1,
      runAt: s.run_at ? new Date(Number(s.run_at) - new Date().getTimezoneOffset() * 60000)
        .toISOString().slice(0, 16) : '',
      mode: s.source,
      template: s.template_key ?? '',
      message: s.body ?? '',
      text: toText(s.recipients, cols),
    });
    setEditing(s.id); setOpen(true); setPreview(null); setError(null);
  };

  const act = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const showRuns = async (s) => {
    if (runs?.id === s.id) return setRuns(null);
    setRuns({ id: s.id, name: s.name, items: await api.scheduleRuns(s.id) });
  };

  const toggleDay = (i) => set({
    days: form.days[i] ? { ...form.days, [i]: false } : { ...form.days, [i]: form.timeOfDay },
  });

  return (
    <div className="page">
      <header className="page__head">
        <h1>Schedules</h1>
        <p className="muted">
          Messages that send themselves — every day, on chosen weekdays, or once a month.
          Each firing goes through the same queue as everything else, so a schedule can
          never send faster than a person could.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section className="card">
        <div className="row row--between">
          <h2>{list.length} schedule{list.length === 1 ? '' : 's'}</h2>
          <button className="primary" onClick={() => {
            setOpen(!open); setEditing(null); setForm({ ...BLANK, session: form.session }); setPreview(null);
          }}>
            {open ? 'Close' : 'New schedule'}
          </button>
        </div>

        {list.length === 0 ? <p className="muted">Nothing scheduled yet.</p> : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>When</th><th>Next</th><th>Last run</th><th /></tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className={s.enabled ? '' : 'is-off'}>
                  <td>
                    <strong>{s.name}</strong>
                    <br />
                    <span className="muted">
                      {s.session} · {s.recipients.length} recipient(s) ·{' '}
                      {s.source === 'template' ? <code>{s.template_key}</code> : 'custom message'}
                    </span>
                  </td>
                  <td>
                    {s.summary}
                    <br /><span className="muted">{s.timezone}</span>
                  </td>
                  <td>{s.enabled && s.next_run_at ? when(s.next_run_at) : <span className="muted">paused</span>}</td>
                  <td>
                    {s.last_run_at ? when(s.last_run_at) : <span className="muted">never</span>}
                    {s.last_error ? <><br /><span className="error">{s.last_error}</span></> : null}
                  </td>
                  <td className="row">
                    <button onClick={() => act(() => api.scheduleToggle(s.id, !s.enabled))} disabled={busy}>
                      {s.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button onClick={() => act(() => api.scheduleRun(s.id))} disabled={busy}>Send now</button>
                    <button onClick={() => showRuns(s)}>History</button>
                    <button onClick={() => edit(s)}>Edit</button>
                    <button className="danger" onClick={() => act(() => api.scheduleDelete(s.id))} disabled={busy}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {runs ? (
        <section className="card">
          <h2>{runs.name} — past runs</h2>
          {runs.items.length === 0 ? <p className="muted">It has not fired yet.</p> : (
            <table className="table">
              <thead><tr><th>Fired</th><th>Was due</th><th>Result</th><th>Detail</th></tr></thead>
              <tbody>
                {runs.items.map((r) => (
                  <tr key={r.id} className={r.status === 'queued' ? '' : 'is-off'}>
                    <td>{when(r.fired_at)}</td>
                    <td>{when(r.due_at)}</td>
                    <td>
                      {r.status === 'queued' ? `${r.queued} queued` : r.status}
                      {r.batch_ref ? <><br /><span className="muted">{r.batch_ref}</span></> : null}
                    </td>
                    <td className={r.status === 'failed' ? 'error' : 'muted'}>{r.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {open ? (
        <section className="card">
          <h2>{editing ? 'Edit schedule' : 'New schedule'}</h2>

          <div className="formgrid">
            <label>Name
              <input value={form.name} onChange={(e) => set({ name: e.target.value })}
                placeholder="Morning clinic reminder" />
            </label>
            <label>Send from
              <select value={form.session} onChange={(e) => set({ session: e.target.value })}>
                <option value="">Select a session</option>
                {sessions.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          </div>

          <div className="formgrid">
            <label>Repeat
              <select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
                <option value="daily">Every day</option>
                <option value="weekly">Chosen days of the week</option>
                <option value="monthly">Once a month</option>
                <option value="once">Once, at a set time</option>
              </select>
            </label>

            {form.kind === 'once' ? (
              <label>When
                <input type="datetime-local" value={form.runAt}
                  onChange={(e) => set({ runAt: e.target.value })} />
              </label>
            ) : (
              <label>Time
                <input type="time" value={form.timeOfDay}
                  onChange={(e) => set({ timeOfDay: e.target.value })} />
              </label>
            )}

            {form.kind === 'monthly' ? (
              <label>Day of the month
                <input type="number" min="1" max="31" value={form.dayOfMonth}
                  onChange={(e) => set({ dayOfMonth: e.target.value })} />
              </label>
            ) : null}
          </div>

          {form.kind === 'monthly' ? (
            <p className="muted">
              In a month that is too short, it sends on the last day instead — the 31st
              becomes the 28th in February rather than being skipped.
            </p>
          ) : null}

          {form.kind === 'weekly' ? (
            <>
              <p className="muted">
                Tick the days you want. Each day keeps its own time, so Monday morning and
                Friday evening can live in one schedule.
              </p>
              <div className="dayslots">
                {DAYS.map((label, i) => (
                  <label key={label} className="dayslot">
                    <input type="checkbox" checked={Boolean(form.days[i])}
                      onChange={() => toggleDay(i)} />
                    <span>{label}</span>
                    <input type="time" disabled={!form.days[i]}
                      value={typeof form.days[i] === 'string' ? form.days[i] : form.timeOfDay}
                      onChange={(e) => set({ days: { ...form.days, [i]: e.target.value } })} />
                  </label>
                ))}
              </div>
            </>
          ) : null}

          <div className="formgrid">
            <label>What to send
              <select value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
                <option value="custom">A custom message</option>
                <option value="template">A saved template</option>
              </select>
            </label>
            {form.mode === 'template' ? (
              <label>Template
                <select value={form.template} onChange={(e) => set({ template: e.target.value })}>
                  <option value="">Select a template</option>
                  {templates.filter((t) => t.enabled).map((t) => (
                    <option key={t.id} value={t.template_key}>{t.name} ({t.template_key})</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>

          {form.mode === 'custom' ? (
            <label>Message
              <textarea rows={4} value={form.message} onChange={(e) => set({ message: e.target.value })}
                placeholder={'Good morning {{name}}, the clinic opens at 9.'} />
            </label>
          ) : null}

          <label>Recipients
            <textarea rows={6} value={form.text} onChange={(e) => set({ text: e.target.value })}
              placeholder={'918860924275, Asha\n919876543210, Ravi'} />
          </label>
          <p className="muted">
            One per line, phone number first
            {columns.length
              ? <>, then one value per placeholder in this order: {columns.map((c) => <em key={c} className="tag">{c}</em>)}</>
              : ' — this message has no placeholders to fill'}.
            {' '}{rows.length} row{rows.length === 1 ? '' : 's'} parsed.
          </p>

          <div className="row">
            <button onClick={check} disabled={busy}>
              {busy ? 'Checking…' : 'Check the timetable'}
            </button>
            <button className="primary" onClick={save} disabled={busy || !preview || Boolean(preview.problem)}>
              {editing ? 'Save changes' : 'Create schedule'}
            </button>
          </div>

          {/*
            * Nothing saves until this has been seen. A recurrence rule is easy
            * to get subtly wrong, and the cost of being wrong is a message that
            * quietly never arrives.
            */}
          {preview ? (
            <div className={preview.problem ? 'card card--warn' : 'notice'}>
              <strong>{preview.summary}</strong>
              <p className="muted">Sending to {preview.recipients} recipient(s). Next firings:</p>
              <ul>
                {preview.upcoming.map((t) => <li key={t}>{when(t)}</li>)}
                {preview.upcoming.length === 0 ? <li>Never — check the days and times.</li> : null}
              </ul>
              {preview.problem ? <p className="error">{preview.problem}</p> : null}
            </div>
          ) : (
            <p className="muted">Check the timetable to see when this would fire, then save.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
