import { config } from './config.js';
import { Schedules, Sessions } from './store.js';
import { renderAll, queueBatch } from './dispatch.js';
import { publish } from './events.js';
import { isConnected } from './whatsapp.js';

/**
 * Recurring messages — the alarm clock.
 *
 * A schedule does not send anything itself. When one comes due it renders its
 * recipients and hands them to the same batch path the bulk screen uses, so a
 * timer cannot become a way to send faster than a person could.
 *
 * Two decisions carry most of the weight here:
 *
 *   - Times are stored as wall-clock ("09:00") plus a timezone, never as a
 *     fixed offset. "Every morning at nine" has to stay nine in the morning
 *     across a daylight-saving change, and a stored epoch cannot do that.
 *
 *   - A firing that is too late is dropped, not delivered. See `graceMinutes`.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ----------------------------- calendar maths ---------------------------- */

/** The wall-clock reading of an instant, as seen in a given timezone. */
function partsIn(ms, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Some ICU versions render midnight as hour 24 rather than 0.
    hour: p.hour === '24' ? 0 : Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

/** How far the zone is from UTC at a particular instant. */
function offsetAt(ms, timezone) {
  const p = partsIn(ms, timezone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which a wall-clock time occurs in a zone.
 *
 * Finding this is circular — to know which UTC instant is 09:00 you need the
 * offset, and the offset depends on the instant — so the two plausible offsets
 * are tried instead of iterating. Iterating looks simpler but oscillates on
 * the two mornings a year when the answer is not a single instant:
 *
 *   - Clocks spring forward and 02:30 never happens. Neither candidate reads
 *     back as 02:30, so the later one wins and the alarm goes off at 03:30,
 *     right after the jump. Iterating settles on 01:30 — an hour *early*,
 *     which is the one answer a 02:30 alarm must never give.
 *
 *   - Clocks fall back and 01:30 happens twice. Both candidates read back
 *     correctly, so the earlier wins and it fires once, not twice.
 */
function instantOf({ year, month, day, hour, minute }, timezone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const DAY = 86400000;

  // The offsets in force on either side of any nearby transition.
  const before = naive - offsetAt(naive - DAY, timezone);
  const after = naive - offsetAt(naive + DAY, timezone);

  const readsBack = (ms) => {
    const p = partsIn(ms, timezone);
    return p.hour === hour && p.minute === minute && p.day === day;
  };

  if (readsBack(before)) return before; // the normal case, and the earlier of a repeated hour
  if (readsBack(after)) return after;
  return Math.max(before, after); // the hour does not exist: fire just after the jump
}

const parseTime = (hhmm) => {
  const [h, m] = String(hhmm ?? '09:00').split(':').map(Number);
  return { hour: Number.isFinite(h) ? h : 9, minute: Number.isFinite(m) ? m : 0 };
};

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The times a schedule wants on one particular calendar day, in order.
 * An empty list means "not this day".
 */
function timesOnDay(schedule, { year, month, day, weekday }) {
  switch (schedule.kind) {
    case 'daily':
      return [schedule.time_of_day ?? '09:00'];

    case 'weekly':
      // Each slot is {day, time}, so Monday at 09:00 and Friday at 18:30 can
      // live in one schedule instead of forcing two near-identical ones.
      return (schedule.slots ?? [])
        .filter((s) => Number(s.day) === weekday)
        .map((s) => s.time ?? schedule.time_of_day ?? '09:00')
        .sort();

    case 'monthly': {
      // "The 31st" in February means the 28th, not "skip February".
      const target = Math.min(Number(schedule.day_of_month ?? 1), daysInMonth(year, month));
      return day === target ? [schedule.time_of_day ?? '09:00'] : [];
    }

    default:
      return [];
  }
}

/**
 * The first firing strictly after `after`, or null if there will never be one.
 *
 * Walks forward a day at a time rather than doing modular arithmetic — slower,
 * but it gets month lengths, leap years and daylight saving right for free,
 * and it runs once per firing rather than once per tick.
 */
export function nextOccurrence(schedule, after = Date.now()) {
  const timezone = schedule.timezone || config.schedule.timezone;

  // A one-off has exactly one firing and never recurs.
  if (schedule.kind === 'once') {
    const at = Number(schedule.run_at);
    return Number.isFinite(at) && at > after ? at : null;
  }

  if (schedule.kind === 'weekly' && !(schedule.slots ?? []).length) return null;

  const base = partsIn(after, timezone);
  // 400 days covers every yearly pattern, including a leap February.
  for (let i = 0; i <= 400; i += 1) {
    const cursor = new Date(Date.UTC(base.year, base.month - 1, base.day + i));
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();

    for (const time of timesOnDay(schedule, { year, month, day, weekday: cursor.getUTCDay() })) {
      const { hour, minute } = parseTime(time);
      const at = instantOf({ year, month, day, hour, minute }, timezone);
      if (at > after) return at;
    }
  }
  return null;
}

/** A plain-English summary, so the list doesn't ask anyone to decode a cron line. */
export function describe(schedule) {
  const time = schedule.time_of_day ?? '09:00';
  switch (schedule.kind) {
    case 'once':
      return `Once, on ${new Date(Number(schedule.run_at)).toLocaleString()}`;
    case 'daily':
      return `Every day at ${time}`;
    case 'weekly': {
      const slots = [...(schedule.slots ?? [])]
        .sort((a, b) => a.day - b.day || String(a.time).localeCompare(String(b.time)));
      if (!slots.length) return 'Weekly, but no days chosen yet';
      const sameTime = new Set(slots.map((s) => s.time)).size === 1;
      return sameTime
        ? `${slots.map((s) => DAY_NAMES[s.day].slice(0, 3)).join(', ')} at ${slots[0].time}`
        : slots.map((s) => `${DAY_NAMES[s.day].slice(0, 3)} ${s.time}`).join(', ');
    }
    case 'monthly':
      return `Day ${schedule.day_of_month} of every month at ${time}`;
    default:
      return schedule.kind;
  }
}

/* -------------------------------- the ticker ----------------------------- */

let timer = null;

/**
 * Do the actual work of a firing: render, queue, write it down.
 *
 * Separate from claiming it, because a manual "send now" is a real send that
 * was never due — it must not be held to a timetable it is deliberately
 * ignoring, and it must not consume the next scheduled occurrence.
 */
async function execute(schedule, { dueAt, at, honourGrace, manual = false }) {
  const log = (status, extra = {}) =>
    Schedules.logRun({ scheduleId: schedule.id, dueAt, status, ...extra });

  /*
   * Too late to be worth sending.
   *
   * This is the difference between an alarm clock and a reminder that shouts
   * at you hours afterwards. "The clinic opens at 9" arriving at 14:00 is not
   * a late success — it is a new and confusing message.
   */
  const lateBy = at - dueAt;
  if (honourGrace && lateBy > config.schedule.graceMinutes * 60000) {
    const mins = Math.round(lateBy / 60000);
    console.log(`[schedule:${schedule.name}] skipped — ${mins}m late (grace ${config.schedule.graceMinutes}m)`);
    await log('skipped', {
      detail: `Missed by ${mins} minutes — the server was not running at the scheduled time.`,
    });
    await Schedules.markRan(schedule.id, at, null);
    return;
  }

  try {
    const row = await Sessions.get(schedule.session);
    if (!row) throw new Error(`No session named "${schedule.session}"`);

    // A disconnected session that is meant to come back can still bank the
    // messages; one that isn't would just collect them until they expire.
    if (!isConnected(schedule.session) && !row.auto_start) {
      throw new Error(`Session "${schedule.session}" is disconnected and not set to reconnect.`);
    }

    const usingTemplate = schedule.source === 'template';
    const { rendered, problems } = await renderAll({
      template: usingTemplate ? schedule.template_key : null,
      message: usingTemplate ? null : schedule.body,
      recipients: schedule.recipients ?? [],
    });

    if (problems.length) {
      throw new Error(
        `${problems.length} of ${schedule.recipients.length} recipients could not be rendered: ${problems[0].error}`,
      );
    }
    if (!rendered.length) throw new Error('No recipients');

    const batch = await queueBatch({
      session: schedule.session,
      template: usingTemplate ? schedule.template_key : null,
      message: usingTemplate ? null : schedule.body,
      rendered,
      userId: schedule.owner_id,
      refPrefix: `sched${schedule.id}`,
    });

    console.log(`[schedule:${schedule.name}] queued ${batch.jobs.length} message(s)${manual ? ' (manual run)' : ''}`);
    await log('queued', {
      queued: batch.jobs.length,
      batchRef: batch.batchRef,
      detail: manual ? 'Sent by hand, outside the timetable.' : null,
    });
    await Schedules.markRan(schedule.id, at, null);
    publish('schedule', { id: schedule.id, name: schedule.name, queued: batch.jobs.length });
  } catch (err) {
    console.error(`[schedule:${schedule.name}]`, err.message);
    await log('failed', { detail: err.message });
    await Schedules.markRan(schedule.id, at, err.message);
  }
}

/**
 * Fire one schedule that has come due.
 *
 * Claims the firing before doing any work, so a crash partway through cannot
 * repeat it and a second process racing for the same schedule finds nothing
 * left to do.
 */
async function fire(schedule, at) {
  const dueAt = Number(schedule.next_run_at);
  const following = nextOccurrence(schedule, Math.max(dueAt, at));

  // Compare-and-set: whoever moves `next_run_at` owns this firing.
  if (!(await Schedules.claim(schedule.id, dueAt, following))) return;

  // A one-off has nothing left to do. Disable it rather than leave a dead row
  // that still looks active in the list.
  if (following === null) await Schedules.setEnabled(schedule.id, false);

  await execute(schedule, { dueAt, at, honourGrace: true });
}

async function tick() {
  const at = Date.now();
  for (const schedule of await Schedules.due(at)) {
    await fire(schedule, at).catch((err) => console.error('[schedule]', err));
  }
}

/**
 * Run a schedule immediately, ignoring its timetable. The "Send now" button.
 *
 * Deliberately skips the claim and leaves `next_run_at` alone: testing a
 * schedule at 3pm should not cancel tomorrow's 9am, and it is not "late" for
 * a time it was never waiting for.
 */
export async function runNow(id) {
  const schedule = await Schedules.get(id);
  if (!schedule) throw new Error(`No schedule ${id}`);

  const at = Date.now();
  await execute(schedule, { dueAt: at, at, honourGrace: false, manual: true });
  return Schedules.get(id);
}

/**
 * Give every schedule a next run, then start the ticker.
 *
 * Backfilling at boot matters: a schedule whose `next_run_at` is in the past
 * because the machine was off all weekend would otherwise fire a stale message
 * the moment the server came back.
 */
export async function startScheduler() {
  const list = await Schedules.list({});
  let repaired = 0;

  for (const s of list) {
    if (!s.enabled) continue;
    const at = Number(s.next_run_at);
    const stale = !at || at + config.schedule.graceMinutes * 60000 < Date.now();
    if (!stale) continue;

    const next = nextOccurrence(s, Date.now());
    await Schedules.setNextRun(s.id, next);
    if (next === null) await Schedules.setEnabled(s.id, false);
    repaired += 1;
  }

  timer = setInterval(
    () => { tick().catch((err) => console.error('[schedule]', err)); },
    config.schedule.tickMs,
  );

  const active = list.filter((s) => s.enabled).length;
  console.log(`[schedule] ticker active — ${active} schedule(s)${repaired ? `, ${repaired} rescheduled after downtime` : ''}`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export const _internals = { partsIn, offsetAt, instantOf, timesOnDay, daysInMonth, fire, execute, tick };
