import { Bots, ChatTags } from './store.js';
import { all } from './db.js';
import { enqueue } from './queue.js';
import { appendRow } from './sheets.js';
import { renderTemplate } from './templates.js';

/**
 * The bot engine.
 *
 * The difference between this and the auto-reply rules is memory. A rule sees
 * one message and answers it. A bot knows which question it just asked, so a
 * bare "2" can mean "Tell me about the interview process" — and that is the
 * whole reason menus work over WhatsApp.
 *
 * The engine is deliberately split in two. `advance()` decides what happens
 * and reaches the outside world only through the `effects` it is handed;
 * `handle()` supplies the real ones. That is what lets the builder's test
 * console run a genuine conversation — conditions, delays and all — while
 * writing nothing to a spreadsheet and sending nothing to WhatsApp.
 */

/** A flow whose steps point at each other must not send messages forever. */
const MAX_HOPS = 12;

/** Steps that do something quietly and hand straight on to the next one. */
const SILENT = new Set(['condition', 'delay', 'sheets', 'api', 'attributes', 'tags', 'hours']);

/** Action buttons — a website, a phone call, a code to copy. */
export const CTA_KINDS = [
  { value: 'url', label: 'Visit a website' },
  { value: 'call', label: 'Call a number' },
  { value: 'copy', label: 'Copy a code' },
];

/** Lenient placeholder fill: a missing value must not break a live chat. */
function fill(text, variables) {
  return String(text ?? '').replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_, key) => variables?.[key] ?? '',
  );
}

/**
 * The plain-text form of a step: header, body, the numbered choices, footer.
 *
 * This is not merely a fallback for when interactive messages are refused — it
 * is what most recipients will actually see, so it has to read well on its own
 * rather than look like a stripped-down version of something better.
 */
export function renderNode(node, variables) {
  const parts = [];

  const header = fill(node.config?.header ?? '', variables).trim();
  if (header) parts.push(`*${header}*`);

  const body = fill(node.body, variables);
  if (body) parts.push(body);

  if (node.kind === 'menu' && node.options?.length) {
    parts.push(node.options.map((o, i) => `${i + 1}. ${fill(o.label, variables)}`).join('\n'));
  }

  /*
   * The text version of an action button has to be usable on its own: a link
   * nobody can tap is only useful if the address is written out.
   */
  if (node.kind === 'cta' && node.options?.length) {
    parts.push(node.options.map((o) => {
      const label = fill(o.label, variables);
      const value = fill(o.value, variables);
      if (o.cta === 'call') return `${label}: ${value}`;
      if (o.cta === 'copy') return `${label}: ${value}`;
      return `${label}: ${value}`;
    }).join('\n'));
  }

  const footer = fill(node.config?.footer ?? '', variables).trim();
  if (footer) parts.push(`_${footer}_`);

  return parts.join('\n\n');
}

/**
 * Which option a reply picked, or -1.
 *
 * Generous on purpose. People answer menus with "2", "2.", the keyword, or the
 * whole label, and a bot that only accepts one of those reads as broken rather
 * than strict.
 */
export function matchOption(options, text, selectedId = null) {
  /*
   * A tapped row carries the option's own index, so there is nothing to guess.
   * This is checked first: someone can tap "Other" on a list whose label also
   * appears inside another option's keyword, and the tap must win.
   */
  if (selectedId != null) {
    const byId = String(selectedId).match(/^opt:(\d+)$/);
    if (byId) {
      const index = Number(byId[1]);
      if (options[index]) return index;
    }
  }

  const said = String(text ?? '').trim().toLowerCase();
  if (!said) return -1;

  // A bare number, the most common answer by far.
  const asNumber = Number(said.replace(/[.)\]]$/, ''));
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) return asNumber - 1;

  const exact = options.findIndex(
    (o) => said === String(o.match ?? '').toLowerCase() || said === String(o.label ?? '').toLowerCase(),
  );
  if (exact !== -1) return exact;

  // Finally a keyword anywhere in the sentence ("tell me about salary").
  return options.findIndex((o) => {
    const keyword = String(o.match ?? '').toLowerCase().trim();
    return keyword.length >= 2 && said.includes(keyword);
  });
}

