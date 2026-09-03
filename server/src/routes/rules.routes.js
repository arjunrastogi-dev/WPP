import { Router } from 'express';
import { route } from '../http.js';
import { Rules } from '../store.js';

const router = Router();

const MATCH_TYPES = ['contains', 'equals', 'starts', 'regex'];

router.get('/', route(async (req, res) => res.json(await Rules.list())));

router.post('/', route(async (req, res) => {
  const { session, name, matchType = 'contains', pattern, reply } = req.body ?? {};
  if (!name || !pattern || !reply) {
    return res.status(400).json({ error: 'name, pattern and reply are required' });
  }
  if (!MATCH_TYPES.includes(matchType)) {
    return res.status(400).json({ error: `matchType must be one of: ${MATCH_TYPES.join(', ')}` });
  }
  if (matchType === 'regex') {
    // Reject a bad pattern here rather than silently never matching later.
    try { new RegExp(pattern); }
    catch (err) { return res.status(400).json({ error: `Invalid regex: ${err.message}` }); }
  }
  res.status(201).json(await Rules.create({ session: session || null, name, matchType, pattern, reply }));
}));

router.patch('/:id', route(async (req, res) => {
  await Rules.toggle(Number(req.params.id), Boolean(req.body?.enabled));
  res.json({ ok: true });
}));

router.delete('/:id', route(async (req, res) => {
  await Rules.remove(Number(req.params.id));
  res.json({ ok: true });
}));

export default router;
