import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import { useSession } from '../SessionContext';
import StatusPill from './StatusPill';

const NAV = [
  { to: '/', label: 'Inbox', icon: '💬', end: true },
  { to: '/sessions', label: 'Sessions', icon: '📱' },
  {
    label: 'Templates',
    icon: '📝',
    children: [
      { to: '/templates/new', label: 'Add Template' },
      { to: '/templates', label: 'Template List', end: true },
    ],
  },
  { to: '/bulk', label: 'Bulk send', icon: '📣' },
  { to: '/schedules', label: 'Schedules', icon: '⏰' },
  { to: '/rules', label: 'Auto-replies', icon: '⚡' },
  { to: '/scheduled', label: 'Queue', icon: '🕒' },
  { to: '/webhooks', label: 'Webhooks', icon: '🔗' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { sessions, active, setActive, status, detail, refresh } = useSession();
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(null);

  const running = sessions.filter((s) => s.status !== 'DISCONNECTED').length;

  /*
   * Each session holds its own Chromium at roughly 400MB. Closing them from
   * here frees that memory without ending the sessions for good — they come
   * back on the next restart, or when the watchdog notices.
   */
  const closeBrowsers = async () => {
    setClosing(true);
    setClosed(null);
    try {
      const result = await api.closeAllBrowsers();
      setClosed(result.closed.length);
      await refresh();
    } catch (err) {
      setClosed(err.message);
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail__brand">
          <span className="rail__logo">W</span>
          <div>
            <strong>WPP Inbox</strong>
            <small>{user?.username} · {user?.role}</small>
          </div>
        </div>

        <label className="rail__session">
          <span>Session</span>
          <select value={active} onChange={(e) => setActive(e.target.value)}>
            {sessions.length === 0 ? <option value="">No sessions yet</option> : null}
            {sessions.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
        </label>

        <StatusPill status={status} detail={detail} />

        <nav className="rail__nav">
          {NAV.map((item) => (
            item.children ? (
              <div key={item.label} className="rail__group">
                <span className="rail__grouphead">
                  <span aria-hidden="true">{item.icon}</span> {item.label}
                </span>
                {item.children.map((child) => (
                  <NavLink key={child.to} to={child.to} end={child.end}
                    className={({ isActive }) => `rail__link rail__link--sub${isActive ? ' is-active' : ''}`}>
                    {child.label}
                  </NavLink>
                ))}
              </div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.end}
                className={({ isActive }) => `rail__link${isActive ? ' is-active' : ''}`}>
                <span aria-hidden="true">{item.icon}</span> {item.label}
              </NavLink>
            )
          ))}
        </nav>

        <div className="rail__foot">
          <button className="rail__browsers" onClick={closeBrowsers} disabled={closing}
            title="Closes every WhatsApp browser and frees its memory. Sessions stay closed until you start them again.">
            {closing ? 'Closing…' : `Close all browsers${running ? ` (${running})` : ''}`}
          </button>
          {closed !== null ? (
            <small className="muted">
              {typeof closed === 'number'
                ? `${closed} browser(s) closed.`
                : closed}
            </small>
          ) : null}
          <button className="rail__logout" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
