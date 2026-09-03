import { useEffect, useRef } from 'react';
import { mediaUrl } from '../api';
import Ack from './Ack';

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (d.toDateString() === today) return 'Today';
  if (d.toDateString() === yesterday) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
};

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'sticker', 'document']);
const PLACEHOLDER = {
  image: 'Photo', video: 'Video', audio: 'Audio',
  ptt: 'Voice message', sticker: 'Sticker', document: 'Document',
};

/** Prefer the mimetype; fall back to the file extension. */
function mediaKind(message) {
  const mime = message.mimetype ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (['image', 'sticker'].includes(message.type)) return 'image';
  if (message.type === 'video') return 'video';
  if (['audio', 'ptt'].includes(message.type)) return 'audio';
  if (/\.(jpe?g|png|gif|webp)$/i.test(message.media_path ?? '')) return 'image';
  if (/\.(mp4|webm|mov)$/i.test(message.media_path ?? '')) return 'video';
  if (/\.(ogg|mp3|m4a|wav)$/i.test(message.media_path ?? '')) return 'audio';
  return 'file';
}

function Attachment({ message, onRetry }) {
  const isMedia = MEDIA_TYPES.has(message.type) || Boolean(message.mimetype) || message.media_path;
  if (!isMedia) return null;

  // The message carries an attachment, but the download never landed.
  if (!message.media_path) {
    return (
      <div className="bubble__missing">
        <span>{PLACEHOLDER[message.type] ?? 'Attachment'} unavailable</span>
        {onRetry ? <button type="button" onClick={onRetry}>Retry download</button> : null}
      </div>
    );
  }

  const url = mediaUrl(message.media_path);
  const name = message.media_name ?? message.media_path;

  switch (mediaKind(message)) {
    case 'image':
      return (
        <a href={url} target="_blank" rel="noreferrer">
          <img className="bubble__image" src={url} alt={name} loading="lazy" />
        </a>
      );
    case 'video':
      return <video className="bubble__image" src={url} controls preload="metadata" />;
    case 'audio':
      return <audio className="bubble__audio" src={url} controls preload="metadata" />;
    default:
      return (
        <a className="bubble__file" href={url} target="_blank" rel="noreferrer" download={name}>
          <span aria-hidden="true">📎</span> {name}
        </a>
      );
  }
}

export default function Thread({ messages, loading, onRetryMedia }) {
  const ref = useRef(null);

  // Pin to the newest message whenever the thread grows.
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [messages]);

  if (loading) return <div className="thread thread--loading">Loading conversation…</div>;

  let lastDay = null;

  return (
    <div className="thread" ref={ref}>
      {messages.map((m) => {
        const day = dayLabel(m.timestamp);
        const showDay = day !== lastDay;
        lastDay = day;
        return (
          <div key={m.id}>
            {showDay ? <div className="thread__day"><span>{day}</span></div> : null}
            <div className={`bubble bubble--${m.direction}`}>
              <Attachment message={m} onRetry={onRetryMedia} />
              {m.body ? <p className="bubble__body">{m.body}</p> : null}
              <span className="bubble__meta">
                {time(m.timestamp)}
                {m.direction === 'out' ? <Ack value={m.ack} /> : null}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
