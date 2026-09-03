import { Router } from 'express';
import { route } from '../http.js';
import { config } from '../config.js';
import { Schedules, Sessions } from '../store.js';
import { renderAll } from '../dispatch.js';
import { nextOccurrence, describe, runNow, DAY_NAMES } from '../schedule.js';

const router = Router();

const KINDS = new Set(['once', 'daily', 'weekly', 'monthly']);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Read a schedule out of a request body, rejecting anything the ticker would
 * later choke on.
 *
 * Validation is strict here because a bad schedule fails silently: nobody
 * watches a screen at 09:00 to notice that nothing went out.
 */
function parse(body) {
  const bad = (message) => { const e = new Error(message); e.status = 400; throw e; };

  const name = String(body?.name ?? '').trim();
  if (!name) bad('Give the schedule a name');

  const session = String(body?.session ?? '').trim();
  if (!session) bad('Choose a session to send from');

  const kind = String(body?.kind ?? '').trim();
  if (!KINDS.has(kind)) bad(`kind must be one of: ${[...KINDS].join(', ')}`);

  const timezone = String(body?.timezone ?? config.schedule.timezone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    bad(`"${timezone}" is not a timezone this machine knows about`);
  }

  const timeOfDay = String(body?.timeOfDay ?? '09:00');
  if (kind !== 'once' && !TIME.test(timeOfDay)) bad('Time must look like 09:00');

  let slots = [];
  let dayOfMonth = null;
  let runAt = null;

  if (kind === 'weekly') {
    slots = (Array.isArray(body?.slots) ? body.slots : [])
      .map((s) => ({ day: Number(s.day), time: String(s.time ?? timeOfDay) }))
      .filter((s) => Number.isInteger(s.day) && s.day >= 0 && s.day <= 6);

    if (!slots.length) bad('Pick at least one day of the week');
    for (const s of slots) {
      if (!TIME.test(s.time)) bad(`${DAY_NAMES[s.day]} has an invalid time — use 09:00`);
    }
  }

  if (kind === 'monthly') {
    dayOfMonth = Number(body?.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      bad('Day of the month must be between 1 and 31');
    }
  }

  if (kind === 'once') {
    runAt = Number(body?.runAt);
    if (!Number.isFinite(runAt)) bad('Pick a date and time');
    if (runAt <= Date.now()) bad('That moment has already passed');
  }

  const source = body?.template ? 'template' : 'custom';
  const templateKey = body?.template ? String(body.template) : null;
  const message = body?.message ? String(body.message) : null;
  if (source === 'custom' && !message?.trim()) bad('Write a message, or pick a template');

  const recipients = (Array.isArray(body?.recipients) ? body.recipients : [])
    .map((r) => ({ to: String(r.to ?? '').trim(), variables: r.variables ?? {} }))
    .filter((r) => r.to);
  if (!recipients.length) bad('Add at least one recipient');
  if (recipients.length > config.bulk.maxRecipients) {
    bad(`That is ${recipients.length} recipients; the limit is ${config.bulk.maxRecipients}`);
  }

  return {
    name, session, kind, timezone, timeOfDay, slots, dayOfMonth, runAt,
    source, templateKey, body: message, recipients,
    enabled: body?.enabled !== false,
  };
}

/** What the client needs to show a row without recomputing any of it. */
function present(s) {
  const upcoming = [];
  let cursor = Date.now();
  for (let i = 0; i < 3; i += 1) {
    const at = nextOccurrence(s, cursor);
    if (at === null) break;
    upcoming.push(at);
    cursor = at;
  }
  return { ...s, summary: describe(s), upcoming };
}

/** Only the owner (or an admin) may touch a schedule. */
async function mine(req, res) {
  const s = await Schedules.get(Number(req.params.id));
  if (!s) {
    res.status(404).json({ error: `No schedule ${req.params.id}` });
    return null;
  }
  if (s.owner_id && s.owner_id !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ error: 'That schedule belongs to someone else' });
    return null;
  }
  return s;
}

router.get('/', route(async (req, res) => {
  const list = await Schedules.list({ userId: req.user.id, isAdmin: req.user.role === 'admin' });
  res.json(list.map(present));
}));

