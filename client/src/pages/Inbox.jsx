import { useCallback, useEffect, useRef, useState } from 'react';
import { api, socket } from '../api';
import { useSession } from '../SessionContext';
import ChatList from '../components/ChatList';
import Thread from '../components/Thread';
import Composer from '../components/Composer';
import ChatHeader from '../components/ChatHeader';
import Empty from '../components/Empty';

/**
 * The shared team inbox: conversation list on the left, thread on the right.
 *
 * History comes from the database, so a refresh (or a colleague opening the
 * app for the first time) shows the full conversation, not just what arrived
 * while the tab happened to be open.
 */
export default function Inbox() {
  const { active, setActive, sessions, connected, qr, status } = useSession();
  const [chats, setChats] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const selectedRef = useRef(null);

  selectedRef.current = selected;

  const loadChats = useCallback(() => {
    if (!active) return;
    api.chats(active).then(setChats).catch((err) => setError(err.message));
  }, [active]);

  useEffect(() => {
    setSelected(null);
    setMessages([]);
    loadChats();
  }, [active, loadChats]);

  // Open a conversation: load its history and clear the unread badge.
  const openChat = useCallback(async (chat) => {
    setSelected(chat);
    setLoading(true);
    setError(null);
    try {
      setMessages(await api.messages(active, chat.id, { limit: 60 }));
      if (chat.unread > 0) {
        await api.markRead(active, chat.id);
        setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, unread: 0 } : c)));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [active]);

  // Drop a deleted conversation from the list, clearing it if it was open.
  const forgetChat = useCallback((chatId) => {
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    setSelected((cur) => {
      if (cur?.id !== chatId) return cur;
      setMessages([]);
      return null;
    });
  }, []);

  // Attachments can fail to download transiently; let the user ask again.
  const retryMedia = useCallback(async () => {
    setError(null);
    try {
      const { recovered } = await api.backfillMedia(active);
      if (recovered === 0) setError('No attachments could be recovered.');
      if (selectedRef.current) {
        setMessages(await api.messages(active, selectedRef.current.id, { limit: 60 }));
      }
    } catch (err) {
      setError(err.message);
    }
  }, [active]);

  // Live updates. Appending only when the message belongs to the open thread
  // avoids a refetch on every inbound message.
  useEffect(() => {
    const onMessage = ({ session, message, chat }) => {
      if (session !== active) return;
      setChats((prev) => {
        const rest = prev.filter((c) => c.id !== chat.id);
        return [chat, ...rest];
      });
      if (selectedRef.current?.id === message.chat_id) {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        api.markRead(session, message.chat_id).catch(() => {});
      }
    };

    const onAck = ({ session, message }) => {
      if (session !== active) return;
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, ack: message.ack } : m)));
    };

    const onChat = ({ session, chat }) => {
      if (session !== active || !chat) return;
      setChats((prev) => prev.map((c) => (c.id === chat.id ? chat : c)));
      setSelected((cur) => (cur?.id === chat.id ? chat : cur));
    };

    const onDeleted = ({ session, chatId }) => {
      if (session === active) forgetChat(chatId);
    };

    socket.on('message', onMessage);
    socket.on('ack', onAck);
    socket.on('chat', onChat);
    socket.on('chat:deleted', onDeleted);
    return () => {
      socket.off('message', onMessage);
      socket.off('ack', onAck);
      socket.off('chat', onChat);
      socket.off('chat:deleted', onDeleted);
    };
  }, [active, forgetChat]);

  const visible = filter
    ? chats.filter((c) =>
        (c.name ?? '').toLowerCase().includes(filter.toLowerCase()) ||
        c.id.toLowerCase().includes(filter.toLowerCase()))
    : chats;

  if (!active) {
    return <Empty icon="📱" title="No session yet"
      hint="Create one under Sessions, then scan its QR code to connect." />;
  }

  return (
    <div className="inbox">
      <ChatList
        chats={visible}
        selectedId={selected?.id}
        filter={filter}
        onFilter={setFilter}
        onSelect={openChat}
        onNewChat={(chat) => { setChats((p) => [chat, ...p.filter((c) => c.id !== chat.id)]); openChat(chat); }}
        sessions={sessions}
        activeSession={active}
        onSession={setActive}
      />

      <section className="thread-pane">
        {!connected && status !== 'WAITING_QR' ? (
          <p className="banner banner--warn">
            “{active}” is {status.toLowerCase().replace('_', ' ')}. New messages won&apos;t arrive and
            anything you send will wait in the queue until it reconnects.
          </p>
        ) : null}

        {qr && status === 'WAITING_QR' ? (
          <div className="qr-overlay">
            <img className="qrcode" src={qr} alt="WhatsApp QR code" width={260} height={260} />
            <p className="muted">
              WhatsApp → Settings → Linked devices → Link a device.<br />The code refreshes every ~20s.
            </p>
          </div>
        ) : selected ? (
          <>
            <ChatHeader chat={selected} session={active}
              onDelete={forgetChat}
              onChange={(chat) => {
                setSelected(chat);
                setChats((prev) => prev.map((c) => (c.id === chat.id ? chat : c)));
              }} />
            {error ? <p className="error">{error}</p> : null}
            <Thread messages={messages} loading={loading} onRetryMedia={retryMedia} />
            <Composer session={active} chat={selected} disabled={!connected}
              onQueued={loadChats} onError={setError} />
          </>
        ) : (
          <Empty icon="💬" title="Select a conversation"
            hint={connected
              ? 'Pick a chat on the left, or start a new one.'
              : 'This session is not connected — start it under Sessions.'} />
        )}
      </section>
    </div>
  );
}
