import { io } from 'socket.io-client';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'wpp.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

/** Absolute URL for a stored media file. */
export const mediaUrl = (filename) => `${API_URL}/media/${filename}`;

/**
 * One shared socket. It carries the same JWT as the REST calls — the server
 * rejects the handshake without it.
 */
export const socket = io(API_URL, {
  autoConnect: false,
  auth: (cb) => cb({ token: getToken() }),
});

export function connectSocket() {
  if (!socket.connected) socket.connect();
}
export function disconnectSocket() {
  if (socket.connected) socket.disconnect();
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, isForm = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers,
    body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });

  // An expired token should drop us back to the login screen rather than
  // leaving the UI in a half-broken state.
  if (res.status === 401) {
    setToken(null);
    disconnectSocket();
    window.dispatchEvent(new Event('wpp:unauthorized'));
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data;
}

export const api = {
  login: (username, password) => request('/auth/login', { method: 'POST', body: { username, password } }),
  register: (username, password) => request('/auth/register', { method: 'POST', body: { username, password } }),
  me: () => request('/auth/me'),
  users: () => request('/auth/users'),
  createUser: (body) => request('/auth/users', { method: 'POST', body }),

  sessions: () => request('/sessions'),
  createSession: (name) => request('/sessions', { method: 'POST', body: { name } }),
  session: (name) => request(`/sessions/${name}`),
  sessionStats: (name) => request(`/sessions/${name}/stats`),
  startSession: (name) => request(`/sessions/${name}/start`, { method: 'POST' }),
  /** `disconnect` clears the intent, so the session stays down across restarts. */
  stopSession: (name, { logout = false, disconnect = false } = {}) =>
    request(`/sessions/${name}/stop`, { method: 'POST', body: { logout, disconnect } }),
  deleteSession: (name) => request(`/sessions/${name}`, { method: 'DELETE' }),
  closeAllBrowsers: (clearIntent = false) =>
    request('/sessions/close-all', { method: 'POST', body: { clearIntent } }),

  chats: (session) => request(`/chats/${session}`),
  messages: (session, chatId, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/chats/${session}/${encodeURIComponent(chatId)}/messages${q ? `?${q}` : ''}`);
  },
  markRead: (session, chatId) => request(`/chats/${session}/${encodeURIComponent(chatId)}/read`, { method: 'POST' }),
  assign: (session, chatId, userId) =>
    request(`/chats/${session}/${encodeURIComponent(chatId)}/assign`, { method: 'POST', body: { userId } }),
  deleteChat: (session, chatId) =>
    request(`/chats/${session}/${encodeURIComponent(chatId)}`, { method: 'DELETE' }),
  setTags: (session, chatId, tags) =>
    request(`/chats/${session}/${encodeURIComponent(chatId)}/tags`, { method: 'POST', body: { tags } }),

  /** Text, media and scheduled sends all go through this one endpoint. */
  send(session, { to, message, file, sendAt }) {
    if (file) {
      const form = new FormData();
      form.append('to', to);
      if (message) form.append('message', message);
      if (sendAt) form.append('sendAt', String(sendAt));
      form.append('file', file);
      return request(`/messages/${session}/send`, { method: 'POST', body: form, isForm: true });
    }
    return request(`/messages/${session}/send`, { method: 'POST', body: { to, message, sendAt } });
  },
  search: (session, q) => request(`/messages/${session}/search?q=${encodeURIComponent(q)}`),
  backfillMedia: (session) => request(`/messages/${session}/media/backfill`, { method: 'POST' }),

  templates: () => request('/templates'),
  template: (id) => request(`/templates/${id}`),
  createTemplate: (body) => request('/templates', { method: 'POST', body }),
  toggleTemplate: (id, enabled) => request(`/templates/${id}`, { method: 'PATCH', body: { enabled } }),
  updateTemplate: (id, body) => request(`/templates/${id}`, { method: 'PATCH', body }),
  deleteTemplate: (id) => request(`/templates/${id}`, { method: 'DELETE' }),
  previewTemplate: (id, variables) =>
    request(`/templates/${id}/preview`, { method: 'POST', body: { variables } }),

  bulkPreview: (body) => request('/bulk/preview', { method: 'POST', body }),
  bulkSend: (body) => request('/bulk/send', { method: 'POST', body }),
  bulkProgress: (session) => request(`/bulk/${session}/progress`),
  bulkCancel: (session) => request(`/bulk/${session}/pending`, { method: 'DELETE' }),
  schedules: () => request('/schedules'),
  schedulePreview: (body) => request('/schedules/preview', { method: 'POST', body }),
  scheduleCreate: (body) => request('/schedules', { method: 'POST', body }),
  scheduleUpdate: (id, body) => request(`/schedules/${id}`, { method: 'PUT', body }),
  scheduleToggle: (id, enabled) => request(`/schedules/${id}/toggle`, { method: 'POST', body: { enabled } }),
  scheduleRun: (id) => request(`/schedules/${id}/run`, { method: 'POST' }),
  scheduleRuns: (id) => request(`/schedules/${id}/runs`),
  scheduleDelete: (id) => request(`/schedules/${id}`, { method: 'DELETE' }),

  bulkHistory: (session) => request(`/bulk/history${session ? `?session=${encodeURIComponent(session)}` : ''}`),
  bulkBatch: (ref) => request(`/bulk/history/${encodeURIComponent(ref)}`),

  rules: () => request('/rules'),
  createRule: (body) => request('/rules', { method: 'POST', body }),
  toggleRule: (id, enabled) => request(`/rules/${id}`, { method: 'PATCH', body: { enabled } }),
  deleteRule: (id) => request(`/rules/${id}`, { method: 'DELETE' }),

  outbox: (session) => request(`/outbox/${session}`),
  cancelJob: (id) => request(`/outbox/${id}`, { method: 'DELETE' }),

  webhooks: () => request('/webhooks'),
  createWebhook: (body) => request('/webhooks', { method: 'POST', body }),
  toggleWebhook: (id, enabled) => request(`/webhooks/${id}`, { method: 'PATCH', body: { enabled } }),
  deleteWebhook: (id) => request(`/webhooks/${id}`, { method: 'DELETE' }),
};
