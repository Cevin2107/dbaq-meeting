/** Time formatting helpers (pure). */

/** "3:45 PM" style clock. */
export function formatClock(date = new Date(), locale = undefined) {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** "Mon, Jul 14" style date. */
export function formatDay(date = new Date(), locale = undefined) {
  return date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Elapsed duration: "05:09", "1:05:09".
 * @param {number} ms
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Chat timestamp: clock time for today, day + time otherwise. */
export function formatChatTime(ts, now = Date.now(), locale = undefined) {
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? formatClock(d, locale) : `${formatDay(d, locale)}, ${formatClock(d, locale)}`;
}
