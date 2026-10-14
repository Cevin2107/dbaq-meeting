/**
 * Timers that keep their schedule in a hidden tab.
 *
 * Everything that keeps a room's link alive runs on page timers: the
 * heartbeat that keeps the directory's entry fresh (20 s against a 60 s
 * lease, src/lib/rooms.js) and the self-probe that notices a dead invite
 * (15 s, src/net/session.js). Browsers throttle a hidden page's timers, and
 * Chrome's intensive throttling runs them once a minute after ~5 minutes
 * hidden — unless the page holds a WebRTC connection or plays audio. A host
 * waiting alone has neither, and is exactly the host most likely to switch
 * tabs: the heartbeat then lands every 60 s, one slow write puts the entry
 * past its lease and the room reads idle, a newcomer sees "nothing running"
 * (or a signed-in one starts a second meeting), and the probe slows to a
 * minute.
 *
 * Timers in a dedicated Worker are not throttled that way, so a tiny shared
 * ticker worker keeps time and posts a message per tick; the page runs the
 * callback on arrival, which is a plain task, not a timer.
 *
 * Measured on 2026-08-27 in Chrome 151 (macOS), one page running a 15 s and
 * a 25 s interval each way, hidden from the moment it loaded:
 *
 *   page setInterval 15 s   15.0 s × 6, then 39.0, 60.0, 60.0, 60.0, 60.0
 *   page setInterval 25 s   25.0 s × 5, then 39.0, 60.0, 60.0, 60.0
 *   this module, 15 s       15.0 s × 22  (min 14.95, max 15.05)
 *   this module, 25 s       25.0 s × 12  (min 24.996, max 25.001)
 *
 * — the page's timers were on the one-minute cadence within two and a half
 * minutes of being hidden, the worker's never moved; and once the tab was
 * shown again the page's timers came back to their interval.
 *
 * Where there is no Worker (tests, an old browser) or the worker cannot be
 * made (a content-security policy that forbids blob: workers), plain timers
 * are used — looked up at call time, so a test's fake timers take effect.
 * A worker that breaks after starting hands its live timers over to plain
 * ones; nothing is lost either way, only the steadiness.
 */

/** Source of the ticker worker: timers by id, a message per tick. */
const WORKER_SOURCE = `
  const timers = new Map();
  self.onmessage = ({ data }) => {
    const { op, id, ms } = data;
    if (op === 'interval') {
      timers.set(id, setInterval(() => postMessage({ id }), ms));
    } else if (op === 'timeout') {
      timers.set(id, setTimeout(() => { timers.delete(id); postMessage({ id }); }, ms));
    } else if (op === 'clear') {
      const timer = timers.get(id);
      clearInterval(timer);
      clearTimeout(timer);
      timers.delete(id);
    }
  };
`;

/** @type {Worker|null|undefined} undefined: not tried yet; null: unavailable */
let worker;
let nextId = 1;
/** @type {Map<number, {fn: () => void, kind: 'interval'|'timeout', ms: number, handle: any}>} */
const live = new Map();

/** The shared ticker, made on first use; null where one cannot be had. */
function ticker() {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
    return worker;
  }
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    const made = new Worker(url);
    made.onmessage = ({ data }) => {
      URL.revokeObjectURL(url); // the script is loaded once it speaks
      const entry = live.get(data?.id);
      if (!entry) return;
      if (entry.kind === 'timeout') live.delete(data.id);
      entry.fn();
    };
    made.onerror = (event) => {
      // Refused (a content-security policy, say) or broken: fall back for
      // good, and keep every timer that was running on it running.
      console.warn('[timers] the ticker worker failed — falling back to page timers', event?.message ?? event);
      if (worker !== made) return;
      worker = null;
      try {
        made.terminate();
      } catch {
        /* noop */
      }
      for (const [id, entry] of live) {
        if (entry.handle === null) entry.handle = plainTimer(id, entry);
      }
    };
    worker = made;
  } catch (error) {
    console.warn('[timers] no ticker worker — using page timers', error);
    worker = null;
  }
  return worker;
}

/** Start a page timer for an entry, returning its handle. */
function plainTimer(id, entry) {
  if (entry.kind === 'interval') return setInterval(entry.fn, entry.ms);
  return setTimeout(() => {
    live.delete(id);
    entry.fn();
  }, entry.ms);
}

function start(fn, ms, kind) {
  const id = nextId++;
  const entry = { fn, kind, ms, handle: null };
  live.set(id, entry);
  const w = ticker();
  if (w) w.postMessage({ op: kind, id, ms });
  else entry.handle = plainTimer(id, entry);
  return () => {
    const current = live.get(id);
    if (!current) return;
    live.delete(id);
    if (current.handle !== null) {
      clearInterval(current.handle);
      clearTimeout(current.handle);
    } else {
      worker?.postMessage({ op: 'clear', id });
    }
  };
}

/**
 * Like setInterval, but keeps its cadence in a hidden tab.
 * @param {() => void} fn
 * @param {number} ms
 * @returns {() => void} stop
 */
export function steadyInterval(fn, ms) {
  return start(fn, ms, 'interval');
}

/**
 * Like setTimeout, but fires on time in a hidden tab.
 * @param {() => void} fn
 * @param {number} ms
 * @returns {() => void} cancel
 */
export function steadyTimeout(fn, ms) {
  return start(fn, ms, 'timeout');
}

/**
 * The promise, or a rejection once `ms` have passed — for work that must
 * not hold up whatever is waiting on it.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Test seam: forget the shared worker so the next timer makes a fresh one. */
export function resetTickerForTests() {
  try {
    worker?.terminate?.();
  } catch {
    /* noop */
  }
  worker = undefined;
  for (const [, entry] of live) {
    if (entry.handle !== null) {
      clearInterval(entry.handle);
      clearTimeout(entry.handle);
    }
  }
  live.clear();
}
