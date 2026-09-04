import { Router } from 'express';
import { route } from '../http.js';
import { Bots, Templates } from '../store.js';
import {
  advance, triggerMatches, recordingEffects, OPERATORS, BUTTON_LIMITS, LIST_LIMITS,
} from '../bots.js';
import { sheetsReady, readHeaders, toSpreadsheetId } from '../sheets.js';

const router = Router();

const KINDS = new Set([
  'menu', 'prompt', 'message', 'end', 'handoff',
  'condition', 'delay', 'sheets', 'api', 'attributes', 'tags', 'hours', 'template', 'cta',
]);
const CTA_TYPES = new Set(['url', 'call', 'copy']);
const EVENTS = new Set(['message', 'no_match', 'first_daily']);
const OPS = new Set(OPERATORS.map((o) => o.value));

/** Steps that act quietly and pass straight on — they have nothing to say. */
const SILENT = new Set(['condition', 'delay', 'sheets', 'api', 'attributes', 'tags', 'hours', 'template']);
const TRIGGERS = new Set(['contains', 'equals', 'starts', 'regex', 'any']);
const KEY = /^[a-z0-9_-]{1,64}$/i;

function parseBot(body) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };

  const name = String(body?.name ?? '').trim();
  if (!name) bad('Give the bot a name');

  const triggerEvent = String(body?.triggerEvent ?? 'message');
  if (!EVENTS.has(triggerEvent)) bad(`triggerEvent must be one of: ${[...EVENTS].join(', ')}`);

  const triggerType = String(body?.triggerType ?? 'contains');
  if (!TRIGGERS.has(triggerType)) bad(`triggerType must be one of: ${[...TRIGGERS].join(', ')}`);

  // Only a keyword trigger needs a keyword; the other events fire on their own.
  const triggerText = String(body?.triggerText ?? '').trim();
  if (triggerEvent === 'message' && triggerType !== 'any' && !triggerText) {
    bad('Say which word starts the conversation');
  }
  if (triggerType === 'regex') {
    try { new RegExp(triggerText); } catch { bad('That is not a valid regular expression'); }
  }

  const entryKey = String(body?.entryKey ?? 'start').trim();
  if (!KEY.test(entryKey)) bad('The first step needs a simple key like "start"');

  return {
    name,
    session: body?.session ? String(body.session) : null,
    triggerEvent,
    triggerType,
    triggerText,
    entryKey,
    fallback: body?.fallback ? String(body.fallback) : null,
    maxRetries: Number.isInteger(Number(body?.maxRetries)) ? Number(body.maxRetries) : 2,
    timeoutMinutes: Number(body?.timeoutMinutes) > 0 ? Number(body.timeoutMinutes) : 30,
    allowGroups: Boolean(body?.allowGroups),
    enabled: body?.enabled !== false,
  };
}

