import { Router } from 'express';
import { route } from '../http.js';
import { Outbox } from '../store.js';

const router = Router();

/** Queued, scheduled and failed jobs for a session. */
router.get('/:session', route(async (req, res) => res.json(await Outbox.pending(req.params.session))));

router.delete('/:id', route(async (req, res) => {
  await Outbox.cancel(Number(req.params.id));
  res.json({ ok: true });
}));

export default router;
