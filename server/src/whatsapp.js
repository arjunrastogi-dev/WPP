import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import wppconnect from '@wppconnect-team/wppconnect';

import { config } from './config.js';
import { publish } from './events.js';
import { Sessions, Chats, Messages, Identity } from './store.js';
import { all, get, run } from './db.js';

const execFileAsync = promisify(execFile);

/**
 * Multi-session WhatsApp manager.
 *
 * Each named session owns its own Chromium instance and its own token folder,
 * so several numbers can be connected at once. Everything WhatsApp tells us is
 * written to SQLite first, then published on the bus — so a browser that was
 * closed at the time still sees the history when it reconnects.
 */

const sessions = new Map(); // name -> { name, client, status, qr, me, starting }

fs.mkdirSync(config.mediaDir, { recursive: true });

function slot(name) {
  if (!sessions.has(name)) {
    sessions.set(name, { name, client: null, status: 'DISCONNECTED', qr: null, me: null, starting: false });
  }
  return sessions.get(name);
}

function setStatus(name, status, detail) {
  const s = slot(name);
  s.status = status;
  if (status === 'CONNECTED') s.qr = null;

  /*
   * A dead session must drop its client handle.
   *
   * WPPConnect reports `browserClose` when Chromium goes away, but the client
   * object stays behind. startSession() bails out early when a client exists,
   * so without this the session can never be restarted — Start appears to work,
   * the status stays DISCONNECTED, and every queued message silently waits
   * forever. Clearing it here makes Start actually start.
   */
  if (status === 'DISCONNECTED' || status === 'ERROR') {
    s.client = null;
    s.qr = null;
  }
  // Called from WPPConnect's synchronous callbacks, so the row update is
  // fire-and-forget: in-memory state is already correct either way.
  Sessions.setStatus(name, status, s.me).catch((err) => console.error('[wpp] setStatus', err));
  console.log(`[wpp:${name}] ${status}${detail ? ` (${detail})` : ''}`);
  publish('status', { session: name, status, detail: detail ?? null, me: s.me });
}

export function sessionState(name) {
  const s = slot(name);
  return { session: name, status: s.status, qr: s.qr, me: s.me };
}

export async function listSessions({ userId = null, isAdmin = true } = {}) {
  // DB rows are the source of truth for *which* sessions exist; the Map holds
  // the live status of the ones currently running in this process.
  const rows = userId === null ? await Sessions.list() : await Sessions.listForUser(userId, isAdmin);
  return rows.map((row) => {
    const live = sessions.get(row.name);
    return {
      name: row.name,
      status: live?.status ?? 'DISCONNECTED',
      qr: live?.qr ?? null,
      me: live?.me ?? (row.me_id ? { id: row.me_id, pushname: row.me_name } : null),
      created_at: row.created_at,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      // Whether the owner means it to be running, as opposed to whether it is.
      wanted: Boolean(row.auto_start),
    };
  });
}

/*
 * Sessions drop on their own: the phone loses signal, WhatsApp logs the device
 * out, Chromium is killed. Nothing noticed before — the session simply stayed
 * down and its queued messages waited forever.
 *
 * Backoff is per session so one that keeps failing (unpaired, needs a QR) does
 * not launch a browser every 30 seconds.
 */
const retryAfter = new Map(); // name -> earliest next attempt
let watchdog = null;

export function startReconnectWatchdog() {
  if (watchdog) return;

  watchdog = setInterval(async () => {
    try {
      const wanted = await Sessions.wanted();

      for (const row of wanted) {
        const live = sessions.get(row.name);
        if (live?.client || live?.starting) continue;
        if ((retryAfter.get(row.name) ?? 0) > Date.now()) continue;
        if (runningCount() >= config.maxSessions) break;

        // 1, 2, 4 … up to 15 minutes between attempts.
        const failures = (retryAfter.get(`${row.name}:count`) ?? 0) + 1;
        retryAfter.set(`${row.name}:count`, failures);
        retryAfter.set(row.name, Date.now() + Math.min(2 ** failures, 30) * 30000);

        console.log(`[wpp:${row.name}] not running but should be — reconnecting (attempt ${failures})`);
        startSession(row.name)
          .then(() => {
            retryAfter.delete(`${row.name}:count`);
            retryAfter.delete(row.name);
          })
          .catch((err) => console.warn(`[wpp:${row.name}] reconnect failed: ${err.message}`));
      }
    } catch (err) {
      console.error('[wpp] watchdog', err);
    }
  }, config.reconnectEveryMs);

  console.log(`[wpp] reconnect watchdog every ${config.reconnectEveryMs / 1000}s, max ${config.maxSessions} sessions`);
}

