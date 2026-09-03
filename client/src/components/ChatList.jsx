import { useState } from 'react';
import Empty from './Empty';

const displayName = (chat) => chat.name || chat.id.split('@')[0];

const when = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
};

export default function ChatList({
  chats, selectedId, filter, onFilter, onSelect, onNewChat,
  sessions = [], activeSession, onSession,
}) {
  const [draft, setDraft] = useState('');

  // "New chat" doesn't hit the server: it creates a local placeholder, and the
  // conversation becomes real as soon as the first message is queued.
  const startNew = (event) => {
    event.preventDefault();
    const digits = draft.replace(/\D/g, '');
    if (!digits) return;
    onNewChat({ id: `${digits}@c.us`, name: null, unread: 0, tags: [], is_group: false });
    setDraft('');
  };

  return (
    <aside className="chatlist">
      {sessions.length > 0 ? (
        <label className="chatlist__session">
          <span>Showing chats from</span>
          <select value={activeSession ?? ''} onChange={(e) => onSession?.(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
                {s.status === 'CONNECTED' ? '' : ` — ${s.status.toLowerCase().replace('_', ' ')}`}
                {s.pending ? ` (${s.pending} waiting)` : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <form className="chatlist__new" onSubmit={startNew}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder="New chat: 918860924275" inputMode="tel" />
        <button type="submit" title="Start chat">+</button>
      </form>

      <input className="chatlist__filter" value={filter} onChange={(e) => onFilter(e.target.value)}
        placeholder="Search conversations" />

      <div className="chatlist__scroll">
        {chats.length === 0 ? (
          <Empty icon="🗂️" title="No conversations yet"
            hint="Incoming messages will appear here automatically." />
        ) : (
          chats.map((chat) => (
            <button key={chat.id} onClick={() => onSelect(chat)}
              className={`chatrow${chat.id === selectedId ? ' is-active' : ''}`}>
              <span className="chatrow__avatar" aria-hidden="true">
                {displayName(chat).slice(0, 2).toUpperCase()}
              </span>
              <span className="chatrow__main">
                <span className="chatrow__top">
                  <strong>{displayName(chat)}</strong>
                  <small>{when(chat.last_message_at)}</small>
                </span>
                <span className="chatrow__preview">{chat.last_message_preview || '—'}</span>
                {chat.tags?.length ? (
                  <span className="chatrow__tags">
                    {chat.tags.map((t) => <em key={t} className="tag">{t}</em>)}
                  </span>
                ) : null}
              </span>
              {chat.unread > 0 ? <span className="chatrow__badge">{chat.unread}</span> : null}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