/**
 * POST /api/schedules/preview — what a schedule *would* do, before saving it.
 *
 * Recurrence rules are easy to get subtly wrong ("the 31st" in February, a
 * weekday nobody ticked), and the cost of being wrong is a message that never
 * arrives. Showing the next few firings up front is cheaper than debugging it
 * a week later.
 */
router.post('/preview', route(async (req, res) => {
  let draft;
  try {
    draft = parse(req.body);
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }

  const shaped = {
    kind: draft.kind,
    time_of_day: draft.timeOfDay,
    slots: draft.slots,
    day_of_month: draft.dayOfMonth,
    run_at: draft.runAt,
    timezone: draft.timezone,
  };

  const upcoming = [];
  let cursor = Date.now();
  for (let i = 0; i < 5; i += 1) {
    const at = nextOccurrence(shaped, cursor);
    if (at === null) break;
    upcoming.push(at);
    cursor = at;
  }

  // Render one recipient too, so a broken template is caught now rather than
  // at 09:00 next Tuesday.
  const { problems } = await renderAll({
    template: draft.source === 'template' ? draft.templateKey : null,
    message: draft.source === 'template' ? null : draft.body,
    recipients: draft.recipients.slice(0, 1),
  });

  res.json({
    summary: describe(shaped),
    upcoming,
    recipients: draft.recipients.length,
    problem: problems[0]?.error ?? null,
  });
}));

router.post('/', route(async (req, res) => {
  let draft;
  try {
    draft = parse(req.body);
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }

  if (!(await Sessions.get(draft.session))) {
    return res.status(404).json({ error: `No session named "${draft.session}"` });
  }

  const nextRunAt = nextOccurrence({
    kind: draft.kind, time_of_day: draft.timeOfDay, slots: draft.slots,
    day_of_month: draft.dayOfMonth, run_at: draft.runAt, timezone: draft.timezone,
  });

  const saved = await Schedules.create({ ...draft, ownerId: req.user.id, nextRunAt });
  res.status(201).json(present(saved));
}));

router.get('/:id', route(async (req, res) => {
  const s = await mine(req, res);
  if (s) res.json(present(s));
}));

router.put('/:id', route(async (req, res) => {
  if (!(await mine(req, res))) return;

  let draft;
  try {
    draft = parse(req.body);
  } catch (err) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }

  // Recompute from scratch: an edited timetable whose old `next_run_at` was
  // kept would fire on yesterday's rule.
  const nextRunAt = draft.enabled
    ? nextOccurrence({
      kind: draft.kind, time_of_day: draft.timeOfDay, slots: draft.slots,
      day_of_month: draft.dayOfMonth, run_at: draft.runAt, timezone: draft.timezone,
    })
    : null;

  res.json(present(await Schedules.update(Number(req.params.id), { ...draft, nextRunAt })));
}));

/** Pause or resume. Resuming recomputes, so a paused schedule never fires late. */
router.post('/:id/toggle', route(async (req, res) => {
  const s = await mine(req, res);
  if (!s) return;

  const enabled = req.body?.enabled ?? !s.enabled;
  await Schedules.setEnabled(s.id, enabled);
  await Schedules.setNextRun(s.id, enabled ? nextOccurrence(s) : null);
  res.json(present(await Schedules.get(s.id)));
}));

/** Send it right now, without disturbing the timetable. */
router.post('/:id/run', route(async (req, res) => {
  const s = await mine(req, res);
  if (!s) return;

  const after = await runNow(s.id);
  const [last] = await Schedules.runs(s.id, 1);
  res.json({ ...present(after), lastRun: last ?? null });
}));

router.get('/:id/runs', route(async (req, res) => {
  const s = await mine(req, res);
  if (s) res.json(await Schedules.runs(s.id, Number(req.query.limit ?? 30)));
}));

router.delete('/:id', route(async (req, res) => {
  const s = await mine(req, res);
  if (!s) return;
  await Schedules.remove(s.id);
  res.json({ ok: true });
}));

export default router;
