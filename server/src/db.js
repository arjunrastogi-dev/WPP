import mysql from 'mysql2/promise';
import { config } from './config.js';

/**
 * Persistence layer on MySQL / MariaDB (XAMPP by default).
 *
 * Everything here is asynchronous — unlike the embedded SQLite this replaced —
 * because the connection is over a socket. A pool is used so concurrent
 * requests, the queue worker and socket handlers don't serialise behind a
 * single connection.
 */

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  charset: 'utf8mb4_unicode_ci',
  // Return DECIMAL/BIGINT as JS numbers where safe; our ids fit comfortably.
  supportBigNumbers: true,
  bigNumberStrings: false,
});

/* ----------------------------- query helpers ----------------------------- */

/** node-mysql2 rejects `undefined`; normalise before binding. */
export function bind(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

const params = (args) => args.map(bind);

export async function all(sql, ...args) {
  const [rows] = await pool.query(sql, params(args));
  return rows;
}

export async function get(sql, ...args) {
  const [rows] = await pool.query(sql, params(args));
  return rows[0] ?? null;
}

/** Returns { insertId, affectedRows }. */
export async function run(sql, ...args) {
  const [result] = await pool.query(sql, params(args));
  return result;
}

export const now = () => Date.now();

/* -------------------------------- schema --------------------------------- */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(16) NOT NULL DEFAULT 'agent',
    created_at    BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sessions (
    name       VARCHAR(64) PRIMARY KEY,
    status     VARCHAR(32) NOT NULL DEFAULT 'DISCONNECTED',
    me_id      VARCHAR(128),
    me_name    VARCHAR(255),
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS chats (
    session              VARCHAR(64) NOT NULL,
    id                   VARCHAR(128) NOT NULL,
    name                 VARCHAR(255),
    is_group             TINYINT NOT NULL DEFAULT 0,
    unread               INT NOT NULL DEFAULT 0,
    last_message_at      BIGINT,
    last_message_preview TEXT,
    assigned_to          INT NULL,
    tags                 TEXT,
    PRIMARY KEY (session, id),
    KEY idx_chats_recent (session, last_message_at),
    CONSTRAINT fk_chats_user FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // A plain UNIQUE(session, wa_id) reproduces SQLite's partial index here:
  // MySQL permits many NULLs in a unique index, so rows without a WhatsApp id
  // are unconstrained while real ids stay de-duplicated.
  `CREATE TABLE IF NOT EXISTS messages (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    wa_id      VARCHAR(191),
    session    VARCHAR(64) NOT NULL,
    chat_id    VARCHAR(128) NOT NULL,
    direction  VARCHAR(8) NOT NULL,
    author     VARCHAR(255),
    body       MEDIUMTEXT,
    type       VARCHAR(32) NOT NULL DEFAULT 'chat',
    media_path VARCHAR(255),
    media_name VARCHAR(255),
    mimetype   VARCHAR(128),
    ack        INT NOT NULL DEFAULT 0,
    timestamp  BIGINT NOT NULL,
    UNIQUE KEY uq_messages_waid (session, wa_id),
    KEY idx_messages_chat (session, chat_id, timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // The outbound queue and scheduled messages share this table: a row whose
  // send_at is in the future simply isn't claimable yet. `locked_by` lets
  // several worker processes claim jobs without ever taking the same one.
  `CREATE TABLE IF NOT EXISTS outbox (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    session    VARCHAR(64) NOT NULL,
    chat_id    VARCHAR(128) NOT NULL,
    kind       VARCHAR(16) NOT NULL DEFAULT 'text',
    body       MEDIUMTEXT,
    media_path VARCHAR(255),
    media_name VARCHAR(255),
    status     VARCHAR(16) NOT NULL DEFAULT 'queued',
    attempts   INT NOT NULL DEFAULT 0,
    last_error VARCHAR(500),
    send_at    BIGINT NOT NULL,
    locked_by  VARCHAR(64),
    created_by INT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_outbox_due (status, send_at),
    KEY idx_outbox_lock (locked_by),
    CONSTRAINT fk_outbox_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Message templates. `template_key` is what an outside system (the clinic CMS)
  // names when it asks for a message — never the numeric id, so templates can be
  // renamed or recreated without breaking the caller.
  /*
   * WhatsApp addresses the same person two ways: a phone-number JID
   * (`9188…@c.us`) and a privacy-preserving LID (`1205…@lid`). Outbound goes to
   * the number, replies arrive from the LID — so one contact becomes two
   * conversations. This caches the mapping so a chat resolves to one canonical
   * id without asking WhatsApp on every message.
   */
  `CREATE TABLE IF NOT EXISTS contact_identity (
    lid          VARCHAR(128) PRIMARY KEY,
    phone_jid    VARCHAR(128),
    display_name VARCHAR(255),
    checked_at   BIGINT NOT NULL,
    KEY idx_identity_phone (phone_jid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS templates (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    template_key VARCHAR(64) NOT NULL UNIQUE,
    name         VARCHAR(255) NOT NULL,
    body         TEXT NOT NULL,
    description  VARCHAR(500),
    enabled      TINYINT NOT NULL DEFAULT 1,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /*
   * Recurring sends — the "alarm clock".
   *
   * `next_run_at` is stored rather than computed on read, so the ticker can
   * find due schedules with an index instead of evaluating every rule every
   * few seconds, and so two servers can race for the same firing safely.
   */
  `CREATE TABLE IF NOT EXISTS schedule (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(120) NOT NULL,
    session      VARCHAR(64) NOT NULL,
    owner_id     INT NULL,
    kind         VARCHAR(16) NOT NULL,
    time_of_day  CHAR(5) NOT NULL DEFAULT '09:00',
    slots        TEXT,
    day_of_month TINYINT,
    run_at       BIGINT,
    timezone     VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    source       VARCHAR(16) NOT NULL,
    template_key VARCHAR(64),
    body         MEDIUMTEXT,
    recipients   MEDIUMTEXT NOT NULL,
    enabled      TINYINT NOT NULL DEFAULT 1,
    next_run_at  BIGINT,
    last_run_at  BIGINT,
    run_count    INT NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    KEY idx_schedule_due (enabled, next_run_at),
    CONSTRAINT fk_schedule_user FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /*
   * Every firing, including the ones that were deliberately not sent.
   *
   * A schedule that silently skipped last Tuesday looks identical to one that
   * never existed unless the skip is written down.
   */
  `CREATE TABLE IF NOT EXISTS schedule_run (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    schedule_id INT NOT NULL,
    due_at      BIGINT NOT NULL,
    fired_at    BIGINT NOT NULL,
    status      VARCHAR(16) NOT NULL,
    queued      INT NOT NULL DEFAULT 0,
    batch_ref   VARCHAR(64),
    detail      TEXT,
    KEY idx_run_schedule (schedule_id, fired_at),
    CONSTRAINT fk_run_schedule FOREIGN KEY (schedule_id)
      REFERENCES schedule(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /*
   * A record of every bulk batch: what was sent, to how many, by whom.
   *
   * The outbox holds individual jobs and is pruned over time; this is the
   * lasting answer to "who sent 200 messages last Tuesday, and what did they
   * say" — which is exactly the question asked after a number gets banned.
   */
  `CREATE TABLE IF NOT EXISTS bulk_batch (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    batch_ref    VARCHAR(64) NOT NULL UNIQUE,
    session      VARCHAR(64) NOT NULL,
    source       VARCHAR(24) NOT NULL,
    template_key VARCHAR(64),
    body         MEDIUMTEXT,
    total        INT NOT NULL DEFAULT 0,
    created_by   INT NULL,
    created_at   BIGINT NOT NULL,
    KEY idx_batch_session (session, created_at),
    CONSTRAINT fk_batch_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  /* One row per recipient, linked to the queue job that carries it. */
  `CREATE TABLE IF NOT EXISTS bulk_recipient (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    batch_id  INT NOT NULL,
    chat_id   VARCHAR(128) NOT NULL,
    outbox_id INT,
    body      MEDIUMTEXT,
    KEY idx_recipient_batch (batch_id),
    KEY idx_recipient_outbox (outbox_id),
    CONSTRAINT fk_recipient_batch FOREIGN KEY (batch_id)
      REFERENCES bulk_batch(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS rules (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    session    VARCHAR(64),
    name       VARCHAR(255) NOT NULL,
    match_type VARCHAR(16) NOT NULL DEFAULT 'contains',
    pattern    VARCHAR(500) NOT NULL,
    reply      TEXT NOT NULL,
    enabled    TINYINT NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS webhooks (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    url             VARCHAR(500) NOT NULL,
    events          VARCHAR(255) NOT NULL DEFAULT '["message"]',
    secret          VARCHAR(255),
    enabled         TINYINT NOT NULL DEFAULT 1,
    last_status     VARCHAR(64),
    last_attempt_at BIGINT,
    created_at      BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/*
 * Repair rows written before media handling was fixed.
 *
 * WhatsApp puts a base64 JPEG thumbnail in a media message's `body`. That used
 * to be stored as the message text, so attachments rendered as a wall of
 * characters. Clear it wherever the body is plainly a base64 blob, then rebuild
 * the affected chat previews. Both statements are idempotent.
 */
const MIGRATIONS = [
  // TEXT with no default meant every new chat started with tags = NULL.
  `ALTER TABLE chats MODIFY COLUMN tags TEXT DEFAULT NULL`,
  `UPDATE chats SET tags = '[]' WHERE tags IS NULL OR tags = ''`,

  /*
   * Purge everything that was stored as a conversation but isn't one: status
   * posts, channels, WhatsApp's own account, and system notices such as
   * encryption-key changes. Chats left with no messages go too.
   */
  `DELETE FROM messages
     WHERE chat_id LIKE '%@broadcast' OR chat_id LIKE '%@newsletter' OR chat_id LIKE '0@%'
        OR type IN ('e2e_notification','notification','notification_template','gp2',
                    'group_notification','broadcast_notification','protocol','ciphertext',
                    'call_log','revoked')`,

  `DELETE FROM chats
     WHERE id LIKE '%@broadcast' OR id LIKE '%@newsletter' OR id LIKE '0@%'
        OR NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT session, chat_id FROM messages) m
                        WHERE m.session = chats.session AND m.chat_id = chats.id)`,

  /*
   * Sessions belong to a user, and remember whether they are *meant* to be
   * running.
   *
   * `auto_start` is the desired state, not the live one. Signing out of the web
   * app must not kill a WhatsApp session — only an explicit Disconnect does.
   * Storing the intent means a server restart brings back exactly the sessions
   * their owners left running.
   */
  `ALTER TABLE sessions
     ADD COLUMN IF NOT EXISTS owner_id INT,
     ADD COLUMN IF NOT EXISTS auto_start TINYINT NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS last_started_at BIGINT,
     ADD COLUMN IF NOT EXISTS disconnected_at BIGINT`,

  // When a job was claimed, as opposed to when it was created. Without this,
  // a job orphaned by a dead worker can't be aged out safely: `created_at`
  // belongs to a scheduled message that may legitimately be days old.
  `ALTER TABLE outbox ADD COLUMN IF NOT EXISTS locked_at BIGINT`,

  // When a held message stops being worth sending.
  `ALTER TABLE outbox ADD COLUMN IF NOT EXISTS expires_at BIGINT`,
];

const REPAIRS = [
  `UPDATE messages
      SET body = ''
    WHERE type IN ('image','video','audio','ptt','sticker','document')
      AND body <> ''
      AND (body LIKE '/9j/%' OR (CHAR_LENGTH(body) > 200 AND body NOT LIKE '% %'))`,

  `UPDATE chats
      SET last_message_preview = ''
    WHERE last_message_preview LIKE '/9j/%'
       OR (CHAR_LENGTH(last_message_preview) > 200 AND last_message_preview NOT LIKE '% %')`,

  `UPDATE chats c
      SET c.last_message_preview = COALESCE((
            SELECT CASE
              WHEN m.body <> ''        THEN m.body
              WHEN m.type = 'image'    THEN 'Photo'
              WHEN m.type = 'video'    THEN 'Video'
              WHEN m.type = 'audio'    THEN 'Audio'
              WHEN m.type = 'ptt'      THEN 'Voice message'
              WHEN m.type = 'sticker'  THEN 'Sticker'
              WHEN m.type = 'document' THEN 'Document'
              ELSE ''
            END
              FROM messages m
             WHERE m.session = c.session AND m.chat_id = c.id
             ORDER BY m.timestamp DESC, m.id DESC
             LIMIT 1
          ), '')
    WHERE c.last_message_preview = '' OR c.last_message_preview IS NULL`,
];

/** Create tables and run repairs. Must be awaited before serving traffic. */
export async function initDb() {
  try {
    for (const statement of SCHEMA) await pool.query(statement);
    for (const statement of MIGRATIONS) await pool.query(statement);
    for (const statement of REPAIRS) await pool.query(statement);
    const [[{ version }]] = await pool.query('SELECT VERSION() AS version');
    console.log(`[db] connected to ${config.db.database} on ${config.db.host}:${config.db.port} (${version})`);
  } catch (err) {
    console.error(
      `[db] cannot reach MySQL at ${config.db.host}:${config.db.port} — `
      + 'is XAMPP running and the database created?',
    );
    throw err;
  }
}

export async function closeDb() {
  await pool.end().catch(() => {});
}
