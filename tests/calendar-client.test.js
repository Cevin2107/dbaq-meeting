import { describe, it, expect, afterEach, vi } from 'vitest';
import { createCalendar, CalendarApiError, LIST_LIMIT } from '../src/lib/calendar.js';

/*
 * The Calendar app's API, as we call it: launched headless inside the Puter
 * desktop, one `list` for the meetings in a window, closed again when idle.
 */

const clients = [];
afterEach(() => {
  clients.forEach((c) => c.dispose());
  clients.length = 0;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in for the Calendar on the other end of an AppConnection. */
function makeService({ answer = null, ready = true, scope = { has: ['meeting'] } } = {}) {
  const listeners = new Map();
  const service = {
    launches: [],
    requests: [],
    closed: false,
    fire(event, msg) {
      for (const fn of [...(listeners.get(event) || [])]) fn(msg);
    },
    emit(msg) {
      service.fire('message', msg);
    },
  };
  const connection = {
    usesSDK: true,
    postMessage(msg) {
      service.requests.push(msg);
      setTimeout(() => {
        const reply = answer ? answer(msg) : { ok: true, result: { events: [], total: 0 } };
        if (reply) service.emit({ $: 'calendar-api', v: 1, id: msg.id, ...reply });
      }, 0);
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    close() {
      service.closed = true;
    },
  };
  const puter = {
    env: 'app',
    ui: {
      launchApp: vi.fn(async (opts) => {
        service.launches.push(opts);
        if (ready) {
          setTimeout(() => service.emit({ $: 'calendar-api', v: 1, type: 'ready', methods: ['ping', 'list'], scope }), 0);
        }
        return connection;
      }),
    },
  };
  return { service, connection, puter };
}

function harness(options = {}, clientOptions = {}) {
  const { service, puter } = makeService(options);
  const calendar = createCalendar({
    getPuter: () => puter,
    launchTimeoutMs: 60,
    requestTimeoutMs: 60,
    idleCloseMs: 20,
    ...clientOptions,
  });
  clients.push(calendar);
  return { service, puter, calendar };
}

describe('calendar client — where it works at all', () => {
  it('is inert outside the Puter desktop, and with no SDK', async () => {
    const web = createCalendar({ getPuter: () => ({ env: 'web', ui: { launchApp: vi.fn() } }) });
    clients.push(web);
    expect(web.supported()).toBe(false);
    await expect(web.listMeetings({ from: 0, to: 1 })).rejects.toThrow();

    const none = createCalendar({ getPuter: () => undefined });
    clients.push(none);
    expect(none.supported()).toBe(false);
  });
});

describe('calendar client — asking', () => {
  it('launches the Calendar headless and asks for the meetings in a window, and only those', async () => {
    const { calendar, service } = harness();
    const { events, total } = await calendar.listMeetings({ from: 100, to: 200 });
    expect(service.launches).toEqual([{ name: 'calendar', args: { service: 'calendar-api' }, background: true }]);
    expect(service.requests).toEqual([
      { $: 'calendar-api', v: 1, id: 'm1', method: 'list', params: { from: 100, to: 200, has: ['meeting'], limit: LIST_LIMIT } },
    ]);
    expect(events).toEqual([]);
    expect(total).toBe(0);
  });

  it('returns the Calendar’s answer, and reuses one connection for a burst', async () => {
    const ev = { id: 'e1', title: 'Standup', start: 1, end: 2, meeting: { url: 'https://meetings.puter.com/#/m/abcd-efgh-ijkl' } };
    const { calendar, service } = harness({ answer: () => ({ ok: true, result: { events: [ev], total: 1 } }) });
    const [a, b] = await Promise.all([calendar.listMeetings({ from: 0, to: 9 }), calendar.listMeetings({ from: 9, to: 18 })]);
    expect(a.events).toEqual([ev]);
    expect(b.total).toBe(1);
    expect(service.launches).toHaveLength(1);
  });

  it('closes the service window once idle, and launches again next time', async () => {
    const { calendar, service } = harness();
    await calendar.listMeetings({ from: 0, to: 1 });
    expect(service.closed).toBe(false);
    await sleep(40);
    expect(service.closed).toBe(true);
    await calendar.listMeetings({ from: 0, to: 1 });
    expect(service.launches).toHaveLength(2);
  });

  it('surfaces a refusal as a CalendarApiError with the API’s code, and stays available', async () => {
    const { calendar } = harness({ answer: () => ({ ok: false, error: { code: 'bad_request', message: 'nope' } }) });
    const err = await calendar.listMeetings({ from: 0, to: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarApiError);
    expect(err.code).toBe('bad_request');
    expect(err.message).toBe('nope');
    expect(calendar.available()).toBe(true);
  });
});

describe('calendar client — when the Calendar is not there', () => {
  it('gives up on a launch that never says hello, closes it, and backs off', async () => {
    const { calendar, service } = harness({ ready: false }, { retryAfterMs: 1000 });
    await expect(calendar.listMeetings({ from: 0, to: 1 })).rejects.toThrow(/did not respond/);
    expect(service.closed).toBe(true);
    expect(calendar.available()).toBe(false);
    expect(calendar.retryIn()).toBeGreaterThan(0);
    // The backoff holds without another launch…
    await expect(calendar.listMeetings({ from: 0, to: 1 })).rejects.toThrow();
    expect(service.launches).toHaveLength(1);
    // …until the user asks.
    calendar.clearBackoff();
    expect(calendar.available()).toBe(true);
  });

  it('fails fast when the service closes before it is ready', async () => {
    const { service, puter } = makeService({ ready: false });
    const calendar = createCalendar({ getPuter: () => puter, launchTimeoutMs: 5000, retryAfterMs: 1000 });
    clients.push(calendar);
    const pending = calendar.listMeetings({ from: 0, to: 1 });
    await sleep(0);
    service.fire('close');
    await expect(pending).rejects.toThrow(/closed before it was ready/);
  });

  it('times out a request that never gets an answer, and backs off', async () => {
    const { calendar } = harness({ answer: () => null }, { retryAfterMs: 1000 });
    await expect(calendar.listMeetings({ from: 0, to: 1 })).rejects.toThrow(/timed out/);
    expect(calendar.available()).toBe(false);
  });

  it('doubles the backoff per failure, up to a ceiling', async () => {
    let t = 0;
    const { puter } = makeService({ ready: false });
    const calendar = createCalendar({
      getPuter: () => puter,
      now: () => t,
      launchTimeoutMs: 10,
      retryAfterMs: 100,
      maxRetryMs: 250,
    });
    clients.push(calendar);
    await calendar.listMeetings({ from: 0, to: 1 }).catch(() => {});
    expect(calendar.retryIn()).toBe(100);
    t = 100;
    await calendar.listMeetings({ from: 0, to: 1 }).catch(() => {});
    expect(calendar.retryIn()).toBe(200);
    t = 300;
    await calendar.listMeetings({ from: 0, to: 1 }).catch(() => {});
    expect(calendar.retryIn()).toBe(250);
  });

  it('rejects what is in flight when the service goes away, and can be disposed', async () => {
    const { calendar, service } = harness({ answer: () => null }, { requestTimeoutMs: 5000 });
    const pending = calendar.listMeetings({ from: 0, to: 1 });
    await sleep(5);
    service.fire('close');
    await expect(pending).rejects.toThrow(/closed/);
    calendar.dispose();
    expect(calendar.available()).toBe(true);
  });

  it('tells subscribers when the calendar changes under a live connection', async () => {
    const { calendar, service } = harness();
    const changed = vi.fn();
    const off = calendar.onChange(changed);
    await calendar.listMeetings({ from: 0, to: 1 });
    service.emit({ $: 'calendar-api', v: 1, type: 'changed' });
    expect(changed).toHaveBeenCalledTimes(1);
    off();
    service.emit({ $: 'calendar-api', v: 1, type: 'changed' });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
