/**
 * The home screen's meeting list, minus the screen: date math, grouping,
 * the read-window strategy and the local snapshot. No DOM and no Puter in
 * here — ui/agenda.js is a thin view over these, and everything below is
 * unit-tested on its own.
 *
 * The list is the user's calendar events that carry a meeting link, read
 * from the Calendar app over its app-to-app API (lib/calendar.js). What the
 * panel does with them: a week strip to pick a day, that day's meetings
 * split into the ones still to come and the ones over, a Join button on
 * each, and — when the day is empty — the next meeting anywhere ahead, so
 * "nothing today" is never a dead end.
 */
import { extractCode } from './codes.js';
import { normalizeRoomCode } from './rooms.js';
import { formatClock, formatDay } from './time.js';

export const DAY_MS = 86_400_000;

/** How far ahead the first read looks: this week and the three after it.
 *  One read covers today, the next few clicks of the week strip, and the
 *  "next up" hint for an empty day — each without launching the Calendar
 *  again. Cheap for the Calendar too: expansion cost scales with the
 *  window, and four weeks of meeting-linked events is a small answer. */
export const LOOKAHEAD_DAYS = 28;

/** A meeting starting within this long counts as "soon". */
export const SOON_MS = 10 * 60_000;

/* ---- Dates ---------------------------------------------------------------- */

/** Local midnight of the day `ts` falls in. */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `n` calendar days from `ts` — the same wall-clock time across a clock
 *  change, where adding 24h × n would drift an hour. */
export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function isSameDay(a, b) {
  return startOfDay(a) === startOfDay(b);
}

/**
 * 0 (Sunday) … 6 (Saturday): the day the week starts on in `locale`, where
 * the browser knows (Intl week info); Sunday otherwise, which is what the
 * calendars most people here grew up with show.
 */
export function firstDayOfWeek(locale) {
  try {
    const tag = locale || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    const loc = new Intl.Locale(tag);
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    const first = info && info.firstDay; // 1 = Monday … 7 = Sunday
    if (Number.isInteger(first) && first >= 1 && first <= 7) return first % 7;
  } catch {
    /* an unknown locale, or no Intl.Locale */
  }
  return 0;
}

/**
 * Local midnight of the first day of the week `ts` falls in.
 *
 * Day starts are always re-derived with startOfDay after stepping: where a
 * clock change falls on midnight (Chile, Cuba — the day starts at 01:00,
 * since 00:00 never happens), addDays keeps the wall-clock time it started
 * from, and a week's worth of "midnights" copied from such a day would all
 * sit at 01:00 — and never compare equal to what startOfDay says for the
 * other six.
 */
export function startOfWeek(ts, firstDay = 0) {
  const day = startOfDay(ts);
  const dow = new Date(day).getDay();
  return startOfDay(addDays(day, -((dow - firstDay + 7) % 7)));
}

/** The seven day-starts of the week beginning at `weekStart`. */
export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => startOfDay(addDays(weekStart, i)));
}

/** Local midnight of the day after the one starting at `dayStart`. */
export function nextDayStart(dayStart) {
  return startOfDay(addDays(dayStart, 1));
}

/* ---- Meetings ------------------------------------------------------------- */

/** A link into this app, wherever it is deployed from. */
const MEETINGS_LINK = /^https:\/\/meetings\.puter\.com\/#\/m\//;

/**
 * An event as the panel shows it, from one as the Calendar API returns it
 * — or null for anything not worth a row (no link, no times). The Calendar
 * already vouches for `meeting.url` being an http(s) URL; it is checked
 * again here because it ends up in an `href`, and a snapshot read back from
 * disk may have been written by an older build.
 *
 * `code` is set for a link into *this* app — the room code Join opens in the
 * green room — and null for any other video link (a Zoom or Meet URL that
 * came in through an .ics import), which the panel opens in a new tab.
 *
 * @param {object} raw an event from the Calendar API
 * @param {{ ownOrigin?: string }} [options] a second origin to treat as ours
 *   (a dev server, a mirror); production links always name meetings.puter.com
 */
