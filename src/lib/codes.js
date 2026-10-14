/**
 * Meeting code & link helpers.
 *
 * A meeting is identified by a persistent room code (see lib/rooms.js) or,
 * for legacy one-time links, by the host's raw Puter Peer invite code. We
 * treat the code as an opaque string and wrap it in shareable URLs of the
 * form:
 *
 *   https://example.com/#/m/<encoded-code>
 */

const MEETING_HASH_RE = /^#\/m\/(.+)$/;

/** Build a shareable meeting URL from a code. */
export function buildMeetingURL(code, base) {
  const origin = base ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '');
  return `${origin}#/m/${encodeURIComponent(code)}`;
}

/** Parse a location.hash value into a route descriptor. */
export function parseHash(hash) {
  if (!hash || hash === '#' || hash === '#/') return { view: 'home' };
  const m = MEETING_HASH_RE.exec(hash);
  if (m) {
    try {
      return { view: 'meeting', code: decodeURIComponent(m[1]) };
    } catch {
      return { view: 'meeting', code: m[1] };
    }
  }
  return { view: 'home' };
}

/**
 * Extract a meeting code from arbitrary user input: a raw code, a full
 * meeting link, or a link pasted with extra whitespace.
 * Returns null when nothing usable is found.
 */
export function extractCode(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  // Full URL (or anything containing our hash route).
  const hashIdx = text.indexOf('#/m/');
  if (hashIdx !== -1) {
    const route = parseHash(text.slice(hashIdx));
    return route.view === 'meeting' && route.code ? route.code.trim() || null : null;
  }

  // A bare URL without our route isn't a meeting code.
  if (/^https?:\/\//i.test(text)) return null;

  // Otherwise treat the input as the raw invite code.
  return text;
}

/**
 * Shorten long codes for display: keeps the start and end,
 * inserts an ellipsis in the middle.
 */
export function displayCode(code, max = 24) {
  if (typeof code !== 'string') return '';
  if (code.length <= max) return code;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${code.slice(0, keep)}…${code.slice(-keep)}`;
}
