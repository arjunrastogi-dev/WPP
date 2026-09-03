import { Router } from 'express';
import { route } from '../http.js';
import { requireAdmin } from '../auth.js';
import { Sessions, Messages } from '../store.js';
import { all } from '../db.js';
import { listSessions, sessionState, startSession, stopSession, closeAllBrowsers, mergeLidChats } from '../whatsapp.js';

const router = Router();

router.get('/', route(async (req, res) => {
  const list = await listSessions({ userId: req.user.id, isAdmin: req.user.role === 'admin' });

  // A disconnected session quietly banks messages. Surfacing the backlog is
  // how someone notices before a patient does.
  const backlog = await all(
    `SELECT session, COUNT(*) AS pending FROM outbox
      WHERE status IN ('queued','sending') GROUP BY session`,
  );
  const pendingBy = Object.fromEntries(backlog.map((r) => [r.session, Number(r.pending)]));

  res.json(list.map((s) => ({ ...s, pending: pendingBy[s.name] ?? 0 })));
}));

/** Anyone signed in can create a session; it belongs to them. */
router.post('/', route(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!/^[a-z0-9_-]{2,32}$/i.test(name)) {
    return res.status(400).json({ error: 'Name must be 2-32 chars, letters/numbers/dash/underscore only' });
  }
  await Sessions.upsert(name, req.user.id);
  res.status(201).json(sessionState(name));
}));

router.get('/:name', (req, res) => res.json(sessionState(req.params.name)));

router.get('/:name/stats', route(async (req, res) => res.json(await Messages.stats(req.params.name))));

/**
 * POST /api/sessions/close-all
 *
 * Shuts every browser down in one go — the "I'm done for the day" button, and
 * the way out when a Chromium has been left behind by a crash.
 */
router.post('/close-all', route(async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can close every session' });
  }
  // Default to true: Boolean(undefined) would send an explicit false and
  // defeat the whole point — the watchdog would reopen what we just closed.
  res.json(await closeAllBrowsers({ clearIntent: req.body?.clearIntent ?? true }));
}));

/** Only the owner (or an admin) may touch a session. */
async function mayUse(req, res) {
  const row = await Sessions.get(req.params.name);
  if (!row) {
    res.status(404).json({ error: `No session named "${req.params.name}"` });
    return false;
  }
  if (row.owner_id && row.owner_id !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ error: `That session belongs to ${row.owner_name}` });
    return false;
  }
  return true;
}

router.post('/:name/start', route(async (req, res) => {
  if (!(await mayUse(req, res))) return;

  // Remember the intent before the browser even opens: this session is meant
  // to be running, so a server restart brings it back.
  await Sessions.upsert(req.params.name, req.user.id);
  await Sessions.setWanted(req.params.name, true);

  // Don't await: create() can block for a minute waiting on a QR scan. The
  // browser learns what happened over Socket.IO instead.
  startSession(req.params.name).catch((err) =>
    console.error(`[wpp:${req.params.name}] start failed:`, err.message));
  res.json({ ok: true, ...sessionState(req.params.name) });
}));

/**
 * Stop a session.
 *
 * `disconnect: true` is the deliberate "I am done with this" — it clears the
 * intent, so the session stays down across restarts. Without it the session is
 * only paused (the browser is closed to free memory) and will come back.
 */
router.post('/:name/stop', route(async (req, res) => {
  if (!(await mayUse(req, res))) return;

  const disconnect = Boolean(req.body?.disconnect ?? req.body?.logout);
  if (disconnect) await Sessions.setWanted(req.params.name, false);

  res.json(await stopSession(req.params.name, { logout: Boolean(req.body?.logout) }));
}));

/**
 * POST /api/sessions/:name/merge-lids
 *
 * The same contact can appear twice — once under their phone number, once
 * under a LID. This folds them together. Without `apply` it only reports.
 */
router.post('/:name/merge-lids', route(async (req, res) => {
  if (!(await mayUse(req, res))) return;
  try {
    res.json(await mergeLidChats(req.params.name, { apply: Boolean(req.body?.apply) }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

router.delete('/:name', route(async (req, res) => {
  if (!(await mayUse(req, res))) return;
  await Sessions.setWanted(req.params.name, false);
  await stopSession(req.params.name, { logout: false });
  await Sessions.remove(req.params.name);
  res.json({ ok: true });
}));

export default router;
