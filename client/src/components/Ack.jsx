/** WhatsApp delivery receipts: -1 error, 0 pending, 1 sent, 2 delivered, 3 read. */
const MARKS = {
  '-1': { glyph: '!', title: 'Failed', className: 'ack--error' },
  0: { glyph: '🕐', title: 'Pending', className: '' },
  1: { glyph: '✓', title: 'Sent', className: '' },
  2: { glyph: '✓✓', title: 'Delivered', className: '' },
  3: { glyph: '✓✓', title: 'Read', className: 'ack--read' },
};

export default function Ack({ value }) {
  const mark = MARKS[String(value)] ?? MARKS[0];
  return <span className={`ack ${mark.className}`} title={mark.title}>{mark.glyph}</span>;
}
