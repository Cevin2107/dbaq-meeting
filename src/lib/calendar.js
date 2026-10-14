/**
 * The user's meetings, borrowed from the Calendar app (calendar.puter.com).
 *
 * The Calendar attaches Puter Meetings links to events; this is where those
 * links come back to us, so the home screen can show the day's meetings with
 * a Join button instead of sending people to dig the link out of an email.
 *
 * Inside the Puter desktop, apps can talk to each other: we launch the
 * Calendar as a headless API server — no UI, `background: true` so the
 * desktop never puts a window on screen — and talk to it over the
 * AppConnection `puter.ui.launchApp` hands back
 * (https://docs.puter.com/Objects/AppConnection/). The Calendar only answers
 * apps on its own allowlist, and it identifies the caller from what the
 * desktop stamps on the window it launched, not from anything we send: this
 * works because we really are `meetings`.
 *
 * Our grant is read-only and *scoped*: `list`, over events that carry a
 * meeting link. The Calendar filters before anything crosses the connection,
 * so the dentist appointment never reaches this app at all — and we ask with
 * `has: ['meeting']` anyway, so the request says what it is for.
 *
 * Everything here degrades to "no calendar": on the open web there is no
 * desktop to launch anything into (puter.env !== 'app'), the Calendar may not
 * be installed, and the user may not have one. Reads reject; the panel that
 * calls them decides what to show. After a failure we back off, doubling, so
 * a missing Calendar costs one launch attempt rather than one per refresh —
 * but only for failures that mean *unreachable*. A refusal the Calendar sent
 * us (`CalendarApiError`) proves the opposite and clears the backoff.
 */

/* ---- The contract with the Calendar app ---------------------------------- */
// Mirrored from calendar.puter.com/src/js/api/protocol.js — a published
// contract between the two apps. Change them together and bump VERSION when
// the shape changes.
const CHANNEL = 'calendar-api';
const VERSION = 1;
const SERVICE_ARG = 'calendar-api';
const APP_NAME = 'calendar';

/** The Calendar caps one `list` at this many events; asking for the cap means
 *  a busy month of meetings still arrives whole. */
export const LIST_LIMIT = 500;

const IDLE_CLOSE_MS = 10_000; // close the service window this long after the last call
const REQUEST_TIMEOUT_MS = 8000;
const LAUNCH_TIMEOUT_MS = 12_000; // includes the Calendar's own boot
const RETRY_AFTER_MS = 60_000; // after a failure, don't try again for a while
const MAX_RETRY_MS = 10 * 60 * 1000; // …doubling per failure, up to this

/**
 * An error the Calendar itself sent back: it read our request, understood
 * it, and said no. Distinct from every other failure here — a launch that
 * never landed, a timeout, a window that closed — because those mean the
 * Calendar is unreachable and this one means the opposite. `code` is the
 * API's own (`bad_request`, `storage_error`, …).
 */
export class CalendarApiError extends Error {
  constructor(code, message) {
    super(message || code || 'The request failed');
    this.name = 'CalendarApiError';
    this.code = code || '';
    this.fromCalendar = true;
  }
}

/**
 * @param {object} [options]
 * @param {() => object|undefined} [options.getPuter]
 * @param {() => number} [options.now]
 */
