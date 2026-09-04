import { Router } from 'express';
import { route } from '../http.js';
import { config } from '../config.js';
import { all } from '../db.js';
import { Messages, Chats } from '../store.js';
import { readInbound } from '../cloud.js';
import { publish } from '../events.js';

/**
 * Meta's webhook.
 *
 * The Cloud API pushes inbound messages here instead of a browser receiving
 * them, so this is the counterpart to the web client's `onMessage`. Everything
 * downstream is shared: a message arriving here is published on the same bus,
 * so bots and auto-replies handle it without knowing which transport it came
 * from.
 *
 * Mounted before the JWT guard — Meta cannot log in. It is authenticated by
 * the verify token on registration and, for each delivery, by the fact that
 * the phone number id must match a session we own.
 */
const router = Router();

/**
 * GET — Meta's one-off subscription handshake.
 *
 * It sends a challenge and expects it echoed back verbatim as plain text; a
 * JSON reply fails the check with a message that does not say why.
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.cloud.verifyToken) {
    console.log('[cloud] webhook verified by Meta');
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }

  console.warn('[cloud] webhook verification refused — the verify token did not match');
  return res.sendStatus(403);
});

/**
 * POST — one or more inbound events.
 *
 * Answered 200 immediately and processed afterwards. Meta retries anything it
 * does not get a prompt 200 for, and a slow bot turn would otherwise be
 * delivered again and answered twice.
 */
router.post('/webhook', route(async (req, res) => {
  res.sendStatus(200);

  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneId = value.metadata?.phone_number_id;
      if (!phoneId) continue;

      // Which of our sessions owns this number.
      const [row] = await all(
        "SELECT * FROM sessions WHERE provider = 'cloud' AND cloud_phone_id = ?",
        phoneId,
      );
      if (!row) {
        console.warn(`[cloud] a message arrived for phone id ${phoneId}, which no session claims`);
        continue;
      }

      for (const raw of value.messages ?? []) {
        const inbound = readInbound(raw);
        if (!inbound) continue;

        const chatId = `${inbound.from}@c.us`;
        const author = value.contacts?.[0]?.profile?.name ?? inbound.from;
        const timestamp = inbound.timestamp || Date.now();

        const saved = await Messages.insert({
          waId: inbound.waId,
          session: row.name,
          chatId,
          direction: 'in',
          author,
          body: inbound.body ?? '',
          type: inbound.type === 'interactive' ? 'buttons_response' : (inbound.type ?? 'chat'),
          mediaPath: null,
          mediaName: null,
          mimetype: null,
          ack: 0,
          timestamp,
        });

        // The id of whatever they tapped travels beside the text, exactly as it
        // does on the web transport, so the bot matches the option outright.
        if (inbound.selectedId) saved.selectedId = inbound.selectedId;

        const chat = await Chats.touch({
          session: row.name,
          id: chatId,
          name: author,
          isGroup: false,
          preview: inbound.body || `[${inbound.type}]`,
          at: timestamp,
          incrementUnread: true,
        });

        console.log(`[cloud] ${row.name} <- ${chatId}${inbound.selectedId ? ` tapped ${inbound.selectedId}` : ''}`);
        publish('message', { session: row.name, message: saved, chat });
      }

      // Delivery receipts, which is how the tick marks stay accurate.
      for (const status of value.statuses ?? []) {
        const ack = { sent: 1, delivered: 2, read: 3, failed: -1 }[status.status] ?? 0;
        const updated = await Messages.setAck(row.name, status.id, ack);
        if (updated) publish('ack', { session: row.name, message: updated });
      }
    }
  }
}));

export default router;