function parseNode(body) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };

  const key = String(body?.key ?? '').trim();
  if (!KEY.test(key)) bad('A step key may only contain letters, numbers, dash and underscore');

  const kind = String(body?.kind ?? 'menu');
  if (!KINDS.has(kind)) bad(`kind must be one of: ${[...KINDS].join(', ')}`);

  // A condition or a spreadsheet write says nothing, so it has no message to
  // require. Everything a person actually sees does.
  const text = String(body?.body ?? '').trim();
  if (!SILENT.has(kind) && !text) bad('A step needs something to say');

  const config = body?.config && typeof body.config === 'object' ? { ...body.config } : {};
  const nextKey = String(body?.nextKey ?? body?.next_key ?? '').trim() || null;
  let options = [];

  if (kind === 'menu') {
    options = (Array.isArray(body?.options) ? body.options : []).map((o) => ({
      label: String(o.label ?? '').trim(),
      match: String(o.match ?? '').trim(),
      description: String(o.description ?? '').trim(),
      next_key: String(o.next_key ?? o.nextKey ?? '').trim(),
      save_as: o.save_as || o.saveAs || null,
    }));
    if (!options.length) bad('A menu needs at least one option');
    for (const o of options) {
      if (!o.label) bad('Every option needs a label');
      if (!o.next_key) bad(`Option "${o.label}" does not say which step comes next`);
    }

    // A header and footer are worth having whatever shape the menu takes —
    // they render as bold and italic lines in the plain-text version too.
    config.header = String(config.header ?? '').trim().slice(0, 60);
    config.footer = String(config.footer ?? '').trim().slice(0, 60);

    config.display = ['list', 'buttons'].includes(config.display) ? config.display : 'text';

    /*
     * WhatsApp's own limits, enforced here rather than discovered later. A
     * message that breaks them is not rejected — it is silently never
     * delivered, which is far harder to diagnose than a step that refuses to
     * save.
     */
    if (config.display === 'buttons') {
      if (options.length > BUTTON_LIMITS.max) {
        bad(`Quick reply buttons cap at ${BUTTON_LIMITS.max}; this has ${options.length}. Use a tappable list instead.`);
      }
      const long = options.find((o) => o.label.length > BUTTON_LIMITS.labelChars);
      if (long) {
        bad(`"${long.label}" is too long for a button — keep labels to ${BUTTON_LIMITS.labelChars} characters.`);
      }
    }

    if (config.display === 'list') {
      if (options.length > LIST_LIMITS.max) {
        bad(`A tappable list holds ${LIST_LIMITS.max} options; this has ${options.length}. Use the numbered menu instead.`);
      }
      const long = options.find((o) => o.label.length > LIST_LIMITS.labelChars);
      if (long) {
        bad(`"${long.label}" is too long for a list row — keep labels to ${LIST_LIMITS.labelChars} characters.`);
      }
      config.buttonText = String(config.buttonText ?? '').trim().slice(0, 20) || 'Choose an option';
      config.listTitle = String(config.listTitle ?? '').trim() || 'Options';
    }
  }

  if (kind === 'condition') {
    /*
     * Rules are an ordered list and the first match wins, which is what makes
     * if / else-if / else read the way people expect. `nextKey` is the
     * otherwise branch.
     */
    options = (Array.isArray(body?.options) ? body.options : []).map((r) => ({
      field: String(r.field ?? '').trim(),
      op: String(r.op ?? 'equals').trim(),
      value: String(r.value ?? '').trim(),
      next_key: String(r.next_key ?? r.nextKey ?? '').trim(),
    }));
    if (!options.length) bad('A condition needs at least one rule');
    for (const r of options) {
      if (!r.field) bad('Every rule needs an answer to check');
      if (!OPS.has(r.op)) bad(`"${r.op}" is not a comparison this understands`);
      if (!r.next_key) bad(`The rule on "${r.field}" does not say where it leads`);
      // "was answered" and "was not answered" take no value; the rest need one.
      if (!['empty', 'not_empty'].includes(r.op) && !r.value) {
        bad(`The rule on "${r.field}" needs something to compare against`);
      }
    }
    if (!nextKey) bad('A condition needs an "otherwise" step for when no rule matches');
  }

  if (kind === 'delay') {
    const seconds = Number(config.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) bad('A delay needs a number of seconds');
    if (seconds > 86400) bad('A delay longer than a day will outlive the conversation');
    config.seconds = seconds;
    if (!nextKey) bad('A delay must say which step comes next');
  }

  if (kind === 'sheets') {
    config.spreadsheetId = toSpreadsheetId(config.spreadsheetId ?? '');
    if (!config.spreadsheetId) bad('Paste the spreadsheet link or its id');
    config.sheetName = String(config.sheetName ?? '').trim() || 'Sheet1';
    config.columns = (Array.isArray(config.columns) ? config.columns : []).map((c) => ({
      header: String(c.header ?? '').trim(),
      value: String(c.value ?? '').trim(),
    }));
    if (!config.columns.length) bad('Choose at least one column to write');
    if (!nextKey) bad('A spreadsheet step must say which step comes next');
  }

  if (kind === 'attributes') {
    options = (Array.isArray(body?.options) ? body.options : []).map((a) => ({
      field: String(a.field ?? '').trim(),
      value: String(a.value ?? ''),
      remove: Boolean(a.remove),
    }));
    if (!options.length) bad('Add at least one thing to remember');
    for (const a of options) if (!a.field) bad('Every attribute needs a name');
    if (!nextKey) bad('This step must say which step comes next');
  }

  if (kind === 'tags') {
    const clean = (list) => (Array.isArray(list) ? list : [])
      .map((t) => String(t).trim()).filter(Boolean);
    config.add = clean(config.add);
    config.remove = clean(config.remove);
    if (!config.add.length && !config.remove.length) bad('Add or remove at least one tag');
    if (!nextKey) bad('This step must say which step comes next');
  }

  if (kind === 'api') {
    config.url = String(config.url ?? '').trim();
    if (!/^https?:\/\//i.test(config.url)) bad('The API address must start with http:// or https://');
    config.method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
      .includes(String(config.method ?? '').toUpperCase())
      ? String(config.method).toUpperCase() : 'GET';
    config.save = (Array.isArray(config.save) ? config.save : [])
      .map((m) => ({ field: String(m.field ?? '').trim(), path: String(m.path ?? '').trim() }))
      .filter((m) => m.field && m.path);
    if (!nextKey) bad('This step must say which step comes next');
  }

  if (kind === 'hours') {
    config.days = (Array.isArray(config.days) ? config.days : [1, 2, 3, 4, 5])
      .map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!config.days.length) bad('Pick at least one working day');
    for (const key of ['from', 'to']) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(config[key] ?? ''))) {
        bad(`The ${key} time must look like 09:00`);
      }
    }
    config.timezone = String(config.timezone ?? '').trim() || 'Asia/Kolkata';
    if (!nextKey) bad('Say which step runs during working hours');
    if (!String(config.closedKey ?? '').trim()) bad('Say which step runs outside working hours');
  }

  if (kind === 'cta') {
    config.header = String(config.header ?? '').trim().slice(0, 60);
    config.footer = String(config.footer ?? '').trim().slice(0, 60);

    options = (Array.isArray(body?.options) ? body.options : []).map((o) => ({
      label: String(o.label ?? '').trim(),
      cta: String(o.cta ?? 'url').trim(),
      value: String(o.value ?? '').trim(),
    }));

    if (!options.length) bad('Add at least one button');
    if (options.length > 3) {
      bad(`WhatsApp allows three action buttons; this has ${options.length}.`);
    }

    for (const o of options) {
      if (!o.label) bad('Every button needs a label');
      if (o.label.length > 20) bad(`"${o.label}" is too long for a button — keep labels to 20 characters.`);
      if (!CTA_TYPES.has(o.cta)) bad(`"${o.cta}" is not a kind of action button`);

      if (o.cta === 'url' && !/^https?:\/\//i.test(o.value)) {
        bad(`"${o.label}" needs a web address starting with http:// or https://`);
      }
      /*
       * A call button dials exactly what it is given, so it has to be a full
       * international number. A local one silently fails on any phone that is
       * not in the same country.
       */
      if (o.cta === 'call' && !/^\+?[1-9]\d{7,15}$/.test(o.value.replace(/[\s-]/g, ''))) {
        bad(`"${o.label}" needs a phone number in full international form, such as +918860924275`);
      }
      if (o.cta === 'copy' && !o.value) bad(`"${o.label}" needs a code to copy`);
    }

    if (!nextKey) bad('An action-button step must say which step comes next');
  }

  if (kind === 'template') {
    config.templateKey = String(config.templateKey ?? '').trim();
    if (!config.templateKey) bad('Choose a template to send');
    if (!nextKey) bad('This step must say which step comes next');
  }

  if ((kind === 'prompt' || kind === 'message') && !nextKey) {
    bad(`A "${kind}" step must say which step comes next`);
  }
  if (kind === 'prompt' && !String(body?.saveAs ?? body?.save_as ?? '').trim()) {
    bad('A question step must say what to call the answer it saves');
  }

  return {
    key,
    kind,
    body: text,
    options,
    config,
    saveAs: String(body?.saveAs ?? body?.save_as ?? '').trim() || null,
    nextKey,
    sort: Number(body?.sort ?? 0),
    x: Number(body?.x ?? 0),
    y: Number(body?.y ?? 0),
  };
}