export function stopReconnectWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

/**
 * Bring back the sessions their owners left running.
 *
 * Signing out of the web app never stops a session, and neither should a
 * server restart — only an explicit Disconnect clears the intent. Started
 * sequentially because each one launches its own Chromium.
 */
export async function restoreSessions() {
  const wanted = await Sessions.wanted();
  if (!wanted.length) return 0;

  console.log(`[wpp] restoring ${wanted.length} session(s) left running: ${wanted.map((w) => w.name).join(', ')}`);
  for (const row of wanted) {
    await startSession(row.name).catch((err) =>
      console.error(`[wpp:${row.name}] restore failed: ${err.message}`));
  }
  return wanted.length;
}

export function getClient(name) {
  const s = sessions.get(name);
  if (!s?.client) throw new Error(`Session "${name}" is not connected. Start it first.`);
  return s.client;
}

export function isConnected(name) {
  return sessions.get(name)?.status === 'CONNECTED';
}

/** WhatsApp ids look like `5511999999999@c.us`. Accept loose user input. */
export function toChatId(input) {
  const raw = String(input ?? '').trim();
  if (raw.includes('@')) return raw; // already an id (@c.us, @g.us or @lid)
  const digits = raw.replace(/\D/g, '');
  if (!digits) throw new Error('Empty phone number');
  return `${digits}@c.us`;
}

/* ---------------------------- one contact, one chat ---------------------- */

/**
 * WhatsApp addresses the same person two ways.
 *
 * Outbound messages go to a phone-number JID (`918860924275@c.us`); the replies
 * come back from a LID (`120546998153296@lid`). Left alone that produces two
 * conversations for one contact — one holding only what you sent, the other
 * only what they said.
 *
 * This resolves a LID to its phone JID so everything lands in one chat. The
 * answer is cached, because asking WhatsApp on every message would be slow and
 * pointless — a person's number does not change between messages.
 */
async function canonicalChatId(client, chatId) {
  const id = String(chatId ?? '');
  if (!id.endsWith('@lid')) return id;

  const cached = await Identity.phoneFor(id);
  if (cached) return cached;

  // Don't hammer WhatsApp for a LID we recently failed to resolve.
  if (await Identity.isFresh(id)) return id;

  try {
    const entry = await client.getPnLidEntry(id);

    /*
     * `phoneNumber` comes back as a wid object, not a string:
     *   { id: '918860924275', server: 'c.us', _serialized: '918860924275@c.us' }
     * Stringifying it yields "[object Object]", so take the serialized form.
     */
    const pn = entry?.phoneNumber ?? entry?.pn ?? null;
    const jid = pn?._serialized
      ?? (pn?.id ? `${pn.id}@${pn.server ?? 'c.us'}` : null)
      ?? (typeof pn === 'string' && /\d/.test(pn) ? `${pn.replace(/\D/g, '')}@c.us` : null);

    await Identity.remember(id, jid, entry?.contact?.pushname ?? entry?.contact?.name ?? null);
    if (jid) console.log(`[wpp] ${id} is ${jid} — merging into one conversation`);
    return jid ?? id;
  } catch (err) {
    // Not every LID maps to a number we can see; remember that so we stop asking.
    await Identity.remember(id, null, null).catch(() => {});
    console.warn(`[wpp] could not resolve ${id}: ${err.message}`);
    return id;
  }
}

/**
 * Fold LID conversations into the phone-number chat they belong to.
 *
 * Runs against the live session because WhatsApp is the only thing that knows
 * which LID maps to which number. Re-runnable: an already merged chat has
 * nothing left to move.
 */
