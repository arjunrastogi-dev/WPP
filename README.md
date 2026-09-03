# WPP Inbox

A shared team inbox for WhatsApp, built on [WPPConnect](https://wppconnect.io/).
Multiple numbers, persistent history, agent assignment, auto-replies, a
rate-limited send queue, scheduling, media and outbound webhooks.

React + Vite on the front, Node + Express + MySQL on the back.

---

## The one thing to understand first

**WPPConnect cannot run in the browser.** It is a Node.js library that drives a
real WhatsApp Web page inside a Puppeteer-controlled Chromium. There is no
official WhatsApp API involved — it automates the web client.

So the architecture is always two pieces:

```
  React (Vite)  ──HTTP + JWT──▶  Node server  ──Puppeteer──▶  Chromium
   localhost:5173 ◀──Socket.IO──   localhost:3001              web.whatsapp.com
                                        │
                                 MySQL / MariaDB (history, queue, rules)
```

The React app never imports `@wppconnect-team/wppconnect`. If you try, Vite
will fail on Node built-ins — that is the architecture talking, not a bug.

## Run it

**Prerequisite:** MySQL or MariaDB running (XAMPP is fine — start MySQL from its
control panel), with the database created once:

```sql
CREATE DATABASE wppinbox CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Copy `server/.env.example` to `server/.env` if your credentials differ from
XAMPP's default (`root`, empty password). Then:

```bash
npm run install:all   # first time only
npm run dev           # server on :3001, client on :5173
```

Tables are created automatically on first boot. Coming from the old SQLite
build? `npm --prefix server run migrate` copies `server/data/app.db` across —
it is re-runnable and never writes to the SQLite file.

Open http://localhost:5173 and sign in with **admin / admin123**.
Then: **Sessions → Create session → Start → scan the QR** with
WhatsApp → Settings → Linked devices → Link a device.

Logins persist in `server/tokens/`, so restarts reconnect without a new QR.

```bash
npm --prefix server test    # 13 unit tests, no WhatsApp connection needed
npm --prefix server run smoke   # drives the real UI in headless Chrome (needs `npm run dev` running)
```

## What's in here

| Feature | Where |
|---|---|
| **Persistent history** | MySQL / MariaDB via `mysql2`, with a connection pool |
| **Shared inbox UI** | Conversation sidebar, threaded view, unread badges, search |
| **Auth** | JWT on both REST *and* the Socket.IO handshake; scrypt password hashing |
| **Rate-limited queue** | Every send is spaced 3–7s apart, with retries and crash recovery |
| **Multi-process safe** | Queue jobs are claimed atomically, so several workers never send the same message twice |
| **Scheduling** | A queue row with `send_at` in the future — same table, no extra machinery |
| **Media** | Send and receive images and files; inbound media saved to disk |
| **Delivery receipts** | `onAck` → the sent / delivered / read ticks |
| **Multi-session** | Several WhatsApp numbers at once, each with its own browser |
| **Auto-replies** | contains / equals / starts-with / regex → templated reply |
| **Assignment & tags** | Claim a conversation, tag it for triage |
| **Webhooks** | Forward events to any URL, HMAC-SHA256 signed |

## Layout

```
server/
  src/
    config.js      env-driven configuration
    db.js          MySQL pool, schema and repair migrations
    store.js       all queries, grouped by table (every method async)
    auth.js        scrypt hashing, JWT, Express + Socket.IO guards
    whatsapp.js    multi-session manager, message persistence, media
    queue.js       rate-limited sender + scheduler
    rules.js       auto-reply engine
    webhooks.js    signed outbound dispatch
    events.js      in-process bus (keeps imports acyclic)
    routes/        one file per resource
  test/            16 unit tests (run against a throwaway `wppinbox_test` DB)
  scripts/         SQLite->MySQL migration, headless-browser UI smoke test
client/
  src/
    api.js               REST wrapper + authenticated socket
    AuthContext.jsx      login state
    SessionContext.jsx   active session + live status
    pages/               Login, Inbox, Sessions, Rules, Scheduled, Webhooks
    components/          ChatList, Thread, Composer, ChatHeader, …
```

## Why the queue exists

It is the most important part of this codebase, and the least obvious.

WhatsApp bans numbers that send in tight loops. So no route ever calls
`sendText` directly — routes enqueue, and a single worker drains at a
randomised 3–7s interval per session. That gives you retries with backoff,
crash recovery (`requeueStuck` on boot), cancellation, and scheduling as a
side effect. Auto-replies go through the same queue, so a burst of inbound
traffic can't become a burst of outbound traffic.

If you add bulk sending, build it on top of this queue. Never loop over
`sendText`.

## Configuration

Copy `server/.env.example` to `server/.env` and edit. The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | `dev-only-change-me` | **Change this.** Signs every token |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin123` | Seed login, created on first boot only |
| `HEADLESS` | `true` | `false` shows the real Chromium — the best way to learn what WPPConnect does |
| `QUEUE_MIN_DELAY_MS` / `QUEUE_MAX_DELAY_MS` | `3000` / `7000` | Gap between sends |
| `CHROME_PATH` | — | Use installed Chrome instead of puppeteer's |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `3306` / `root` / _(empty)_ / `wppinbox` | Database connection |

## API

All routes are under `/api` and need `Authorization: Bearer <token>`, except
`/api/auth/login` and `/api/health`.

```
POST   /auth/login                      → { token, user }
GET    /sessions                        list sessions and live status
POST   /sessions/:name/start|stop       lifecycle (start returns immediately)
GET    /chats/:session                  inbox sidebar
GET    /chats/:session/:chatId/messages paged history
POST   /chats/:session/:chatId/assign   assign to an agent
POST   /messages/:session/send          JSON or multipart; queues the send
GET    /outbox/:session                 queued, scheduled and failed jobs
GET/POST/PATCH/DELETE /rules            auto-replies
GET/POST/PATCH/DELETE /webhooks         outbound webhooks
```

Socket.IO events: `status`, `qr`, `message`, `ack`, `chat`, `outbox`, `sessions`.
Clients `emit('subscribe', sessionName)` to join a session's room.

### Webhook payloads

```json
{ "event": "message", "sentAt": "2026-08-27T…", "data": { "session": "sales", "message": {…} } }
```

Verify with the `X-Wpp-Signature` header (`sha256=<hmac>`) over the raw body.

## Phone number format

WhatsApp ids look like `918860924275@c.us` — **always include the country
code**; there is no default. A bare 10-digit number fails silently, so
`/messages/:session/send` asks WhatsApp via `checkNumberStatus` first and
returns a clear error instead.

`@lid` ids (WhatsApp's newer privacy-preserving identity format) pass through
`toChatId()` untouched. Their digits are *not* a phone number — never
reformat them.

## Things that will bite you

- **`tokens/` is credentials.** That folder is a live WhatsApp login — anyone
  holding it is signed into your WhatsApp. It is gitignored; keep it that way.
- **MySQL must be running before the server starts.** Boot fails fast with a
  clear message if it isn't — start MySQL in the XAMPP control panel.
- **Use a spare number.** This automates the web client, not the official
  Business API. WhatsApp bans accounts for automated bulk messaging — read
  their terms before going beyond learning.
- **WhatsApp Web updates break things.** When something stops working after
  months, update first: `npm --prefix server update`.
- **`Version not available for 2.3000.x, using latest as fallback`** on boot is
  benign — WPPConnect falls back and works.
- **`No LID for user …`** in the browser console comes from WhatsApp's own
  bundle, not this app. Harmless.
- **npm 11 blocks install scripts.** If a fresh clone can't launch a browser:
  `npm --prefix server approve-scripts puppeteer && npm --prefix server rebuild puppeteer`
- **One browser per session name.** Each session needs ~400MB of RAM, so a
  dozen sessions is a real server, not a laptop tab.

## Where to go next

- **Docker** — Chromium in a container is genuinely fiddly and worth learning
- **Message search across sessions** — the `messages` table is already indexed
- **Analytics** — response time, messages per agent, busiest hours
- **Flow builder** — multi-step conversations rather than single-shot replies
- **`wppconnect-server`** — the official ready-made REST API; compare it to
  what you built here
- **Baileys** — talks the WhatsApp protocol over WebSocket with no browser at
  all, in tens of MB instead of a gigabyte

Docs: <https://wppconnect.io/wppconnect/> · Source: <https://github.com/wppconnect-team/wppconnect>