export function toMeeting(raw, { ownOrigin = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.meeting && typeof raw.meeting.url === 'string' ? raw.meeting.url.trim() : '';
  if (!/^https?:\/\//i.test(url) || url.length > 500) return null;
  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const own = MEETINGS_LINK.test(url) || (ownOrigin && url.startsWith(`${ownOrigin}#/m/`));
  let code = null;
  if (own) {
    const extracted = extractCode(url);
    if (extracted) code = normalizeRoomCode(extracted) ?? extracted;
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${start}:${url}`,
    title: title || 'Untitled meeting',
    start,
    end: Math.max(end, start),
    allDay: Boolean(raw.allDay),
    url,
    code,
    // The API sends the people; the snapshot only keeps how many.
    guests: Array.isArray(raw.guests) ? raw.guests.length : Number.isInteger(raw.guests) && raw.guests > 0 ? raw.guests : 0,
    recurring: Boolean(raw.recurring),
  };
}

/** Chronological, all-day first — the order an agenda reads in. */
export function byStart(a, b) {
  return Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.end - b.end;
}

/** The meetings that touch the calendar day starting at `dayStart`. */
export function onDay(meetings, dayStart) {
  const dayEnd = nextDayStart(dayStart);
  return meetings.filter((m) => m.start < dayEnd && m.end > dayStart).sort(byStart);
}

/** 'now' (running), 'soon' (starts within SOON_MS), 'upcoming' or 'past'. */
export function statusOf(m, now) {
  if (m.end <= now) return 'past';
  if (m.start <= now) return 'now';
  if (m.start - now <= SOON_MS) return 'soon';
  return 'upcoming';
}

/** A day's meetings as { ahead, past }: running or still to come, and over. */
export function splitPast(meetings, now) {
  const ahead = [];
  const past = [];
  for (const m of meetings) (m.end <= now ? past : ahead).push(m);
  return { ahead, past };
}

/**
 * The next meeting still to come (or running), skipping the day
 * `excludeDay` falls in — the one the user is already looking at. Strictly
 * by time: the all-day-first order a day's list reads in would put next
 * month's offsite ahead of the call that starts in ten minutes.
 */
export function nextUp(meetings, now, excludeDay) {
  let best = null;
  for (const m of meetings) {
    if (m.end <= now) continue;
    if (excludeDay !== undefined && isSameDay(m.start, excludeDay)) continue;
    if (!best || m.start < best.start || (m.start === best.start && m.end < best.end)) best = m;
  }
  return best;
}

/* ---- Read windows --------------------------------------------------------- */

/** True when [from, to) lies inside one of `ranges` ({ from, to } each). */
export function covered(ranges, from, to) {
  return ranges.some((r) => r.from <= from && r.to >= to);
}

/** `ranges` with [from, to) added, overlapping or touching ones merged. */
export function addRange(ranges, from, to) {
  const all = [...ranges, { from, to }].sort((a, b) => a.from - b.from);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: r.to });
  }
  return out;
}

/**
 * The window to read for the week starting at `weekStart`: the LOOKAHEAD
 * weeks from today's week when that week is one of them — one read then
 * serves today, the next few clicks and the "next up" hint — and otherwise
 * just that week.
 */
export function windowFor(weekStart, todayWeekStart) {
  const ahead = startOfDay(addDays(todayWeekStart, LOOKAHEAD_DAYS));
  if (weekStart >= todayWeekStart && weekStart < ahead) return { from: todayWeekStart, to: ahead };
  return { from: weekStart, to: startOfDay(addDays(weekStart, 7)) };
}

/**
 * Fold a read of [from, to) into `byId`: everything previously known to
 * touch the window goes (a meeting cancelled or moved since is gone for
 * good, not just missing from the new answer), then the answer goes in.
 * Mutates and returns `byId`.
 */
export function mergeWindow(byId, meetings, from, to) {
  for (const [id, m] of byId) {
    if (m.start < to && m.end > from) byId.delete(id);
  }
  for (const m of meetings) byId.set(m.id, m);
  return byId;
}

/* ---- The local snapshot --------------------------------------------------- */

const CACHE_PREFIX = 'pm.agenda:';
const CACHE_VERSION = 1;
/** Meetings kept per snapshot — plenty for four weeks, and a bound on what a
 *  runaway calendar could park in localStorage. */
export const CACHE_MAX = 300;

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // private mode, or storage disabled
  }
}

/**
 * The last list this device saw for `userKey`, or null. Launching the
 * Calendar to ask again takes a second or two; the snapshot paints the
 * panel immediately and is replaced when the fresh answer lands. Rows are
 * re-validated through toMeeting, so a malformed one is dropped rather
 * than thrown from a render.
 *
 * @param {string} userKey
 * @param {{ ownOrigin?: string }} [options] passed on to toMeeting, so a row
 *   read back on a dev or mirror origin still knows its own links
 * @returns {{ savedAt: number, from: number, to: number, meetings: object[] } | null}
 */
export function readAgendaCache(userKey, { ownOrigin = '' } = {}) {
  const store = storage();
  if (!store || !userKey) return null;
  try {
    const blob = JSON.parse(store.getItem(CACHE_PREFIX + userKey) || 'null');
    if (!blob || blob.v !== CACHE_VERSION || !Array.isArray(blob.meetings)) return null;
    const meetings = blob.meetings.map((m) => toMeeting({ ...m, meeting: { url: m.url } }, { ownOrigin })).filter(Boolean);
    const savedAt = Number(blob.savedAt);
    const from = Number(blob.from);
    const to = Number(blob.to);
    if (![savedAt, from, to].every(Number.isFinite) || to <= from) return null;
    return { savedAt, from, to, meetings };
  } catch {
    return null;
  }
}

/**
 * Remember the meetings in [from, to) for `userKey`. Only meetings touching
 * the window are kept, the earliest CACHE_MAX of them; when that cuts the
 * list short the window is shortened to match, so the snapshot never
 * claims a day it does not fully hold.
 */
export function writeAgendaCache(userKey, { savedAt, from, to, meetings }) {
  const store = storage();
  if (!store || !userKey) return;
  let kept = meetings.filter((m) => m.start < to && m.end > from).sort(byStart);
  let end = to;
  if (kept.length > CACHE_MAX) {
    end = Math.min(to, kept[CACHE_MAX].start);
    kept = kept.slice(0, CACHE_MAX).filter((m) => m.start < end);
  }
  try {
    store.setItem(
      CACHE_PREFIX + userKey,
      JSON.stringify({
        v: CACHE_VERSION,
        savedAt,
        from,
        to: end,
        meetings: kept.map(({ id, title, start, end: e, allDay, url, guests, recurring }) => ({
          id,
          title,
          start,
          end: e,
          allDay,
          url,
          guests,
          recurring,
        })),
      })
    );
  } catch {
    /* quota, or storage unavailable — the panel just paints a moment later */
  }
}

/** Forget every snapshot on this device — for sign-out, when whoever signs
 *  in next must not see the last account's meetings. */
export function clearAgendaCaches() {
  const store = storage();
  if (!store) return;
  try {
    const keys = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => store.removeItem(key));
  } catch {
    /* ignore */
  }
}

/* ---- Text ----------------------------------------------------------------- */

/** "8:00 – 8:30 AM"; "All day"; a meeting running past midnight names its end day. */
export function formatRange(m, locale = undefined) {
  if (m.allDay) return 'All day';
  const s = new Date(m.start);
  const e = new Date(m.end);
  if (!isSameDay(m.start, m.end)) return `${formatClock(s, locale)} – ${formatDay(e, locale)}, ${formatClock(e, locale)}`;
  try {
    const f = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    if (typeof f.formatRange === 'function') return f.formatRange(s, e).replace(/\s*[–—-]\s*/, ' – ');
  } catch {
    /* fall through */
  }
  return `${formatClock(s, locale)} – ${formatClock(e, locale)}`;
}

/** "Today", "Tomorrow", "Yesterday", else "Tue, Aug 25". */
export function dayLabel(dayStart, todayStart, locale = undefined) {
  const diff = Math.round((startOfDay(dayStart) - startOfDay(todayStart)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return formatDay(new Date(dayStart), locale);
}

/** "2 guests", "1 guest", or '' for none. */
export function guestsLabel(n) {
  if (!n) return '';
  return n === 1 ? '1 guest' : `${n} guests`;
}