export async function mergeLidChats(name, { apply = false } = {}) {
  const client = getClient(name);
  const lidChats = await all(
    "SELECT * FROM chats WHERE session = ? AND id LIKE '%@lid'",
    name,
  );

  const plan = [];
  for (const chat of lidChats) {
    const phoneJid = await canonicalChatId(client, chat.id);
    if (phoneJid === chat.id) {
      plan.push({ lid: chat.id, name: chat.name, resolved: false });
      continue;
    }
    plan.push({ lid: chat.id, name: chat.name, phoneJid, resolved: true });

    if (!apply) continue;

    await run('UPDATE messages SET chat_id = ? WHERE session = ? AND chat_id = ?', phoneJid, name, chat.id);

    const existing = await get('SELECT * FROM chats WHERE session = ? AND id = ?', name, phoneJid);
    if (existing) {
      // Keep the better name and whichever conversation was active last.
      await run(
        `UPDATE chats
            SET name                 = COALESCE(name, ?),
                unread               = unread + ?,
                last_message_preview = IF(COALESCE(?, 0) > COALESCE(last_message_at, 0), ?, last_message_preview),
                last_message_at      = GREATEST(COALESCE(last_message_at, 0), COALESCE(?, 0))
          WHERE session = ? AND id = ?`,
        chat.name, chat.unread, chat.last_message_at, chat.last_message_preview,
        chat.last_message_at, name, phoneJid,
      );
      await run('DELETE FROM chats WHERE session = ? AND id = ?', name, chat.id);
    } else {
      await run('UPDATE chats SET id = ? WHERE session = ? AND id = ?', phoneJid, name, chat.id);
    }
  }

  const merged = plan.filter((p) => p.resolved).length;
  console.log(`[wpp:${name}] ${apply ? 'merged' : 'would merge'} ${merged} LID conversation(s)`);
  return { applied: apply, merged, unresolved: plan.length - merged, plan };
}

/* ------------------------------ media helpers ---------------------------- */

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a', 'application/pdf': '.pdf',
};

/**
 * Chats that are not conversations.
 *
 * `status@broadcast` carries everyone's Status posts, and newsletters/channels
 * are one-way feeds. They arrive through the same onMessage hook as a real
 * message, so without this the inbox fills with content nobody can reply to.
 */
const NON_CONVERSATION = /@(broadcast|newsletter)$/i;

/**
 * Message types WhatsApp delivers through the same hook as real messages, but
 * which nobody wrote and nobody can reply to: encryption-key changes, group
 * membership churn, system notices, undecryptable payloads. Left unfiltered
 * they each open a chat and bury the actual patients.
 */
const SYSTEM_TYPES = new Set([
  'e2e_notification', 'notification', 'notification_template', 'gp2',
  'group_notification', 'broadcast_notification', 'protocol', 'ciphertext',
  'call_log', 'revoked',
]);

/** `0@c.us` is WhatsApp itself — product announcements, not a contact. */
const SYSTEM_SENDER = /^0@/;

export const isConversation = (chatId) =>
  !NON_CONVERSATION.test(String(chatId ?? '')) && !SYSTEM_SENDER.test(String(chatId ?? ''));

export const isSystemMessage = (type) => SYSTEM_TYPES.has(String(type ?? '').toLowerCase());

/** Message types that carry a downloadable attachment. */
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'sticker', 'document']);

const MEDIA_LABELS = {
  image: 'Photo', video: 'Video', audio: 'Audio',
  ptt: 'Voice message', sticker: 'Sticker', document: 'Document',
};

/** Human-readable sidebar preview for an attachment with no caption. */
export const mediaLabel = (type) => MEDIA_LABELS[type] ?? `[${type}]`;

/**
 * `isMedia` alone is unreliable across WhatsApp Web builds, so fall back to the
 * message type and the presence of a mimetype.
 */
export function isMediaMessage(message) {
  return Boolean(
    message?.isMedia || message?.isMMS || MEDIA_TYPES.has(message?.type) || message?.mimetype,
  );
}

