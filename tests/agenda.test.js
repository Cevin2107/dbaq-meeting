// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DAY_MS,
  LOOKAHEAD_DAYS,
  CACHE_MAX,
  startOfDay,
  addDays,
  isSameDay,
  firstDayOfWeek,
  startOfWeek,
  weekDays,
  toMeeting,
  onDay,
  statusOf,
  splitPast,
  nextUp,
  covered,
  addRange,
  windowFor,
  mergeWindow,
  readAgendaCache,
  writeAgendaCache,
  clearAgendaCaches,
  formatRange,
  dayLabel,
  guestsLabel,
} from '../src/lib/agenda.js';

/*
 * The home screen's meeting list, minus the screen: how a day is picked,
 * what it holds, what is read from the Calendar and when, and the snapshot
 * that paints it before the Calendar answers.
 */

// A Tuesday. Local time throughout, like the panel.
const TUE = new Date(2031, 7, 26, 0, 0, 0, 0).getTime(); // Tue 26 Aug 2031
const at = (day, h = 9, m = 0) => new Date(2031, 7, day, h, m, 0, 0).getTime();

const MEET = 'https://meetings.puter.com/#/m/abcd-efgh-ijkl';

/** An event as the Calendar API returns one. */
const event = (over = {}) => ({
  id: 'e1',
  title: 'Design review',
  start: at(26, 10),
  end: at(26, 11),
  allDay: false,
  recurring: false,
  guests: [{ email: 'ada@analytical.co' }],
  meeting: { url: MEET, code: 'abcd-efgh-ijkl' },
  ...over,
});

describe('dates', () => {
  it('finds midnight, steps whole days, and compares days', () => {
    expect(startOfDay(at(26, 15, 30))).toBe(TUE);
    expect(addDays(TUE, 1)).toBe(at(27, 0));
    expect(addDays(TUE, -7)).toBe(at(19, 0));
    expect(isSameDay(at(26, 1), at(26, 23))).toBe(true);
    expect(isSameDay(at(26, 23), at(27, 0))).toBe(false);
  });

  it('starts the week on the locale’s day, Sunday when unknown', () => {
    // Deterministic whatever Intl knows: pass the week start explicitly.
    expect(new Date(startOfWeek(TUE, 0)).getDay()).toBe(0);
    expect(startOfWeek(TUE, 0)).toBe(at(24, 0));
    expect(startOfWeek(TUE, 1)).toBe(at(25, 0));
    // A Sunday with a Monday week start belongs to the week before.
    expect(startOfWeek(at(24, 12), 1)).toBe(at(18, 0));
    expect([0, 1, 6]).toContain(firstDayOfWeek('en-US'));
    expect(firstDayOfWeek('not a locale at all!!')).toBe(0);
  });

  it('lists the seven days of a week', () => {
    const days = weekDays(at(24, 0));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe(at(24, 0));
    expect(days[6]).toBe(at(30, 0));
  });
});

describe('toMeeting', () => {
  it('turns a Calendar event into a row, with the room code of a link into this app', () => {
    const m = toMeeting(event());
    expect(m).toMatchObject({
      id: 'e1',
      title: 'Design review',
      start: at(26, 10),
      end: at(26, 11),
      url: MEET,
      code: 'abcd-efgh-ijkl',
      guests: 1,
      recurring: false,
    });
  });

  it('normalizes the code the way the app does, and accepts a classic room code', () => {
    expect(toMeeting(event({ meeting: { url: 'https://meetings.puter.com/#/m/ABC-DEFG-HIJ' } })).code).toBe(
      'abc-defg-hij'
    );
  });

  it('treats another origin as ours only when told to', () => {
    const url = 'http://localhost:6767/#/m/abcd-efgh-ijkl';
    expect(toMeeting(event({ meeting: { url } })).code).toBeNull();
    expect(toMeeting(event({ meeting: { url } }), { ownOrigin: 'http://localhost:6767/' }).code).toBe(
      'abcd-efgh-ijkl'
    );
  });

  it('keeps a link to some other service, without a code', () => {
    const m = toMeeting(event({ meeting: { url: 'https://zoom.us/j/123' } }));
    expect(m.url).toBe('https://zoom.us/j/123');
    expect(m.code).toBeNull();
  });

  it('drops anything without a usable link or times', () => {
    expect(toMeeting(null)).toBeNull();
    expect(toMeeting(event({ meeting: null }))).toBeNull();
    expect(toMeeting(event({ meeting: { url: 'javascript:alert(1)' } }))).toBeNull();
    expect(toMeeting(event({ meeting: { url: 'x'.repeat(600) } }))).toBeNull();
    expect(toMeeting(event({ start: 'soon' }))).toBeNull();
  });

  it('never shows an empty title, and never an end before the start', () => {
    const m = toMeeting(event({ title: '  ', end: at(26, 9) }));
    expect(m.title).toBe('Untitled meeting');
    expect(m.end).toBe(m.start);
  });

  it('accepts a guest count as well as a guest list (the snapshot keeps the count)', () => {
    expect(toMeeting(event({ guests: 3 })).guests).toBe(3);
    expect(toMeeting(event({ guests: undefined })).guests).toBe(0);
  });
});

