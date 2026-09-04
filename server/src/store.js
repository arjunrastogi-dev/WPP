import crypto from 'node:crypto';
import { all, get, run, now } from './db.js';

/**
 * All database access, grouped by table. Every method is async — MySQL is
 * spoken over a socket, unlike the embedded SQLite this replaced.
 */

/* ------------------------------- sessions ------------------------------- */

export const Sessions = {
  list: () =>
    all(`SELECT s.*, u.username AS owner_name
           FROM sessions s LEFT JOIN users u ON u.id = s.owner_id
          ORDER BY s.created_at`),

  listForUser: (userId, isAdmin) =>
    all(
      `SELECT s.*, u.username AS owner_name
         FROM sessions s LEFT JOIN users u ON u.id = s.owner_id
        WHERE ? = 1 OR s.owner_id = ? OR s.owner_id IS NULL
        ORDER BY s.created_at`,
      isAdmin ? 1 : 0, userId,
    ),

  get: (name) =>
    get(`SELECT s.*, u.username AS owner_name
           FROM sessions s LEFT JOIN users u ON u.id = s.owner_id
          WHERE s.name = ?`, name),

  async upsert(name, ownerId = null) {
    await run(
      'INSERT IGNORE INTO sessions (name, owner_id, created_at) VALUES (?, ?, ?)',
      name, ownerId, now(),
    );
    // Claim an unowned session for whoever first starts it.
    if (ownerId) {
      await run('UPDATE sessions SET owner_id = ? WHERE name = ? AND owner_id IS NULL', ownerId, name);
    }
    return this.get(name);
  },

  /** Sessions their owners left running — restored when the server restarts. */
  wanted: () => all("SELECT * FROM sessions WHERE auto_start = 1"),

  /** Records intent, not the live status: 1 = should be running. */
  /** Point a session at a transport, with the credentials it needs. */
  setProvider: (name, { provider, cloudPhoneId = null, cloudToken = null, cloudWabaId = null }) =>
    run(
      `UPDATE sessions SET provider = ?, cloud_phone_id = ?, cloud_token = ?, cloud_waba_id = ?
        WHERE name = ?`,
      provider, cloudPhoneId, cloudToken, cloudWabaId, name,
    ),

  setWanted: (name, wanted) =>
    run(
      wanted
        ? 'UPDATE sessions SET auto_start = 1, last_started_at = ? WHERE name = ?'
        : 'UPDATE sessions SET auto_start = 0, disconnected_at = ? WHERE name = ?',
      now(), name,
    ),
  setStatus: (name, status, me) =>
    run(
      'UPDATE sessions SET status = ?, me_id = ?, me_name = ? WHERE name = ?',
      status, me?.id ?? null, me?.pushname ?? null, name,
    ),
  remove: (name) => run('DELETE FROM sessions WHERE name = ?', name),
};

/* --------------------------------- chats -------------------------------- */