/**
 * Is it currently inside the configured working hours?
 *
 * Days are 0-6 from Sunday, times are wall-clock in the configured zone. An
 * overnight window (22:00 to 06:00) is normal for a support line, so a range
 * that wraps past midnight is treated as one window rather than an error.
 */
export function withinHours(config, at = new Date()) {
  const zone = config?.timezone || 'Asia/Kolkata';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const read = (type) => parts.find((p) => p.type === type)?.value;

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = days.indexOf(read('weekday'));
  const minutes = (read('hour') === '24' ? 0 : Number(read('hour'))) * 60 + Number(read('minute'));

  const open = config?.days ?? [1, 2, 3, 4, 5];
  if (!open.map(Number).includes(day)) return false;

  const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm ?? '').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const from = toMinutes(config?.from ?? '09:00');
  const to = toMinutes(config?.to ?? '18:00');

  return from <= to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to; // a window that wraps past midnight
}

/** Does this message start the flow at all? */
export function triggerMatches(bot, text) {
  const said = String(text ?? '').trim().toLowerCase();
  const want = String(bot.trigger_text ?? '').trim().toLowerCase();

  switch (bot.trigger_type) {
    case 'any': return said.length > 0;
    case 'equals': return said === want;
    case 'starts': return said.startsWith(want);
    case 'regex':
      try { return new RegExp(bot.trigger_text, 'i').test(text ?? ''); } catch { return false; }
    case 'contains':
    default:
      return Boolean(want) && said.includes(want);
  }
}

/**
 * Is this person trying to start over rather than answer?
 *
 * Saying the trigger word again while a conversation is already open used to
 * be read as a menu choice, fail to match, and earn an apology — so someone
 * typing "hi" a second time was told they had not been understood, which is
 * both true and useless. A greeting means "start over".
 *
 * The two step kinds are treated differently on purpose:
 *
 *   - On a menu the word only reaches here after failing to match an option,
 *     so anything containing it can safely restart.
 *   - On a question the reply is about to be *saved*, and discarding what
 *     someone typed is worse than storing something odd. Only the bare word
 *     restarts: "hi" starts over, "hi my name is Asha" is an answer.
 */
export function wantsRestart(bot, node, text) {
  // A bot that starts on any message would restart on every message.
  if (bot.trigger_type === 'any') return false;

  const want = String(bot.trigger_text ?? '').trim().toLowerCase();
  if (!want) return false;

  const said = String(text ?? '').trim().toLowerCase();
  if (node.kind !== 'menu') return said === want;

  /*
   * A whole word, not a substring.
   *
   * Triggers are often two letters. Plain "contains" matching would find "hi"
   * inside "this", "which" and "shipping", so answering a menu with an
   * ordinary sentence would silently throw away everything the person had
   * already filled in. Starting a conversation is forgiving about this;
   * destroying one in progress should not be.
   */
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i').test(said);
  } catch {
    return said === want;
  }
}

/* --------------------------------- if / else ------------------------------ */

export const OPERATORS = [
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'starts', label: 'starts with' },
  { value: 'empty', label: 'was not answered' },
  { value: 'not_empty', label: 'was answered' },
  { value: 'gt', label: 'is more than' },
  { value: 'lt', label: 'is less than' },
];

/**
 * Test one rule against what the bot has collected so far.
 *
 * Comparisons are case-insensitive and trimmed, because the values being
 * compared were typed by a person on a phone, not chosen from a dropdown.
 */
export function testRule(rule, variables) {
  const raw = variables?.[rule.field];
  const got = String(raw ?? '').trim().toLowerCase();
  const want = String(rule.value ?? '').trim().toLowerCase();

  switch (rule.op) {
    case 'empty': return got === '';
    case 'not_empty': return got !== '';
    case 'not_equals': return got !== want;
    case 'contains': return got.includes(want);
    case 'starts': return got.startsWith(want);
    case 'gt': return Number(got) > Number(want);
    case 'lt': return Number(got) < Number(want);
    case 'equals':
    default: return got === want;
  }
}

