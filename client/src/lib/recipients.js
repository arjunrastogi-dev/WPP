/**
 * The pasted-recipient format, shared by bulk sends and schedules.
 *
 * One recipient per line: the phone number first, then one value per
 * placeholder in the order they appear in the message. Kept in one place so
 * the two screens can't drift into two subtly different formats.
 */

/** Placeholder names in a message, in first-seen order and without repeats. */
export function placeholdersIn(text) {
  return [...new Set(
    [...String(text ?? '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]),
  )];
}

export function parseRows(text, columns) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      const [to, ...rest] = cells;
      const variables = {};
      columns.forEach((name, i) => { variables[name] = rest[i] ?? ''; });
      return { to, variables };
    });
}

/** Turn saved recipients back into the pasted form, for editing. */
export function toText(recipients, columns) {
  return (recipients ?? [])
    .map((r) => [r.to, ...columns.map((c) => r.variables?.[c] ?? '')].join(', '))
    .join('\n');
}
