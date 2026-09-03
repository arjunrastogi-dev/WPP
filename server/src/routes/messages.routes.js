import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';

import { route } from '../http.js';
import { config } from '../config.js';
import { Messages } from '../store.js';
import { enqueue } from '../queue.js';
import { toChatId, checkNumber, isConnected, backfillMedia } from '../whatsapp.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: config.mediaDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 32 * 1024 * 1024 }, // WhatsApp's own ceiling is ~64MB
});

/**
 * POST /api/messages/:session/send
 *
 * Accepts JSON or multipart (with a `file` field). Never sends directly — the
 * message is queued, so pacing and retries are handled in one place.
 */
router.post('/:session/send', upload.single('file'), route(async (req, res) => {
  const { session } = req.params;
  const { to, message, sendAt } = req.body ?? {};

  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!message && !req.file) return res.status(400).json({ error: 'message or file is required' });
  if (!isConnected(session)) return res.status(409).json({ error: `Session "${session}" is not connected` });

  const chatId = toChatId(to);

  // Only validate real phone numbers — a group/LID id can't be checked this way.
  let target = chatId;
  if (chatId.endsWith('@c.us')) {
    const check = await checkNumber(session, chatId);
    if (!check.ok) {
      return res.status(400).json({
        error: `${chatId} is not on WhatsApp. Did you include the country code? `
          + '(e.g. India 91 + 10 digits = 918860924275)',
      });
    }
    target = check.id;
  }

  const when = sendAt ? Number(sendAt) : Date.now();
  if (Number.isNaN(when)) return res.status(400).json({ error: 'sendAt must be an epoch timestamp in ms' });

  const job = await enqueue({
    session,
    chatId: target,
    kind: req.file ? 'media' : 'text',
    body: message ?? '',
    mediaPath: req.file?.filename ?? null,
    mediaName: req.file?.originalname ?? null,
    sendAt: when,
    userId: req.user?.id,
  });

  res.status(202).json({ ok: true, queued: job, scheduled: when > Date.now() });
}));

/**
 * POST /api/messages/:session/media/backfill
 *
 * Retry the attachment download for stored messages that have none. Useful
 * after a transient failure, or after fixing media handling itself.
 */
router.post('/:session/media/backfill', route(async (req, res) => {
  const { session } = req.params;
  if (!isConnected(session)) {
    return res.status(409).json({ error: `Session "${session}" is not connected` });
  }
  const limit = Math.min(Number(req.body?.limit ?? 25), 100);
  res.json(await backfillMedia(session, limit));
}));

router.get('/:session/search', route(async (req, res) => {
  const term = String(req.query.q ?? '').trim();
  if (!term) return res.json([]);
  res.json(await Messages.search(req.params.session, term));
}));

export default router;
