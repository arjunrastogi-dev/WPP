import { Router } from 'express';
import { route } from '../http.js';
import { requireAdmin } from '../auth.js';
import { Webhooks } from '../store.js';

const router = Router();

router.get('/', route(async (req, res) => res.json(await Webhooks.list())));

router.post('/', requireAdmin, route(async (req, res) => {
  const { url, events, secret } = req.body ?? {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); }
  catch { return res.status(400).json({ error: 'url must be a valid absolute URL' }); }
  res.status(201).json(await Webhooks.create({ url, events, secret }));
}));

router.patch('/:id', requireAdmin, route(async (req, res) => {
  await Webhooks.toggle(Number(req.params.id), Boolean(req.body?.enabled));
  res.json({ ok: true });
}));

router.delete('/:id', requireAdmin, route(async (req, res) => {
  await Webhooks.remove(Number(req.params.id));
  res.json({ ok: true });
}));

export default router;
