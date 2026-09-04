import { useEffect, useState } from 'react';
import { api } from '../api';
import Modal from './Modal';
import MessagePreview from './MessagePreview';

/**
 * The panel for one step.
 *
 * Every kind shows only the fields it actually uses — a menu has options, a
 * delay has seconds, a spreadsheet step has columns. Showing all of them at
 * once and greying out the rest makes a simple step look complicated.
 */

const OPERATORS = [
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'starts', label: 'starts with' },
  { value: 'empty', label: 'was not answered' },
  { value: 'not_empty', label: 'was answered' },
  { value: 'gt', label: 'is more than' },
  { value: 'lt', label: 'is less than' },
];

const NO_VALUE = new Set(['empty', 'not_empty']);

/* WhatsApp's real limits, mirrored so the count turns red before saving does. */
const LIMITS = {
  buttons: { max: 3, label: 20 },
  list: { max: 10, label: 24 },
};
const HEADER_MAX = 60;
const FOOTER_MAX = 60;

/** A character count that only draws attention once it matters. */
function Count({ value, max }) {
  const n = String(value ?? '').length;
  return <span className={n > max ? 'error count' : 'muted count'}>{n}/{max}</span>;
}

const TITLES = {
  message: 'Send a message', menu: 'Menu', prompt: 'Ask a question',
  condition: 'If / else', sheets: 'Add a row to Google Sheets',
  delay: 'Wait', end: 'Ending', handoff: 'Hand over to a person',
  api: 'Call an API', attributes: 'Remember something', tags: 'Tag the chat',
  hours: 'Working hours', template: 'Send a template', cta: 'Action buttons',
};

const CTA_KINDS = [
  { value: 'url', label: 'Visit a website', placeholder: 'https://example.com/careers' },
  { value: 'call', label: 'Call a number', placeholder: '+918860924275' },
  { value: 'copy', label: 'Copy a code', placeholder: 'CLINIC10' },
];

/* Steps with nothing to say to the person — they act and pass straight on. */
const SILENT = new Set(['condition', 'delay', 'sheets', 'api', 'attributes', 'tags', 'hours', 'template']);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Every answer the flow could have collected by now, to offer as a choice. */
function knownFields(steps) {
  const names = new Set();
  for (const s of steps) {
    if (s.save_as) names.add(s.save_as);
    for (const o of s.options ?? []) if (o.save_as) names.add(o.save_as);
  }
  return [...names];
}

