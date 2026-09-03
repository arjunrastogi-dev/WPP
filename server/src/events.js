import { EventEmitter } from 'node:events';

/**
 * A single in-process bus so the session manager doesn't have to know about
 * the queue, the rules engine or webhooks. Everything that reacts to WhatsApp
 * activity subscribes here instead, which keeps the imports acyclic.
 *
 * Events: 'message', 'ack', 'status', 'qr', 'chat', 'outbox'
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

let io = null;
export function attachIo(server) {
  io = server;
}

/**
 * Publish to both the bus (server-side subscribers) and Socket.IO (browsers).
 * Browser clients join a room per session so one tab watching session "sales"
 * never sees traffic from session "support".
 */
export function publish(event, payload) {
  bus.emit(event, payload);
  if (!io) return;
  if (payload?.session) io.to(`session:${payload.session}`).emit(event, payload);
  else io.emit(event, payload);
}
