import { Router } from 'express';
import { route } from '../http.js';
import { Templates } from '../store.js';
import { extractVariables, render } from '../templates.js';

const router = Router();

const withVariables = (t) => ({
  ...t,
  enabled: Boolean(t.enabled),
  variables: extractVariables(t.body),
});

router.get('/', route(async (req, res) => {
  const rows = await Templates.list();
  res.json(rows.map(withVariables));
}));

router.get('/:id', route(async (req, res) => {
  const template = await Templates.byId(Number(req.params.id));
  if (!template) return res.status(404).json({ error: 'Template not found' });
  res.json(withVariables(template));
}));

router.post('/', route(async (req, res) => {
  const { templateKey, name, body, description } = req.body ?? {};
  if (!templateKey || !name || !body) {
    return res.status(400).json({ error: 'templateKey, name and body are required' });
  }
  if (!/^[a-z0-9_]{2,64}$/.test(templateKey)) {
    return res.status(400).json({
      error: 'templateKey must be 2-64 chars: lowercase letters, numbers, underscore',
    });
  }
  if (await Templates.byKey(templateKey)) {
    return res.status(409).json({ error: `Template "${templateKey}" already exists` });
  }
  res.status(201).json(withVariables(await Templates.create({ templateKey, name, body, description })));
}));

router.patch('/:id', route(async (req, res) => {
  const updated = await Templates.update(Number(req.params.id), req.body ?? {});
  if (!updated) return res.status(404).json({ error: 'Template not found' });
  res.json(withVariables(updated));
}));

router.delete('/:id', route(async (req, res) => {
  await Templates.remove(Number(req.params.id));
  res.json({ ok: true });
}));

/** Render a template against sample values, without sending anything. */
router.post('/:id/preview', route(async (req, res) => {
  const template = await Templates.byId(Number(req.params.id));
  if (!template) return res.status(404).json({ error: 'Template not found' });
  const { text, missing } = render(template.body, req.body?.variables ?? {});
  res.json({ text, missing });
}));

export default router;
