import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketServer } from 'socket.io';

import { config } from './config.js';
import { initDb, closeDb } from './db.js';
import { attachIo } from './events.js';
import { ensureSeedUser, socketAuth } from './auth.js';
import { listSessions, sessionState, stopAll, restoreSessions, startReconnectWatchdog, stopReconnectWatchdog } from './whatsapp.js';
import { startQueue, stopQueue } from './queue.js';
import { startRules } from './rules.js';
import { startScheduler, stopScheduler } from './schedule.js';
import { startWebhooks } from './webhooks.js';
import { ensureSeedTemplates } from './templates.js';
import api from './routes/index.js';

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());

// Received and uploaded media. Served statically so <img src> just works.
app.use('/media', express.static(config.mediaDir));
app.use('/api', api);

const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: config.clientOrigin } });

// Socket.IO carries the same JWT as the REST API — an unauthenticated socket
// would otherwise be a way around the auth middleware.
io.use(socketAuth);
attachIo(io);

io.on('connection', (socket) => {
  const who = socket.data.user?.username;
  console.log(`[io] ${who} connected`);

  // Clients subscribe per session, so one open tab doesn't receive another
  // session's message traffic.
  socket.on('subscribe', (name) => {
    for (const room of socket.rooms) {
      if (room.startsWith('session:')) socket.leave(room);
    }
    if (!name) return;
    socket.join(`session:${name}`);
    socket.emit('status', { ...sessionState(name), detail: 'snapshot' });
  });

  listSessions()
    .then((list) => socket.emit('sessions', list))
    .catch((err) => console.error('[io] sessions', err));
});

// Nothing may serve traffic before the schema exists and the pool is live.
await initDb();
await ensureSeedUser();
await ensureSeedTemplates();
await startQueue();
await startScheduler();
startRules();
startWebhooks();

server.listen(config.port, () => {
  console.log(`\n  API     http://localhost:${config.port}/api`);
  console.log(`  Health  http://localhost:${config.port}/api/health`);
  console.log(`  CORS    ${config.clientOrigin}`);
  console.log(`  Login   ${config.adminUser} / ${config.adminPass}\n`);
  console.log(`  API key ${config.apiKey}   <- the clinic CMS uses this`);

  // Not awaited: each session launches a browser, and the API should answer
  // while that happens. Progress arrives over Socket.IO as usual.
  restoreSessions()
    .catch((err) => console.error('[wpp] restore', err))
    // Only watch for drops once the intended sessions have had their chance.
    .finally(() => startReconnectWatchdog());
});

// Close every Chromium cleanly, or each restart leaks a browser process.
let shuttingDown = false;

/*
 * Windows sends no SIGINT when a console window is closed, and `taskkill /F`
 * cannot be caught at all — either way Chromium is left running and holding
 * its profile lock. SIGHUP and SIGBREAK cover the cases that *are* catchable;
 * a locked profile from the ones that aren't is cleared on the next start.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[server] shutting down…');
    stopQueue();
    stopScheduler();
    stopReconnectWatchdog();
    await stopAll();
    await closeDb();
    process.exit(0);
  });
}