/**
 * Where a condition sends someone.
 *
 * Rules are tried in order and the first match wins, which is what makes
 * if / else-if / else read the way people expect. `next_key` is the otherwise.
 */
export function pickBranch(node, variables) {
  for (const rule of node.options ?? []) {
    if (testRule(rule, variables)) return { key: rule.next_key, rule };
  }
  return { key: node.next_key ?? null, rule: null };
}

/* ---------------------------------- effects ------------------------------- */

/**
 * The outside world, as far as a flow is concerned.
 *
 * The rehearsal console swaps these for recorders, so a test run can exercise
 * a Google Sheets step without adding a row to anyone's real spreadsheet.
 */
export const liveEffects = {
  appendSheet: (args) => appendRow(args),

  /**
   * Call someone else's API mid-conversation.
   *
   * Hard-capped at ten seconds. A person is sitting on the other end waiting
   * for a reply, and an endpoint that hangs would otherwise hold the whole
   * conversation open until it timed out somewhere further down.
   */
  async callApi({ url, method, headers, body }) {
    const stop = AbortSignal.timeout(10000);
    const res = await fetch(url, {
      method: method || 'GET',
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      body: ['GET', 'HEAD'].includes((method || 'GET').toUpperCase()) ? undefined : body,
      signal: stop,
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not every API answers in JSON */ }

    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return { status: res.status, json, text };
  },

  async setTags({ session, chatId, add, remove }) {
    const current = await ChatTags.get(session, chatId);
    const next = current
      .filter((t) => !remove.includes(t))
      .concat(add.filter((t) => !current.includes(t)));
    return ChatTags.set(session, chatId, next);
  },
};

export function recordingEffects(log) {
  return {
    appendSheet: async ({ sheetName, row }) => {
      log.push(`Would add a row to ${sheetName || 'Sheet1'}: ${row.join(' | ')}`);
      return { skipped: true };
    },
    /*
     * A rehearsal genuinely calls the API. Faking the response would defeat
     * the point — most of what goes wrong with this step is the endpoint
     * itself, and that is exactly what the console is for. Writes to a
     * spreadsheet are different: those leave a mark someone has to clean up.
     */
    callApi: (args) => liveEffects.callApi(args),
    setTags: async ({ add, remove }) => {
      log.push(`Would tag this chat${add.length ? ` +${add.join(' +')}` : ''}${remove.length ? ` -${remove.join(' -')}` : ''}`);
      return [];
    },
  };
}

/*
 * WhatsApp's own limits for the two interactive shapes. They are different
 * constructs, not two sizes of the same one: buttons sit under the message and
 * cap at three, a list opens a sheet and holds ten.
 */
export const BUTTON_LIMITS = { max: 3, labelChars: 20 };
export const LIST_LIMITS = { max: 10, labelChars: 24 };

/**
 * The tappable form of a menu, in whichever shape the step asked for.
 *
 * Option ids are the option's index either way, so a tap comes back as an
 * exact answer rather than a label to be matched by hand. Going over a limit
 * returns null rather than sending something WhatsApp will silently drop.
 */
export function buildList(node, variables) {
  const options = node.options ?? [];
  if (!options.length) return null;

  const wants = node.config?.display;
  const body = fill(node.body, variables);
  const header = fill(node.config?.header ?? '', variables).trim() || undefined;
  const footer = fill(node.config?.footer ?? '', variables).trim() || undefined;

  if (wants === 'buttons') {
    if (options.length > BUTTON_LIMITS.max) return null;
    return {
      mode: 'buttons',
      title: header,
      description: body,
      footer,
      // `{id, text}` is what makes WhatsApp build a quick reply rather than an
      // action button, and the id is the option index so a tap is exact.
      buttons: options.map((o, i) => ({
        id: `opt:${i}`,
        text: fill(o.label, variables).slice(0, BUTTON_LIMITS.labelChars),
      })),
    };
  }

  if (options.length > LIST_LIMITS.max) return null;
  return {
    mode: 'list',
    buttonText: node.config?.buttonText || 'Choose an option',
    title: header,
    description: body,
    footer,
    sections: [{
      title: node.config?.listTitle || 'Options',
      rows: options.map((o, i) => ({
        rowId: `opt:${i}`,
        title: fill(o.label, variables).slice(0, LIST_LIMITS.labelChars),
        description: fill(o.description ?? '', variables),
      })),
    }],
  };
}

/**
 * The action-button form of a step.
 *
 * Each button's own shape tells WhatsApp which kind to build, so a website
 * button and a call button can sit side by side on one message.
 */
export function buildCta(node, variables) {
  const buttons = (node.options ?? []).slice(0, BUTTON_LIMITS.max).map((o) => {
    const text = fill(o.label, variables).slice(0, BUTTON_LIMITS.labelChars);
    if (o.cta === 'call') return { text, phoneNumber: fill(o.value, variables) };
    if (o.cta === 'copy') return { text, code: fill(o.value, variables) };
    return { text, url: fill(o.value, variables) };
  });

  if (!buttons.length) return null;

  return {
    mode: 'cta',
    title: fill(node.config?.header ?? '', variables).trim() || undefined,
    description: fill(node.body, variables),
    footer: fill(node.config?.footer ?? '', variables).trim() || undefined,
    buttons,
  };
}

/**
 * Play a flow forward from `key` until it needs the person to say something.
 *
 * Conditions, delays and spreadsheet writes happen along the way without
 * sending anything — so one reply from a candidate can branch on their answer,
 * log them to a sheet, and land on the next question as a single step.
 */
async function walk(nodes, key, variables, effects, notes, context = {}) {
  const replies = [];
  let delayMs = 0;
  let cursor = key;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const node = nodes.find((n) => n.node_key === cursor);
    if (!node) return { replies, delayMs, waitingAt: null, status: 'done', missing: cursor };

    if (node.kind === 'condition') {
      const { key: branch, rule } = pickBranch(node, variables);
      notes.push(rule
        ? `${node.node_key}: "${rule.field}" ${rule.op} "${rule.value}" → ${branch}`
        : `${node.node_key}: nothing matched → ${branch ?? 'stop'}`);
      if (!branch) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = branch;
      continue;
    }

    if (node.kind === 'delay') {
      /*
       * Not a sleep. The queue already sends on a timestamp, so a delay just
       * pushes everything after it further out — the process is never blocked
       * holding a conversation open.
       */
      const seconds = Math.max(0, Number(node.config?.seconds ?? 0));
      delayMs += seconds * 1000;
      notes.push(`${node.node_key}: waits ${seconds}s before the next message`);
      if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = node.next_key;
      continue;
    }

    if (node.kind === 'sheets') {
      const columns = node.config?.columns ?? [];
      const row = columns.map((c) => fill(c.value, variables));
      try {
        await effects.appendSheet({
          spreadsheetId: node.config?.spreadsheetId,
          sheetName: node.config?.sheetName,
          row,
        });
        notes.push(`${node.node_key}: saved a row — ${row.join(' | ')}`);
      } catch (err) {
        /*
         * A spreadsheet that is unreachable must not end the conversation.
         * The person on the other end did nothing wrong, and losing their
         * place is a worse outcome than a missing row we can see in the log.
         */
        notes.push(`${node.node_key}: could not save the row — ${err.message}`);
        console.error('[bot:sheets]', err.message);
      }
      if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = node.next_key;
      continue;
    }

    if (node.kind === 'attributes') {
      // Remembering something without asking for it: a campaign source, a
      // branch already taken, anything a later condition wants to test.
      for (const a of node.options ?? []) {
        if (a.remove) delete variables[a.field];
        else variables[a.field] = fill(a.value, variables);
      }
      notes.push(`${node.node_key}: set ${(node.options ?? []).map((a) => a.field).join(', ')}`);
      if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = node.next_key;
      continue;
    }

    if (node.kind === 'tags') {
      const add = (node.config?.add ?? []).map((t) => fill(t, variables)).filter(Boolean);
      const remove = (node.config?.remove ?? []).map((t) => fill(t, variables)).filter(Boolean);
      try {
        await effects.setTags({ session: context.session, chatId: context.chatId, add, remove });
        notes.push(`${node.node_key}: tagged${add.length ? ` +${add.join(' +')}` : ''}${remove.length ? ` -${remove.join(' -')}` : ''}`);
      } catch (err) {
        notes.push(`${node.node_key}: could not tag — ${err.message}`);
      }
      if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = node.next_key;
      continue;
    }

    if (node.kind === 'api') {
      /*
       * A failing endpoint takes the `on failure` branch rather than ending
       * the conversation. Someone waiting on a reply should get a sentence
       * explaining it, not silence, and the flow author decides what it says.
       */
      try {
        const res = await effects.callApi({
          url: fill(node.config?.url, variables),
          method: node.config?.method ?? 'GET',
          headers: node.config?.headers ?? {},
          body: fill(node.config?.body ?? '', variables) || undefined,
        });

        for (const m of node.config?.save ?? []) {
          const value = String(m.path ?? '')
            .split('.')
            .filter(Boolean)
            .reduce((acc, key) => (acc == null ? acc : acc[key]), res.json);
          variables[m.field] = value == null ? '' : String(value);
        }

        notes.push(`${node.node_key}: called the API (${res.status})${(node.config?.save ?? []).length ? `, saved ${node.config.save.map((m) => m.field).join(', ')}` : ''}`);
      } catch (err) {
        notes.push(`${node.node_key}: the API call failed — ${err.message}`);
        const onFail = node.config?.onError;
        if (onFail) { cursor = onFail; continue; }
        return { replies, delayMs, waitingAt: null, status: 'done' };
      }
      if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = node.next_key;
      continue;
    }

    if (node.kind === 'hours') {
      const open = withinHours(node.config, new Date());
      notes.push(`${node.node_key}: ${open ? 'inside' : 'outside'} working hours`);
      const branch = open ? node.next_key : node.config?.closedKey;
      if (!branch) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = branch;
      continue;
    }

    if (node.kind === 'cta') {
      /*
       * Action buttons send nothing back.
       *
       * Opening a website, dialling a number or copying a code produces no
       * inbound message, so this step cannot wait for one — it says its piece
       * and carries on. Treating it like a menu would strand the conversation
       * on an answer that is never coming.
       */
      replies.push({
        nodeKey: node.node_key,
        text: renderNode(node, variables),
        list: buildCta(node, variables),
      });
      if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = node.next_key;
      continue;
    }

    if (node.kind === 'template') {
      try {
        const { text } = await renderTemplate(node.config?.templateKey, variables);
        replies.push({ nodeKey: node.node_key, text, list: null });
      } catch (err) {
        notes.push(`${node.node_key}: template failed — ${err.message}`);
      }
      if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
      cursor = node.next_key;
      continue;
    }

    replies.push({
      nodeKey: node.node_key,
      text: renderNode(node, variables),
      // A menu can go out as a tappable list instead of a numbered one. The
      // text version travels with it regardless — see `deliverList`.
      list: node.kind === 'menu' && ['list', 'buttons'].includes(node.config?.display)
        ? buildList(node, variables)
        : null,
    });

    if (node.kind === 'end') return { replies, delayMs, waitingAt: null, status: 'done' };
    if (node.kind === 'handoff') return { replies, delayMs, waitingAt: null, status: 'handoff' };
    if (node.kind === 'menu' || node.kind === 'prompt') {
      return { replies, delayMs, waitingAt: node.node_key, status: 'active' };
    }

    // 'message' — keep going.
    if (!node.next_key) return { replies, delayMs, waitingAt: null, status: 'done' };
    cursor = node.next_key;
  }

  // Ran out of hops: the flow loops. Stop and say so rather than keep sending.
  return { replies, delayMs, waitingAt: null, status: 'done', looped: true };
}

