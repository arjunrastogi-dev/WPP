import { Templates } from './store.js';

/**
 * Message templates.
 *
 * A template body uses `{{variable}}` placeholders:
 *
 *   Hi {{patient}}, your appointment with {{doctor}} is confirmed for {{time}}.
 *
 * The clinic CMS names a template by its `template_key` and supplies the
 * variables; it never sends raw message text. That way the wording can change
 * here without touching the CMS.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every distinct placeholder in a body, in order of first appearance. */
export function extractVariables(body) {
  const found = [];
  for (const [, name] of String(body ?? '').matchAll(PLACEHOLDER)) {
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Fill a template body. Returns the rendered text plus any placeholders the
 * caller didn't supply, so the route can reject rather than send a message
 * reading "your appointment with undefined".
 */
export function render(body, variables = {}) {
  const missing = [];
  const text = String(body ?? '').replace(PLACEHOLDER, (_match, name) => {
    const value = variables[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return String(value);
  });
  return { text: text.trim(), missing: [...new Set(missing)] };
}

/** Look up a template and render it in one step. Throws with a clear reason. */
export async function renderTemplate(templateKey, variables) {
  const template = await Templates.byKey(templateKey);
  if (!template) {
    const err = new Error(`No template with key "${templateKey}"`);
    err.code = 'TEMPLATE_NOT_FOUND';
    throw err;
  }
  if (!template.enabled) {
    const err = new Error(`Template "${templateKey}" is disabled`);
    err.code = 'TEMPLATE_DISABLED';
    throw err;
  }

  const { text, missing } = render(template.body, variables);
  if (missing.length) {
    const err = new Error(`Missing variables: ${missing.join(', ')}`);
    err.code = 'MISSING_VARIABLES';
    err.missing = missing;
    throw err;
  }

  return { template, text };
}

/** Starter templates, created once on an empty database. */
const SEED = [
  {
    templateKey: 'booking_confirm',
    name: 'Appointment confirmed',
    description: 'Sent when a patient books an appointment.',
    body: `Hi {{patient}}, your appointment with {{doctor}} is confirmed for {{date}} at {{time}}.

{{clinic}}`,
  },
  {
    templateKey: 'booking_reminder',
    name: 'Appointment reminder',
    description: 'Sent before an appointment.',
    body: `Reminder: {{patient}}, you have an appointment with {{doctor}} on {{date}} at {{time}}.

See you soon,
{{clinic}}`,
  },
  {
    templateKey: 'booking_rescheduled',
    name: 'Appointment moved',
    description: 'Sent when an appointment is rescheduled.',
    body: `Hi {{patient}}, your appointment with {{doctor}} has been moved to {{date}} at {{time}}.

If that does not suit you, please call us.

{{clinic}}`,
  },
  {
    templateKey: 'booking_completed',
    name: 'Visit complete',
    description: 'Sent after a completed visit.',
    body: `Hi {{patient}}, thank you for visiting {{doctor}} on {{date}}.

Wishing you a speedy recovery.

{{clinic}}`,
  },
  {
    templateKey: 'doctor_new_booking',
    name: 'New booking (for the doctor)',
    description: 'Sent to the doctor when a patient books with them.',
    body: `{{doctor}} — a new appointment has been booked.

Patient: {{patient}} ({{phone}})
When: {{date}} at {{time}}
Reason: {{reason}}

{{clinic}}`,
  },
  {
    templateKey: 'booking_cancelled',
    name: 'Appointment cancelled',
    description: 'Sent when an appointment is cancelled.',
    body: `Hi {{patient}}, your appointment with {{doctor}} on {{date}} at {{time}} has been cancelled.

{{clinic}}`,
  },
];

/**
 * Add any starter template that isn't there yet. Per-key rather than
 * all-or-nothing, so a new template added in a later version still lands on a
 * database that already has the earlier ones.
 */
export async function ensureSeedTemplates() {
  const existing = await Templates.list();
  const have = new Set(existing.map((t) => t.template_key));
  const missing = SEED.filter((t) => !have.has(t.templateKey));

  for (const t of missing) await Templates.create(t);
  if (missing.length) {
    console.log(`[templates] seeded ${missing.length} template(s): ${missing.map((t) => t.templateKey).join(', ')}`);
  }
  return missing.length;
}
