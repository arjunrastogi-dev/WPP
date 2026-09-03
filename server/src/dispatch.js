import { config } from './config.js';
import { Bulk } from './store.js';
import { renderTemplate, render } from './templates.js';
import { enqueue } from './queue.js';
import { toChatId } from './whatsapp.js';

/**
 * Turning "this message, these people" into queued jobs.
 *
 * Shared by the bulk screen and the scheduler so both take the same route:
 * render everything first, refuse the whole batch if any row is broken, log
 * what was sent, then queue at a deliberate pace. A scheduled send is not a
 * second, quieter way to message 200 people — it is the same way, on a timer.
 */

/** Extra spacing between messages in a batch, on top of the queue's own jitter. */
export const SPREAD_MS = Number(process.env.BULK_SPREAD_MS ?? 10000);

/**
 * Render one recipient's message, from either a saved template or a one-off
 * message typed into the form.
 *
 * A custom message still honours `{{placeholders}}`, so a one-off can be
 * personalised without first having to save a template for it. The same
 * missing-variable rule applies either way — a message reading "Hi ," is worse
 * than a rejected batch.
 */
export async function renderFor({ template, message, variables }) {
  if (template) {
    const { text } = await renderTemplate(template, variables ?? {});
    return text;
  }

  const { text, missing } = render(message, variables ?? {});
  if (missing.length) {
    const err = new Error(`Missing variables: ${missing.join(', ')}`);
    err.code = 'MISSING_VARIABLES';
    err.missing = missing;
    throw err;
  }
  if (!text.trim()) {
    const err = new Error('The message is empty');
    err.code = 'EMPTY_MESSAGE';
    throw err;
  }
  return text;
}

/**
 * Render every recipient up front.
 *
 * Nothing is queued here on purpose: a half-sent batch with a broken template
 * is much worse than a rejected one, and the caller can only make that choice
 * if it learns about every problem before the first message moves.
 */
export async function renderAll({ template, message, recipients }) {
  const rendered = [];
  const problems = [];

  for (const [index, r] of recipients.entries()) {
    try {
      rendered.push({
        to: toChatId(r.to),
        text: await renderFor({ template, message, variables: r.variables }),
      });
    } catch (err) {
      problems.push({ index, to: r.to, error: err.message });
    }
  }
  return { rendered, problems };
}

/**
 * Log the batch, then queue it.
 *
 * The log row is written before a single job exists, so a crash mid-queue
 * still leaves a trace of what was attempted rather than nothing at all.
 */
export async function queueBatch({
  session, template, message, rendered, userId, startAt, refPrefix = 'bulk',
}) {
  const begin = startAt ? Number(startAt) : Date.now();
  const batchRef = `${refPrefix}-${Date.now()}`;

  const batch = await Bulk.createBatch({
    batchRef,
    session,
    source: template ? 'template' : 'custom',
    templateKey: template ?? null,
    // A custom message is stored verbatim; a template only by key, since the
    // template itself is already versioned in its own table.
    body: template ? null : message,
    total: rendered.length,
    userId: userId ?? null,
  });

  const jobs = [];
  for (const [i, item] of rendered.entries()) {
    const job = await enqueue({
      session,
      chatId: item.to,
      body: item.text,
      // Stagger on top of the queue's own pacing.
      sendAt: begin + i * SPREAD_MS,
      expiresAt: begin + i * SPREAD_MS + config.queue.ttlHours * 3600000,
    });
    jobs.push(job);
    // The rendered text is kept per recipient: the template can be edited
    // tomorrow, and then it no longer tells you what actually went out.
    await Bulk.addRecipient(batch.id, item.to, job.id, item.text);
  }

  return {
    batchRef,
    jobs,
    firstAt: begin,
    lastAt: begin + Math.max(0, jobs.length - 1) * SPREAD_MS,
    estimatedMinutes: Math.ceil((jobs.length * SPREAD_MS) / 60000),
  };
}
