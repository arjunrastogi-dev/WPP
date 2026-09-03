import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';

/*
 * These run against a throwaway MySQL database so they can never touch real
 * data. Point them elsewhere with DB_HOST/DB_USER/DB_PASSWORD if your MySQL
 * isn't XAMPP's default.
 */
const TEST_DB = process.env.TEST_DB_NAME ?? 'wppinbox_test';
const conn = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
};

const admin = await mysql.createConnection(conn);
await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
await admin.query(`CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4`);
await admin.end();

// Must be set before config.js is first imported.
process.env.DB_NAME = TEST_DB;
process.env.MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-test-'));

const { initDb, pool } = await import('../src/db.js');
const { _internals } = await import('../src/rules.js');
const { Outbox, Messages, Chats, Users, Rules } = await import('../src/store.js');
const { hashPassword, verifyPassword } = await import('../src/auth.js');
const { toChatId } = await import('../src/whatsapp.js');

const { matches, render } = _internals;

before(async () => { await initDb(); });

after(async () => {
  await pool.end();
  const cleanup = await mysql.createConnection(conn);
  await cleanup.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await cleanup.end();
});

/* ------------------------------ pure helpers ----------------------------- */

test('toChatId normalises loose phone input', () => {
  assert.equal(toChatId('918860924275'), '918860924275@c.us');
  assert.equal(toChatId('+91 88609 24275'), '918860924275@c.us');
  // Already-formed ids pass through untouched — including @lid, whose digits
  // are NOT a phone number and must never be reformatted.
  assert.equal(toChatId('12345@lid'), '12345@lid');
  assert.equal(toChatId('9876@g.us'), '9876@g.us');
  assert.throws(() => toChatId('   '), /Empty phone number/);
});

test('rule matching honours each match type', () => {
  assert.ok(matches({ match_type: 'contains', pattern: 'price' }, 'What is the PRICE?'));
  assert.ok(!matches({ match_type: 'contains', pattern: 'price' }, 'hello'));

  assert.ok(matches({ match_type: 'equals', pattern: 'hi' }, '  HI  '));
  assert.ok(!matches({ match_type: 'equals', pattern: 'hi' }, 'hi there'));

  assert.ok(matches({ match_type: 'starts', pattern: '/help' }, '/help me'));
  assert.ok(!matches({ match_type: 'starts', pattern: '/help' }, 'please /help'));

  assert.ok(matches({ match_type: 'regex', pattern: '^order #\\d+' }, 'Order #123 status?'));
  // An invalid regex must not throw and take the message handler down.
  assert.doesNotThrow(() => matches({ match_type: 'regex', pattern: '[bad' }, 'x'));
  assert.equal(matches({ match_type: 'regex', pattern: '[bad' }, 'x'), false);
});

test('reply templates interpolate placeholders', () => {
  assert.equal(
    render('Hi {{name}}, you said: {{body}}', { author: 'Asha', body: 'hello' }),
    'Hi Asha, you said: hello',
  );
  assert.equal(render('Hi {{name}}', {}), 'Hi there');
});

test('password hashing round-trips and rejects wrong input', () => {
  const stored = hashPassword('correct-horse');
  assert.ok(verifyPassword('correct-horse', stored));
  assert.ok(!verifyPassword('wrong', stored));
  assert.ok(!verifyPassword('x', 'malformed-hash'));
  // Distinct salts mean identical passwords never produce identical hashes.
  assert.notEqual(stored, hashPassword('correct-horse'));
});

/* -------------------------------- queue ---------------------------------- */

test('queue only claims jobs that are due', async () => {
  await Outbox.enqueue({ session: 's', chatId: 'a@c.us', body: 'later', sendAt: Date.now() + 60_000 });
  assert.equal(await Outbox.claimNext('s'), null, 'a scheduled job must not be claimed early');

  await Outbox.enqueue({ session: 's', chatId: 'a@c.us', body: 'now', sendAt: Date.now() - 1 });
  const claimed = await Outbox.claimNext('s');
  assert.equal(claimed.body, 'now');

  // Claiming marks it 'sending', so a second tick can't grab the same row.
  assert.equal(await Outbox.claimNext('s'), null);
  await Outbox.markSent(claimed.id);
});

test('a claimed job is never handed out twice', async () => {
  await Outbox.enqueue({ session: 'race', chatId: 'a@c.us', body: 'only-once', sendAt: Date.now() - 1 });

  // Two concurrent claims model two worker processes hitting the same row.
  const [first, second] = await Promise.all([Outbox.claimNext('race'), Outbox.claimNext('race')]);
  const winners = [first, second].filter(Boolean);
  assert.equal(winners.length, 1, 'exactly one claim may succeed');
  assert.equal(winners[0].body, 'only-once');
});

test('queue retries then gives up at maxAttempts', async () => {
  const job = await Outbox.enqueue({ session: 'r', chatId: 'a@c.us', body: 'x', sendAt: Date.now() - 1 });
  assert.equal(await Outbox.markFailed(job.id, 'boom', 3), 'queued');
  assert.equal(await Outbox.markFailed(job.id, 'boom', 3), 'queued');
  assert.equal(await Outbox.markFailed(job.id, 'boom', 3), 'failed');
});

