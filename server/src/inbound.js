import { bus } from './events.js';
import { applyBot } from './bots.js';
import { applyRules } from './rules.js';

/**
 * Who answers an inbound message.
 *
 * Bots and auto-reply rules both want to respond, and if each subscribed to
 * the bus independently they would both fire — one question, two replies. So
 * there is exactly one subscriber, and it tries them in order.
 *
 * Bots go first because a bot may be mid-conversation: once someone is three
 * questions into a menu, a stray keyword matching an auto-reply rule must not
 * derail them.
 */
export function startInbound() {
  bus.on('message', ({ session, message }) => {
    if (message.direction !== 'in') return; // never answer ourselves

    // The bus is synchronous, so this handler owns its error handling — an
    // unhandled rejection here would take the process down.
    (async () => {
      if (await applyBot({ session, message })) return;
      await applyRules({ session, message });
    })().catch((err) => console.error('[inbound]', err));
  });

  console.log('[inbound] bots and auto-replies active');
}
