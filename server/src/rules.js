import { bus } from './events.js';
import { Rules } from './store.js';
import { enqueue } from './queue.js';

/**
 * Auto-reply engine.
 *
 * Subscribes to inbound messages and enqueues a reply when a rule matches.
 * Replies go through the same rate-limited queue as everything else, so a
 * burst of inbound traffic can't turn into a burst of outbound traffic.
 */

function matches(rule, text) {
  const body = String(text ?? '');
  const pattern = rule.pattern ?? '';
  switch (rule.match_type) {
    case 'equals':
      return body.trim().toLowerCase() === pattern.trim().toLowerCase();
    case 'starts':
      return body.trim().toLowerCase().startsWith(pattern.trim().toLowerCase());
    case 'regex':
      try {
        return new RegExp(pattern, 'i').test(body);
      } catch {
        return false; // a user typed an invalid regex in the editor
      }
    case 'contains':
    default:
      return body.toLowerCase().includes(pattern.toLowerCase());
  }
}

/** `{{name}}` and `{{body}}` placeholders in the reply template. */
function render(template, { author, body }) {
  return String(template)
    .replaceAll('{{name}}', author ?? 'there')
    .replaceAll('{{body}}', body ?? '');
}

export function startRules() {
  // The bus is synchronous, so this handler must own its own error handling —
  // an unhandled rejection here would take the process down.
  bus.on('message', ({ session, message }) => {
    if (message.direction !== 'in') return; // never reply to ourselves

    (async () => {
      const rules = await Rules.active(session);
      const rule = rules.find((r) => matches(r, message.body));
      if (!rule) return;

      console.log(`[rules:${session}] "${rule.name}" matched -> replying to ${message.chat_id}`);
      await enqueue({
        session,
        chatId: message.chat_id,
        body: render(rule.reply, { author: message.author, body: message.body }),
      });
    })().catch((err) => console.error('[rules]', err));
  });
  console.log('[rules] auto-reply engine active');
}

export const _internals = { matches, render };