/**
 * One turn of a conversation.
 *
 * Give it the bot, its steps, the current state and what the person just said;
 * it returns what to send and where they now stand.
 */
export async function advance({
  bot, nodes, state, text, selectedId = null, effects = liveEffects, context = {},
}) {
  const variables = { ...(state?.variables ?? {}) };
  const notes = [];

  const finish = (result, retries = 0) => ({
    replies: result.replies,
    delayMs: result.delayMs,
    notes,
    looped: result.looped,
    state: { node_key: result.waitingAt, variables, retries, status: result.status },
  });

  // Nobody is mid-conversation — this is the opening message.
  if (!state?.node_key) {
    return finish(await walk(nodes, bot.entry_key, variables, effects, notes, context));
  }

  const node = nodes.find((n) => n.node_key === state.node_key);
  if (!node) {
    // The step was deleted underneath a live conversation. End it cleanly
    // rather than leave someone stuck talking to a flow that no longer runs.
    return {
      replies: [{ nodeKey: null, text: bot.fallback || 'Sorry, this conversation has ended.' }],
      delayMs: 0,
      notes,
      state: { node_key: null, variables, retries: 0, status: 'done' },
    };
  }

  // Starting over beats answering, but only for an unmistakable greeting.
  if (wantsRestart(bot, node, text)) {
    notes.push(`${node.node_key}: greeted again — starting the flow over`);
    // A fresh start is a fresh start: what was collected belonged to the run
    // being abandoned, and carrying it forward produces a half-filled form.
    const cleared = {};
    const result = await walk(nodes, bot.entry_key, cleared, effects, notes, context);
    return {
      replies: result.replies,
      delayMs: result.delayMs,
      notes,
      looped: result.looped,
      state: { node_key: result.waitingAt, variables: cleared, retries: 0, status: result.status },
    };
  }

  // A question takes whatever was said and keeps it.
  if (node.kind === 'prompt') {
    if (node.save_as) variables[node.save_as] = String(text ?? '').trim();
    return finish(await walk(nodes, node.next_key, variables, effects, notes, context));
  }

  // A menu needs one of its options.
  const picked = matchOption(node.options ?? [], text, selectedId);
  if (picked === -1) {
    const retries = (state.retries ?? 0) + 1;

    /*
     * Give up gracefully rather than repeat the menu forever.
     *
     * Someone who has missed twice is usually asking something the flow does
     * not cover. Repeating the same list a third time is how a bot becomes the
     * thing people complain about, so hand over instead.
     */
    if (retries > (bot.max_retries ?? 2)) {
      return {
        replies: [{
          nodeKey: node.node_key,
          text: bot.fallback || "Sorry, I didn't catch that. Someone will reply to you shortly.",
        }],
        delayMs: 0,
        notes,
        state: { node_key: null, variables, retries, status: 'handoff' },
      };
    }

    /*
     * Re-ask in the same shape it was asked.
     *
     * Rebuilding this as plain text was a real bug: a menu sent as tappable
     * buttons came back, on the very next turn, as a numbered list nobody
     * could tap — so the one moment someone is already confused is the moment
     * the buttons disappeared. The apology goes inside the body so the header
     * still leads and the interactive form survives.
     */
    const reask = {
      ...node,
      body: `Sorry, I didn't understand that.\n\n${node.body}`,
    };

    return {
      replies: [{
        nodeKey: node.node_key,
        text: renderNode(reask, variables),
        list: node.kind === 'menu' && ['list', 'buttons'].includes(node.config?.display)
          ? buildList(reask, variables)
          : null,
      }],
      delayMs: 0,
      notes,
      state: { node_key: node.node_key, variables, retries, status: 'active' },
    };
  }

  const option = node.options[picked];
  if (option.save_as) variables[option.save_as] = option.label;

  return finish(await walk(nodes, option.next_key, variables, effects, notes, context));
}