describe('a day’s meetings', () => {
  const rows = [
    toMeeting(event({ id: 'a', start: at(26, 14), end: at(26, 15) })),
    toMeeting(event({ id: 'b', start: at(26, 9), end: at(26, 9, 30) })),
    toMeeting(event({ id: 'c', start: at(27, 9), end: at(27, 10) })),
    toMeeting(event({ id: 'd', start: at(26, 0), end: at(27, 0), allDay: true })),
    toMeeting(event({ id: 'late', start: at(25, 23), end: at(26, 1) })), // runs past midnight
  ];

  it('picks what touches the day, all-day first then by start', () => {
    expect(onDay(rows, TUE).map((m) => m.id)).toEqual(['d', 'late', 'b', 'a']);
    expect(onDay(rows, at(27, 0)).map((m) => m.id)).toEqual(['c']);
    expect(onDay(rows, at(28, 0))).toEqual([]);
  });

  it('knows whether a meeting is over, running, about to start, or ahead', () => {
    const m = rows[1]; // 9:00–9:30
    expect(statusOf(m, at(26, 8, 30))).toBe('upcoming');
    expect(statusOf(m, at(26, 8, 52))).toBe('soon');
    expect(statusOf(m, at(26, 9, 10))).toBe('now');
    expect(statusOf(m, at(26, 9, 30))).toBe('past');
  });

  it('splits a day into what is ahead and what is over', () => {
    const { ahead, past } = splitPast(onDay(rows, TUE), at(26, 10));
    expect(past.map((m) => m.id)).toEqual(['late', 'b']);
    expect(ahead.map((m) => m.id)).toEqual(['d', 'a']);
  });

  it('finds the next meeting ahead, skipping the day on screen', () => {
    expect(nextUp(rows, at(26, 10), TUE).id).toBe('c');
    expect(nextUp(rows, at(26, 10)).id).toBe('d'); // nothing excluded: today's all-day one
    expect(nextUp(rows, at(27, 12))).toBeNull();
  });

  it('next up is strictly by time — a far-off all-day event does not jump the queue', () => {
    const withOffsite = [
      ...rows.filter((m) => m.id !== 'd'), // no all-day event today, so time alone decides
      toMeeting(event({ id: 'offsite', start: at(30, 0), end: at(31, 0), allDay: true })),
    ];
    // Looking at an empty Monday while Tuesday's 2pm call is still ahead.
    expect(nextUp(withOffsite, at(26, 10), at(25, 0)).id).toBe('a');
    // A running meeting counts as next, ahead of one that starts later.
    expect(nextUp(withOffsite, at(26, 14, 30), at(25, 0)).id).toBe('a');
  });
});

describe('read windows', () => {
  it('knows what has been read, and merges windows that touch', () => {
    let ranges = addRange([], 10, 20);
    ranges = addRange(ranges, 20, 30);
    expect(ranges).toEqual([{ from: 10, to: 30 }]);
    ranges = addRange(ranges, 40, 50);
    ranges = addRange(ranges, 5, 12);
    expect(ranges).toEqual([
      { from: 5, to: 30 },
      { from: 40, to: 50 },
    ]);
    expect(covered(ranges, 6, 29)).toBe(true);
    expect(covered(ranges, 25, 45)).toBe(false);
    expect(covered([], 1, 2)).toBe(false);
  });

  it('reads four weeks from today for any week in them, one week otherwise', () => {
    const todayWs = at(24, 0);
    expect(windowFor(todayWs, todayWs)).toEqual({ from: todayWs, to: addDays(todayWs, LOOKAHEAD_DAYS) });
    expect(windowFor(addDays(todayWs, 21), todayWs)).toEqual({ from: todayWs, to: addDays(todayWs, 28) });
    expect(windowFor(addDays(todayWs, 28), todayWs)).toEqual({
      from: addDays(todayWs, 28),
      to: addDays(todayWs, 35),
    });
    expect(windowFor(addDays(todayWs, -7), todayWs)).toEqual({ from: addDays(todayWs, -7), to: todayWs });
  });

  it('folds a read into what is held: the window’s old rows go, the answer comes in', () => {
    const held = new Map();
    const a = toMeeting(event({ id: 'a', start: at(26, 9), end: at(26, 10) }));
    const b = toMeeting(event({ id: 'b', start: at(30, 9), end: at(30, 10) }));
    const spans = toMeeting(event({ id: 's', start: at(25, 23), end: at(26, 1) }));
    mergeWindow(held, [a, b, spans], at(24, 0), at(31, 0));
    expect([...held.keys()]).toEqual(['a', 'b', 's']);

    // Re-read Tuesday alone: `a` was cancelled meanwhile, `s` touches the
    // day and is re-sent, `b` is untouched.
    mergeWindow(held, [spans], TUE, at(27, 0));
    expect([...held.keys()].sort()).toEqual(['b', 's']);
  });
});