async function mine(req, res) {
  const bot = await Bots.get(Number(req.params.id));
  if (!bot) {
    res.status(404).json({ error: `No bot ${req.params.id}` });
    return null;
  }
  if (bot.owner_id && bot.owner_id !== req.user.id && req.user.role !== 'admin') {
    res.status(403).json({ error: 'That bot belongs to someone else' });
    return null;
  }
  return bot;
}

/* --------------------------------- bots ---------------------------------- */

router.get('/', route(async (req, res) => {
  const list = await Bots.list({ userId: req.user.id, isAdmin: req.user.role === 'admin' });
  const withCounts = await Promise.all(list.map(async (b) => ({
    ...b,
    steps: (await Bots.nodes(b.id)).length,
  })));
  res.json(withCounts);
}));

router.post('/', route(async (req, res) => {
  let draft;
  try { draft = parseBot(req.body); } catch (e) { return res.status(e.status ?? 400).json({ error: e.message }); }
  res.status(201).json(await Bots.create({ ...draft, ownerId: req.user.id }));
}));

router.get('/:id', route(async (req, res) => {
  const bot = await mine(req, res);
  if (bot) res.json({ ...bot, nodes: await Bots.nodes(bot.id) });
}));

router.put('/:id', route(async (req, res) => {
  if (!(await mine(req, res))) return;
  let draft;
  try { draft = parseBot(req.body); } catch (e) { return res.status(e.status ?? 400).json({ error: e.message }); }
  res.json(await Bots.update(Number(req.params.id), draft));
}));

