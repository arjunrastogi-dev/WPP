import { useEffect, useState } from 'react';
import { api } from '../api';

/** Conversation header: who it is, who owns it, and how it's tagged. */
export default function ChatHeader({ chat, session, onChange, onDelete }) {
  const [users, setUsers] = useState([]);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // Only admins can list users; agents just won't see the assignment control.
  useEffect(() => {
    api.users().then(setUsers).catch(() => setUsers([]));
  }, []);

  const assign = async (value) => {
    setBusy(true);
    try {
      onChange(await api.assign(session, chat.id, value ? Number(value) : null));
    } finally {
      setBusy(false);
    }
  };

  const addTag = async (event) => {
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!tag || (chat.tags ?? []).includes(tag)) return setTagDraft('');
    onChange(await api.setTags(session, chat.id, [...(chat.tags ?? []), tag]));
    setTagDraft('');
  };

  const removeTag = async (tag) => {
    onChange(await api.setTags(session, chat.id, (chat.tags ?? []).filter((t) => t !== tag)));
  };

  // Destructive and irreversible locally, so confirm and spell out the scope:
  // this clears our copy, it does not delete the chat on WhatsApp.
  const remove = async () => {
    const name = chat.name || chat.id.split('@')[0];
    const ok = window.confirm(
      [
        `Delete the conversation with ${name} from this inbox?`,
        '',
        'Its messages and attachments are removed from this app permanently.',
        'The chat on WhatsApp itself is NOT affected.',
      ].join('\n'),
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteChat(session, chat.id);
      onDelete?.(chat.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="chathead">
      <div className="chathead__who">
        <strong>{chat.name || chat.id.split('@')[0]}</strong>
        <small>{chat.id}</small>
      </div>

      <div className="chathead__controls">
        {users.length > 0 ? (
          <label className="chathead__assign">
            Assigned
            <select value={chat.assigned_to ?? ''} onChange={(e) => assign(e.target.value)} disabled={busy}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
            </select>
          </label>
        ) : null}

        <button type="button" className="danger chathead__delete" onClick={remove} disabled={busy}
          title="Delete this conversation from the inbox">Delete</button>

        <form className="chathead__tags" onSubmit={addTag}>
          {(chat.tags ?? []).map((t) => (
            <button key={t} type="button" className="tag tag--removable" onClick={() => removeTag(t)}
              title="Remove tag">{t} ✕</button>
          ))}
          <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} placeholder="+ tag" />
        </form>
      </div>
    </header>
  );
}
