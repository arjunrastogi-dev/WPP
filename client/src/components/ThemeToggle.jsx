import { useEffect, useState } from 'react';

/**
 * Light / dark / follow the system.
 *
 * The choice is written to the root element as `data-theme`, which the CSS
 * reads — and remembered, because a theme that resets on every reload is worse
 * than not offering one. "System" stores nothing and removes the attribute, so
 * the media query takes over again.
 */
const ORDER = ['system', 'light', 'dark'];
const ICON = { system: '🖥️', light: '☀️', dark: '🌙' };
const LABEL = { system: 'System theme', light: 'Light', dark: 'Dark' };

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** Read the saved choice before React mounts, so there is no flash of light. */
export function bootTheme() {
  try {
    applyTheme(localStorage.getItem('theme') ?? 'system');
  } catch { /* private mode: the system theme is a fine fallback */ }
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') ?? 'system'; } catch { return 'system'; }
  });

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem('theme', theme); } catch { /* nothing to do */ }
  }, [theme]);

  return (
    <button
      type="button"
      className="rail__theme"
      title={LABEL[theme]}
      onClick={() => setTheme(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length])}
    >
      <span>{ICON[theme]}</span>
      <span>{LABEL[theme]}</span>
    </button>
  );
}