router.post('/:id/toggle', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;
  await Bots.setEnabled(bot.id, req.body?.enabled ?? !bot.enabled);
  res.json(await Bots.get(bot.id));
}));

router.delete('/:id', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;
  await Bots.remove(bot.id);
  res.json({ ok: true });
}));

/* --------------------------------- steps --------------------------------- */

router.get('/:id/nodes', route(async (req, res) => {
  const bot = await mine(req, res);
  if (bot) res.json(await Bots.nodes(bot.id));
}));

router.put('/:id/nodes/:key', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;

  let node;
  try {
    node = parseNode({ ...req.body, key: req.params.key });
  } catch (e) {
    return res.status(e.status ?? 400).json({ error: e.message });
  }

  await Bots.upsertNode(bot.id, node);
  res.json(await Bots.node(bot.id, node.key));
}));

router.delete('/:id/nodes/:key', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;

  if (req.params.key === bot.entry_key) {
    return res.status(400).json({ error: 'That is the first step — point the bot somewhere else first' });
  }
  await Bots.removeNode(bot.id, req.params.key);
  res.json({ ok: true });
}));

/**
 * GET /api/bots/:id/check — find the mistakes a flow editor makes easy.
 *
 * A step pointing at a key that no longer exists is invisible until someone
 * reaches it in a real conversation, which is the worst possible time.
 */
router.get('/:id/check', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;

  const nodes = await Bots.nodes(bot.id);
  const keys = new Set(nodes.map((n) => n.node_key));
  const problems = [];

  if (!nodes.length) problems.push({ where: bot.entry_key, error: 'This bot has no steps yet' });
  else if (!keys.has(bot.entry_key)) {
    problems.push({ where: bot.entry_key, error: `The first step "${bot.entry_key}" does not exist` });
  }

  /*
   * Only a menu and a condition keep edges in `options`. Everywhere else the
   * list holds data — the fields an attributes step sets, the links a cta step
   * offers — and reading those as arrows reported a fault on every one of them.
   */
  const BRANCHING = new Set(['menu', 'condition']);

  // Steps that carry on, versus steps that are meant to be the last word.
  const MUST_CONTINUE = new Set([
    'prompt', 'message', 'delay', 'sheets', 'condition',
    'api', 'attributes', 'tags', 'hours', 'template', 'cta',
  ]);

  for (const n of nodes) {
    if (MUST_CONTINUE.has(n.kind) && !n.next_key) {
      problems.push({
        where: n.node_key,
        error: n.kind === 'condition'
          ? 'Has no "otherwise" step, so an answer matching no rule stops here'
          : 'Does not continue anywhere, so the conversation stops here',
      });
    }
    if (n.next_key && !keys.has(n.next_key)) {
      problems.push({ where: n.node_key, error: `Points at "${n.next_key}", which does not exist` });
    }
    for (const extra of ['closedKey', 'onError']) {
      const target = n.config?.[extra];
      if (target && !keys.has(target)) {
        problems.push({ where: n.node_key, error: `Points at "${target}", which does not exist` });
      }
    }
    if (BRANCHING.has(n.kind)) {
      for (const o of n.options ?? []) {
        if (!keys.has(o.next_key)) {
          const which = o.label || `${o.field} ${o.op} ${o.value}`.trim();
          problems.push({
            where: n.node_key,
            error: `"${which}" points at "${o.next_key}", which does not exist`,
          });
        }
      }
    }
  }

  // Anything nobody can walk to is dead weight, and usually a typo.
  const reachable = new Set();
  const queue = [bot.entry_key];
  while (queue.length) {
    const key = queue.shift();
    if (reachable.has(key) || !keys.has(key)) continue;
    reachable.add(key);
    const node = nodes.find((n) => n.node_key === key);
    if (node.next_key) queue.push(node.next_key);

    /*
     * The second exits. A working-hours step leaves through `closedKey` and an
     * API step through `onError`; without these, the only steps that handle
     * "closed" and "it broke" looked like dead weight.
     */
    if (node.config?.closedKey) queue.push(node.config.closedKey);
    if (node.config?.onError) queue.push(node.config.onError);

    if (BRANCHING.has(node.kind)) {
      for (const o of node.options ?? []) queue.push(o.next_key);
    }
  }

  const orphans = nodes.filter((n) => !reachable.has(n.node_key)).map((n) => n.node_key);
  res.json({ ok: problems.length === 0, problems, orphans });
}));

