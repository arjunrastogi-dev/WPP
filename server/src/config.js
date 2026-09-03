import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',

  // MySQL / MariaDB — XAMPP's defaults are root with no password.
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'wppinbox',
    connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10),
  },
  mediaDir: process.env.MEDIA_DIR ?? path.join(ROOT, 'media'),
  tokensDir: process.env.TOKENS_DIR ?? path.join(ROOT, 'tokens'),

  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me',

  // Shared key for server-to-server callers such as the clinic CMS. They can't
  // log in with a username, so template sends are authorised with this instead.
  apiKey: process.env.API_KEY ?? 'cms-dev-key-change-me',

  jwtExpiry: process.env.JWT_EXPIRY ?? '12h',

  // Seed admin, created on first boot only.
  adminUser: process.env.ADMIN_USER ?? 'admin',
  adminPass: process.env.ADMIN_PASS ?? 'admin123',

  /*
   * Each session runs its own Chromium at roughly 400MB. Without a ceiling it
   * is easy to start six and put the machine into swap, which looks like
   * "WhatsApp is broken" rather than "we ran out of memory".
   */
  maxSessions: Number(process.env.MAX_SESSIONS ?? 3),

  // How often to check whether a session that should be running actually is.
  reconnectEveryMs: Number(process.env.RECONNECT_EVERY_MS ?? 30000),

  /*
   * Bulk sending is the fastest route to a banned number, so the ceiling is
   * deliberately low. Raise it knowingly, not by accident.
   */
  bulk: {
    maxRecipients: Number(process.env.BULK_MAX_RECIPIENTS ?? 200),
  },

  /*
   * Recurring sends.
   *
   * `graceMinutes` is the important one. If the server was down when a 9am
   * schedule was due, firing it at noon sends "good morning" at lunchtime, so
   * anything later than this is skipped and written to the run log rather than
   * delivered at the wrong moment. Same reasoning as the queue's TTL.
   */
  schedule: {
    tickMs: Number(process.env.SCHEDULE_TICK_MS ?? 30000),
    graceMinutes: Number(process.env.SCHEDULE_GRACE_MINUTES ?? 30),
    timezone: process.env.SCHEDULE_TIMEZONE ?? 'Asia/Kolkata',
  },

  headless: process.env.HEADLESS !== 'false',
  chromePath: process.env.CHROME_PATH || undefined,

  // Outbound pacing. WhatsApp bans accounts that fire messages in a tight loop,
  // so every send goes through a queue with a randomised gap between them.
  queue: {
    minDelayMs: Number(process.env.QUEUE_MIN_DELAY_MS ?? 3000),
    maxDelayMs: Number(process.env.QUEUE_MAX_DELAY_MS ?? 7000),
    maxAttempts: Number(process.env.QUEUE_MAX_ATTEMPTS ?? 3),
    tickMs: Number(process.env.QUEUE_TICK_MS ?? 1000),

    /*
     * How long a message may wait for a disconnected session before it is
     * abandoned. "Your appointment is tomorrow at 3" delivered two days late
     * is worse than not delivered at all.
     */
    ttlHours: Number(process.env.QUEUE_TTL_HOURS ?? 24),
  },
};
