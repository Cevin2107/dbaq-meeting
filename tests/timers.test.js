import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/*
 * Timers that keep their schedule in a hidden tab: a shared ticker Worker
 * keeps time and posts a message per tick, the page runs the callback on
 * arrival. With no Worker to be had — tests, an old browser, a policy that
 * forbids blob: workers — plain page timers stand in, looked up at call
 * time so fake timers apply; and a worker that breaks after starting hands
 * its live timers over to plain ones without dropping any.
 */

/** A Worker that records what it is told and lets the test tick it. */
class FakeWorker {
  static instances = [];
  posted = [];
  onmessage = null;
  onerror = null;
  terminated = false;
  constructor(url) {
    this.url = url;
    FakeWorker.instances.push(this);
  }
  postMessage(data) {
    this.posted.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  /** The worker's timer for `id` fires. */
  tick(id) {
    this.onmessage?.({ data: { id } });
  }
  /** The worker breaks (or was refused by a content-security policy). */
  fail() {
    this.onerror?.({ message: 'blocked by CSP' });
  }
}

let timers;
let savedWorker;
let savedCreate;
let savedRevoke;

beforeEach(async () => {
  savedWorker = globalThis.Worker;
  savedCreate = URL.createObjectURL;
  savedRevoke = URL.revokeObjectURL;
  FakeWorker.instances = [];
  URL.createObjectURL = vi.fn(() => 'blob:ticker');
  URL.revokeObjectURL = vi.fn();
  vi.resetModules();
  timers = await import('../src/lib/timers.js');
});

afterEach(() => {
  timers.resetTickerForTests();
  globalThis.Worker = savedWorker;
  URL.createObjectURL = savedCreate;
  URL.revokeObjectURL = savedRevoke;
  vi.useRealTimers();
});

describe('steady timers on the ticker worker', () => {
  beforeEach(() => {
    globalThis.Worker = FakeWorker;
  });

  it('keeps one worker for every timer, and runs each callback on its own tick', () => {
    const a = vi.fn();
    const b = vi.fn();
    timers.steadyInterval(a, 25_000);
    timers.steadyTimeout(b, 8000);
    expect(FakeWorker.instances).toHaveLength(1);
    const [worker] = FakeWorker.instances;
    expect(worker.posted).toEqual([
      { op: 'interval', id: expect.any(Number), ms: 25_000 },
      { op: 'timeout', id: expect.any(Number), ms: 8000 },
    ]);
    const [intervalId, timeoutId] = worker.posted.map((m) => m.id);
    expect(intervalId).not.toBe(timeoutId);

    worker.tick(intervalId);
    worker.tick(intervalId);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).not.toHaveBeenCalled();
    worker.tick(timeoutId);
    expect(b).toHaveBeenCalledTimes(1);
    // A timeout fires once; a late duplicate from the worker is ignored.
    worker.tick(timeoutId);
    expect(b).toHaveBeenCalledTimes(1);
    // The blob URL is let go of once the worker is known to be running.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:ticker');
  });

  it('stops a timer in the worker when cancelled, and never runs it again', () => {
    const fn = vi.fn();
    const stop = timers.steadyInterval(fn, 1000);
    const [worker] = FakeWorker.instances;
    const { id } = worker.posted[0];
    worker.tick(id);
    stop();
    expect(worker.posted.at(-1)).toEqual({ op: 'clear', id });
    worker.tick(id); // a tick already in flight when we cancelled
    expect(fn).toHaveBeenCalledTimes(1);
    stop(); // idempotent
    expect(worker.posted.filter((m) => m.op === 'clear')).toHaveLength(1);
  });

  it('hands live timers over to page timers when the worker breaks, without dropping any', () => {
    vi.useFakeTimers();
    const interval = vi.fn();
    const timeout = vi.fn();
    const stopInterval = timers.steadyInterval(interval, 1000);
    timers.steadyTimeout(timeout, 2500);
    const [worker] = FakeWorker.instances;
    worker.fail();
    expect(worker.terminated).toBe(true);

    // Page timers carry on from here.
    vi.advanceTimersByTime(3100);
    expect(interval).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledTimes(1);
    // A new timer made after the failure goes straight to page timers —
    // no second worker is tried.
    const later = vi.fn();
    timers.steadyTimeout(later, 500);
    expect(FakeWorker.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(later).toHaveBeenCalledTimes(1);
    // ...and cancelling one that moved clears its page timer.
    stopInterval();
    vi.advanceTimersByTime(5000);
    expect(interval).toHaveBeenCalledTimes(3);
  });
});

describe('steady timers without a worker', () => {
  it('fall back to page timers, which fake timers drive', () => {
    delete globalThis.Worker;
    vi.useFakeTimers();
    const interval = vi.fn();
    const timeout = vi.fn();
    const stop = timers.steadyInterval(interval, 1000);
    const cancel = timers.steadyTimeout(timeout, 1500);
    vi.advanceTimersByTime(2000);
    expect(interval).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(2000);
    expect(interval).toHaveBeenCalledTimes(2);
    cancel(); // already fired: harmless
  });

  it('fall back when the worker cannot even be constructed', () => {
    globalThis.Worker = class {
      constructor() {
        throw new DOMException('Refused to create a worker', 'SecurityError');
      }
    };
    vi.useFakeTimers();
    const fn = vi.fn();
    timers.steadyTimeout(fn, 100);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