/* ------------------------------ the try console --------------------------- */

/*
 * Test conversations live in memory, keyed by user and bot.
 *
 * Deliberately not in the database: a rehearsal is not a conversation with a
 * real person, and mixing the two would poison the transcripts people use to
 * see how the flow is actually going.
 */
const rehearsals = new Map();

router.post('/:id/try', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;

  const nodes = await Bots.nodes(bot.id);
  if (!nodes.length) return res.status(400).json({ error: 'Add a step first' });

  const slot = `${req.user.id}:${bot.id}`;
  if (req.body?.reset) rehearsals.delete(slot);

  const text = String(req.body?.text ?? '');
  const state = rehearsals.get(slot) ?? null;

  // Outside a conversation, the trigger still has to match — otherwise the
  // console would happily test a bot that never actually starts.
  if (!state && !triggerMatches(bot, text)) {
    return res.json({
      started: false,
      replies: [],
      note: `Nothing happened — this bot starts when a message ${bot.trigger_type} "${bot.trigger_text}".`,
    });
  }

  // Recorders instead of the real world: a rehearsal must not add rows to
  // anyone's live spreadsheet.
  const performed = [];
  const result = await advance({
    bot, nodes, state, text, effects: recordingEffects(performed),
  });

  // Remember where the rehearsal got to, or forget it once the flow has ended
  // so the next message starts a fresh run rather than resuming a finished one.
  if (result.state.node_key) rehearsals.set(slot, result.state);
  else rehearsals.delete(slot);

  res.json({
    started: true,
    replies: result.replies.map((r) => r.text),
    waitingAt: result.state.node_key,
    status: result.state.status,
    variables: result.state.variables,
    looped: Boolean(result.looped),
    // What the flow did along the way — which branch a condition took, what
    // would have been written where. Invisible otherwise, and the usual reason
    // a flow "does nothing".
    notes: [...result.notes, ...performed],
    delaySeconds: Math.round((result.delayMs ?? 0) / 1000),
  });
}));

/* ------------------------------ conversations ----------------------------- */

router.get('/:id/conversations', route(async (req, res) => {
  const bot = await mine(req, res);
  if (bot) res.json(await Bots.conversations(bot.id, Number(req.query.limit ?? 30)));
}));

router.get('/:id/conversations/:chatRowId', route(async (req, res) => {
  const bot = await mine(req, res);
  if (bot) res.json(await Bots.transcript(Number(req.params.chatRowId)));
}));

/**
 * POST /api/bots/example — a complete recruitment screening flow, ready to edit.
 *
 * Deliberately exercises every message shape WhatsApp offers and every action
 * this builder can perform, because the fastest way to understand the
 * difference between a quick reply and a list is to open one that runs and
 * change it.
 *
 * Every menu is a tappable list, and that choice is evidence-based rather than
 * a preference. Probing a real WhatsApp Web session showed lists arriving and
 * being tapped, while quick reply buttons and action buttons were accepted by
 * the server and never delivered — their acks stopped at 1 while the text and
 * list messages reached 3.
 *
 * Run POST /api/sessions/<name>/probe against your own number before changing
 * this: what a given account may send is not fixed, and a refusal is silent.
 *
 * and around them: a condition, saved attributes, chat tags, a spreadsheet
 * row, a template, a delay, an API lookup and a hand-over.
 */