export const Chats = {
  async list(session) {
    const rows = await all(
      `SELECT c.*, u.username AS assigned_name
         FROM chats c LEFT JOIN users u ON u.id = c.assigned_to
        WHERE c.session = ?
        ORDER BY COALESCE(c.last_message_at, 0) DESC
        LIMIT 200`,
      session,
    );
    return rows.map(hydrateChat);
  },

  async get(session, id) {
    const row = await get(
      `SELECT c.*, u.username AS assigned_name
         FROM chats c LEFT JOIN users u ON u.id = c.assigned_to
        WHERE c.session = ? AND c.id = ?`,
      session, id,
    );
    return row ? hydrateChat(row) : null;
  },

  /** Called on every inbound/outbound message so the sidebar stays ordered. */
  async touch({ session, id, name, isGroup, preview, at, incrementUnread }) {
    await run(
      `INSERT INTO chats (session, id, name, is_group, unread, last_message_at, last_message_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name                 = COALESCE(VALUES(name), chats.name),
         last_message_at      = VALUES(last_message_at),
         last_message_preview = VALUES(last_message_preview),
         unread               = chats.unread + ?`,
      session, id, name ?? null, isGroup ? 1 : 0, incrementUnread ? 1 : 0,
      at, preview ?? '', incrementUnread ? 1 : 0,
    );
    return this.get(session, id);
  },

  markRead: (session, id) =>
    run('UPDATE chats SET unread = 0 WHERE session = ? AND id = ?', session, id),

  assign: (session, id, userId) =>
    run('UPDATE chats SET assigned_to = ? WHERE session = ? AND id = ?', userId, session, id),

  setTags: (session, id, tags) =>
    run('UPDATE chats SET tags = ? WHERE session = ? AND id = ?', JSON.stringify(tags), session, id),

  /**
   * Delete a conversation from OUR database only — this never touches the chat
   * on WhatsApp itself. Returns the media filenames that are now orphaned so
   * the caller can unlink them from disk.
   */
  async remove(session, id) {
    const rows = await all(
      `SELECT media_path FROM messages
        WHERE session = ? AND chat_id = ? AND media_path IS NOT NULL`,
      session, id,
    );
    // Drop anything still queued for this chat, or the next queue tick would
    // deliver it and immediately recreate the conversation.
    await run(
      "UPDATE outbox SET status = 'cancelled' WHERE session = ? AND chat_id = ? AND status = 'queued'",
      session, id,
    );
    await run('DELETE FROM messages WHERE session = ? AND chat_id = ?', session, id);
    await run('DELETE FROM chats WHERE session = ? AND id = ?', session, id);
    return rows.map((r) => r.media_path);
  },
};

function hydrateChat(row) {
  return { ...row, tags: safeJson(row.tags, []), is_group: Boolean(row.is_group) };
}

/* --------------------------- contact identity --------------------------- */

export const Identity = {
  /** Cached phone JID for a LID, or null if we have never resolved it. */
  async phoneFor(lid) {
    const row = await get('SELECT phone_jid FROM contact_identity WHERE lid = ?', lid);
    return row?.phone_jid ?? null;
  },

  /** Remember a mapping. `phoneJid` may be null — a LID with no known number. */
  remember: (lid, phoneJid, displayName) =>
    run(
      `INSERT INTO contact_identity (lid, phone_jid, display_name, checked_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         phone_jid    = COALESCE(VALUES(phone_jid), contact_identity.phone_jid),
         display_name = COALESCE(VALUES(display_name), contact_identity.display_name),
         checked_at   = VALUES(checked_at)`,
      lid, phoneJid ?? null, displayName ?? null, now(),
    ),

  /** Have we asked about this LID recently? Avoids re-querying every message. */
  isFresh: async (lid, maxAgeMs = 86400000) => {
    const row = await get('SELECT checked_at FROM contact_identity WHERE lid = ?', lid);
    return Boolean(row) && Number(row.checked_at) > now() - maxAgeMs;
  },
};

/* ------------------------------- messages ------------------------------- */

