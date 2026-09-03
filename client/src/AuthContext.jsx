import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken, connectSocket, disconnectSocket } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // On boot, exchange any stored token for the current user. A stale token
  // just resolves to logged-out rather than a broken shell.
  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    api.me()
      .then(({ user }) => {
        setUser(user);
        connectSocket();
      })
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  // api.js fires this when any request comes back 401.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('wpp:unauthorized', onExpired);
    return () => window.removeEventListener('wpp:unauthorized', onExpired);
  }, []);

  const value = useMemo(
    () => ({
      user,
      ready,
      async login(username, password) {
        const { token, user } = await api.login(username, password);
        setToken(token);
        setUser(user);
        connectSocket();
        return user;
      },
      async register(username, password) {
        const { token, user } = await api.register(username, password);
        setToken(token);
        setUser(user);
        connectSocket();
        return user;
      },
      /**
       * Signs out of this app only. WhatsApp sessions keep running on the
       * server — stopping one is a separate, deliberate act.
       */
      logout() {
        setToken(null);
        setUser(null);
        disconnectSocket();
      },
    }),
    [user, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
