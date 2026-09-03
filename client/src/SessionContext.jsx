import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, socket } from './api';
import { useAuth } from './AuthContext';

const SessionContext = createContext(null);
const ACTIVE_KEY = 'wpp.activeSession';

/**
 * Tracks which WhatsApp session the UI is looking at, and keeps its live
 * status in sync. The server pushes status/qr per session room, so switching
 * sessions means re-subscribing.
 */
export function SessionProvider({ children }) {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(() => localStorage.getItem(ACTIVE_KEY) ?? '');
  const [status, setStatus] = useState('DISCONNECTED');
  const [detail, setDetail] = useState(null);
  const [qr, setQr] = useState(null);
  const [me, setMe] = useState(null);

  const refresh = useCallback(async () => {
    const list = await api.sessions().catch(() => []);
    setSessions(list);
    setActive((current) => {
      if (current && list.some((s) => s.name === current)) return current;
      return list[0]?.name ?? '';
    });
    return list;
  }, []);

  useEffect(() => {
    if (user) refresh();
  }, [user, refresh]);

  useEffect(() => {
    if (active) localStorage.setItem(ACTIVE_KEY, active);
  }, [active]);

  // Re-subscribe whenever the active session changes, and re-subscribe after a
  // reconnect — otherwise a dropped socket silently stops delivering events.
  useEffect(() => {
    if (!user || !active) return undefined;

    const subscribe = () => socket.emit('subscribe', active);
    subscribe();
    socket.on('connect', subscribe);

    const onStatus = (payload) => {
      if (payload.session && payload.session !== active) return;
      setStatus(payload.status);
      setDetail(payload.detail ?? null);
      setMe(payload.me ?? null);
      if (payload.status === 'CONNECTED') setQr(null);
      if (payload.qr) setQr(payload.qr);
      setSessions((prev) =>
        prev.map((s) => (s.name === payload.session ? { ...s, status: payload.status, me: payload.me } : s)));
    };
    const onQr = (payload) => {
      if (payload.session === active) setQr(payload.qr);
    };

    socket.on('status', onStatus);
    socket.on('qr', onQr);

    api.session(active).then(onStatus).catch(() => {});

    return () => {
      socket.off('connect', subscribe);
      socket.off('status', onStatus);
      socket.off('qr', onQr);
    };
  }, [user, active]);

  const value = useMemo(
    () => ({ sessions, active, setActive, status, detail, qr, me, refresh, connected: status === 'CONNECTED' }),
    [sessions, active, status, detail, qr, me, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