export function createCalendar({
  getPuter = () => (typeof window !== 'undefined' ? window.puter : undefined),
  appName = APP_NAME,
  now = () => Date.now(),
  idleCloseMs = IDLE_CLOSE_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  launchTimeoutMs = LAUNCH_TIMEOUT_MS,
  retryAfterMs = RETRY_AFTER_MS,
  maxRetryMs = MAX_RETRY_MS,
} = {}) {
  let conn = null; // the live AppConnection, or null
  let connecting = null; // in-flight connect(), so callers share one launch
  let pending = new Map(); // request id -> { resolve, reject, timer }
  let nextId = 1;
  let idleTimer = null;
  let generation = 0; // bumped by disconnect(), so a late launch is abandoned
  let blockedUntil = 0; // set after a failure, so we stop retrying for a bit
  let failures = 0; // consecutive failures, for how long that block lasts
  const listeners = new Set();

  /** Can we talk to other apps at all? Only true inside the Puter desktop. */
  function supported() {
    const p = getPuter();
    return Boolean(p && p.env === 'app' && p.ui && typeof p.ui.launchApp === 'function');
  }

  /** Is launching the Calendar something we should try right now? */
  function available() {
    return supported() && now() >= blockedUntil;
  }

  /** Stop trying for a while, doubling the wait for a Calendar that keeps
   *  failing. Cleared by the first success. */
  function backOff(err) {
    failures += 1;
    const wait = Math.min(retryAfterMs * 2 ** (failures - 1), maxRetryMs);
    blockedUntil = now() + wait;
    if (err) console.warn('[meetings] calendar unavailable:', err.message || err);
  }

  /** A Calendar that answered at all is a Calendar we can reach. */
  function succeeded() {
    failures = 0;
    blockedUntil = 0;
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** Let the service window go once we've been quiet for a moment. */
  function scheduleIdleClose() {
    clearIdle();
    if (!conn) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pending.size) return scheduleIdleClose();
      disconnect();
    }, idleCloseMs);
  }

  function rejectPending(reason) {
    const err = new Error(reason);
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending = new Map();
  }

  /** Drop the connection. `gone: true` means the service already closed
   *  itself, so there is nothing left to close from this side. */
  function disconnect({ gone = false } = {}) {
    clearIdle();
    generation++;
    const c = conn;
    conn = null;
    connecting = null;
    rejectPending('The calendar service closed');
    if (c && !gone) closeQuietly(c);
  }

  function closeQuietly(connection) {
    try {
      connection.close();
    } catch {
      /* already gone */
    }
  }

  /** Tell subscribers the calendar changed under a live connection. */
  function announce() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.warn('[meetings] calendar listener failed:', err && err.message);
      }
    }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.$ !== CHANNEL) return;
    if (msg.type === 'changed') {
      announce();
      return;
    }
    const entry = msg.id ? pending.get(msg.id) : null;
    if (!entry) return; // a reply we no longer care about, or the `ready` notice
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else {
      const err = msg.error || {};
      entry.reject(new CalendarApiError(err.code, err.message));
    }
  }

  /**
   * Launch the Calendar in service mode and wait for it to say hello.
   * Resolves to the AppConnection; rejects (and backs off) if it never does.
   */
  function connect() {
    if (conn) return Promise.resolve(conn);
    if (connecting) return connecting;
    if (!available()) return Promise.reject(new Error('Calendar is not available here'));

    const p = getPuter();
    const gen = generation;
    connecting = new Promise((resolve, reject) => {
      let settled = false;
      let opened = null; // set once launchApp resolves
      let timer = null;

      // Never leave a service window behind: if it opened but never said
      // hello, close it on the way out.
      const giveUp = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (opened) closeQuietly(opened);
        reject(err);
      };
      timer = setTimeout(() => giveUp(new Error('Calendar did not respond')), launchTimeoutMs);

      // `background: true` asks the desktop not to show the window at all.
      // Older desktops ignore it and show one, which the Calendar then hides
      // itself — a brief flash rather than a broken launch.
      Promise.resolve(p.ui.launchApp({ name: appName, args: { service: SERVICE_ARG }, background: true }))
        .then((connection) => {
          if (!connection || connection.usesSDK === false) {
            // A window did open — one we cannot talk to. It is still ours
            // to close, or it sits in the background for good.
            if (connection) closeQuietly(connection);
            throw new Error('Calendar did not open with messaging support');
          }
          opened = connection;
          // Timed out, or torn down while the launch was in flight. Either
          // way the window is ours to clean up.
          if (settled || gen !== generation) {
            closeQuietly(connection);
            giveUp(new Error('Calendar was closed'));
            return;
          }
          connection.on('message', onMessage);
          connection.on('close', () => {
            if (conn === connection) {
              disconnect({ gone: true });
              return;
            }
            // Closed before it ever said hello: the ordinary shape of "the
            // Calendar is not going to serve us" — not installed, not
            // allowed, nobody signed in — since the service exits as soon as
            // it works that out. Fail now rather than wait out the timeout.
            giveUp(new Error('Calendar closed before it was ready'));
          });
          // The service announces itself once it's listening; treat that as
          // the handshake, so the first request can't race its own listener.
          const ready = (msg) => {
            if (!msg || msg.$ !== CHANNEL || msg.type !== 'ready') return;
            if (typeof connection.off === 'function') connection.off('message', ready);
            if (settled) return;
            if (gen !== generation) {
              closeQuietly(connection);
              giveUp(new Error('Calendar was closed'));
              return;
            }
            settled = true;
            clearTimeout(timer);
            conn = connection;
            resolve(connection);
          };
          connection.on('message', ready);
        })
        .catch(giveUp);
    })
      .catch((err) => {
        backOff(err);
        throw err;
      })
      .finally(() => {
        connecting = null;
      });

    return connecting;
  }

  /**
   * Call a Calendar API method. Rejects on transport failure, on a timeout,
   * or — as a `CalendarApiError` carrying the API's own `code` — with
   * whatever the Calendar refused us for. Only the first two count against
   * the Calendar's reachability.
   */
  async function call(method, params = {}) {
    const connection = await connect();
    const id = `m${nextId++}`;
    clearIdle();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Calendar timed out on "${method}"`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    try {
      // postMessage can throw synchronously (the window closed under us
      // before its `close` event was delivered). The pending entry must go
      // with it, or its timer would later reject a promise nobody holds.
      connection.postMessage({ $: CHANNEL, v: VERSION, id, method, params });
      const value = await result;
      succeeded();
      return value;
    } catch (err) {
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(id);
      }
      if (err instanceof CalendarApiError) {
        // The Calendar answered — it just answered "no". A fact about this
        // request, not about whether the Calendar can be reached.
        succeeded();
      } else if (now() >= blockedUntil) {
        backOff();
      }
      throw err;
    } finally {
      scheduleIdleClose();
    }
  }

  return {
    /** True where talking to another app is possible at all. Safe to call on
     *  every render — unlike `available()`, it doesn't go quiet during a
     *  backoff, so the UI doesn't flicker over a transient failure. */
    supported,

    /** True when a launch of the Calendar is worth attempting right now. */
    available,

    /** How long until the next attempt is worth making, in ms (0 = now). */
    retryIn() {
      return Math.max(0, blockedUntil - now());
    },

    /** Lift a backoff: the user pressed Refresh, so the next attempt is
     *  theirs to spend. The doubling starts over if it fails again. */
    clearBackoff() {
      succeeded();
    },

    /** Called when the calendar changed under a live connection. Returns an
     *  unsubscribe function. */
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * The events with a meeting link in [from, to), as the Calendar API
     * returns them: occurrences of a recurring series expanded, earliest
     * first, each with `meeting: { url, code? }`. Resolves to
     * `{ events, total }`; rejects like `call`.
     *
     * @param {{ from: number, to: number }} window epoch milliseconds
     */
    async listMeetings({ from, to }) {
      const result = await call('list', { from, to, has: ['meeting'], limit: LIST_LIMIT });
      const events = result && Array.isArray(result.events) ? result.events : [];
      const total = result && Number.isFinite(result.total) ? result.total : events.length;
      return { events, total };
    },

    /** The raw call, for anything the helpers above don't cover. */
    call,

    /** Close the service window and forget everything about this session. */
    dispose() {
      disconnect();
      listeners.clear();
      failures = 0;
      blockedUntil = 0;
    },
  };
}
