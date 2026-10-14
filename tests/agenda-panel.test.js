// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountAgenda } from '../src/ui/agenda.js';
import { writeAgendaCache, readAgendaCache, addDays } from '../src/lib/agenda.js';

/*
 * The "Your meetings" panel on the home screen: what it paints for a day,
 * how Join gets someone into the green room, and what it reads from the
 * Calendar, when.
 */

const MEET = 'https://meetings.puter.com/#/m/abcd-efgh-ijkl';
const NOW = new Date(2031, 7, 26, 9, 0, 0, 0).getTime(); // Tue 26 Aug 2031, 09:00
const at = (day, h = 9, m = 0) => new Date(2031, 7, day, h, m, 0, 0).getTime();

const event = (over = {}) => ({
  id: 'e1',
  title: 'Design review',
  start: at(26, 10),
  end: at(26, 11),
  allDay: false,
  recurring: false,
  guests: [{ email: 'ada@analytical.co' }, { email: 'grace@navy.mil' }],
  meeting: { url: MEET, code: 'abcd-efgh-ijkl' },
  ...over,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A Calendar client double: answers `listMeetings` from `events`, records windows. */
function fakeCalendar(events = [], { available = true, fail = null } = {}) {
  const calls = [];
  const listeners = new Set();
  let gate = null;
  return {
    calls,
    events,
    supported: () => true,
    available: () => available,
    clearBackoff: vi.fn(),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** What the client does when the Calendar says it changed. */
    changed() {
      for (const fn of [...listeners]) fn();
    },
    /** Hold the next answer until release() is called. */
    hold() {
      let release;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        release();
        gate = null;
      };
    },
    async listMeetings({ from, to }) {
      calls.push({ from, to });
      if (gate) await gate;
      if (fail) throw fail;
      return { events: this.events.filter((e) => e.start < to && e.end > from), total: 0 };
    },
  };
}

let host;
let cleanups;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  cleanups = [];
});
afterEach(() => {
  cleanups.forEach((fn) => fn());
  host.remove();
  vi.useRealTimers();
});

function mount(calendar, over = {}) {
  const ctx = { openPrejoin: vi.fn() };
  const cleanup = mountAgenda(host, { calendar, ctx, now: () => NOW, locale: 'en-US', userKey: 'u1', ...over });
  cleanups.push(cleanup);
  return { ctx, cleanup };
}

const titles = () => [...host.querySelectorAll('.agenda-item-title')].map((n) => n.textContent);
const text = () => host.textContent;

describe('agenda panel — a day', () => {
  it('shows today’s meetings from the Calendar, ahead and earlier apart', async () => {
    const calendar = fakeCalendar([
      event({ id: 'a', title: 'Standup', start: at(26, 8), end: at(26, 8, 30) }),
      event({ id: 'b', title: 'Design review' }),
      event({ id: 'c', title: 'Tomorrow’s', start: at(27, 10), end: at(27, 11) }),
    ]);
    mount(calendar);
    // Before the answer: a skeleton, and the frame.
    expect(host.querySelector('.agenda-title').textContent).toBe('Today');
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await flush();
    await flush();
    expect(titles()).toEqual(['Design review', 'Standup']);
    const sections = [...host.querySelectorAll('.agenda-section-title')].map((n) => n.textContent);
    expect(sections).toEqual(['Upcoming', 'Earlier today']);
    expect(host.querySelector('.agenda-item.is-past .agenda-item-title').textContent).toBe('Standup');
    expect(text()).toContain('2 guests');
    // The week strip marks the days with meetings, today included.
    const dots = [...host.querySelectorAll('.agenda-day.has-meetings')].map((n) => n.dataset.day);
    expect(dots).toEqual([String(at(26, 0)), String(at(27, 0))]);
    expect(host.querySelector('.agenda-day.is-today.is-selected')).not.toBeNull();
    expect(host.querySelector('.agenda-today').disabled).toBe(true);
  });

  it('Join opens the green room for the event’s room code', async () => {
    const calendar = fakeCalendar([event()]);
    const { ctx } = mount(calendar);
    await flush();
    await flush();
    const join = host.querySelector('.agenda-join');
    expect(join.textContent).toContain('Join');
    join.click();
    expect(ctx.openPrejoin).toHaveBeenCalledWith({ mode: 'join', code: 'abcd-efgh-ijkl' });
  });

  it('a running meeting is badged and its Join is the primary action', async () => {
    const calendar = fakeCalendar([event({ start: at(26, 8, 45), end: at(26, 9, 30) })]);
    mount(calendar);
    await flush();
    await flush();
    expect(host.querySelector('.agenda-badge.is-now').textContent).toBe('Now');
    expect(host.querySelector('.agenda-join').classList.contains('btn-primary')).toBe(true);
  });

  it('a link to another service opens in a new tab instead', async () => {
    const calendar = fakeCalendar([event({ meeting: { url: 'https://zoom.us/j/123' } })]);
    const { ctx } = mount(calendar);
    await flush();
    await flush();
    const link = host.querySelector('a.agenda-join');
    expect(link.getAttribute('href')).toBe('https://zoom.us/j/123');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(ctx.openPrejoin).not.toHaveBeenCalled();
  });

  it('an empty day points at the next meeting ahead, and a click goes there', async () => {
    const calendar = fakeCalendar([event({ id: 'c', title: 'Thursday sync', start: at(28, 14), end: at(28, 15) })]);
    mount(calendar);
    await flush();
    await flush();
    expect(text()).toContain('No meetings today');
    const next = host.querySelector('.agenda-next');
    expect(next.textContent).toContain('Thursday sync');
    expect(next.textContent).toMatch(/Thu, Aug 28/);
    next.click();
    expect(host.querySelector('.agenda-title').textContent).toMatch(/Thu, Aug 28/);
    expect(titles()).toEqual(['Thursday sync']);
    expect(host.querySelector('.agenda-today').disabled).toBe(false);
  });

  it('with nothing ahead at all, explains where meetings come from', async () => {
    const openCalendar = vi.fn();
    mount(fakeCalendar([]), { openCalendar });
    await flush();
    await flush();
    expect(text()).toContain('Add a Puter Meetings link to an event in Calendar');
    host.querySelector('.agenda-open-calendar').click();
    expect(openCalendar).toHaveBeenCalled();
  });
});

