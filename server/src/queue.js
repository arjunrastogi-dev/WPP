import { config } from './config.js';
import { publish } from './events.js';
import { Outbox, Messages, Chats } from './store.js';
import { deliver, isConnected, listSessions } from './whatsapp.js';

/**
 * Outbound queue + scheduler.
 *
 * Nothing in the app calls WhatsApp's send methods directly. Everything is
 * enqueued here and drained at a deliberately human pace, because firing
 * messages in a tight loop is the fastest way to get a number banned.
 *
 * Scheduling falls out of the same design for free: a row whose `send_at` is
 * in the future simply isn't claimed until that time arrives.
 */

/** Per-session timestamp before which we refuse to send again. */
const cooldownUntil = new Map();
let timer = null;

const jitter = () => {
  const { minDelayMs, maxDelayMs } = config.queue;
  return minDelayMs + Math.floor(Math.random() * Math.max(1, maxDelayMs - minDelayMs));
};

async function drainSession(name) {
  if (!isConnected(name)) return;
  if ((cooldownUntil.get(name) ?? 0) > Date.now()) return;

  const job = await Outbox.claimNext(name);
  if (!job) return;

  // Reserve the slot before awaiting, so a slow send can't let a second job
  // slip through on the next tick.
  cooldownUntil.set(name, Date.now() + jitter());

  try {
    const result = await deliver({
      session: name,
      chatId: job.chat_id,
      kind: job.kind,
      body: job.body,
      mediaPath: job.media_path,
      mediaName: job.media_name,
      payload: job.payload,
    });

    await Outbox.markSent(job.id);

    const waId = result?.id?._serialized ?? result?.id ?? null;
    const timestamp = Date.now();
    const saved = await Messages.insert({
      waId, session: name, chatId: job.chat_id, direction: 'out', author: 'You',
      body: job.body ?? '', type: job.kind === 'media' ? 'media' : 'chat',
      mediaPath: job.media_path, mediaName: job.media_name, ack: 1, timestamp,
    });

    const chat = await Chats.touch({
      session: name, id: job.chat_id,
      preview: job.body || '[media]', at: timestamp, incrementUnread: false,
    });

    publish('message', { session: name, message: saved, chat });
    publish('outbox', { session: name, job: { ...job, status: 'sent' } });
  } catch (err) {
    const status = await Outbox.markFailed(job.id, err.message, config.queue.maxAttempts);
    console.warn(`[queue:${name}] job ${job.id} ${status}: ${err.message}`);
    publish('outbox', { session: name, job: { ...job, status, last_error: err.message } });
  }
}

let sinceSweep = 0;

async function tick() {
  // Every ~60s, hand back any job that has been 'sending' far too long.
  sinceSweep += config.queue.tickMs;
  if (sinceSweep >= 60000) {
    sinceSweep = 0;
    await Outbox.requeueStale().catch((err) => console.error('[queue] sweep', err));

    // Abandon anything that waited too long for a session that never returned.
    const expired = await Outbox.expireStale().catch(() => null);
    if (expired?.affectedRows) {
      console.warn(`[queue] expired ${expired.affectedRows} message(s) — session never reconnected`);
    }
  }

  for (const s of await listSessions()) {
    await drainSession(s.name).catch((err) => console.error('[queue]', err));
  }
}

export async function startQueue() {
  // A job stuck in 'sending' means the process died mid-flight — retry it.
  await Outbox.requeueStuck();
  timer = setInterval(() => { tick(); }, config.queue.tickMs);
  const { minDelayMs, maxDelayMs } = config.queue;
  console.log(`[queue] draining every ${config.queue.tickMs}ms, ${minDelayMs}-${maxDelayMs}ms between sends`);
}

export function stopQueue() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** The one public way to send anything. */
export async function enqueue(opts) {
  const job = await Outbox.enqueue(opts);
  publish('outbox', { session: opts.session, job });
  return job;
}