describe('the snapshot', () => {
  beforeEach(() => localStorage.clear());

  const rows = [
    toMeeting(event({ id: 'a', start: at(26, 9), end: at(26, 10) })),
    toMeeting(event({ id: 'z', start: at(26, 14), end: at(26, 15), meeting: { url: 'https://zoom.us/j/1' } })),
    toMeeting(event({ id: 'out', start: at(40, 9), end: at(40, 10) })), // outside the window
  ];

  it('round-trips the meetings in a window, per account', () => {
    writeAgendaCache('u1', { savedAt: at(26, 8), from: at(24, 0), to: at(31, 0), meetings: rows });
    const snap = readAgendaCache('u1');
    expect(snap.savedAt).toBe(at(26, 8));
    expect(snap.from).toBe(at(24, 0));
    expect(snap.to).toBe(at(31, 0));
    expect(snap.meetings.map((m) => m.id)).toEqual(['a', 'z']);
    // Rows come back exactly as toMeeting made them, code included.
    expect(snap.meetings[0]).toEqual(rows[0]);
    expect(snap.meetings[1].code).toBeNull();
    expect(readAgendaCache('u2')).toBeNull();
    expect(readAgendaCache('')).toBeNull();
  });

  it('keeps at most CACHE_MAX rows and shortens the window to match', () => {
    const many = Array.from({ length: CACHE_MAX + 20 }, (_, i) =>
      toMeeting(event({ id: `m${i}`, start: TUE + i * 3600_000, end: TUE + i * 3600_000 + 1800_000 }))
    );
    writeAgendaCache('u1', { savedAt: 1, from: TUE, to: TUE + 60 * DAY_MS, meetings: many });
    const snap = readAgendaCache('u1');
    expect(snap.meetings).toHaveLength(CACHE_MAX);
    expect(snap.to).toBe(many[CACHE_MAX].start);
  });

  it('ignores a snapshot it cannot trust', () => {
    localStorage.setItem('pm.agenda:u1', 'not json');
    expect(readAgendaCache('u1')).toBeNull();
    localStorage.setItem('pm.agenda:u1', JSON.stringify({ v: 99, meetings: [] }));
    expect(readAgendaCache('u1')).toBeNull();
    localStorage.setItem(
      'pm.agenda:u1',
      JSON.stringify({ v: 1, savedAt: 1, from: 10, to: 5, meetings: [] })
    );
    expect(readAgendaCache('u1')).toBeNull();
  });

  it('drops a malformed row rather than failing the whole snapshot', () => {
    localStorage.setItem(
      'pm.agenda:u1',
      JSON.stringify({
        v: 1,
        savedAt: 1,
        from: 0,
        to: 10,
        meetings: [{ id: 'bad', url: 'javascript:x', start: 1, end: 2 }, { id: 'ok', url: MEET, start: 1, end: 2, title: 'Ok' }],
      })
    );
    expect(readAgendaCache('u1').meetings.map((m) => m.id)).toEqual(['ok']);
  });

  it('forgets every account’s snapshot on request, and nothing else', () => {
    writeAgendaCache('u1', { savedAt: 1, from: 0, to: 10, meetings: [] });
    writeAgendaCache('u2', { savedAt: 1, from: 0, to: 10, meetings: [] });
    localStorage.setItem('pm.theme', '"dark"');
    clearAgendaCaches();
    expect(readAgendaCache('u1')).toBeNull();
    expect(readAgendaCache('u2')).toBeNull();
    expect(localStorage.getItem('pm.theme')).toBe('"dark"');
  });
});

describe('text', () => {
  it('formats a time range, an all-day meeting, and one that runs past midnight', () => {
    const m = toMeeting(event({ start: at(26, 8), end: at(26, 8, 30) }));
    const text = formatRange(m, 'en-US');
    expect(text).toMatch(/8:00/);
    expect(text).toMatch(/8:30/);
    expect(text).toContain(' – ');
    expect(formatRange(toMeeting(event({ allDay: true })))).toBe('All day');
    const late = formatRange(toMeeting(event({ start: at(26, 23), end: at(27, 1) })), 'en-US');
    expect(late).toMatch(/11:00/);
    expect(late).toMatch(/Aug 27/);
  });

  it('names a day relative to today when it is close', () => {
    expect(dayLabel(TUE, TUE)).toBe('Today');
    expect(dayLabel(at(27, 0), TUE)).toBe('Tomorrow');
    expect(dayLabel(at(25, 0), TUE)).toBe('Yesterday');
    expect(dayLabel(at(28, 0), TUE, 'en-US')).toMatch(/Thu.*Aug.*28/);
  });

  it('counts guests', () => {
    expect(guestsLabel(0)).toBe('');
    expect(guestsLabel(1)).toBe('1 guest');
    expect(guestsLabel(4)).toBe('4 guests');
  });
});