/* ------------------------------ the live wiring --------------------------- */

/** Groups and broadcasts, where an eager bot would be very unwelcome. */
const isGroup = (chatId) => String(chatId).endsWith('@g.us');

/**
 * Handle one inbound message. Returns true if a bot took it.
 *
 * The return value is what keeps the auto-reply rules from answering the same
 * message: exactly one of the two responds, and the bot wins because it may be
 * mid-conversation.
 */
export async function applyBot({ session, message }) {
  const chatId = message.chat_id;
  const text = message.body ?? '';

  const open = await Bots.chat(session, chatId);

  // Pick up where we left off, unless they went quiet for too long.
  if (open) {
    const bot = await Bots.get(open.bot_id);
    if (bot?.enabled) {
      const idleMs = Date.now() - Number(open.last_at);
      if (idleMs <= bot.timeout_minutes * 60000) {
        return runTurn({ bot, session, chatId, text, selectedId: message.selectedId, chatRow: open });
      }

      /*
       * They answered a question we asked hours ago. Treating "2" as a menu
       * choice now would reply to something they have long forgotten, so the
       * old conversation is closed and this message is allowed to start a
       * fresh one.
       */
      await Bots.saveChat(open.id, { ...open, nodeKey: null, status: 'expired' });
    }
  }

  /*
   * Nothing open: does anything want to start?
   *
   * Bots are tried in two passes. Keyword bots go first, and only if none of
   * them wanted the message does a "nothing else matched" bot get it —
   * otherwise the catch-all would swallow every conversation before the
   * specific flows ever saw it.
   */
  const live = (await Bots.live(session)).filter((b) => !isGroup(chatId) || b.allow_groups);

  for (const bot of live) {
    if ((bot.trigger_event ?? 'message') !== 'message') continue;
    if (!triggerMatches(bot, text)) continue;
    return runTurn({ bot, session, chatId, text, selectedId: message.selectedId, chatRow: null });
  }

  for (const bot of live) {
    const event = bot.trigger_event ?? 'message';
    if (event === 'message') continue;

    if (event === 'first_daily' && !(await isFirstToday(session, chatId, message))) continue;
    // 'no_match' needs no test of its own: reaching here *is* the test.

    return runTurn({ bot, session, chatId, text, selectedId: message.selectedId, chatRow: null });
  }

  return false;
}

