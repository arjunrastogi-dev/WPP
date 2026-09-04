/**
 * How a step will actually look on a phone.
 *
 * The four interactive shapes render very differently, and the names do not
 * make that obvious — "list" and "buttons" both sound like a list of choices,
 * but one stacks tappable rows under the message and the other shows a single
 * button that opens a sheet. Choosing the wrong one is only discovered after
 * sending, so the choice is shown rather than described.
 */

const fill = (text, vars) => String(text ?? '').replace(
  /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
  (_, key) => vars?.[key] ?? `{{${key}}}`,
);

/** The icon WhatsApp puts on an action button, by what it does. */
const CTA_ICON = { url: '🔗', call: '📞', copy: '📋' };

export default function MessagePreview({ step, sample = {} }) {
  const display = step.kind === 'cta' ? 'cta' : (step.config?.display ?? 'text');
  const header = fill(step.config?.header, sample).trim();
  const footer = fill(step.config?.footer, sample).trim();
  const body = fill(step.body, sample);
  const options = step.options ?? [];

  return (
    <div className="wapreview">
      <div className="wapreview__bubble">
        {header ? <div className="wapreview__header">{header}</div> : null}
        <div className="wapreview__body">
          {body.split('\n').map((line, i) => <div key={i}>{line || ' '}</div>)}

          {/* A plain menu spells the choices out, because they are typed. */}
          {display === 'text' && options.length ? (
            <div className="wapreview__numbered">
              {options.map((o, i) => (
                <div key={i}>{i + 1}. {fill(o.label, sample)}</div>
              ))}
            </div>
          ) : null}
        </div>

        {footer ? <div className="wapreview__footer">{footer}</div> : null}
        <div className="wapreview__time">17:21</div>

        {/* Quick replies: stacked rows, each with a reply arrow. */}
        {display === 'buttons' ? options.slice(0, 3).map((o, i) => (
          <div key={i} className="wapreview__reply">
            <span className="wapreview__arrow">↩</span> {fill(o.label, sample).slice(0, 20)}
          </div>
        )) : null}

        {/* Action buttons look the same but carry an icon for what they do. */}
        {display === 'cta' ? options.slice(0, 3).map((o, i) => (
          <div key={i} className="wapreview__reply">
            <span className="wapreview__arrow">{CTA_ICON[o.cta ?? 'url']}</span>
            {' '}{fill(o.label, sample).slice(0, 20)}
          </div>
        )) : null}

        {/* A list is one button; the choices live behind it. */}
        {display === 'list' ? (
          <div className="wapreview__reply wapreview__reply--list">
            <span className="wapreview__arrow">☰</span>
            {' '}{step.config?.buttonText || 'Choose an option'}
          </div>
        ) : null}
      </div>

      {display === 'list' ? (
        <div className="wapreview__sheet">
          <div className="wapreview__sheettitle">
            {step.config?.listTitle || 'Options'}
          </div>
          {options.slice(0, 10).map((o, i) => (
            <div key={i} className="wapreview__row">
              <div>
                <strong>{fill(o.label, sample).slice(0, 24)}</strong>
                {o.description ? <div className="muted">{fill(o.description, sample)}</div> : null}
              </div>
              <span className="wapreview__radio">○</span>
            </div>
          ))}
          <p className="muted wapreview__note">
            Opens as a separate sheet when they tap the button above.
          </p>
        </div>
      ) : null}
    </div>
  );
}