function extFromName(name) {
  const ext = path.extname(String(name ?? ''));
  return ext && ext.length <= 6 ? ext : null;
}

/** Persist an inbound media message to disk, returning a relative filename. */
async function saveIncomingMedia(client, message) {
  try {
    const base64 = await client.downloadMedia(message.id);
    if (!base64) {
      // Log it — a silent null here is why attachments used to vanish.
      console.warn(`[wpp] downloadMedia returned nothing for ${message.id} (${message.type})`);
      return null;
    }
    // downloadMedia may return a full data URI or a bare base64 payload.
    const payload = base64.startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
    const mimetype = message.mimetype ?? 'application/octet-stream';
    const ext = EXT_BY_MIME[mimetype] ?? extFromName(message.filename) ?? '';
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(config.mediaDir, filename), Buffer.from(payload, 'base64'));
    return filename;
  } catch (err) {
    console.warn(`[wpp] media download failed for ${message.id}: ${err.message}`);
    return null;
  }
}

/* --------------------------- orphaned browsers --------------------------- */

/**
 * Chromium outlives a hard-killed Node.
 *
 * `taskkill /F`, a crash, or pulling the plug never runs our SIGINT handler, so
 * the browser stays alive holding a lock on the session's profile directory.
 * The next start then fails with "The browser is already running for …".
 *
 * Only processes whose command line contains this session's own token folder
 * are touched — never the user's own browser.
 */
async function killOrphanedBrowser(name) {
  const profile = path.join(config.tokensDir, name);

  try {
    if (process.platform === 'win32') {
      // Ask for the process list as JSON and filter here, rather than building
      // a PowerShell -like pattern out of a Windows path full of backslashes.
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });

      const parsed = JSON.parse(stdout || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      // Renderer and GPU children carry the profile path too, so matching on it
      // sweeps the whole tree even when the parent has already exited.
      const ours = rows.filter((r) => String(r?.CommandLine ?? '').includes(profile));

      for (const row of ours) {
        await execFileAsync('taskkill', ['/F', '/T', '/PID', String(row.ProcessId)], { timeout: 10000 })
          .catch(() => {});
      }
      if (ours.length) console.log(`[wpp:${name}] cleared ${ours.length} orphaned browser process(es)`);
    } else {
      await execFileAsync('pkill', ['-f', profile], { timeout: 10000 }).catch(() => {});
    }
  } catch (err) {
    console.warn(`[wpp:${name}] could not clear the old browser: ${err.message}`);
  }

  // Chromium also leaves lock files behind; a stale one blocks a fresh start.
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(profile, lock), { force: true, recursive: true });
  }
}

/** Does this error mean a previous browser is still holding the profile? */
const isProfileLocked = (err) => /already running|user-data-dir|SingletonLock/i.test(String(err?.message ?? ''));

/* ------------------------------- lifecycle ------------------------------- */

/** How many sessions currently hold a live browser. */
export const runningCount = () =>
  [...sessions.values()].filter((s) => s.client || s.starting).length;

