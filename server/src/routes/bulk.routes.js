import { Router } from 'express';
import { route } from '../http.js';
import { config } from '../config.js';
import { all, get } from '../db.js';
import { Sessions, Outbox, Bulk } from '../store.js';
import { renderFor, renderAll, queueBatch, SPREAD_MS } from '../dispatch.js';
import { toChatId, isConnected } from '../whatsapp.js';

/**
 * Bulk sending.
 *
 * This is the single most dangerous feature in the app: sending in a tight
 * loop is what gets a WhatsApp number banned. So it does not send anything
 * itself — every recipient becomes an ordinary queue row, drained at the same
 * deliberate pace as a single message, and spread further apart on top.
 *
 * A batch is therefore slow by design. 200 recipients at ~10s apart is a bit
 * over half an hour, and that is the point.
 */
const router = Router();

/** POST /api/bulk/preview — render every row without sending, to catch mistakes first. */
router.post('/preview', route(async (req, res) => {
  const { template, message, recipients } = req.body ?? {};
  if ((!template && !message) || !Array.isArray(recipients)) {
    return res.status(400).json({ error: 'recipients[] plus either template or message are required' });
  }

  const rows = [];
  for (const [index, r] of recipients.slice(0, config.bulk.maxRecipients).entries()) {
    try {
      const text = await renderFor({ template, message, variables: r.variables });
      rows.push({ index, to: toChatId(r.to), ok: true, preview: text });
    } catch (err) {
      rows.push({ index, to: r.to, ok: false, error: err.message, missing: err.missing });
    }
  }

  const bad = rows.filter((r) => !r.ok).length;
  res.json({
    total: rows.length,
    ready: rows.length - bad,
    problems: bad,
    // Roughly how long the batch will take, so nobody expects it to be instant.
    estimatedMinutes: Math.ceil((rows.length * SPREAD_MS) / 60000),
    rows,
  });
}));

/** POST /api/bulk/send — queue the batch. */
router.post('/send', route(async (req, res) => {
  const { session, template, message, recipients, startAt } = req.body ?? {};

  if (!session || (!template && !message) || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({
      error: 'session, a non-empty recipients[], and either template or message are required',
    });
  }
  if (recipients.length > config.bulk.maxRecipients) {
    return res.status(400).json({
      error: `That is ${recipients.length} recipients; the limit is ${config.bulk.maxRecipients} per batch.`,
    });
  }

  const row = await Sessions.get(session);
  if (!row) return res.status(404).json({ error: `No session named "${session}"` });
  if (!isConnected(session) && !row.auto_start) {
    return res.status(409).json({
      error: `Session "${session}" is disconnected and not set to reconnect.`,
      code: 'SESSION_DISCONNECTED',
    });
  }

  const { rendered, problems } = await renderAll({ template, message, recipients });
  if (problems.length) {
    return res.status(400).json({
      error: `${problems.length} of ${recipients.length} rows could not be rendered. Nothing was sent.`,
      problems: problems.slice(0, 20),
    });
  }

  const batch = await queueBatch({
    session, template, message, rendered, userId: req.user?.id, startAt,
  });

  res.status(202).json({
    ok: true,
    batchId: batch.batchRef,
    queued: batch.jobs.length,
    firstAt: batch.firstAt,
    lastAt: batch.lastAt,
    estimatedMinutes: batch.estimatedMinutes,
    source: template ? `template:${template}` : 'custom message',
    messageIds: batch.jobs.map((j) => j.id),
  });
}));

/**
 * GET /api/bulk/history — past batches and how they turned out.
 *
 * Outcomes are joined live from the queue rather than copied here, so a batch
 * that is still draining reports honestly instead of showing a count frozen at
 * the moment it was created.
 */
router.get('/history', route(async (req, res) => {
  const list = await Bulk.list(req.query.session || null, Number(req.query.limit ?? 50));
  res.json(list.map((b) => ({
    ...b,
    sent: Number(b.sent ?? 0),
    failed: Number(b.failed ?? 0),
    pending: Number(b.pending ?? 0),
    cancelled: Number(b.cancelled ?? 0),
    expired: Number(b.expired ?? 0),
  })));
}));

/** GET /api/bulk/history/:ref — one batch, recipient by recipient. */
router.get('/history/:ref', route(async (req, res) => {
  const batch = await Bulk.byRef(req.params.ref);
  if (!batch) return res.status(404).json({ error: `No batch "${req.params.ref}"` });
  res.json({ ...batch, recipients: await Bulk.recipients(batch.id) });
}));

/** GET /api/bulk/:session/progress — how the batch is getting on. */
router.get('/:session/progress', route(async (req, res) => {
  const rows = await all(
    `SELECT status, COUNT(*) AS n FROM outbox WHERE session = ? GROUP BY status`,
    req.params.session,
  );
  const next = await get(
    `SELECT send_at FROM outbox WHERE session = ? AND status = 'queued' ORDER BY send_at LIMIT 1`,
    req.params.session,
  );

  res.json({
    counts: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])),
    nextSendAt: next?.send_at ?? null,
    workerId: Outbox.workerId,
  });
}));

/** DELETE /api/bulk/:session/pending — stop a batch that shouldn't have gone out. */
router.delete('/:session/pending', route(async (req, res) => {
  const result = await all(
    `SELECT id FROM outbox WHERE session = ? AND status = 'queued'`,
    req.params.session,
  );
  for (const row of result) await Outbox.cancel(row.id);
  res.json({ cancelled: result.length });
}));

export default router;
