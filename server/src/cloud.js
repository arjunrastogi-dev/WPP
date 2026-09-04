import { config } from './config.js';

/**
 * The official WhatsApp Business Cloud API.
 *
 * This exists for one reason: interactive messages. Buttons and lists sent
 * through WhatsApp Web automation are accepted, acked, and then silently never
 * rendered on the recipient's phone — there is no error to catch and no
 * fallback to trigger. Meta only delivers them for senders on the Business
 * API, which is what DoubleTick, Gupshup and every other BSP is really using.
 *
 * The bot engine does not know or care which of the two is in use. It produces
 * a message and an optional interactive payload; this module translates that
 * into Meta's shapes, and `whatsapp.js` picks the transport per session.
 */

const GRAPH = 'https://graph.facebook.com';

/** WhatsApp wants a bare international number, not the web client's chat id. */
export const toWaId = (chatId) => String(chatId ?? '').replace(/@.*$/, '').replace(/\D/g, '');

/*
 * Meta's limits. They differ from the web client's, and breaking one is a 400
 * with a long error rather than a silent drop — which is an improvement, but
 * still better caught here.
 */
export const CLOUD_LIMITS = {
  buttons: { max: 3, title: 20 },
  list: { rows: 10, title: 24, description: 72, button: 20 },
  body: 1024,
  header: 60,
  footer: 60,
};

const trim = (text, max) => {
  const value = String(text ?? '').trim();
  return value.length > max ? value.slice(0, max) : value;
};

/**
 * Turn our payload into Meta's `interactive` object.
 *
 * Returns null when the shape has no Cloud API equivalent, which tells the
 * caller to send the plain text instead of guessing.
 */
export function toInteractive(payload, body) {
  if (!payload) return null;

  const header = payload.title ? { type: 'text', text: trim(payload.title, CLOUD_LIMITS.header) } : undefined;
  const footer = payload.footer ? { text: trim(payload.footer, CLOUD_LIMITS.footer) } : undefined;
  const text = trim(payload.description || body, CLOUD_LIMITS.body);

  if (payload.mode === 'buttons') {
    const buttons = (payload.buttons ?? []).slice(0, CLOUD_LIMITS.buttons.max);
    if (!buttons.length) return null;
    return {
      type: 'button',
      ...(header ? { header } : {}),
      body: { text },
      ...(footer ? { footer } : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: trim(b.text, CLOUD_LIMITS.buttons.title) },
        })),
      },
    };
  }

  if (payload.mode === 'list') {
    const rows = (payload.sections?.[0]?.rows ?? []).slice(0, CLOUD_LIMITS.list.rows);
    if (!rows.length) return null;
    return {
      type: 'list',
      ...(header ? { header } : {}),
      body: { text },
      ...(footer ? { footer } : {}),
      action: {
        button: trim(payload.buttonText || 'Choose', CLOUD_LIMITS.list.button),
        sections: [{
          title: trim(payload.sections[0].title || 'Options', CLOUD_LIMITS.list.title),
          rows: rows.map((r) => ({
            id: r.rowId,
            title: trim(r.title, CLOUD_LIMITS.list.title),
            // An empty description is rejected, so it is omitted rather than sent blank.
            ...(r.description ? { description: trim(r.description, CLOUD_LIMITS.list.description) } : {}),
          })),
        }],
      },
    };
  }

  if (payload.mode === 'cta') {
    /*
     * Meta's cta_url carries exactly one button, and has no equivalent for a
     * call or a copy-code button. Rather than quietly dropping the others, the
     * whole step falls back to text — which already writes every link out in
     * full, so nothing is lost but the tap.
     */
    const url = (payload.buttons ?? []).find((b) => b.url);
    if (!url || payload.buttons.length > 1) return null;
    return {
      type: 'cta_url',
      ...(header ? { header } : {}),
      body: { text },
      ...(footer ? { footer } : {}),
      action: {
        name: 'cta_url',
        parameters: { display_text: trim(url.text, CLOUD_LIMITS.buttons.title), url: url.url },
      },
    };
  }

  return null;
}

/** Whether this session is configured to send through Meta rather than the web client. */
export function isCloudSession(row) {
  return row?.provider === 'cloud' && Boolean(row?.cloud_phone_id) && Boolean(row?.cloud_token);
}

async function post(row, payload) {
  const res = await fetch(`${GRAPH}/${config.cloud.version}/${row.cloud_phone_id}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${row.cloud_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    signal: AbortSignal.timeout(20000),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Meta's own message is far more useful than the status line.
    const detail = json?.error?.message ?? `${res.status} ${res.statusText}`;
    const err = new Error(detail);
    err.code = json?.error?.code;
    throw err;
  }
  return { id: json?.messages?.[0]?.id ?? null };
}

/**
 * Send one message through the Cloud API.
 *
 * An interactive message that Meta rejects is retried as plain text, because
 * the text form always carries the same question in a numbered list — a person
 * who cannot tap can still type.
 */
export async function sendCloud({ row, chatId, body, payload }) {
  const to = toWaId(chatId);
  const interactive = toInteractive(
    typeof payload === 'string' ? JSON.parse(payload) : payload,
    body,
  );

  if (!interactive) {
    return post(row, { to, type: 'text', text: { preview_url: true, body: body ?? '' } });
  }

  try {
    const sent = await post(row, { to, type: 'interactive', interactive });
    console.log(`[cloud] sent ${interactive.type} to ${to}`);
    return sent;
  } catch (err) {
    console.warn(`[cloud] ${interactive.type} rejected (${err.message}) — sending the text version`);
    return post(row, { to, type: 'text', text: { preview_url: true, body: body ?? '' } });
  }
}

/**
 * Pull the useful parts out of one inbound webhook message.
 *
 * A tapped button or list row arrives with its own id — the same id the bot
 * put on the option — so the answer is exact rather than matched from a label.
 */
export function readInbound(message) {
  if (!message) return null;

  const base = {
    waId: message.id,
    from: message.from,
    timestamp: Number(message.timestamp ?? 0) * 1000,
    type: message.type,
  };

  if (message.type === 'text') return { ...base, body: message.text?.body ?? '' };

  if (message.type === 'interactive') {
    const reply = message.interactive?.button_reply ?? message.interactive?.list_reply ?? null;
    if (reply) return { ...base, body: reply.title ?? '', selectedId: reply.id ?? null };
  }

  // The older template-button format, still sent by some clients.
  if (message.type === 'button') {
    return { ...base, body: message.button?.text ?? '', selectedId: message.button?.payload ?? null };
  }

  return { ...base, body: message.caption ?? '' };
}