export async function startSession(name) {
  const s = slot(name);
  if (s.client || s.starting) return sessionState(name);

  // Refuse rather than thrash: an out-of-memory machine is far harder to
  // diagnose than a clear "you are at the limit" message.
  if (runningCount() >= config.maxSessions) {
    const err = new Error(
      `Already running ${runningCount()} of ${config.maxSessions} allowed sessions. `
      + 'Disconnect one first, or raise MAX_SESSIONS.',
    );
    err.code = 'SESSION_LIMIT';
    setStatus(name, 'DISCONNECTED', 'session limit reached');
    throw err;
  }

  s.starting = true;
  await Sessions.upsert(name);
  setStatus(name, 'STARTING');

  // Build the options once: a retry after clearing a stale lock must use
  // exactly the same configuration.
  const options = () => ({
      session: name,

      catchQR: (base64Qr, _ascii, attempts) => {
        s.qr = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        setStatus(name, 'WAITING_QR', `attempt ${attempts}`);
        publish('qr', { session: name, qr: s.qr, attempts });
      },

      statusFind: (statusSession) => {
        if (['isLogged', 'qrReadSuccess', 'chatsAvailable', 'successChat'].includes(statusSession)) {
          setStatus(name, 'CONNECTED', statusSession);
        } else if (['notLogged', 'qrReadFail', 'desconnectedMobile', 'disconnectedMobile'].includes(statusSession)) {
          setStatus(name, 'WAITING_QR', statusSession);
        } else if (['browserClose', 'deviceNotConnected', 'autocloseCalled'].includes(statusSession)) {
          setStatus(name, 'DISCONNECTED', statusSession);
        }
      },

      // 0 disables the default 60s timeout, which otherwise kills the session
      // while you are still reaching for your phone.
      autoClose: 0,
      headless: config.headless,
      puppeteerOptions: config.chromePath ? { executablePath: config.chromePath } : {},
      folderNameToken: config.tokensDir,
      logQR: false,
  });

  try {
    let client;
    try {
      client = await wppconnect.create(options());
    } catch (err) {
      /*
       * A hard kill (taskkill /F, a crash) never runs our shutdown handler, so
       * the previous Chromium is still alive holding this profile. Clear it and
       * try once more, rather than making someone hunt for the process by hand.
       */
      if (!isProfileLocked(err)) throw err;
      console.warn(`[wpp:${name}] profile is locked by an old browser — clearing it and retrying`);
      await killOrphanedBrowser(name);
      client = await wppconnect.create(options());
    }

    s.client = client;
    s.qr = null;
    s.me = await client.getHostDevice().then(
      (d) => ({ id: d?.id?._serialized ?? d?.wid?._serialized ?? null, pushname: d?.pushname ?? null }),
      () => null,
    );
    setStatus(name, 'CONNECTED');

    registerListeners(name, client);
    return sessionState(name);
  } catch (err) {
    s.client = null;
    setStatus(name, 'ERROR', err.message);
    throw err;
  } finally {
    s.starting = false;
  }
}

function registerListeners(name, client) {
  client.onMessage(async (message) => {
    const rawChatId = message.from;

    // Drop non-conversations before they reach the database, rather than
    // filtering them out on the way to the screen.
    if (!isConversation(rawChatId) || isSystemMessage(message.type)) return;

    // Land the message in the same conversation we send to, not a parallel one.
    const chatId = await canonicalChatId(client, rawChatId);

    const isGroup = Boolean(message.isGroupMsg);
    const timestamp = (message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;

    const hasMedia = isMediaMessage(message);
    const mediaPath = hasMedia ? await saveIncomingMedia(client, message) : null;

    const author = message.sender?.pushname ?? message.notifyName ?? chatId;
    // For media, WhatsApp puts a base64 JPEG thumbnail in `body`. Storing that
    // as the message text is what rendered attachments as a wall of characters.
    const body = hasMedia ? (message.caption ?? '') : (message.body ?? '');

    const saved = await Messages.insert({
      waId: message.id, session: name, chatId, direction: 'in', author, body,
      type: message.type ?? 'chat', mediaPath, mediaName: message.filename ?? null,
      mimetype: message.mimetype ?? null, ack: 0, timestamp,
    });

    const chat = await Chats.touch({
      session: name, id: chatId, name: author, isGroup,
      preview: body || mediaLabel(message.type), at: timestamp, incrementUnread: true,
    });

    publish('message', { session: name, message: saved, chat });
  });

  // Delivery receipts: this is what powers the tick marks in the UI.
  client.onAck((ack) => {
    const waId = ack?.id?._serialized ?? ack?.id;
    if (!waId) return;
    Messages.setAck(name, waId, ack.ack ?? 0)
      .then((updated) => { if (updated) publish('ack', { session: name, message: updated }); })
      .catch((err) => console.error('[wpp] onAck', err));
  });

  client.onStateChange((state) => {
    if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(state)) {
      setStatus(name, 'DISCONNECTED', state);
    }
  });
}