export default function StepEditor({ step, steps, busy, isEntry, onChange, onSave, onDelete, onClose }) {
  const [sheets, setSheets] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [headers, setHeaders] = useState(null);
  const [reading, setReading] = useState(false);

  const set = (patch) => onChange({ ...step, ...patch });

  /* Stand-in values, so the preview reads as a message rather than a template. */
  const sample = Object.fromEntries(knownFields(steps).map((f) => [f, `[${f}]`]));
  const others = steps.filter((s) => s.node_key !== step.key);
  const fields = knownFields(steps);

  useEffect(() => {
    if (step.kind === 'sheets') api.sheetsStatus().then(setSheets).catch(() => {});
    if (step.kind === 'template') api.templates().then(setTemplates).catch(() => {});
  }, [step.kind]);

  const StepPicker = ({ value, onPick, label }) => (
    <label>{label}
      <select value={value ?? ''} onChange={(e) => onPick(e.target.value)}>
        <option value="">— nothing yet —</option>
        {others.map((s) => <option key={s.node_key} value={s.node_key}>{s.node_key} ({s.kind})</option>)}
      </select>
    </label>
  );

  const loadHeaders = async () => {
    setReading(true);
    try {
      const res = await api.sheetsHeaders({
        spreadsheetId: step.config.spreadsheetId,
        sheetName: step.config.sheetName,
      });
      setHeaders(res.headers);
      // Pre-fill a column per header, so the mapping starts from what the
      // sheet already says rather than from an empty list.
      if (!step.config.columns?.length && res.headers.length) {
        set({ config: { ...step.config, columns: res.headers.map((h) => ({ header: h, value: '' })) } });
      }
    } catch (e) {
      setHeaders(null);
      set({ config: { ...step.config, error: e.message } });
    } finally { setReading(false); }
  };

  return (
    <Modal title={`${TITLES[step.kind] ?? step.kind} — ${step.key}`} size="lg" onClose={onClose}>
      {!step.isNew && isEntry ? <p className="muted">This is the first step of the bot.</p> : null}

      {step.isNew ? (
        <label>Name this step
          <input value={step.key} onChange={(e) => set({ key: e.target.value })} />
        </label>
      ) : null}

      {/* Every kind that actually says something to a person. */}
      {!SILENT.has(step.kind) ? (
        <label>Message
          <textarea rows={4} value={step.body} onChange={(e) => set({ body: e.target.value })}
            placeholder={'Thanks {{name}}! Which role are you applying for?'} />
        </label>
      ) : null}

      {fields.length ? (
        <p className="muted">
          Answers collected so far: {fields.map((f) => <em key={f} className="tag">{`{{${f}}}`}</em>)}
        </p>
      ) : null}

      {step.kind === 'prompt' ? (
        <div className="formgrid">
          <label>Save their reply as
            <input value={step.saveAs} onChange={(e) => set({ saveAs: e.target.value })} placeholder="name" />
          </label>
          <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </div>
      ) : null}

      {step.kind === 'message' ? (
        <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
      ) : null}

      {step.kind === 'menu' ? (
        <>
          <h3>How it looks</h3>
          <div className="previewsplit">
            <div>
              <label>Send this menu as
                <select value={step.config.display ?? 'text'}
                  onChange={(e) => set({ config: { ...step.config, display: e.target.value } })}>
                  <option value="text">Plain text they reply with a number</option>
                  <option value="buttons">Quick reply buttons (up to 3)</option>
                  <option value="list">A list behind one button (up to 10)</option>
                </select>
              </label>
              <p className="muted">
                Buttons sit under the message and are tapped directly. A list shows one button
                that opens a separate sheet — better for many choices, an extra tap for few.
              </p>
            </div>
            <MessagePreview step={step} sample={sample} />
          </div>

          <div className="formgrid">
            <label>Header <Count value={step.config.header} max={HEADER_MAX} />
              <input value={step.config.header ?? ''} maxLength={HEADER_MAX}
                onChange={(e) => set({ config: { ...step.config, header: e.target.value } })}
                placeholder="JobStatus" />
            </label>
            <label>Footer <Count value={step.config.footer} max={FOOTER_MAX} />
              <input value={step.config.footer ?? ''} maxLength={FOOTER_MAX}
                onChange={(e) => set({ config: { ...step.config, footer: e.target.value } })}
                placeholder="Reply anytime" />
            </label>
          </div>
          <p className="muted">
            Both are optional, and both survive the plain-text fallback — the header goes out
            bold, the footer italic.
          </p>

          {/*
            * Said plainly, because it is the single most common disappointment
            * with WhatsApp automation: tappable menus are a Business API
            * feature and this is not the Business API.
            */}
          {step.config.display === 'buttons' ? (
            <div className="card">
              <strong>Sent as real quick-reply buttons.</strong>
              <p className="muted">
                Three buttons maximum, {LIMITS.buttons.label} characters each. If WhatsApp
                refuses the message — it does so unpredictably, by account and by recipient —
                the numbered version is sent instead, so nobody is ever left unable to answer.
              </p>
            </div>
          ) : null}

          {step.config.display === 'list' ? (
            <div className="card card--warn">
              <strong>Tappable lists often do not arrive.</strong>
              <p className="muted">
                WhatsApp restricts them largely to the official Business API. This app drives
                WhatsApp Web, so the send is attempted and the numbered version goes instead
                whenever it is refused. Worth testing against a real phone before relying on it.
              </p>
              <div className="formgrid">
                <label>Button text
                  <input value={step.config.buttonText ?? ''} maxLength={20}
                    onChange={(e) => set({ config: { ...step.config, buttonText: e.target.value } })}
                    placeholder="Choose an option" />
                </label>
                <label>Section heading
                  <input value={step.config.listTitle ?? ''}
                    onChange={(e) => set({ config: { ...step.config, listTitle: e.target.value } })}
                    placeholder="Options" />
                </label>
              </div>
              <p className="muted">
                Ten options maximum, {LIMITS.list.label} characters each.
              </p>
            </div>
          ) : null}

          <h3>{step.config.display === 'buttons' ? 'Quick reply buttons' : 'Options'}</h3>
          <p className="muted">People can answer with the number, the keyword, or the whole label.</p>
          {LIMITS[step.config.display] && step.options.length > LIMITS[step.config.display].max ? (
            <p className="error">
              That is {step.options.length} options and the limit is
              {' '}{LIMITS[step.config.display].max}. WhatsApp drops the message rather than
              trimming it, so this will not save.
            </p>
          ) : null}
          {step.options.map((o, i) => (
            <div key={i} className="formgrid formgrid--tight">
              <label>
                {i + 1}. Label
                {LIMITS[step.config.display]
                  ? <Count value={o.label} max={LIMITS[step.config.display].label} />
                  : null}
                <input value={o.label} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...o, label: e.target.value }; set({ options });
                }} placeholder="How to apply" />
              </label>
              <label>Keyword
                <input value={o.match} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...o, match: e.target.value }; set({ options });
                }} placeholder="apply" />
              </label>
              {step.config.display === 'list' ? (
                <label>Small print
                  <input value={o.description ?? ''} onChange={(e) => {
                    const options = [...step.options]; options[i] = { ...o, description: e.target.value }; set({ options });
                  }} placeholder="Shown under the label" />
                </label>
              ) : null}
              <label>Goes to
                <select value={o.next_key} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...o, next_key: e.target.value }; set({ options });
                }}>
                  <option value="">— choose —</option>
                  {others.map((s) => <option key={s.node_key} value={s.node_key}>{s.node_key}</option>)}
                </select>
              </label>
              <button className="danger" onClick={() =>
                set({ options: step.options.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button onClick={() => set({ options: [...step.options, { label: '', match: '', next_key: '' }] })}>
            {step.config.display === 'buttons' ? 'Add button' : 'Add an option'}
          </button>
        </>
      ) : null}

      {step.kind === 'condition' ? (
        <>
          <h3>Rules</h3>
          <p className="muted">
            Checked in order — the first one that fits wins, and anything that fits none takes
            the "otherwise" path.
          </p>
          {step.options.map((r, i) => (
            <div key={i} className="formgrid formgrid--tight">
              <label>{i === 0 ? 'If' : 'Else if'}
                <input list="known-fields" value={r.field} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...r, field: e.target.value }; set({ options });
                }} placeholder="role" />
              </label>
              <label>Comparison
                <select value={r.op} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...r, op: e.target.value }; set({ options });
                }}>
                  {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              {!NO_VALUE.has(r.op) ? (
                <label>Value
                  <input value={r.value} onChange={(e) => {
                    const options = [...step.options]; options[i] = { ...r, value: e.target.value }; set({ options });
                  }} placeholder="Registered Nurse" />
                </label>
              ) : null}
              <label>Goes to
                <select value={r.next_key} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...r, next_key: e.target.value }; set({ options });
                }}>
                  <option value="">— choose —</option>
                  {others.map((s) => <option key={s.node_key} value={s.node_key}>{s.node_key}</option>)}
                </select>
              </label>
              <button className="danger" onClick={() =>
                set({ options: step.options.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <datalist id="known-fields">
            {fields.map((f) => <option key={f} value={f} />)}
          </datalist>
          <button onClick={() => set({
            options: [...step.options, { field: fields[0] ?? '', op: 'equals', value: '', next_key: '' }],
          })}>Add a rule</button>

          <StepPicker label="Otherwise go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </>
      ) : null}

      {step.kind === 'delay' ? (
        <div className="formgrid">
          <label>Wait for (seconds)
            <input type="number" min="0" value={step.config.seconds ?? 0}
              onChange={(e) => set({ config: { ...step.config, seconds: Number(e.target.value) } })} />
          </label>
          <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </div>
      ) : null}

      {step.kind === 'cta' ? (
        <>
          {/*
            * Action buttons send nothing back, so this step continues rather
            * than waiting. Saying so here saves someone wiring an answer path
            * that can never be taken.
            */}
          <div className="previewsplit">
            <p className="muted">
              Tapping one of these opens a website, dials a number or copies a code — none of
              which sends a message back, so the flow carries straight on to the next step.
            </p>
            <MessagePreview step={step} sample={sample} />
          </div>

          <div className="formgrid">
            <label>Header <Count value={step.config.header} max={HEADER_MAX} />
              <input value={step.config.header ?? ''} maxLength={HEADER_MAX}
                onChange={(e) => set({ config: { ...step.config, header: e.target.value } })}
                placeholder="Apply now" />
            </label>
            <label>Footer <Count value={step.config.footer} max={FOOTER_MAX} />
              <input value={step.config.footer ?? ''} maxLength={FOOTER_MAX}
                onChange={(e) => set({ config: { ...step.config, footer: e.target.value } })}
                placeholder="We reply within a day" />
            </label>
          </div>

          <h3>Buttons</h3>
          <p className="muted">Up to three. The address is written into the text as well, so it still works if the buttons do not arrive.</p>
          {step.options.map((o, i) => (
            <div key={i} className="formgrid formgrid--tight">
              <label>Label <Count value={o.label} max={LIMITS.buttons.label} />
                <input value={o.label} maxLength={LIMITS.buttons.label} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...o, label: e.target.value }; set({ options });
                }} placeholder="Visit our site" />
              </label>
              <label>Does what
                <select value={o.cta ?? 'url'} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...o, cta: e.target.value }; set({ options });
                }}>
                  {CTA_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </label>
              <label>{(o.cta ?? 'url') === 'url' ? 'Address' : (o.cta === 'call' ? 'Number' : 'Code')}
                <input value={o.value ?? ''} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...o, value: e.target.value }; set({ options });
                }} placeholder={CTA_KINDS.find((k) => k.value === (o.cta ?? 'url'))?.placeholder} />
              </label>
              <button className="danger" onClick={() =>
                set({ options: step.options.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          {step.options.length < 3 ? (
            <button onClick={() => set({ options: [...step.options, { label: '', cta: 'url', value: '' }] })}>
              Add button
            </button>
          ) : <p className="muted">Three is the maximum WhatsApp accepts.</p>}

          <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </>
      ) : null}

      {step.kind === 'template' ? (
        <div className="formgrid">
          <label>Template
            <select value={step.config.templateKey ?? ''}
              onChange={(e) => set({ config: { ...step.config, templateKey: e.target.value } })}>
              <option value="">Choose a template</option>
              {templates.filter((t) => t.enabled).map((t) => (
                <option key={t.id} value={t.template_key}>{t.name} ({t.template_key})</option>
              ))}
            </select>
          </label>
          <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </div>
      ) : null}

      {step.kind === 'attributes' ? (
        <>
          <p className="muted">
            Store a value without asking for it — useful for remembering which branch someone
            took, so a later condition can test it.
          </p>
          {step.options.map((a, i) => (
            <div key={i} className="formgrid formgrid--tight">
              <label>Call it
                <input value={a.field} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...a, field: e.target.value }; set({ options });
                }} placeholder="source" />
              </label>
              {!a.remove ? (
                <label>Set to
                  <input value={a.value} onChange={(e) => {
                    const options = [...step.options]; options[i] = { ...a, value: e.target.value }; set({ options });
                  }} placeholder="campaign" />
                </label>
              ) : null}
              <label className="row">
                <input type="checkbox" checked={Boolean(a.remove)} onChange={(e) => {
                  const options = [...step.options]; options[i] = { ...a, remove: e.target.checked }; set({ options });
                }} />
                Forget it instead
              </label>
              <button className="danger" onClick={() =>
                set({ options: step.options.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button onClick={() => set({ options: [...step.options, { field: '', value: '', remove: false }] })}>
            Add one
          </button>
          <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </>
      ) : null}

      {step.kind === 'tags' ? (
        <>
          <p className="muted">
            Tags go on the chat itself, so they are still there in the inbox long after the
            conversation ends. Separate several with commas.
          </p>
          <div className="formgrid">
            <label>Add tags
              <input value={(step.config.add ?? []).join(', ')}
                onChange={(e) => set({ config: { ...step.config, add: e.target.value.split(',').map((t) => t.trim()) } })}
                placeholder="applicant, nurse" />
            </label>
            <label>Remove tags
              <input value={(step.config.remove ?? []).join(', ')}
                onChange={(e) => set({ config: { ...step.config, remove: e.target.value.split(',').map((t) => t.trim()) } })}
                placeholder="new-enquiry" />
            </label>
          </div>
          <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </>
      ) : null}

      {step.kind === 'hours' ? (
        <>
          <p className="muted">
            Sends people down one path during opening hours and another outside them — so an
            after-hours message can say so instead of promising a call back in ten minutes.
          </p>
          <div className="formgrid">
            <label>From
              <input type="time" value={step.config.from ?? '09:00'}
                onChange={(e) => set({ config: { ...step.config, from: e.target.value } })} />
            </label>
            <label>To
              <input type="time" value={step.config.to ?? '18:00'}
                onChange={(e) => set({ config: { ...step.config, to: e.target.value } })} />
            </label>
            <label>Timezone
              <input value={step.config.timezone ?? 'Asia/Kolkata'}
                onChange={(e) => set({ config: { ...step.config, timezone: e.target.value } })} />
            </label>
          </div>
          <p className="muted">A range that ends before it starts, like 22:00 to 06:00, runs overnight.</p>

          <div className="row">
            {WEEKDAYS.map((d, i) => {
              const days = step.config.days ?? [1, 2, 3, 4, 5];
              const on = days.includes(i);
              return (
                <label key={d} className="row">
                  <input type="checkbox" checked={on} onChange={() => set({
                    config: {
                      ...step.config,
                      days: on ? days.filter((x) => x !== i) : [...days, i].sort(),
                    },
                  })} />
                  {d}
                </label>
              );
            })}
          </div>

          <div className="formgrid">
            <StepPicker label="During working hours, go to" value={step.nextKey}
              onPick={(v) => set({ nextKey: v })} />
            <StepPicker label="Outside them, go to" value={step.config.closedKey}
              onPick={(v) => set({ config: { ...step.config, closedKey: v } })} />
          </div>
        </>
      ) : null}

      {step.kind === 'api' ? (
        <>
          <p className="muted">
            Calls an endpoint mid-conversation and keeps part of the answer. Capped at ten
            seconds — someone is waiting on the other end.
          </p>
          <div className="formgrid">
            <label>Method
              <select value={step.config.method ?? 'GET'}
                onChange={(e) => set({ config: { ...step.config, method: e.target.value } })}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
            <label>Address
              <input value={step.config.url ?? ''}
                onChange={(e) => set({ config: { ...step.config, url: e.target.value } })}
                placeholder="https://api.example.com/status/{{phone}}" />
            </label>
          </div>

          {!['GET', 'HEAD'].includes(step.config.method ?? 'GET') ? (
            <label>Body
              <textarea rows={3} value={step.config.body ?? ''}
                onChange={(e) => set({ config: { ...step.config, body: e.target.value } })}
                placeholder={'{"name": "{{name}}"}'} />
            </label>
          ) : null}

          <h3>Keep from the answer</h3>
          <p className="muted">
            A dotted path into the JSON, such as <code>data.status</code>.
          </p>
          {(step.config.save ?? []).map((m, i) => (
            <div key={i} className="formgrid formgrid--tight">
              <label>Path
                <input value={m.path} onChange={(e) => {
                  const save = [...step.config.save]; save[i] = { ...m, path: e.target.value };
                  set({ config: { ...step.config, save } });
                }} placeholder="data.status" />
              </label>
              <label>Call it
                <input value={m.field} onChange={(e) => {
                  const save = [...step.config.save]; save[i] = { ...m, field: e.target.value };
                  set({ config: { ...step.config, save } });
                }} placeholder="status" />
              </label>
              <button className="danger" onClick={() => set({
                config: { ...step.config, save: step.config.save.filter((_, j) => j !== i) },
              })}>Remove</button>
            </div>
          ))}
          <button onClick={() => set({
            config: { ...step.config, save: [...(step.config.save ?? []), { path: '', field: '' }] },
          })}>Keep a value</button>

          <div className="formgrid">
            <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
            <StepPicker label="If the call fails, go to" value={step.config.onError}
              onPick={(v) => set({ config: { ...step.config, onError: v } })} />
          </div>
          <p className="muted">
            Leave the failure path empty and a broken endpoint simply ends the conversation.
            Pointing it at a step lets you apologise instead.
          </p>
        </>
      ) : null}

      {step.kind === 'sheets' ? (
        <>
          {/*
            * Nothing here works until a service account exists and the sheet is
            * shared with it, so the account's address is put in front of the
            * person rather than buried in a setup guide.
            */}
          {sheets && !sheets.ready ? (
            <div className="card card--warn">
              <strong>Google Sheets is not connected yet.</strong>
              <p className="muted">{sheets.error}</p>
            </div>
          ) : sheets ? (
            <p className="muted">
              Share your sheet (as Editor) with <code>{sheets.account}</code>, or nothing can be written to it.
            </p>
          ) : null}

          <div className="formgrid">
            <label>Spreadsheet link or id
              <input value={step.config.spreadsheetId ?? ''}
                onChange={(e) => set({ config: { ...step.config, spreadsheetId: e.target.value } })}
                placeholder="https://docs.google.com/spreadsheets/d/…" />
            </label>
            <label>Tab name
              <input value={step.config.sheetName ?? ''}
                onChange={(e) => set({ config: { ...step.config, sheetName: e.target.value } })}
                placeholder="Sheet1" />
            </label>
          </div>

          <button onClick={loadHeaders} disabled={reading || !step.config.spreadsheetId}>
            {reading ? 'Reading…' : 'Read the column names'}
          </button>
          {headers ? <p className="muted">Found: {headers.join(' · ')}</p> : null}
          {step.config.error ? <p className="error">{step.config.error}</p> : null}

          <h3>What to write</h3>
          <p className="muted">
            One row per person who reaches this step. Use <code>{'{{name}}'}</code> for anything
            collected earlier.
          </p>
          {(step.config.columns ?? []).map((c, i) => (
            <div key={i} className="formgrid formgrid--tight">
              <label>Column
                <input value={c.header} onChange={(e) => {
                  const columns = [...step.config.columns];
                  columns[i] = { ...c, header: e.target.value };
                  set({ config: { ...step.config, columns } });
                }} placeholder="Name" />
              </label>
              <label>Value
                <input value={c.value} onChange={(e) => {
                  const columns = [...step.config.columns];
                  columns[i] = { ...c, value: e.target.value };
                  set({ config: { ...step.config, columns } });
                }} placeholder={'{{name}}'} />
              </label>
              <button className="danger" onClick={() => set({
                config: { ...step.config, columns: step.config.columns.filter((_, j) => j !== i) },
              })}>Remove</button>
            </div>
          ))}
          <button onClick={() => set({
            config: { ...step.config, columns: [...(step.config.columns ?? []), { header: '', value: '' }] },
          })}>Add a column</button>

          <StepPicker label="Then go to" value={step.nextKey} onPick={(v) => set({ nextKey: v })} />
        </>
      ) : null}

      <div className="row row--between modal__actions">
        <button className="primary" onClick={() => onSave(step)} disabled={busy || !step.key.trim()}>
          {step.isNew ? 'Add this step' : 'Save'}
        </button>
        <div className="row">
          {!step.isNew && !isEntry ? (
            <button className="danger" onClick={() => onDelete(step.key)} disabled={busy}>Delete step</button>
          ) : null}
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
