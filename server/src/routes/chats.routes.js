import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { route } from '../http.js';
import { Chats, Messages } from '../store.js';
import { publish } from '../events.js';
import { config } from '../config.js';

const router = Router();

/** GET /api/chats/:session — the inbox sidebar. */
router.get('/:session', route(async (req, res) => res.json(await Chats.list(req.params.session))));

/** GET /api/chats/:session/:chatId/messages — one conversation, paged. */
router.get('/:session/:chatId/messages', route(async (req, res) => {
  const { session, chatId } = req.params;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const before = req.query.before ? Number(req.query.before) : null;
  res.json(await Messages.list(session, chatId, { limit, before }));
}));

router.post('/:session/:chatId/read', route(async (req, res) => {
  const { session, chatId } = req.params;
  await Chats.markRead(session, chatId);
  const chat = await Chats.get(session, chatId);
  publish('chat', { session, chat });
  res.json(chat);
}));

/** Assign a conversation to an agent (or pass null to unassign). */
router.post('/:session/:chatId/assign', route(async (req, res) => {
  const { session, chatId } = req.params;
  const userId = req.body?.userId ?? null;
  await Chats.assign(session, chatId, userId);
  const chat = await Chats.get(session, chatId);
  publish('chat', { session, chat });
  res.json(chat);
}));

router.post('/:session/:chatId/tags', route(async (req, res) => {
  const { session, chatId } = req.params;
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String).slice(0, 20) : [];
  await Chats.setTags(session, chatId, tags);
  const chat = await Chats.get(session, chatId);
  publish('chat', { session, chat });
  res.json(chat);
}));

/**
 * DELETE /api/chats/:session/:chatId
 *
 * Removes the conversation from this app's database and deletes its stored
 * attachments. It does NOT delete the chat on WhatsApp — that would remove it
 * from the linked phone too, which is irreversible.
 */
router.delete('/:session/:chatId', route(async (req, res) => {
  const { session, chatId } = req.params;
  if (!(await Chats.get(session, chatId))) return res.status(404).json({ error: 'Chat not found' });

  const orphaned = await Chats.remove(session, chatId);
  let filesRemoved = 0;
  for (const file of orphaned) {
    try {
      fs.unlinkSync(path.join(config.mediaDir, file));
      filesRemoved += 1;
    } catch {
      // Already gone, or never written — nothing to clean up.
    }
  }

  publish('chat:deleted', { session, chatId });
  res.json({ ok: true, chatId, filesRemoved });
}));

export default router;