export const Messages = {
  /** Newest-last page of a conversation. `before` is a message id, for paging up. */
  list: (session, chatId, { limit = 50, before = null } = {}) =>
    all(
      `SELECT * FROM (
         SELECT * FROM messages
          WHERE session = ? AND chat_id = ? AND (? IS NULL OR id < ?)
          ORDER BY id DESC LIMIT ?
       ) AS page ORDER BY id ASC`,
      session, chatId, before, before, limit,
    ),

  async insert(msg) {
    // WhatsApp re-delivers messages on reconnect; the unique index on
    // (session, wa_id) makes that a no-op rather than a duplicate row.
    const result = await run(
      `INSERT IGNORE INTO messages
         (wa_id, session, chat_id, direction, author, body, type, media_path, media_name, mimetype, ack, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.waId ?? null, msg.session, msg.chatId, msg.direction, msg.author ?? null,
      msg.body ?? '', msg.type ?? 'chat', msg.mediaPath ?? null, msg.mediaName ?? null,
      msg.mimetype ?? null, msg.ack ?? 0, msg.timestamp ?? now(),
    );
    if (msg.waId) {
      return get('SELECT * FROM messages WHERE session = ? AND wa_id = ?', msg.session, msg.waId);
    }
    return get('SELECT * FROM messages WHERE id = ?', result.insertId);
  },

  byId: (id) => get('SELECT * FROM messages WHERE id = ?', id),

  /** Delivery receipts: -1 error, 0 pending, 1 sent, 2 delivered, 3 read. */
  async setAck(session, waId, ack) {
    await run(
      'UPDATE messages SET ack = ? WHERE session = ? AND wa_id = ? AND ack < ?',
      ack, session, waId, ack,
    );
    return get('SELECT * FROM messages WHERE session = ? AND wa_id = ?', session, waId);
  },

  /** Media messages whose attachment never made it to disk. */
  missingMedia: (session, limit = 25) =>
    all(
      `SELECT * FROM messages
        WHERE session = ? AND direction = 'in' AND media_path IS NULL
          AND (mimetype IS NOT NULL OR type IN ('image','video','audio','ptt','sticker','document'))
        ORDER BY id DESC LIMIT ?`,
      session, limit,
    ),

  async setMedia(id, mediaPath, mediaName) {
    await run(
      'UPDATE messages SET media_path = ?, media_name = COALESCE(?, media_name) WHERE id = ?',
      mediaPath, mediaName ?? null, id,
    );
    return get('SELECT * FROM messages WHERE id = ?', id);
  },

  search: (session, term) =>
    all(
      `SELECT * FROM messages
        WHERE session = ? AND body LIKE ?
        ORDER BY timestamp DESC LIMIT 100`,
      session, `%${term}%`,
    ),

  async stats(session) {
    const row = await get(
      `SELECT COUNT(*) AS total,
              SUM(direction = 'in')  AS inbound,
              SUM(direction = 'out') AS outbound
         FROM messages WHERE session = ?`,
      session,
    );
    const chats = await get('SELECT COUNT(*) AS n FROM chats WHERE session = ?', session);
    return {
      total: Number(row?.total ?? 0),
      inbound: Number(row?.inbound ?? 0),
      outbound: Number(row?.outbound ?? 0),
      chats: Number(chats?.n ?? 0),
    };
  },
};

/* -------------------------- outbox / scheduling ------------------------- */

/** Identifies this process when claiming queue rows. */
const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

export const Outbox = {
  workerId: WORKER_ID,

  async enqueue({
    session, chatId, kind = 'text', body, mediaPath, mediaName,
    sendAt, userId, expiresAt, payload,
  }) {
    const result = await run(
      `INSERT INTO outbox
         (session, chat_id, kind, body, media_path, media_name, payload,
          send_at, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session, chatId, kind, body ?? null, mediaPath ?? null, mediaName ?? null,
      payload ? JSON.stringify(payload) : null,
      sendAt ?? now(), expiresAt ?? null, userId ?? null, now(),
    );
    return get('SELECT * FROM outbox WHERE id = ?', result.insertId);
  },

  /** Give up on messages that waited too long for a session to come back. */
  expireStale: () =>
    run(
      `UPDATE outbox
          SET status = 'expired',
              last_error = 'Session never reconnected in time'
        WHERE status = 'queued' AND expires_at IS NOT NULL AND expires_at < ?`,
      now(),
    ),

  /**
   * Atomically claim one due job.
   *
   * The UPDATE stamps our worker id on exactly one row; a second process
   * running the identical statement cannot then match that row, so a job is
   * never delivered twice. This replaces the SELECT-then-UPDATE that was safe
   * under single-process SQLite but would race across processes.
   *
   * (MariaDB 10.4 has no SKIP LOCKED, hence the worker-token approach.)
   */
  async claimNext(session) {
    const result = await run(
      `UPDATE outbox
          SET status = 'sending', locked_by = ?, locked_at = ?
        WHERE status = 'queued' AND send_at <= ? AND session = ?
        ORDER BY send_at, id
        LIMIT 1`,
      WORKER_ID, now(), now(), session,
    );
    if (!result.affectedRows) return null;
    return get(
      "SELECT * FROM outbox WHERE locked_by = ? AND status = 'sending' ORDER BY id LIMIT 1",
      WORKER_ID,
    );
  },

  markSent: (id) => run("UPDATE outbox SET status = 'sent', locked_by = NULL WHERE id = ?", id),

  async markFailed(id, error, maxAttempts) {
    const row = await get('SELECT attempts FROM outbox WHERE id = ?', id);
    const attempts = (row?.attempts ?? 0) + 1;
    const status = attempts >= maxAttempts ? 'failed' : 'queued';
    await run(
      'UPDATE outbox SET status = ?, attempts = ?, last_error = ?, send_at = ?, locked_by = NULL WHERE id = ?',
      status, attempts, String(error).slice(0, 500), now() + attempts * 5000, id,
    );
    return status;
  },

  /**
   * Jobs left 'sending' belong to a process that died mid-flight. Only reclaim
   * our own, so restarting one worker cannot steal a job another is sending.
   */
  requeueStuck: () =>
    run(
      "UPDATE outbox SET status = 'queued', locked_by = NULL WHERE status = 'sending' AND (locked_by = ? OR locked_by IS NULL)",
      WORKER_ID,
    ),

  /**
   * Reclaim our own jobs that have sat in 'sending' too long. A send that was
   * in flight when the WhatsApp session dropped would otherwise stay stuck
   * until the process restarts — the message never arrives and nothing says so.
   */
  requeueStale: (ownAfterMs = 120000, anyAfterMs = 600000) =>
    run(
      `UPDATE outbox
          SET status = 'queued', locked_by = NULL, locked_at = NULL
        WHERE status = 'sending'
          AND (
            (locked_by = ? AND COALESCE(locked_at, 0) < ?)
            OR COALESCE(locked_at, 0) < ?
          )`,
      // Our own jobs are reclaimed quickly. A job held by a worker that no
      // longer exists is reclaimed after longer, since we cannot ask whether
      // that process is still alive — no real send takes ten minutes.
      WORKER_ID, now() - ownAfterMs, now() - anyAfterMs,
    ),

  pending: (session) =>
    all(
      `SELECT * FROM outbox
        WHERE session = ? AND status IN ('queued','sending','failed')
        ORDER BY send_at LIMIT 200`,
      session,
    ),

  cancel: (id) => run("UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'queued'", id),
};

/* ------------------------------- templates ------------------------------- */

export const Templates = {
  list: () => all('SELECT * FROM templates ORDER BY template_key'),
  byKey: (key) => get('SELECT * FROM templates WHERE template_key = ?', key),
  byId: (id) => get('SELECT * FROM templates WHERE id = ?', id),

  async create({ templateKey, name, body, description }) {
    const result = await run(
      `INSERT INTO templates (template_key, name, body, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      templateKey, name, body, description ?? null, now(), now(),
    );
    return get('SELECT * FROM templates WHERE id = ?', result.insertId);
  },

  async update(id, { name, body, description, enabled }) {
    await run(
      `UPDATE templates
          SET name        = COALESCE(?, name),
              body        = COALESCE(?, body),
              description = COALESCE(?, description),
              enabled     = COALESCE(?, enabled),
              updated_at  = ?
        WHERE id = ?`,
      name ?? null, body ?? null, description ?? null,
      enabled === undefined ? null : (enabled ? 1 : 0), now(), id,
    );
    return get('SELECT * FROM templates WHERE id = ?', id);
  },

  remove: (id) => run('DELETE FROM templates WHERE id = ?', id),
};

/* ---------------------------------- bots --------------------------------- */

/** Chat tags, as a bot action sees them. */
export const ChatTags = {
  async get(session, chatId) {
    const row = await get('SELECT tags FROM chats WHERE session = ? AND id = ?', session, chatId);
    return safeJson(row?.tags, []);
  },

  async set(session, chatId, tags) {
    await run(
      'UPDATE chats SET tags = ? WHERE session = ? AND id = ?',
      JSON.stringify([...new Set(tags)]), session, chatId,
    );
    return [...new Set(tags)];
  },
};


const hydrateBot = (row) => row && ({ ...row, enabled: Boolean(row.enabled), allow_groups: Boolean(row.allow_groups) });
const hydrateNode = (row) => row && ({
  ...row,
  options: safeJson(row.options, []),
  config: safeJson(row.config, {}),
});
const hydrateBotChat = (row) => row && ({ ...row, variables: safeJson(row.variables, {}) });

export const Bots = {
  async create(b) {
    const r = await run(
      `INSERT INTO bot (name, session, trigger_event, trigger_type, trigger_text, entry_key,
                        fallback, max_retries, timeout_minutes, allow_groups, enabled,
                        owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name, b.session ?? null, b.triggerEvent ?? 'message', b.triggerType, b.triggerText,
      b.entryKey, b.fallback ?? null,
      b.maxRetries ?? 2, b.timeoutMinutes ?? 30, b.allowGroups ? 1 : 0,
      b.enabled === false ? 0 : 1, b.ownerId ?? null, now(), now(),
    );
    return Bots.get(r.insertId);
  },

  async update(id, b) {
    await run(
      `UPDATE bot SET name = ?, session = ?, trigger_event = ?, trigger_type = ?,
              trigger_text = ?, entry_key = ?, fallback = ?, max_retries = ?,
              timeout_minutes = ?, allow_groups = ?, enabled = ?, updated_at = ?
        WHERE id = ?`,
      b.name, b.session ?? null, b.triggerEvent ?? 'message', b.triggerType, b.triggerText,
      b.entryKey, b.fallback ?? null,
      b.maxRetries ?? 2, b.timeoutMinutes ?? 30, b.allowGroups ? 1 : 0,
      b.enabled === false ? 0 : 1, now(), id,
    );
    return Bots.get(id);
  },

  async get(id) {
    return hydrateBot(await get('SELECT * FROM bot WHERE id = ?', id));
  },

  async list({ userId, isAdmin } = {}) {
    const rows = isAdmin || !userId
      ? await all('SELECT * FROM bot ORDER BY enabled DESC, name')
      : await all('SELECT * FROM bot WHERE owner_id = ? OR owner_id IS NULL ORDER BY enabled DESC, name', userId);
    return rows.map(hydrateBot);
  },

  /** Every bot that could answer on this session, cheapest filter first. */
  async live(session) {
    const rows = await all(
      'SELECT * FROM bot WHERE enabled = 1 AND (session IS NULL OR session = ?) ORDER BY id',
      session,
    );
    return rows.map(hydrateBot);
  },

  setEnabled: (id, enabled) =>
    run('UPDATE bot SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now(), id),

  remove: (id) => run('DELETE FROM bot WHERE id = ?', id),

  /* ------------------------------- the steps ------------------------------ */

  async nodes(botId) {
    const rows = await all('SELECT * FROM bot_node WHERE bot_id = ? ORDER BY sort, id', botId);
    return rows.map(hydrateNode);
  },

  async node(botId, key) {
    return hydrateNode(await get('SELECT * FROM bot_node WHERE bot_id = ? AND node_key = ?', botId, key));
  },

  upsertNode: (botId, n) =>
    run(
      `INSERT INTO bot_node (bot_id, node_key, kind, body, options, config,
                             save_as, next_key, sort, pos_x, pos_y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = VALUES(kind), body = VALUES(body),
         options = VALUES(options), config = VALUES(config), save_as = VALUES(save_as),
         next_key = VALUES(next_key), sort = VALUES(sort),
         pos_x = VALUES(pos_x), pos_y = VALUES(pos_y)`,
      botId, n.key, n.kind, n.body ?? '', JSON.stringify(n.options ?? []),
      JSON.stringify(n.config ?? {}), n.saveAs ?? null, n.nextKey ?? null,
      n.sort ?? 0, Math.round(n.x ?? 0), Math.round(n.y ?? 0),
    ),

  /** Move a step on the canvas without touching anything it does. */
  moveNode: (botId, key, x, y) =>
    run(
      'UPDATE bot_node SET pos_x = ?, pos_y = ? WHERE bot_id = ? AND node_key = ?',
      Math.round(x), Math.round(y), botId, key,
    ),

  removeNode: (botId, key) =>
    run('DELETE FROM bot_node WHERE bot_id = ? AND node_key = ?', botId, key),

  /* --------------------------- live conversations -------------------------- */

  async chat(session, chatId) {
    return hydrateBotChat(await get(
      `SELECT * FROM bot_chat WHERE session = ? AND chat_id = ? AND status = 'active'
        ORDER BY id DESC LIMIT 1`,
      session, chatId,
    ));
  },

  /**
   * Open a conversation.
   *
   * `at` exists for campaigns. A batch of 200 goes out over half an hour, so a
   * conversation created now for a message that leaves in twenty minutes must
   * date from when it *arrives* — otherwise the idle timeout starts running
   * before the person has been spoken to, and the earliest recipients get a
   * bot that has already forgotten them.
   */
  async startChat({ botId, session, chatId, nodeKey, variables, at }) {
    const when = at ?? now();
    const r = await run(
      `INSERT INTO bot_chat (bot_id, session, chat_id, node_key, variables, started_at, last_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      botId, session, chatId, nodeKey, JSON.stringify(variables ?? {}), when, when,
    );
    return hydrateBotChat(await get('SELECT * FROM bot_chat WHERE id = ?', r.insertId));
  },

  saveChat: (id, { nodeKey, variables, retries, status }) =>
    run(
      `UPDATE bot_chat SET node_key = ?, variables = ?, retries = ?, status = ?, last_at = ?
        WHERE id = ?`,
      nodeKey ?? null, JSON.stringify(variables ?? {}), retries ?? 0, status ?? 'active', now(), id,
    ),

  /** Close conversations nobody came back to. */
  expireChats: (before) =>
    run(
      `UPDATE bot_chat SET status = 'expired' WHERE status = 'active' AND last_at < ?`,
      before,
    ),

  /** Close whatever is open on a chat, so a campaign cannot double-book it. */
  closeChats: (session, chatId) =>
    run(
      `UPDATE bot_chat SET status = 'expired'
        WHERE session = ? AND chat_id = ? AND status = 'active'`,
      session, chatId,
    ),

  logEvent: ({ botChatId, direction, nodeKey, body }) =>
    run(
      'INSERT INTO bot_event (bot_chat_id, direction, node_key, body, at) VALUES (?, ?, ?, ?, ?)',
      botChatId, direction, nodeKey ?? null, body ?? null, now(),
    ),

  conversations: (botId, limit = 30) =>
    all(
      `SELECT c.*, (SELECT COUNT(*) FROM bot_event e WHERE e.bot_chat_id = c.id) AS turns
         FROM bot_chat c WHERE c.bot_id = ? ORDER BY c.last_at DESC LIMIT ?`,
      botId, limit,
    ),

  transcript: (botChatId) =>
    all('SELECT * FROM bot_event WHERE bot_chat_id = ? ORDER BY at, id', botChatId),
};

/* -------------------------------- schedules ------------------------------ */

const hydrateSchedule = (row) => row && ({
  ...row,
  enabled: Boolean(row.enabled),
  slots: safeJson(row.slots, []),
  recipients: safeJson(row.recipients, []),
});

export const Schedules = {
  async create(s) {
    const result = await run(
      `INSERT INTO schedule
         (name, session, owner_id, kind, time_of_day, slots, day_of_month, run_at,
          timezone, source, template_key, body, recipients, enabled, next_run_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.name, s.session, s.ownerId ?? null, s.kind, s.timeOfDay ?? '09:00',
      JSON.stringify(s.slots ?? []), s.dayOfMonth ?? null, s.runAt ?? null,
      s.timezone, s.source, s.templateKey ?? null, s.body ?? null,
      JSON.stringify(s.recipients ?? []), s.enabled === false ? 0 : 1,
      s.nextRunAt ?? null, now(), now(),
    );
    return Schedules.get(result.insertId);
  },

  async update(id, s) {
    await run(
      `UPDATE schedule SET name = ?, session = ?, kind = ?, time_of_day = ?, slots = ?,
              day_of_month = ?, run_at = ?, timezone = ?, source = ?, template_key = ?,
              body = ?, recipients = ?, enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
      s.name, s.session, s.kind, s.timeOfDay ?? '09:00', JSON.stringify(s.slots ?? []),
      s.dayOfMonth ?? null, s.runAt ?? null, s.timezone, s.source, s.templateKey ?? null,
      s.body ?? null, JSON.stringify(s.recipients ?? []), s.enabled === false ? 0 : 1,
      s.nextRunAt ?? null, now(), id,
    );
    return Schedules.get(id);
  },

  async get(id) {
    return hydrateSchedule(await get('SELECT * FROM schedule WHERE id = ?', id));
  },

  async list({ userId, isAdmin } = {}) {
    const rows = isAdmin || !userId
      ? await all('SELECT * FROM schedule ORDER BY enabled DESC, next_run_at')
      : await all(
        'SELECT * FROM schedule WHERE owner_id = ? OR owner_id IS NULL ORDER BY enabled DESC, next_run_at',
        userId,
      );
    return rows.map(hydrateSchedule);
  },

  /** Everything currently owed a run — including anything long overdue. */
  async due(at) {
    const rows = await all(
      'SELECT * FROM schedule WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
      at,
    );
    return rows.map(hydrateSchedule);
  },

  /**
   * Move a schedule's next run forward, but only if nobody else already did.
   *
   * The compare-and-set on `next_run_at` is what makes a firing exactly-once:
   * a second process racing for the same schedule updates zero rows and backs
   * off, instead of sending everything twice.
   */
  async claim(id, expectedNextRunAt, newNextRunAt) {
    const result = await run(
      'UPDATE schedule SET next_run_at = ? WHERE id = ? AND next_run_at = ?',
      newNextRunAt, id, expectedNextRunAt,
    );
    return result.affectedRows === 1;
  },

  markRan: (id, firedAt, error = null) =>
    run(
      `UPDATE schedule SET last_run_at = ?, run_count = run_count + 1, last_error = ?
        WHERE id = ?`,
      firedAt, error, id,
    ),

  setEnabled: (id, enabled) =>
    run('UPDATE schedule SET enabled = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, now(), id),

  setNextRun: (id, at) =>
    run('UPDATE schedule SET next_run_at = ?, updated_at = ? WHERE id = ?', at, now(), id),

  remove: (id) => run('DELETE FROM schedule WHERE id = ?', id),

  logRun: ({ scheduleId, dueAt, status, queued = 0, batchRef = null, detail = null }) =>
    run(
      `INSERT INTO schedule_run (schedule_id, due_at, fired_at, status, queued, batch_ref, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      scheduleId, dueAt, now(), status, queued, batchRef, detail,
    ),

  runs: (scheduleId, limit = 30) =>
    all(
      'SELECT * FROM schedule_run WHERE schedule_id = ? ORDER BY fired_at DESC LIMIT ?',
      scheduleId, limit,
    ),
};

/* ------------------------------ bulk batches ----------------------------- */

export const Bulk = {
  async createBatch({ batchRef, session, source, templateKey, body, total, userId }) {
    const result = await run(
      `INSERT INTO bulk_batch
         (batch_ref, session, source, template_key, body, total, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      batchRef, session, source, templateKey ?? null, body ?? null, total, userId ?? null, now(),
    );
    return get('SELECT * FROM bulk_batch WHERE id = ?', result.insertId);
  },

  addRecipient: (batchId, chatId, outboxId, body) =>
    run(
      'INSERT INTO bulk_recipient (batch_id, chat_id, outbox_id, body) VALUES (?, ?, ?, ?)',
      batchId, chatId, outboxId ?? null, body ?? null,
    ),

  /**
   * Batches with their live outcome, joined from the queue rather than stored
   * twice — a status kept in two places drifts.
   */
  list: (session, limit = 50) =>
    all(
      `SELECT b.*, u.username AS created_by_name,
              SUM(o.status = 'sent')      AS sent,
              SUM(o.status = 'failed')    AS failed,
              SUM(o.status = 'cancelled') AS cancelled,
              SUM(o.status = 'expired')   AS expired,
              SUM(o.status IN ('queued','sending')) AS pending
         FROM bulk_batch b
         LEFT JOIN users u          ON u.id = b.created_by
         LEFT JOIN bulk_recipient r ON r.batch_id = b.id
         LEFT JOIN outbox o         ON o.id = r.outbox_id
        WHERE (? IS NULL OR b.session = ?)
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT ?`,
      session ?? null, session ?? null, limit,
    ),

  recipients: (batchId) =>
    all(
      `SELECT r.chat_id, r.body, o.status, o.last_error, o.send_at
         FROM bulk_recipient r LEFT JOIN outbox o ON o.id = r.outbox_id
        WHERE r.batch_id = ? ORDER BY o.send_at, r.id`,
      batchId,
    ),

  byRef: (batchRef) => get('SELECT * FROM bulk_batch WHERE batch_ref = ?', batchRef),
};

/* ---------------------------- rules & webhooks --------------------------- */

export const Rules = {
  async list() {
    const rows = await all('SELECT * FROM rules ORDER BY id');
    return rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  },
  active: (session) =>
    all('SELECT * FROM rules WHERE enabled = 1 AND (session IS NULL OR session = ?) ORDER BY id', session),
  async create({ session, name, matchType, pattern, reply }) {
    const result = await run(
      'INSERT INTO rules (session, name, match_type, pattern, reply, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      session ?? null, name, matchType, pattern, reply, now(),
    );
    const row = await get('SELECT * FROM rules WHERE id = ?', result.insertId);
    return { ...row, enabled: Boolean(row.enabled) };
  },
  toggle: (id, enabled) => run('UPDATE rules SET enabled = ? WHERE id = ?', enabled, id),
  remove: (id) => run('DELETE FROM rules WHERE id = ?', id),
};

export const Webhooks = {
  async list() {
    const rows = await all('SELECT * FROM webhooks ORDER BY id');
    return rows.map(hydrateWebhook);
  },
  async enabled() {
    const rows = await all('SELECT * FROM webhooks WHERE enabled = 1');
    return rows.map(hydrateWebhook);
  },
  async create({ url, events, secret }) {
    const result = await run(
      'INSERT INTO webhooks (url, events, secret, created_at) VALUES (?, ?, ?, ?)',
      url, JSON.stringify(events ?? ['message']), secret ?? null, now(),
    );
    return hydrateWebhook(await get('SELECT * FROM webhooks WHERE id = ?', result.insertId));
  },
  recordAttempt: (id, status) =>
    run('UPDATE webhooks SET last_status = ?, last_attempt_at = ? WHERE id = ?', String(status), now(), id),
  toggle: (id, enabled) => run('UPDATE webhooks SET enabled = ? WHERE id = ?', enabled, id),
  remove: (id) => run('DELETE FROM webhooks WHERE id = ?', id),
};

function hydrateWebhook(row) {
  return { ...row, enabled: Boolean(row.enabled), events: safeJson(row.events, ['message']) };
}

function safeJson(raw, fallback) {
  if (Array.isArray(raw)) return raw; // a JSON column may arrive already parsed
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw);
    // JSON.parse('null') returns null without throwing, so the catch below
    // never fires — that is how a NULL column became a null `tags` array and
    // crashed every caller doing `.map` on it.
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/* --------------------------------- users -------------------------------- */

export const Users = {
  list: () => all('SELECT id, username, role, created_at FROM users ORDER BY id'),
  byName: (username) => get('SELECT * FROM users WHERE username = ?', username),
  byId: (id) => get('SELECT id, username, role, created_at FROM users WHERE id = ?', id),
  async create({ username, passwordHash, role = 'agent' }) {
    const result = await run(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
      username, passwordHash, role, now(),
    );
    return get('SELECT id, username, role, created_at FROM users WHERE id = ?', result.insertId);
  },
  async count() {
    const row = await get('SELECT COUNT(*) AS n FROM users');
    return Number(row?.n ?? 0);
  },
};