describe('agenda panel — moving around', () => {
  it('reads four weeks once, then only a week it has not seen', async () => {
    const calendar = fakeCalendar([]);
    mount(calendar);
    await flush();
    await flush();
    const weekStart = Number(host.querySelector('.agenda-day').dataset.day);
    expect(calendar.calls).toEqual([{ from: weekStart, to: addDays(weekStart, 28) }]);

    // Next week is inside what was read: no new call.
    host.querySelector('[aria-label="Next week"]').click();
    await flush();
    expect(calendar.calls).toHaveLength(1);

    // Last week is not.
    host.querySelector('[aria-label="Previous week"]').click();
    host.querySelector('[aria-label="Previous week"]').click();
    await flush();
    await flush();
    expect(calendar.calls).toHaveLength(2);
    expect(calendar.calls[1]).toEqual({ from: addDays(weekStart, -7), to: weekStart });

    // Today brings the selection back without another read.
    host.querySelector('.agenda-today').click();
    await flush();
    expect(calendar.calls).toHaveLength(2);
    expect(host.querySelector('.agenda-title').textContent).toBe('Today');
  });

  it('arrow keys move the day, across a week boundary', async () => {
    mount(fakeCalendar([]));
    await flush();
    await flush();
    const strip = host.querySelector('.agenda-strip');
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(host.querySelector('.agenda-title').textContent).toBe('Tomorrow');
    expect(document.activeElement).toBe(host.querySelector('.agenda-day.is-selected'));
    for (let i = 0; i < 6; i++) strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(host.querySelector('.agenda-title').textContent).toMatch(/Tue, Sep 2/);
    expect(Number(host.querySelector('.agenda-day').dataset.day)).toBe(at(31, 0));
  });
});

