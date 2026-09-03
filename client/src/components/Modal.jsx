import { useEffect, useRef } from 'react';

/**
 * A dialog built on <dialog>, so Escape and the backdrop come for free.
 * Centred explicitly, because the browser's own `margin: auto` is easily lost
 * to a reset.
 */
export default function Modal({ open, title, onClose, children }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <header className="modal__head">
        <h2>{title}</h2>
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="modal__body">{children}</div>
    </dialog>
  );
}