router.post('/example', route(async (req, res) => {
  /*
   * The flow sends a template, so it has to be sure one exists. The seeded
   * templates are all clinic bookings; borrowing one of those would send a
   * candidate an appointment confirmation.
   */
  const TEMPLATE_KEY = 'interview_invite';
  if (!(await Templates.byKey(TEMPLATE_KEY))) {
    await Templates.create({
      templateKey: TEMPLATE_KEY,
      name: 'Interview invitation',
      description: 'Sent when a candidate picks an interview slot.',
      body: 'Hi {{name}},\n\nYour interview for the *{{role}}* role is confirmed for *{{slot}}*.\n\nPlease bring a photo ID and a printed copy of your CV. If you need to change the time, just reply here.\n\nCity Care Clinic',
    });
  }

  const bot = await Bots.create({
    name: 'Interview screening',
    session: req.body?.session ?? null,
    triggerEvent: 'message',
    triggerType: 'contains',
    triggerText: 'hi',
    entryKey: 'welcome',
    fallback: "Sorry, I did not follow that. One of our recruiters will pick this up shortly.",
    maxRetries: 2,
    timeoutMinutes: 30,
    ownerId: req.user.id,
  });

  const steps = [
    /*
     * No opening-hours gate.
     *
     * The flow answers the same way at every hour: an application can be
     * started at midnight just as well as at midday, and telling someone the
     * team is unavailable only invites them to leave without applying. The
     * "Working hours" action is still in the palette if a different flow ever
     * wants one.
     */

    /* ------------------ reply buttons: a short, clear menu ---------------- */
    {
      key: 'welcome', kind: 'menu', sort: 0, x: -360, y: 320,
      body: 'What would you like to do?',
      config: { display: 'list', buttonText: 'Choose an option', listTitle: 'Careers', header: 'City Care Careers', footer: 'We reply within one working day' },
      options: [
        { label: 'Apply for a role', match: 'apply', next_key: 'ask_name' },
        { label: 'Check my status', match: 'status', next_key: 'ask_ref' },
        { label: 'Talk to a person', match: 'person', next_key: 'human' },
      ],
    },

    /* --------------------------- text questions -------------------------- */
    {
      key: 'ask_name', kind: 'prompt', sort: 1, x: 40, y: 40, saveAs: 'name',
      body: 'Great — this takes about a minute.\n\nWhat is your full name?',
      nextKey: 'ask_qual',
    },

    /* ------------- reply buttons again: three short options -------------- */
    {
      key: 'ask_qual', kind: 'menu', sort: 4, x: 720, y: 40,
      body: 'Thanks {{name}}. What is your highest qualification?',
      config: { display: 'list', buttonText: 'Choose one', listTitle: 'Qualification' },
      options: [
        { label: '10th', match: '10th', next_key: 'ask_role', save_as: 'qualification' },
        { label: '12th', match: '12th', next_key: 'ask_role', save_as: 'qualification' },
        { label: 'Graduate or above', match: 'graduate', next_key: 'ask_role', save_as: 'qualification' },
      ],
    },

    /* ------- a list: five roles, and labels too long for buttons --------- */
    {
      key: 'ask_role', kind: 'menu', sort: 5, x: 1060, y: 40,
      body: 'Which role are you applying for?',
      config: {
        display: 'list', buttonText: 'See open roles', listTitle: 'Open positions',
      },
      options: [
        { label: 'Registered Nurse', match: 'nurse', next_key: 'check_clinical', save_as: 'role', description: 'Full time, rotating shifts' },
        { label: 'Lab Technician', match: 'lab', next_key: 'check_clinical', save_as: 'role', description: 'Full time, day shift' },
        { label: 'Radiology Assistant', match: 'radiology', next_key: 'check_clinical', save_as: 'role', description: 'Full time, day shift' },
        { label: 'Front Desk Coordinator', match: 'front desk', next_key: 'check_clinical', save_as: 'role', description: 'Full time, rotating shifts' },
        { label: 'Pharmacist', match: 'pharmacist', next_key: 'check_clinical', save_as: 'role', description: 'Part time considered' },
      ],
    },

    /* ------------------- a branch on what they answered ------------------ */
    {
      key: 'check_clinical', kind: 'condition', sort: 6, x: 1420, y: 40, body: '',
      options: [
        { field: 'role', op: 'contains', value: 'nurse', next_key: 'ask_licence' },
        { field: 'role', op: 'contains', value: 'lab', next_key: 'ask_licence' },
        { field: 'role', op: 'contains', value: 'radiology', next_key: 'ask_licence' },
        { field: 'role', op: 'contains', value: 'pharmacist', next_key: 'ask_licence' },
      ],
      nextKey: 'ask_experience',
    },
    {
      key: 'ask_licence', kind: 'prompt', sort: 7, x: 1420, y: 340, saveAs: 'licence',
      body: 'That role is a clinical one, so we need your registration or licence number.\n\nWhat is it?',
      nextKey: 'ask_experience',
    },
    {
      key: 'ask_experience', kind: 'menu', sort: 8, x: 1780, y: 180,
      body: 'How much experience do you have in this field?',
      config: { display: 'list', buttonText: 'Choose one', listTitle: 'Experience' },
      options: [
        { label: 'Under 1 year', match: 'under', next_key: 'remember', save_as: 'experience' },
        { label: '1 to 5 years', match: '1 to 5', next_key: 'remember', save_as: 'experience' },
        { label: 'Over 5 years', match: 'over', next_key: 'remember', save_as: 'experience' },
      ],
    },

    /* --------------------- quiet steps that do work ---------------------- */
    {
      key: 'remember', kind: 'attributes', sort: 9, x: 2120, y: 180, body: '',
      options: [
        { field: 'source', value: 'WhatsApp bot' },
        { field: 'stage', value: 'Screened' },
      ],
      nextKey: 'tag_applicant',
    },
    {
      key: 'tag_applicant', kind: 'tags', sort: 10, x: 2440, y: 180, body: '',
      config: { add: ['applicant', '{{role}}'], remove: ['new-enquiry'] },
      nextKey: 'slot_menu',
    },
    {
      key: 'save_row', kind: 'sheets', sort: 12, x: 3120, y: 180, body: '',
      config: {
        spreadsheetId: '',
        sheetName: 'Applicants',
        columns: [
          { header: 'Name', value: '{{name}}' },
          { header: 'Qualification', value: '{{qualification}}' },
          { header: 'Role', value: '{{role}}' },
          { header: 'Licence', value: '{{licence}}' },
          { header: 'Experience', value: '{{experience}}' },
          { header: 'Slot', value: '{{slot}}' },
          { header: 'Source', value: '{{source}}' },
        ],
      },
      nextKey: 'invite',
    },

    /* ---------------- a second list: the interview slots ----------------- */
    {
      key: 'slot_menu', kind: 'menu', sort: 11, x: 2760, y: 180,
      body: 'Almost done. When would you like your first interview call?',
      config: { display: 'list', buttonText: 'Pick a time', listTitle: 'Available slots' },
      options: [
        { label: 'Tomorrow, 10:00', match: 'tomorrow 10', next_key: 'save_row', save_as: 'slot' },
        { label: 'Tomorrow, 15:00', match: 'tomorrow 15', next_key: 'save_row', save_as: 'slot' },
        { label: 'Day after, 11:00', match: 'day after 11', next_key: 'save_row', save_as: 'slot' },
        { label: 'Day after, 16:00', match: 'day after 16', next_key: 'save_row', save_as: 'slot' },
        { label: 'Someone should call me', match: 'call me', next_key: 'save_row', save_as: 'slot' },
      ],
    },

    /* ------------------------ a saved template --------------------------- */
    {
      key: 'invite', kind: 'template', sort: 13, x: 3440, y: 180, body: '',
      config: { templateKey: TEMPLATE_KEY },
      nextKey: 'hold',
    },
    {
      key: 'hold', kind: 'delay', sort: 14, x: 3760, y: 180, body: '',
      config: { seconds: 3 },
      nextKey: 'apply_cta',
    },

    /* ------------- action buttons: a link, a call, a code ---------------- */
    {
      key: 'apply_cta', kind: 'cta', sort: 15, x: 4040, y: 180,
      body: 'A few things that might help before we speak.',
      config: { header: 'Before your interview', footer: 'Quote your code if you call' },
      options: [
        { label: 'Read the role', cta: 'url', value: 'https://example.com/careers' },
        { label: 'Call our HR team', cta: 'call', value: '+918860924275' },
        { label: 'Copy your code', cta: 'copy', value: 'CARE-2026' },
      ],
      nextKey: 'done',
    },
    {
      key: 'done', kind: 'end', sort: 16, x: 4400, y: 180,
      body: 'That is everything, {{name}} — thank you. You will get a confirmation from our team before your call.',
    },

    /* ----------------- the second branch: checking status ---------------- */
    {
      key: 'ask_ref', kind: 'prompt', sort: 17, x: 40, y: 660, saveAs: 'reference',
      body: 'Of course. What is your application reference?\n\nIt looks like CARE-2026.',
      nextKey: 'lookup',
    },
    {
      key: 'lookup', kind: 'api', sort: 18, x: 720, y: 660, body: '',
      config: {
        url: 'https://example.com/api/applications/{{reference}}',
        method: 'GET',
        save: [{ path: 'data.stage', field: 'stage' }],
        onError: 'status_unknown',
      },
      nextKey: 'status_reply',
    },
    {
      key: 'status_reply', kind: 'message', sort: 19, x: 1060, y: 660,
      body: 'Your application {{reference}} is currently at the *{{stage}}* stage.',
      nextKey: 'status_cta',
    },
    {
      key: 'status_unknown', kind: 'message', sort: 20, x: 720, y: 920,
      body: 'I could not reach our system just now, so I cannot check {{reference}} automatically. Our team can look it up for you.',
      nextKey: 'status_cta',
    },
    {
      key: 'status_cta', kind: 'cta', sort: 21, x: 1400, y: 660,
      body: 'Anything else you need?',
      config: { footer: 'City Care Clinic' },
      options: [
        { label: 'Open the portal', cta: 'url', value: 'https://example.com/careers/status' },
        { label: 'Call our HR team', cta: 'call', value: '+918860924275' },
      ],
      nextKey: 'status_done',
    },
    {
      /*
       * The status branch needs its own goodbye. Sharing the applicant's one
       * greeted people by a name this branch never asks for, so it signed off
       * with "That is everything,  — thank you."
       */
      key: 'status_done', kind: 'end', sort: 22, x: 1760, y: 660,
      body: 'Thanks for checking in. If anything changes with your application, we will message you here.',
    },

    /* ---------------------------- hand over ------------------------------ */
    {
      key: 'human', kind: 'handoff', sort: 23, x: -360, y: 660,
      body: 'No problem — I have passed this to a recruiter and someone will reply here shortly.',
    },
  ];

  for (const step of steps) await Bots.upsertNode(bot.id, step);
  res.status(201).json({ ...bot, nodes: await Bots.nodes(bot.id) });
}));