describe('agenda panel — the snapshot and freshness', () => {
  it('paints the last known list at once, then replaces it with the Calendar’s answer', async () => {
    const calendar = fakeCalendar([event({ id: 'fresh', title: 'Fresh' })]);
    const release = calendar.hold();
    writeAgendaCache('u1', {
      savedAt: NOW - 3600_000,
      from: at(24, 0),
      to: at(31, 0),
      meetings: [{ id: 'old', title: 'Stale', start: at(26, 10), end: at(26, 11), url: MEET, allDay: false, guests: 0, recurring: false }],
    });
    mount(calendar);
    await flush();
    expect(titles()).toEqual(['Stale']);
    expect(host.querySelector('.agenda-status').textContent).toBe('Updating…');
    release();
    await flush();
    await flush();
    expect(titles()).toEqual(['Fresh']);
    expect(host.querySelector('.agenda-status').textContent).toBe('');
    expect(readAgendaCache('u1').meetings.map((m) => m.id)).toEqual(['fresh']);
  });

  it('with nothing stored and no Calendar, says so and offers to try again', async () => {
    const calendar = fakeCalendar([], { fail: new Error('Calendar did not respond') });
    mount(calendar);
    await flush();
    await flush();
    expect(text()).toContain('Couldn’t reach Calendar');
    host.querySelector('.agenda-body .btn').click();
    expect(calendar.clearBackoff).toHaveBeenCalled();
    expect(calendar.calls).toHaveLength(2);
  });

  it('keeps the list it has when an update fails, and says the update failed', async () => {
    const calendar = fakeCalendar([event()]);
    mount(calendar);
    await flush();
    await flush();
    expect(titles()).toEqual(['Design review']);
    calendar.listMeetings = async () => {
      throw new Error('boom');
    };
    host.querySelector('.agenda-refresh').click();
    await flush();
    await flush();
    expect(titles()).toEqual(['Design review']);
    expect(host.querySelector('.agenda-status').textContent).toContain('Couldn’t update');
  });

  it('does not launch the Calendar while backing off', async () => {
    const calendar = fakeCalendar([], { available: false });
    mount(calendar);
    await flush();
    await flush();
    expect(calendar.calls).toHaveLength(0);
    expect(text()).toContain('Couldn’t reach Calendar');
  });

  it('re-reads when the window comes back to the front, once the list is old enough', async () => {
    let t = NOW;
    const calendar = fakeCalendar([]);
    mount(calendar, { now: () => t });
    await flush();
    await flush();
    expect(calendar.calls).toHaveLength(1);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(calendar.calls).toHaveLength(1); // fresh enough
    t += 90_000;
    window.dispatchEvent(new Event('focus'));
    await flush();
    await flush();
    expect(calendar.calls).toHaveLength(2);
  });

  it('a refresh asked for while a read is under way runs after it — and the panel does not get stuck', async () => {
    const calendar = fakeCalendar([event()]);
    const release = calendar.hold();
    mount(calendar);
    await flush();
    expect(calendar.calls).toHaveLength(1);
    expect(host.querySelector('.agenda-status').textContent).toBe('Loading…');

    // The Calendar says it changed — twice, as an edit and its cloud
    // confirmation do — while the first read is still out.
    calendar.events.push(event({ id: 'e2', title: 'Added meanwhile' }));
    calendar.changed();
    calendar.changed();
    release();
    await flush();
    await flush();
    await flush();
    // The follow-up read ran once (not once per notice), its answer is on
    // screen, and nothing is left spinning.
    expect(calendar.calls).toHaveLength(2);
    expect(titles()).toEqual(['Design review', 'Added meanwhile']);
    expect(host.querySelector('.agenda-status').textContent).toBe('');
    expect(host.querySelector('.agenda-refresh').disabled).toBe(false);
    expect(host.querySelector('.agenda-refresh').classList.contains('is-spinning')).toBe(false);
  });

  it('a week clicked to while a read is under way is read next, and shows as loading meanwhile — not as empty', async () => {
    const calendar = fakeCalendar([event({ id: 'lw', title: 'Last week’s', start: at(19, 10), end: at(19, 11) })]);
    const release = calendar.hold();
    mount(calendar);
    await flush();
    expect(calendar.calls).toHaveLength(1);

    host.querySelector('[aria-label="Previous week"]').click();
    await flush();
    // Nothing is known about last week yet: a skeleton, never "No meetings".
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(text()).not.toContain('No meetings');

    release();
    await flush();
    await flush();
    await flush();
    const weekStart = Number(host.querySelector('.agenda-day').dataset.day);
    expect(calendar.calls).toHaveLength(2);
    expect(calendar.calls[1]).toEqual({ from: weekStart, to: addDays(weekStart, 7) });
    expect(titles()).toEqual(['Last week’s']);
    expect(host.querySelector('.agenda-status').textContent).toBe('');
  });

  it('keeps keyboard focus where it was when a read lands and the panel is rebuilt', async () => {
    const calendar = fakeCalendar([event()]);
    const release = calendar.hold();
    mount(calendar);
    await flush();
    const strip = host.querySelector('.agenda-strip');
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const tomorrow = host.querySelector('.agenda-day.is-selected');
    expect(document.activeElement).toBe(tomorrow);

    release();
    await flush();
    await flush();
    // The strip was rebuilt with the answer; focus is still on tomorrow.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.classList.contains('agenda-day')).toBe(true);
    expect(document.activeElement.dataset.day).toBe(tomorrow.dataset.day);
    // And the arrow keys still work from there.
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(host.querySelector('.agenda-title').textContent).toBe('Today');

    // A Join button survives the half-minute tick's rebuild too.
    host.querySelector('.agenda-join').focus();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(document.activeElement.classList.contains('agenda-join')).toBe(true);
  });

  it('a snapshot of another week says nothing about today until the Calendar answers', async () => {
    const calendar = fakeCalendar([]);
    const release = calendar.hold();
    // The last thing read was a week far ahead — that is all the snapshot holds.
    writeAgendaCache('u1', {
      savedAt: NOW - 3600_000,
      from: at(21, 0) + 21 * 86_400_000,
      to: at(28, 0) + 21 * 86_400_000,
      meetings: [{ id: 'far', title: 'Offsite', start: at(23, 10) + 21 * 86_400_000, end: at(23, 11) + 21 * 86_400_000, url: MEET, allDay: false, guests: 0, recurring: false }],
    });
    mount(calendar);
    await flush();
    // Today is not in the snapshot: unread, so loading — not "No meetings
    // today" with the offsite offered as what is next.
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(text()).not.toContain('No meetings today');
    release();
    await flush();
    await flush();
    expect(text()).toContain('No meetings today');
  });

  it('stops everything on cleanup', async () => {
    const calendar = fakeCalendar([]);
    const { cleanup } = mount(calendar);
    await flush();
    await flush();
    cleanup();
    expect(host.querySelector('.agenda')).toBeNull();
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(calendar.calls).toHaveLength(1);
  });
});
