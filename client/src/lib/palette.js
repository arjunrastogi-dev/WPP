/**
 * The builder palette: what a flow can start on, and what it can do.
 *
 * Items that this app genuinely cannot perform are listed rather than hidden,
 * marked `unavailable` with the reason. Leaving them out entirely invites the
 * same question every week; showing a dead button that does nothing is worse.
 * Neither can be dragged.
 */

export const TRIGGERS = [
  {
    group: 'Message & conversation',
    items: [
      {
        kind: 'message', label: 'On message', icon: '💬',
        hint: 'When someone sends a word you choose',
      },
      {
        kind: 'first_daily', label: 'On first daily message', icon: '🌅',
        hint: 'The first thing they say each day',
      },
      {
        kind: 'no_match', label: 'On no keyword match', icon: '🤷',
        hint: 'When nothing else answered them',
      },
      {
        kind: 'open_conversation', label: 'On open conversation', icon: '📂',
        unavailable: 'Needs a shared inbox with agents opening and closing chats — this app has no such concept yet.',
      },
      {
        kind: 'close_conversation', label: 'On close conversation', icon: '✅',
        unavailable: 'Same as above: nothing here marks a conversation closed.',
      },
      {
        kind: 'ctwa', label: 'Message from an ad', icon: '📣',
        unavailable: 'Click-to-WhatsApp ads are a Meta Business feature and are not visible to WhatsApp Web.',
      },
    ],
  },
  {
    group: 'Leads & contacts',
    items: [
      {
        kind: 'new_lead', label: 'On new lead', icon: '🧲',
        unavailable: 'There is no CRM behind this app — a lead is just a chat.',
      },
      {
        kind: 'agent_assign', label: 'On agent assign', icon: '🙋',
        unavailable: 'Chats are not assigned to agents here.',
      },
    ],
  },
  {
    group: 'Templates & events',
    items: [
      {
        kind: 'template_delivered', label: 'On template delivered', icon: '📨',
        unavailable: 'Delivery receipts are tracked, but nothing yet starts a flow from one.',
      },
      {
        kind: 'sla', label: 'On SLA breached', icon: '⏰',
        unavailable: 'No response-time targets are defined anywhere in this app.',
      },
    ],
  },
];

export const ACTIONS = [
  {
    group: 'Messaging',
    items: [
      { kind: 'message', label: 'Send message', icon: '💬', hint: 'Say something, then continue' },
      { kind: 'menu', label: 'Send menu', icon: '📋', hint: 'Numbered, buttons or a tappable list' },
      { kind: 'prompt', label: 'Ask a question', icon: '❓', hint: 'Save whatever they reply' },
      { kind: 'template', label: 'Send template', icon: '📝', hint: 'One of your saved templates' },
      {
        kind: 'cta', label: 'Action buttons', icon: '🔗',
        hint: 'Visit a website, call a number, copy a code',
      },
      {
        kind: 'catalogue', label: 'Send catalogue', icon: '🛍️',
        unavailable: 'Catalogues belong to a WhatsApp Business profile, not to WhatsApp Web.',
      },
    ],
  },
  {
    group: 'Logic & flow',
    items: [
      { kind: 'condition', label: 'If / else', icon: '🔀', hint: 'Branch on an earlier answer' },
      { kind: 'hours', label: 'Working hours', icon: '🕘', hint: 'Branch on the time and day' },
      { kind: 'delay', label: 'Wait', icon: '⏱️', hint: 'Pause before the next message' },
      { kind: 'end', label: 'Ending', icon: '🏁', hint: 'Say goodbye and close' },
      { kind: 'handoff', label: 'Hand to a person', icon: '🤝', hint: 'Stop and let a human take over' },
    ],
  },
  {
    group: 'Data & APIs',
    items: [
      { kind: 'sheets', label: 'Google Sheets', icon: '📊', hint: 'Add a row to a spreadsheet' },
      { kind: 'api', label: 'Call an API', icon: '🔌', hint: 'Fetch something and keep part of it' },
      { kind: 'attributes', label: 'Remember something', icon: '🏷️', hint: 'Set a value without asking' },
      { kind: 'tags', label: 'Tag the chat', icon: '🔖', hint: 'Add or remove chat tags' },
    ],
  },
  {
    group: 'AI',
    items: [
      {
        kind: 'ai', label: 'Generate an AI reply', icon: '✨',
        unavailable: 'No language model is connected to this app.',
      },
    ],
  },
];

/** Trigger kinds are stored on the bot, not as steps, so they are listed apart. */
export const TRIGGER_KINDS = new Set(['message', 'first_daily', 'no_match']);

export const ACTION_META = Object.fromEntries(
  ACTIONS.flatMap((g) => g.items).map((i) => [i.kind, i]),
);