test('requeueStuck recovers jobs orphaned by a crash', async () => {
  await Outbox.enqueue({ session: 'c', chatId: 'a@c.us', body: 'x', sendAt: Date.now() - 1 });
  await Outbox.claimNext('c');                 // now 'sending', locked by us
  await Outbox.requeueStuck();                 // simulate a restart
  const reclaimed = await Outbox.claimNext('c');
  assert.equal(reclaimed.body, 'x');
});

/* ------------------------------- messages -------------------------------- */

test('duplicate WhatsApp ids do not create duplicate rows', async () => {
  const msg = { waId: 'ABC123', session: 'm1', chatId: 'a@c.us', direction: 'in', body: 'hello' };
  await Messages.insert(msg);
  await Messages.insert(msg);                  // WhatsApp re-delivers on reconnect
  assert.equal((await Messages.list('m1', 'a@c.us')).length, 1);
});

test('rows without a WhatsApp id are not treated as duplicates', async () => {
  // MySQL allows many NULLs in a UNIQUE index — this is what replaced SQLite's
  // partial index, so verify it actually behaves that way.
  await Messages.insert({ session: 'm2', chatId: 'b@c.us', direction: 'out', body: 'one' });
  await Messages.insert({ session: 'm2', chatId: 'b@c.us', direction: 'out', body: 'two' });
  assert.equal((await Messages.list('m2', 'b@c.us')).length, 2);
});

test('acks only ever move forward', async () => {
  await Messages.insert({ waId: 'ACK1', session: 'm3', chatId: 'b@c.us', direction: 'out', body: 'x', ack: 1 });
  assert.equal((await Messages.setAck('m3', 'ACK1', 3)).ack, 3);
  // A late 'delivered' must not overwrite an existing 'read'.
  assert.equal((await Messages.setAck('m3', 'ACK1', 2)).ack, 3);
});

/* --------------------------------- chats --------------------------------- */

test('chat unread count increments then clears', async () => {
  const at = Date.now();
  await Chats.touch({ session: 'c1', id: 'c@c.us', name: 'Asha', preview: 'one', at, incrementUnread: true });
  const chat = await Chats.touch({ session: 'c1', id: 'c@c.us', preview: 'two', at, incrementUnread: true });
  assert.equal(chat.unread, 2);
  assert.equal(chat.name, 'Asha', 'a later touch without a name must not erase it');

  await Chats.markRead('c1', 'c@c.us');
  assert.equal((await Chats.get('c1', 'c@c.us')).unread, 0);
});

test('tags round-trip as an array', async () => {
  await Chats.touch({ session: 'c2', id: 'd@c.us', preview: 'x', at: Date.now(), incrementUnread: false });
  await Chats.setTags('c2', 'd@c.us', ['vip', 'billing']);
  assert.deepEqual((await Chats.get('c2', 'd@c.us')).tags, ['vip', 'billing']);
});

test('deleting a chat removes its messages and cancels queued sends', async () => {
  const at = Date.now();
  await Chats.touch({ session: 'del', id: 'x@c.us', preview: 'hi', at, incrementUnread: false });
  await Messages.insert({ session: 'del', chatId: 'x@c.us', direction: 'in', body: 'hi', mediaPath: 'f.jpg' });
  const job = await Outbox.enqueue({ session: 'del', chatId: 'x@c.us', body: 'queued', sendAt: at + 99_999 });

  const orphaned = await Chats.remove('del', 'x@c.us');
  assert.deepEqual(orphaned, ['f.jpg'], 'orphaned media is reported for unlinking');
  assert.equal(await Chats.get('del', 'x@c.us'), null);
  assert.equal((await Messages.list('del', 'x@c.us')).length, 0);

  // A still-queued send would otherwise resurrect the conversation.
  const [row] = await Outbox.pending('del');
  assert.equal(row, undefined);
  assert.ok(job.id);
});

/* ---------------------------- rules and users ---------------------------- */

test('session-scoped rules do not leak across sessions', async () => {
  await Rules.create({ session: 'alpha', name: 'a-only', matchType: 'contains', pattern: 'x', reply: 'r' });
  await Rules.create({ session: null, name: 'global', matchType: 'contains', pattern: 'y', reply: 'r' });

  const alpha = (await Rules.active('alpha')).map((r) => r.name).sort();
  assert.deepEqual(alpha, ['a-only', 'global']);
  assert.deepEqual((await Rules.active('beta')).map((r) => r.name), ['global']);
});

test('user creation stores a hash, never the password', async () => {
  const user = await Users.create({ username: 'agent1', passwordHash: hashPassword('pw'), role: 'agent' });
  assert.equal(user.username, 'agent1');
  assert.ok(!('password_hash' in user), 'create must not return the hash');
  assert.ok(!(await Users.byName('agent1')).password_hash.includes('pw'));
});
