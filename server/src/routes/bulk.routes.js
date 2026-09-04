import { Router } from 'express';
import { route } from '../http.js';
import { config } from '../config.js';
import { all, get } from '../db.js';
import { Sessions, Outbox, Bulk, Bots } from '../store.js';
import { renderFor, renderAll, renderBotStart, queueBatch, SPREAD_MS } from '../dispatch.js';
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

/**
 * A campaign can open with one of a bot's own steps instead of a flat message.
 *
 * Resolved here so preview and send agree on what "bot 3, step ask_role" means,
 * and so a step deleted between the two is caught rather than sent.
 */
async function resolveBotStart({ bot: botId, step }, req) {
  if (!botId) return null;

  const bot = await Bots.get(Number(botId));
  if (!bot) { const e = new Error(`No bot ${botId}`); e.status = 404; throw e; }
  if (bot.owner_id && bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    const e = new Error('That bot belongs to someone else'); e.status = 403; throw e;
  }

  const node = await Bots.node(bot.id, String(step || bot.entry_key));
  if (!node) {
    const e = new Error(`That bot has no step called "${step || bot.entry_key}"`);
    e.status = 404; throw e;
  }

  /*
   * A campaign has to leave the conversation somewhere it can be answered.
   * Opening with an ending or a hand-over sends a message and then parks a
   * conversation nobody is able to reply to.
   */
  if (!['menu', 'prompt'].includes(node.kind)) {
    const e = new Error(
      `A campaign has to open with a menu or a question, and "${node.node_key}" is a ${node.kind} step.`,
    );
    e.status = 400; throw e;
  }

  return { bot, node };
}

/** POST /api/bulk/preview — render every row without sending, to catch mistakes first. */
router.post('/preview', route(async (req, res) => {
  const { template, message, bot, step, recipients } = req.body ?? {};
  if ((!template && !message && !bot) || !Array.isArray(recipients)) {
    return res.status(400).json({
      error: 'recipients[] plus one of template, message or bot are required',
    });
  }

  let botStart = null;
  if (bot) {
    try {
      botStart = await resolveBotStart({ bot, step }, req);
    } catch (err) {
      return res.status(err.status ?? 400).json({ error: err.message });
    }
  }

  const capped = recipients.slice(0, config.bulk.maxRecipients);
  const rows = [];

  if (botStart) {
    const { rendered, problems } = await renderBotStart({ node: botStart.node, recipients: capped });
    rendered.forEach((r, index) => rows.push({
      index, to: r.to, ok: true, preview: r.text, tappable: Boolean(r.list),
    }));
    problems.forEach((pr) => rows.push({ index: pr.index, to: pr.to, ok: false, error: pr.error }));
  } else {
    for (const [index, r] of capped.entries()) {
      try {
        const text = await renderFor({ template, message, variables: r.variables });
        rows.push({ index, to: toChatId(r.to), ok: true, preview: text });
      } catch (err) {
        rows.push({ index, to: r.to, ok: false, error: err.message, missing: err.missing });
      }
    }
  }

  const bad = rows.filter((r) => !r.ok).length;
  res.json({
    total: rows.length,
    ready: rows.length - bad,
    problems: bad,
    // Roughly how long the batch will take, so nobody expects it to be instant.
    estimatedMinutes: Math.ceil((rows.length * SPREAD_MS) / 60000),
    // What happens after they answer, so nobody sends a campaign expecting a
    // conversation and gets silence.
    conversation: botStart
      ? `Replies are handled by "${botStart.bot.name}", starting at "${botStart.node.node_key}".`
      : null,
    rows,
  });
}));

/** POST /api/bulk/send — queue the batch. */
router.post('/send', route(async (req, res) => {
  const { session, template, message, bot, step, recipients, startAt } = req.body ?? {};

  if (!session || (!template && !message && !bot)
      || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({
      error: 'session, a non-empty recipients[], and one of template, message or bot are required',
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

  let botStart = null;
  if (bot) {
    try {
      botStart = await resolveBotStart({ bot, step }, req);
    } catch (err) {
      return res.status(err.status ?? 400).json({ error: err.message });
    }
  }

  const { rendered, problems } = botStart
    ? await renderBotStart({ node: botStart.node, recipients })
    : await renderAll({ template, message, recipients });

  if (problems.length) {
    return res.status(400).json({
      error: `${problems.length} of ${recipients.length} rows could not be rendered. Nothing was sent.`,
      problems: problems.slice(0, 20),
    });
  }

  const batch = await queueBatch({
    session, template, message, rendered, userId: req.user?.id, startAt, botStart,
  });

  res.status(202).json({
    ok: true,
    batchId: batch.batchRef,
    queued: batch.jobs.length,
    firstAt: batch.firstAt,
    lastAt: batch.lastAt,
    estimatedMinutes: batch.estimatedMinutes,
    source: botStart
      ? `bot:${botStart.bot.name} at ${botStart.node.node_key}`
      : (template ? `template:${template}` : 'custom message'),
    // Every recipient now has a conversation waiting, so a tap or a typed
    // reply is read as an answer rather than as a new request.
    conversations: botStart ? rendered.length : 0,
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