export async function stopSession(name, { logout = false } = {}) {
  const s = sessions.get(name);
  if (!s?.client) {
    setStatus(name, 'DISCONNECTED');
    return sessionState(name);
  }
  try {
    if (logout) await s.client.logout();
    await s.client.close();
  } catch (err) {
    console.warn(`[wpp:${name}] close failed: ${err.message}`);
  } finally {
    s.client = null;
    s.qr = null;
    s.me = null;
    setStatus(name, 'DISCONNECTED', logout ? 'logout' : 'closed');
  }
  return sessionState(name);
}

/**
 * Close every browser this process is running, and sweep up any Chromium left
 * behind by an earlier hard kill.
 *
 * `keepWanted` decides what happens next time: false is "shut down for now,
 * bring them back on restart", true is "and stay down".
 */
export async function closeAllBrowsers({ clearIntent = true } = {}) {
  const names = [...sessions.keys()];
  const closed = [];

  /*
   * Clear the intent BEFORE closing anything.
   *
   * The watchdog restarts any session still marked as wanted, so closing first
   * and clearing after leaves a window where it simply reopens what we just
   * shut — the button appeared to do nothing. Sessions are started again by
   * hand, which is what "close all browsers" implies.
   */
  if (clearIntent) {
    for (const name of names) await Sessions.setWanted(name, false).catch(() => {});
  }

  for (const name of names) {
    if (sessions.get(name)?.client) {
      await stopSession(name).catch(() => {});
      closed.push(name);
    }
  }

  // Chromium takes a moment to exit after close(); sweeping too early leaves
  // its children behind. Then clear anything orphaned by an earlier crash.
  await new Promise((r) => setTimeout(r, 1500));
  const known = await Sessions.list().catch(() => []);
  for (const row of known) await killOrphanedBrowser(row.name);

  console.log(`[wpp] closed ${closed.length} browser(s)${clearIntent ? ' and cleared auto-restart' : ''}`);
  return { closed, clearedIntent: clearIntent };
}

export async function stopAll() {
  await Promise.all([...sessions.keys()].map((name) => stopSession(name).catch(() => {})));
}

/**
 * Re-download attachments for stored messages that have no file yet.
 *
 * Media can fail to download for transient reasons — the page still syncing, an
 * expired URL. Rather than losing the attachment forever, retry on demand.
 */
export async function backfillMedia(session, limit = 25) {
  const client = getClient(session);
  const pending = await Messages.missingMedia(session, limit);
  let recovered = 0;

  for (const row of pending) {
    if (!row.wa_id) continue;
    const filename = await saveIncomingMedia(client, {
      id: row.wa_id, type: row.type, mimetype: row.mimetype, filename: row.media_name,
    });
    if (filename) {
      await Messages.setMedia(row.id, filename);
      recovered += 1;
      publish('message', {
        session,
        message: await Messages.byId(row.id),
        chat: await Chats.get(session, row.chat_id),
      });
    }
  }
  console.log(`[wpp:${session}] media backfill: ${recovered}/${pending.length} recovered`);
  return { attempted: pending.length, recovered };
}

/**
 * Actually push a message to WhatsApp. Only the queue worker calls this —
 * routes enqueue instead, so nothing bypasses the rate limiter.
 */
export async function deliver({ session, chatId, kind, body, mediaPath, mediaName }) {
  const client = getClient(session);

  if (kind === 'media' && mediaPath) {
    const abs = path.join(config.mediaDir, mediaPath);
    const isImage = /\.(jpe?g|png|gif|webp)$/i.test(mediaPath);
    return isImage
      ? client.sendImage(chatId, abs, mediaName ?? path.basename(abs), body ?? '')
      : client.sendFile(chatId, abs, mediaName ?? path.basename(abs), body ?? '');
  }

  return client.sendText(chatId, body ?? '');
}

/** Ask WhatsApp whether a number exists, rather than guessing country codes. */
export async function checkNumber(session, chatId) {
  const client = getClient(session);
  const check = await client.checkNumberStatus(chatId).catch(() => null);
  if (!check) return { ok: true, id: chatId }; // check unavailable — don't block the send
  const exists = check.numberExists ?? check.canReceiveMessage ?? check.status === 200;
  return { ok: Boolean(exists), id: check.id?._serialized ?? chatId };
}
