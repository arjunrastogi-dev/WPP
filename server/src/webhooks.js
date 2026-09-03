import crypto from 'node:crypto';
import { bus } from './events.js';
import { Webhooks } from './store.js';

/**
 * Outbound webhooks: lets other systems (a CRM, an n8n flow, your own backend)
 * subscribe to WhatsApp activity without talking to this server's socket.
 *
 * Each delivery is signed with HMAC-SHA256 over the raw body when the webhook
 * has a secret, so the receiver can verify it really came from us.
 */

const DELIVERABLE = ['message', 'ack', 'status'];
const TIMEOUT_MS = 8000;

async function deliver(hook, event, payload) {
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), data: payload });
  const headers = { 'Content-Type': 'application/json', 'X-Wpp-Event': event };

  if (hook.secret) {
    headers['X-Wpp-Signature'] = `sha256=${crypto
      .createHmac('sha256', hook.secret)
      .update(body)
      .digest('hex')}`;
  }

  // Never let a slow or dead endpoint stall the process.
  const abort = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(hook.url, { method: 'POST', headers, body, signal: abort });
    await Webhooks.recordAttempt(hook.id, res.status);
    if (!res.ok) console.warn(`[webhook] ${hook.url} -> HTTP ${res.status}`);
  } catch (err) {
    await Webhooks.recordAttempt(hook.id, err.name === 'TimeoutError' ? 'timeout' : err.message);
    console.warn(`[webhook] ${hook.url} failed: ${err.message}`);
  }
}

export function startWebhooks() {
  for (const event of DELIVERABLE) {
    bus.on(event, (payload) => {
      // Fire and forget — webhook latency must not slow message handling.
      (async () => {
        const hooks = await Webhooks.enabled();
        for (const hook of hooks.filter((h) => h.events.includes(event))) {
          deliver(hook, event, payload);
        }
      })().catch((err) => console.error('[webhooks]', err));
    });
  }
  console.log(`[webhooks] dispatching events: ${DELIVERABLE.join(', ')}`);
}
