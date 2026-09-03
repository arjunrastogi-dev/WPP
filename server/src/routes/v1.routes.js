import { Router } from 'express';
import { route } from '../http.js';
import { requireApiKey } from '../auth.js';
import { renderTemplate } from '../templates.js';
import { enqueue } from '../queue.js';
import { toChatId, isConnected } from '../whatsapp.js';
import { Sessions } from '../store.js';
import { config } from '../config.js';

/**
 * The public, machine-facing API — this is what the clinic CMS calls.
 *
 * Authenticated with a shared API key rather than a user login, and versioned
 * so the wording of a template (or this app's internals) can change without
 * breaking the caller.
 */
const router = Router();
router.use(requireApiKey);

/**
 * POST /api/v1/send-template
 * { session, template, to, variables, sendAt? }
 *
 * One endpoint for every template — the template is named in the body, not the
 * URL, so adding a template never means adding an endpoint.
 */
router.post('/send-template', route(async (req, res) => {
  const { session, template, to, variables, sendAt } = req.body ?? {};

  if (!session || !template || !to) {
    return res.status(400).json({
      error: 'session, template and to are required',
      code: 'BAD_REQUEST',
    });
  }
  /*
   * A disconnected session is not necessarily a dead end.
   *
   * If the session exists and its owner means it to be running, the watchdog
   * will reconnect it — so the honest thing is to accept the message and hold
   * it, rather than reject and make the caller invent its own retry. It is
   * refused only when nothing will ever pick it up.
   */
  const row = await Sessions.get(session);
  if (!row) {
    return res.status(404).json({
      error: `No session named "${session}"`,
      code: 'SESSION_NOT_FOUND',
    });
  }

  const live = isConnected(session);
  if (!live && !row.auto_start) {
    return res.status(409).json({
      error: `Session "${session}" is disconnected and not set to reconnect. `
        + 'Start it, then send again.',
      code: 'SESSION_DISCONNECTED',
    });
  }

  let rendered;
  try {
    rendered = await renderTemplate(template, variables ?? {});
  } catch (err) {
    // Template problems are the caller's fault, so answer 400 with the reason.
    return res.status(400).json({ error: err.message, code: err.code ?? 'TEMPLATE_ERROR', missing: err.missing });
  }

  const job = await enqueue({
    session,
    chatId: toChatId(to),
    body: rendered.text,
    sendAt: sendAt ? Number(sendAt) : Date.now(),
    // Only held messages expire; a live send goes out within seconds anyway.
    expiresAt: live ? null : Date.now() + config.queue.ttlHours * 3600000,
  });

  // 202: accepted and queued. Delivery happens on the rate limiter's schedule.
  res.status(202).json({
    ok: true,
    messageId: job.id,
    status: job.status,
    // Tell the caller plainly which of the two situations they are in.
    delivery: live ? 'queued' : 'held',
    note: live
      ? undefined
      : `Session "${session}" is offline. Held for up to ${config.queue.ttlHours}h and sent when it reconnects.`,
    template: rendered.template.template_key,
    to: toChatId(to),
    preview: rendered.text,
  });
}));

/** Let the caller check what happened to a queued message. */
router.get('/messages/:id', route(async (req, res) => {
  const { Outbox } = await import('../store.js');
  const { get } = await import('../db.js');
  const job = await get('SELECT * FROM outbox WHERE id = ?', Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Unknown message id', code: 'NOT_FOUND' });
  res.json({
    messageId: job.id,
    status: job.status,
    attempts: job.attempts,
    error: job.last_error,
    sendAt: job.send_at,
    workerId: Outbox.workerId,
  });
}));

export default router;
