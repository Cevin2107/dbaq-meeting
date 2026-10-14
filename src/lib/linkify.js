/**
 * Split plain chat text into text/link segments (pure, no DOM).
 *
 * Safety rules that matter here, because chat text comes from other people:
 *  - Only http(s) hrefs are ever produced. The scheme is either matched
 *    literally as `http://` / `https://` or synthesized as `https://`, so a
 *    `javascript:` / `data:` payload in a message can never become an href.
 *  - Every candidate is re-parsed with `new URL()` and dropped if it does not
 *    survive, so nothing malformed reaches the DOM.
 *  - Candidates carrying credentials (`https://puter.com@evil.test`) or bidi
 *    controls are left as plain text; both read as one host but resolve to
 *    another.
 *  - The caller renders segments as text nodes / `<a>` elements, never as
 *    markup, so link text cannot inject HTML.
 */

/** Hosts without a scheme are only linked when they end in one of these. */
const TLDS = [
  // generic
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz',
  'io', 'ai', 'dev', 'app', 'co', 'me', 'tv', 'xyz', 'online', 'site',
  'tech', 'cloud', 'store', 'blog', 'news', 'live', 'space', 'world', 'link',
  // country
  'us', 'uk', 'ca', 'au', 'nz', 'de', 'fr', 'es', 'it', 'nl', 'be', 'ch',
  'at', 'se', 'no', 'fi', 'dk', 'ie', 'pt', 'gr', 'pl', 'cz', 'ru', 'ua',
  'tr', 'il', 'ae', 'sa', 'in', 'cn', 'jp', 'kr', 'hk', 'tw', 'sg', 'th',
  'vn', 'ph', 'id', 'my', 'br', 'mx', 'ar', 'cl', 'za', 'ng', 'ke', 'eu',
];
// Deliberately absent: TLDs that collide with common file extensions
// ('sh', 'py', 'rs', 'cc', 'zip', 'mov'), so "main.js" or "notes.sh" stay
// plain text.

/** One DNS label. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** Characters allowed inside a URL once past the host. */
const TAIL = '[^\\s<>"\'`\\u0000-\\u001f\\u007f]';

const CANDIDATE = new RegExp(
  [
    `https?://${TAIL}+`,
    `www\\.${TAIL}+`,
    // Bare host: needs a known TLD that is not itself the start of a longer
    // label ("foo.community") or followed by another label ("foo.com.zzz").
    `(?:${LABEL}\\.){1,8}(?:${TLDS.join('|')})(?![a-z0-9-])(?!\\.[a-z0-9])(?:[:/?#]${TAIL}*)?`,
  ].join('|'),
  'gi'
);

/** Trailing characters that punctuate a sentence rather than end a URL. */
const TRAILING = new Set([...'.,;:!?\'"`*_~|^…‚„“”‘’«»']);
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/** Characters that mean the match is a fragment of something bigger. */
const PRECEDING_URL_CHAR = /[A-Za-z0-9@._+\-%/\\]/;

/** Direction overrides and marks: they let link text lie about its target. */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** Runaway guard; a 4000-character message cannot hold more real links. */
const MAX_LINKS = 100;

/**
 * @typedef {{ type: 'text', text: string } | { type: 'link', text: string, href: string }} Segment
 */

/**
 * @param {string} text
 * @returns {Segment[]} Segments in order; concatenating `.text` rebuilds the input.
 */
export function linkify(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  /** @type {Segment[]} */
  const segments = [];
  let cursor = 0;
  let links = 0;

  CANDIDATE.lastIndex = 0;
  for (let match; (match = CANDIDATE.exec(source)); ) {
    const start = match.index;
    // Sentence punctuation swallowed by the match goes back to the text run,
    // so re-scan from the end of the trimmed candidate. Candidates always
    // start with a letter or digit, so this still advances and cannot loop.
    const raw = trimTrailing(match[0]);
    CANDIDATE.lastIndex = start + raw.length;

    if (links >= MAX_LINKS) break;
    if (start > 0 && PRECEDING_URL_CHAR.test(source[start - 1])) continue;

    const href = toHref(raw);
    if (!href) continue; // not a URL we trust: leave it as plain text

    if (start > cursor) segments.push({ type: 'text', text: source.slice(cursor, start) });
    segments.push({ type: 'link', text: raw, href });
    cursor = start + raw.length;
    links++;
  }

  if (cursor < source.length) segments.push({ type: 'text', text: source.slice(cursor) });
  return segments;
}

/** Resolve a candidate to a safe absolute href, or null to leave it as text. */
function toHref(raw) {
  if (!raw || BIDI.test(raw)) return null;
  // Only these two schemes can come from the text; everything else is a bare
  // host that we explicitly make https.
  const absolute = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href;
}

/** Drop trailing punctuation and brackets the URL never opened. */
function trimTrailing(raw) {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if (TRAILING.has(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener && count(raw, ch, end) > count(raw, opener, end)) {
      end--;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

function count(str, ch, end) {
  let n = 0;
  for (let i = 0; i < end; i++) if (str[i] === ch) n++;
  return n;
}