/**
 * Is this the first thing they have said today?
 *
 * "Today" is the server's own day, which is the same day the person is having
 * as long as the clinic and its server are in one place — true here, and worth
 * revisiting the moment they are not.
 */
async function isFirstToday(session, chatId, message) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const [row] = await all(
    `SELECT COUNT(*) AS n FROM messages
      WHERE session = ? AND chat_id = ? AND direction = 'in'
        AND timestamp >= ? AND (wa_id IS NULL OR wa_id <> ?)`,
    session, chatId, midnight.getTime(), message?.wa_id ?? '',
  );
  return Number(row?.n ?? 0) === 0;
}

async function runTurn({ bot, session, chatId, text, selectedId, chatRow }) {
  const nodes = await Bots.nodes(bot.id);
  if (!nodes.length) return false;

  const row = chatRow ?? await Bots.startChat({ botId: bot.id, session, chatId, nodeKey: null });
  await Bots.logEvent({ botChatId: row.id, direction: 'in', nodeKey: row.node_key, body: text });

  const { replies, state, delayMs, looped, notes } = await advance({
    bot, nodes, state: chatRow ? row : null, text, selectedId,
    effects: liveEffects, context: { session, chatId },
  });

  if (looped) console.error(`[bot:${bot.name}] flow loops — stopped after ${MAX_HOPS} steps`);
  for (const note of notes) console.log(`[bot:${bot.name}] ${note}`);

  for (const reply of replies) {
    await enqueue({
      session,
      chatId,
      body: reply.text,
      kind: reply.list ? 'list' : 'text',
      payload: reply.list ?? undefined,
      // A delay step pushes everything after it further out rather than
      // blocking; null lets the queue pick its own moment as usual.
      sendAt: delayMs ? Date.now() + delayMs : undefined,
    });
    await Bots.logEvent({
      botChatId: row.id, direction: 'out', nodeKey: reply.nodeKey, body: reply.text,
    });
  }

  await Bots.saveChat(row.id, {
    nodeKey: state.node_key,
    variables: state.variables,
    retries: state.retries,
    status: state.status,
  });

  console.log(`[bot:${bot.name}] ${chatId} -> ${state.node_key ?? state.status}`);
  return true;
}

/** Sweep conversations nobody came back to, so they can start over cleanly. */
export async function expireIdleChats() {
  await Bots.expireChats(Date.now() - 24 * 3600000);
}
