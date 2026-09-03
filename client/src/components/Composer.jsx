import { useRef, useState } from 'react';
import { api } from '../api';

/**
 * Message composer: text, attachment and optional scheduling.
 *
 * Sends are queued server-side, so the response is 202 rather than a delivered
 * message — the real message arrives back over the socket once the rate
 * limiter releases it.
 */
export default function Composer({ session, chat, disabled, onQueued, onError }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const reset = () => {
    setText('');
    setFile(null);
    setScheduleAt('');
    setShowSchedule(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!text.trim() && !file) return;

    setBusy(true);
    onError?.(null);
    try {
      // datetime-local yields local wall-clock time; Date parses it as local,
      // which is what the user meant.
      const sendAt = showSchedule && scheduleAt ? new Date(scheduleAt).getTime() : undefined;
      if (sendAt && Number.isNaN(sendAt)) throw new Error('Invalid schedule time');

      await api.send(session, { to: chat.id, message: text.trim(), file, sendAt });
      reset();
      onQueued?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Enter sends, Shift+Enter makes a new line.
  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit(event);
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      {file ? (
        <div className="composer__file">
          📎 {file.name} <button type="button" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}>✕</button>
        </div>
      ) : null}

      {showSchedule ? (
        <div className="composer__schedule">
          <label>
            Send at
            <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
          </label>
          <button type="button" onClick={() => { setShowSchedule(false); setScheduleAt(''); }}>Cancel</button>
        </div>
      ) : null}

      <div className="composer__row">
        <button type="button" className="icon" title="Attach a file"
          onClick={() => fileRef.current?.click()} disabled={disabled}>📎</button>
        <input ref={fileRef} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />

        <button type="button" className={`icon${showSchedule ? ' is-on' : ''}`} title="Schedule this message"
          onClick={() => setShowSchedule((v) => !v)} disabled={disabled}>🕒</button>

        <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
          rows={1} placeholder={disabled ? 'Session not connected' : 'Type a message… (Enter to send)'}
          disabled={disabled} />

        <button type="submit" className="primary" disabled={disabled || busy || (!text.trim() && !file)}>
          {busy ? '…' : showSchedule ? 'Schedule' : 'Send'}
        </button>
      </div>
    </form>
  );
}
