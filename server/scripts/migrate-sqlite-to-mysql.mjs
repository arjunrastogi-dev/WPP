/**
 * One-shot migration: copy everything from the old SQLite file into MySQL.
 *
 *   node scripts/migrate-sqlite-to-mysql.mjs [path-to-app.db]
 *
 * Safe to re-run: every insert uses INSERT IGNORE, so rows already migrated are
 * skipped rather than duplicated. The SQLite file is only ever read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { pool, initDb } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlitePath = process.argv[2] ?? path.join(here, '..', 'data', 'app.db');

if (!fs.existsSync(sqlitePath)) {
  console.error(`No SQLite database at ${sqlitePath} — nothing to migrate.`);
  process.exit(1);
}

await initDb();

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const read = (table) => {
  try {
    return sqlite.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    return []; // table absent in an older file
  }
};

/** Insert rows, skipping any that already exist. Returns how many landed. */
async function copy(table, rows, columns) {
  if (!rows.length) return 0;
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  let inserted = 0;
  for (const row of rows) {
    const values = columns.map((c) => (row[c] === undefined ? null : row[c]));
    const [res] = await pool.query(sql, values);
    inserted += res.affectedRows;
  }
  return inserted;
}

const plan = [
  ['users', ['id', 'username', 'password_hash', 'role', 'created_at']],
  ['sessions', ['name', 'status', 'me_id', 'me_name', 'created_at']],
  ['chats', ['session', 'id', 'name', 'is_group', 'unread', 'last_message_at',
    'last_message_preview', 'assigned_to', 'tags']],
  ['messages', ['id', 'wa_id', 'session', 'chat_id', 'direction', 'author', 'body', 'type',
    'media_path', 'media_name', 'mimetype', 'ack', 'timestamp']],
  ['outbox', ['id', 'session', 'chat_id', 'kind', 'body', 'media_path', 'media_name',
    'status', 'attempts', 'last_error', 'send_at', 'created_by', 'created_at']],
  ['rules', ['id', 'session', 'name', 'match_type', 'pattern', 'reply', 'enabled', 'created_at']],
  ['webhooks', ['id', 'url', 'events', 'secret', 'enabled', 'last_status', 'last_attempt_at', 'created_at']],
];

console.log(`Migrating ${sqlitePath} -> MySQL\n`);
let total = 0;
for (const [table, columns] of plan) {
  const rows = read(table);
  const inserted = await copy(table, rows, columns);
  total += inserted;
  const skipped = rows.length - inserted;
  console.log(
    `  ${table.padEnd(10)} ${String(inserted).padStart(4)} copied`
    + (skipped > 0 ? `, ${skipped} already present` : ''),
  );
}

// AUTO_INCREMENT must clear the highest migrated id, or the next insert collides.
for (const table of ['users', 'messages', 'outbox', 'rules', 'webhooks']) {
  const [[{ next }]] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${table}`);
  await pool.query(`ALTER TABLE ${table} AUTO_INCREMENT = ${Number(next)}`);
}

console.log(`\n${total} rows migrated. AUTO_INCREMENT counters realigned.`);
sqlite.close();
await pool.end();
