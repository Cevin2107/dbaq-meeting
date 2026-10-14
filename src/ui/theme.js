import { getThemePref, setThemePref } from '../lib/prefs.js';

/**
 * Theme management. An explicit choice is stamped on <html data-theme>;
 * with no explicit choice the OS preference applies via CSS.
 */

/** The user's explicit choice: 'light' | 'dark' | null (follow system). */
export function chosenTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : null;
}

/** The theme actually in effect right now. */
export function effectiveTheme() {
  const chosen = chosenTheme();
  if (chosen) return chosen;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** @param {'light'|'dark'|null} theme  null = follow system */
export function setTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  setThemePref(theme ?? null);
}

export function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** Apply the persisted preference (call at boot). */
export function initTheme() {
  const saved = getThemePref();
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }
}