/* --------------------------------- canvas -------------------------------- */

/**
 * PUT /api/bots/:id/layout — where the boxes sit.
 *
 * Position is presentation, not behaviour, so this deliberately touches
 * nothing else. Dragging a box must never be able to change what a flow does.
 */
router.put('/:id/layout', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;

  const moves = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
  for (const m of moves) {
    if (!KEY.test(String(m.key ?? ''))) continue;
    await Bots.moveNode(bot.id, m.key, Number(m.x) || 0, Number(m.y) || 0);
  }
  res.json({ ok: true, moved: moves.length });
}));

/**
 * PUT /api/bots/:id/connect — draw one arrow between two steps.
 *
 * `handle` says which outlet was dragged: "next" is the step's own
 * continuation, "opt:2" is its third menu option or condition rule. Passing a
 * null `to` cuts the arrow instead.
 */
router.put('/:id/connect', route(async (req, res) => {
  const bot = await mine(req, res);
  if (!bot) return;

  const from = await Bots.node(bot.id, String(req.body?.from ?? ''));
  if (!from) return res.status(404).json({ error: 'That step no longer exists' });

  const to = req.body?.to ? String(req.body.to) : null;
  if (to && !(await Bots.node(bot.id, to))) {
    return res.status(404).json({ error: `There is no step called "${to}"` });
  }

  const handle = String(req.body?.handle ?? 'next');
  const options = [...(from.options ?? [])];
  let nextKey = from.next_key;

  if (handle === 'next') {
    // An ending is the end. The canvas draws no outlet for one, and the API
    // should not quietly accept what the canvas cannot express.
    if (['end', 'handoff'].includes(from.kind)) {
      return res.status(400).json({
        error: `"${from.node_key}" ends the conversation, so nothing can follow it`,
      });
    }
    nextKey = to;
  } else {
    const index = Number(handle.split(':')[1]);
    if (!options[index]) return res.status(400).json({ error: 'That outlet no longer exists' });
    options[index] = { ...options[index], next_key: to ?? '' };
  }

  await Bots.upsertNode(bot.id, {
    key: from.node_key,
    kind: from.kind,
    body: from.body,
    options,
    config: from.config,
    saveAs: from.save_as,
    nextKey,
    sort: from.sort,
    x: from.pos_x,
    y: from.pos_y,
  });

  res.json(await Bots.node(bot.id, from.node_key));
}));

/* ------------------------------ google sheets ----------------------------- */

/** Whether Sheets is set up at all, and which account to share sheets with. */
router.get('/sheets/status', route(async (req, res) => res.json(sheetsReady())));

/**
 * POST /api/bots/sheets/headers — read row 1 of a sheet.
 *
 * So the builder can offer the real column names instead of asking someone to
 * type them again and hope they match.
 */
router.post('/sheets/headers', route(async (req, res) => {
  try {
    const spreadsheetId = toSpreadsheetId(req.body?.spreadsheetId ?? '');
    const headers = await readHeaders({ spreadsheetId, sheetName: req.body?.sheetName });
    res.json({ ok: true, spreadsheetId, headers });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

export default router;
