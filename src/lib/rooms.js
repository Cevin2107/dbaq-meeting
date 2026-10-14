import { Emitter } from './emitter.js';
import { steadyInterval, steadyTimeout } from './timers.js';

/**
 * Persistent meeting rooms.
 *
 * A room gives a meeting a stable code (`abc-defg-hij`) whose link keeps
 * working across meeting sessions — create it today, meet next Wednesday.
 * Peer invite codes can't be chosen or reused, so the room adds one level
 * of indirection: whoever hosts writes the invite that is live *right now*
 * to the ROOM DIRECTORY, and guests ask the directory where the meeting is.
 *
 * The directory is one Puter Worker with one key-value store behind it
 * (worker/rooms.js — `https://puter-meetings-rooms.puter.work`), so a room
 * has exactly one record, written and read in one place, judged fresh by
 * one clock (the worker's). There is nothing to propagate, nothing to
 * cache, no copy that can lag another, and no account that has to own
 * anything: a room code is the capability, as the link already is. A
 * visitor with no Puter session reads and writes it like anyone else.
 *
 * The record is a LEASE. The first host to write claims the room under a
 * secret of its choosing; every later write repeats the secret, and a write
 * under another secret is refused (409 `held`) while the lease is fresh —
 * with the live entry, so the loser joins that meeting instead of hosting
 * a second one. The secret is the meeting's, not the host's: it travels to
 * every participant in WELCOME, so when the host role moves, the successor
 * simply carries the lease on. A lease not heartbeated for 60 s is gone,
 * and the next writer takes the room over — a host whose tab died holds
 * nothing for long.
 *
 * Two code classes share the directory:
 *  - classic codes (abc-defg-hij, 10 letters), minted by this app;
 *  - open codes (abcd-efgh-ijkl, 12 letters), minted STATELESSLY by other
 *    apps (a calendar dropping a link into an event) with no Puter calls at
 *    all — the two extra letters buy collision headroom, since uncoordinated
 *    minters can't check for existing rooms.
 * Neither costs anything to mint: a room exists from the moment someone
 * starts a meeting on it, and only for as long as one runs.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const CLASSIC_GROUPS = [3, 4, 3]; //  abc-defg-hij   (this app)
const OPEN_GROUPS = [4, 4, 4]; //     abcd-efgh-ijkl (minted statelessly elsewhere)
const GROUPS_BY_LENGTH = new Map([CLASSIC_GROUPS, OPEN_GROUPS].map((g) => [g.reduce((a, b) => a + b, 0), g]));
const CLASSIC_CODE_LETTERS = CLASSIC_GROUPS.reduce((a, b) => a + b, 0);
const OPEN_CODE_LETTERS = OPEN_GROUPS.reduce((a, b) => a + b, 0);

function mintLetters(count) {
  // Rejection sampling — 256 % 26 !== 0, so a bare modulo would skew the
  // letter distribution (and shave entropy off the code).
  const limit = 256 - (256 % LETTERS.length);
  const letters = [];
  while (letters.length < count) {
    const bytes = new Uint8Array(count - letters.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit) letters.push(LETTERS[byte % LETTERS.length]);
    }
  }
  return letters.join('');
}

function groupLetters(letters, groups) {
  let i = 0;
  return groups.map((len) => letters.slice(i, (i += len))).join('-');
}

/** Mint a new classic room code: lowercase letters in abc-defg-hij groups. Costs nothing. */
export function mintRoomCode() {
  return groupLetters(mintLetters(CLASSIC_CODE_LETTERS), CLASSIC_GROUPS);
}

/**
 * Mint an open room code (abcd-efgh-ijkl). Other apps mint these
 * themselves; this export is the reference implementation of the format.
 */
export function mintOpenRoomCode() {
  return groupLetters(mintLetters(OPEN_CODE_LETTERS), OPEN_GROUPS);
}

/**
 * Normalize user input into a canonical room code, or null when the input
 * isn't one (peer invite codes are much longer and pass through untouched
 * by callers as "legacy" codes).
 */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const letters = input.trim().toLowerCase().replace(/[\s-]/g, '');
  const groups = GROUPS_BY_LENGTH.get(letters.length);
  if (!groups || /[^a-z]/.test(letters)) return null;
  return groupLetters(letters, groups);
}

export function isRoomCode(input) {
  return normalizeRoomCode(input) !== null;
}

/** Whether the code is an open room — minted by another app, statelessly. */
export function isOpenRoomCode(input) {
  const code = normalizeRoomCode(input);
  return code !== null && code.replace(/-/g, '').length === OPEN_CODE_LETTERS;
}

// ---- the directory ----

/** Where the room directory lives (worker/rooms.js). */
export const ROOMS_ORIGIN =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ROOMS_ORIGIN) || 'https://puter-meetings-rooms.puter.work';

/** How often a host renews its lease. */
export const HEARTBEAT_MS = 20_000;
/** The directory's own rule (worker/rooms.js): a lease this old is gone. Documented here; never judged here. */
export const LEASE_TTL_MS = 60_000;
/** A heartbeat that failed is tried again this soon, then on the usual cadence. */
export const BEAT_RETRY_MS = 5000;
/** How often a keeper looks at an entry whose host has gone quiet. */
export const WARM_CHECK_MS = 10_000;
/**
 * How stale an entry has to look before a keeper writes to it. Comfortably
 * past a host's heartbeat, so a host that is still writing is never fought
 * over, and comfortably short of the directory's TTL, so the room is held
 * before it can lapse.
 */
export const WARM_AFTER_MS = 30_000;
/**
 * A fresh claim is checked again this soon after: two hosts claiming the
 * same room in the same instant can both be told they won, and the check
 * tells the one whose write did not stand — while it is still alone.
 */
export const VERIFY_CLAIM_AFTER_MS = 2000;
/** Cap on the optional room work around a start — the meeting is never held hostage to its link. */
export const ROOM_SETUP_TIMEOUT_MS = 15_000;
/** Caps on each directory request — a poll loop must never stall on one. */
export const READ_TIMEOUT_MS = 6000;
export const WRITE_TIMEOUT_MS = 8000;
/** Longest guest grant an entry may carry (Puter caps its own at 512). */
const MAX_GRANT_CHARS = 512;

function roomUrl(code, suffix = '') {
  return `${ROOMS_ORIGIN}/v1/rooms/${encodeURIComponent(code)}${suffix}`;
}

/**
 * One request to the directory. Bodies go as text/plain-encoded JSON: a
 * simple request, so a browser makes no CORS preflight, and the same bytes
 * can go out by `sendBeacon` on unload. Resolves {status, data}; rejects
 * when the directory could not be reached, or did not answer in time.
 */
async function request(url, { method = 'GET', body = null, timeoutMs }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await withDeadline(
      fetch(url, {
        method,
        body: body === null ? undefined : JSON.stringify(body),
        cache: 'no-store',
        signal: controller?.signal,
      }),
      timeoutMs
    );
    let data = null;
    try {
      data = await withDeadline(response.json(), timeoutMs);
    } catch {
      data = null;
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The room directory did not answer within ${ms} ms.`)), ms);
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

function readGrant(value) {
  return typeof value === 'string' && value && value.length <= MAX_GRANT_CHARS ? value : null;
}

/** The directory's entry as the app reads it. */
function interpret(room) {
  if (!room || typeof room !== 'object') return { status: 'idle' };
  const common = {
    host: typeof room.host === 'string' ? room.host : null,
    participants: Number.isInteger(room.participants) ? room.participants : 1,
    startedAt: typeof room.startedAt === 'number' ? room.startedAt : null,
    age: typeof room.age === 'number' ? room.age : 0,
  };
  if (typeof room.invite !== 'string' || !room.invite) return { status: 'starting', ...common };
  return { status: 'live', invite: room.invite, grant: readGrant(room.grant), ...common };
}

/**
 * What is running on a room right now. Never rejects. One of:
 *   {status: 'live', invite, grant, host, participants, startedAt, age}
 *                              a meeting is running; dial `invite`. `grant`
 *                              is the host's guest grant where it has one
 *   {status: 'starting', ...}  someone claimed the room a moment ago and is
 *                              serving as we speak — the invite comes next
 *   {status: 'idle'}           nothing is running — the room is free to start
 *   {status: 'unknown'}        the directory could not be reached
 */
export async function readRoom(code) {
  try {
    const { status, data } = await request(roomUrl(code), { timeoutMs: READ_TIMEOUT_MS });
    if (status !== 200 || !data?.ok) return { status: 'unknown' };
    return interpret(data.room);
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Write the room's entry under `secret`: a claim when nothing fresh is
 * there, a heartbeat or update when the fresh entry is ours. Resolves
 * {ok: true, room} when the entry is now ours, {ok: false, held: true,
 * room} when a fresh lease under another secret holds the room (`room` is
 * that meeting — join it). Rejects only when the directory could not be
 * reached or answered with an error.
 *
 * `invite` null claims a room whose invite is not known yet (the host is
 * serving as we speak); the directory keeps such a claim for 20 s only.
 */
export async function claimRoom(code, { secret, invite = null, grant = null, host = null, participants = 1, term = 0 }) {
  if (typeof secret !== 'string' || !secret) throw new Error('A room claim needs a secret.');
  const body = {
    secret,
    invite: typeof invite === 'string' && invite ? invite : null,
    grant: readGrant(grant),
    host: typeof host === 'string' && host ? host.slice(0, 80) : null,
    participants: Number.isInteger(participants) && participants > 0 ? participants : 1,
    term: Number.isInteger(term) && term >= 0 ? term : 0,
  };
  const { status, data } = await request(roomUrl(code), { method: 'POST', body, timeoutMs: WRITE_TIMEOUT_MS });
  if (status === 200 && data?.ok) return { ok: true, room: interpret(data.room) };
  if (status === 409 && data?.reason === 'held') return { ok: false, held: true, room: interpret(data.room) };
  // The meeting has moved on without us: someone at a later term holds the
  // entry, and ours would put its address back. Not an error, and not a
  // room held by strangers — the caller stands down and follows instead.
  if (status === 409 && data?.reason === 'stale_term') {
    return { ok: false, stale: true, room: interpret(data.room) };
  }
  throw new Error(`The room directory refused the write (${status}${data?.reason ? ` ${data.reason}` : ''}).`);
}

/**
 * Release the room's entry, if it is ours. Best-effort: never rejects.
 * Resolves whether an entry was ended. `term` is the meeting's as we know
 * it: the directory refuses a release from a term the meeting has left
 * behind, as it refuses a write.
 */
export async function endRoom(code, secret, term = 0) {
  if (typeof secret !== 'string' || !secret) return false;
  try {
    const { status, data } = await request(roomUrl(code, '/end'), {
      method: 'POST',
      body: { secret, term: Number.isInteger(term) && term >= 0 ? term : 0 },
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    return status === 200 && !!data?.ended;
  } catch {
    return false;
  }
}

/**
 * As endRoom(), from an unload handler — a beacon, which the browser sends
 * after the page is gone. Returns whether one was queued.
 */
export function endRoomOnUnload(code, secret, term = 0) {
  if (typeof secret !== 'string' || !secret) return false;
  try {
    const body = { secret, term: Number.isInteger(term) && term >= 0 ? term : 0 };
    return !!navigator?.sendBeacon?.(roomUrl(code, '/end'), JSON.stringify(body));
  } catch {
    return false;
  }
}

/**
 * What a host's lease writes about its meeting, read off the session on
 * every beat (see RoomLease): the invite newcomers dial, the guest grant in
 * force, who hosts, how many are in, and how often the meeting has changed
 * hands.
 * @param {import('../net/session.js').RoomSession} session
 */
export function hostFields(session) {
  return {
    invite: session.code,
    grant: session.guestGrant,
    host: session.name,
    participants: session.peerCount + 1,
    term: session.term,
  };
}

/**
 * A host's hold on a room: writes the entry now and then, and keeps it
 * fresh for as long as we host. `fields()` is read on every write, so the
 * entry always carries the invite, grant and headcount as they stand.
 *
 * Emits 'beat' {ok, held, stale, room, error} after every write:
 *   ok     the entry is ours and fresh
 *   held   a fresh lease under another secret holds the room; `room` is
 *          that meeting (the caller decides whether to join it)
 *   stale  our own meeting has moved on to a later term and someone else
 *          is writing for it now; `room` is what they wrote
 *   error  the directory could not be reached (the entry we last wrote
 *          stands until the directory forgets it)
 * A held or failed beat does not stop the lease: the other meeting may
 * end, the network may come back, and the next beat then takes the room.
 *
 * On a timer that keeps its cadence in a hidden tab (lib/timers.js): a
 * host waiting alone with the tab in the background is exactly the host
 * whose entry must not expire.
 */
export class RoomLease extends Emitter {
  #code;
  #secret;
  #fields;
  #stopTimer = null;
  #retryTimer = null;
  #verifyTimer = null;
  #stopped = false;
  #inflight = null;
  #again = false;
  /** The outcome of the last write: 'ok' | 'held' | 'error' | null (none yet). */
  last = null;

  /**
   * @param {string} code
   * @param {string} secret  the meeting's secret (RoomSession#meetingSecret)
   * @param {() => {invite?: string|null, grant?: string|null, host?: string|null, participants?: number, term?: number}} fields
   */
  constructor(code, secret, fields) {
    super();
    this.#code = code;
    this.#secret = secret;
    this.#fields = fields;
  }

  get code() {
    return this.#code;
  }

  get secret() {
    return this.#secret;
  }

  get stopped() {
    return this.#stopped;
  }

  /**
   * Take the room, and keep it: a write now, a check soon after (see
   * VERIFY_CLAIM_AFTER_MS), and a heartbeat from then on. Resolves with the
   * first write's outcome — {ok, held, room} or {ok: false, error} — and
   * never rejects; whatever the first write said, the heartbeat goes on.
   */
  async start() {
    if (this.#stopped) return { ok: false, error: new Error('The lease has been stopped.') };
    this.#stopTimer ??= steadyInterval(() => void this.#beat(), HEARTBEAT_MS);
    const result = await this.#beat();
    if (result.ok && !this.#stopped) {
      this.#verifyTimer?.();
      this.#verifyTimer = steadyTimeout(() => {
        this.#verifyTimer = null;
        void this.#beat();
      }, VERIFY_CLAIM_AFTER_MS);
    }
    return result;
  }

  /** Something the entry carries changed (invite, grant, headcount): write it now. */
  refresh() {
    if (this.#stopped) return Promise.resolve({ ok: false, error: new Error('The lease has been stopped.') });
    return this.#beat();
  }

  /** Stop keeping the entry fresh. It stays for a successor to carry on — or expires on its own. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopTimer?.();
    this.#stopTimer = null;
    this.#retryTimer?.();
    this.#retryTimer = null;
    this.#verifyTimer?.();
    this.#verifyTimer = null;
  }

  /** Stop, and release the room. Never rejects. */
  async end() {
    this.stop();
    // Wait out a write in flight: it must not land after the release.
    try {
      await this.#inflight;
    } catch {
      /* the beat reported it */
    }
    return endRoom(this.#code, this.#secret, this.#term());
  }

  /** As end(), from an unload handler. */
  endOnUnload() {
    this.stop();
    return endRoomOnUnload(this.#code, this.#secret, this.#term());
  }

  /** The meeting's term as the entry carries it, for a release to be fenced by. */
  #term() {
    try {
      return this.#fields()?.term ?? 0;
    } catch {
      return 0;
    }
  }

  /** One write; coalesced with one already in flight (which is followed by another). */
  #beat() {
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    this.#inflight = (async () => {
      let result;
      try {
        const fields = this.#fields() ?? {};
        result = await claimRoom(this.#code, { ...fields, secret: this.#secret });
      } catch (error) {
        result = { ok: false, error };
      }
      this.#inflight = null;
      if (this.#stopped) return result;
      this.last = result.ok ? 'ok' : result.held ? 'held' : 'error';
      if (result.error) {
        // Sooner than the next beat: an outage over in seconds should not
        // cost the entry a third of its life.
        this.#retryTimer?.();
        this.#retryTimer = steadyTimeout(() => {
          this.#retryTimer = null;
          void this.#beat();
        }, BEAT_RETRY_MS);
      }
      try {
        this.emit('beat', {
          ok: !!result.ok,
          held: !!result.held,
          stale: !!result.stale,
          room: result.room ?? null,
          error: result.error ?? null,
        });
      } catch {
        /* a listener's failure is not ours */
      }
      if (this.#again) {
        this.#again = false;
        void this.#beat();
      }
      return result;
    })();
    return this.#inflight;
  }
}

/**
 * Holds a room's entry while its host is out of reach.
 *
 * Only the host heartbeats the directory, so a meeting between hosts has
 * nobody writing for it: the entry lapses, and the next person to open the
 * link finds the code free and starts a rival meeting on it. A keeper — the
 * successor this side would elect — carries the entry across that gap.
 *
 * It writes only when the entry is actually going stale, so a host that is
 * merely wobbling is never written over, and it carries the meeting's term,
 * so the directory turns it away the moment a successor writes at a later
 * one (see worker/rooms.js).
 *
 * Emits 'warm' {ok, stale, held, error} after every write it makes.
 */
export class RoomWarmer extends Emitter {
  #code;
  #secret;
  #fields;
  #stopped = false;
  #stopTimer = null;
  #inflight = null;

  /**
   * @param {string} code
   * @param {string} secret the meeting's secret, as every participant holds it
   * @param {() => object} fields read on every write (see `hostFields`)
   */
  constructor(code, secret, fields) {
    super();
    this.#code = code;
    this.#secret = secret;
    this.#fields = fields;
  }

  start() {
    if (this.#stopped) return;
    this.#stopTimer ??= steadyInterval(() => void this.#tick(), WARM_CHECK_MS);
    void this.#tick();
  }

  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopTimer?.();
    this.#stopTimer = null;
  }

  get stopped() {
    return this.#stopped;
  }

  #tick() {
    if (this.#inflight) return this.#inflight;
    this.#inflight = (async () => {
      try {
        return await this.#hold();
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }

  async #hold() {
    if (this.#stopped) return { ok: false };
    const room = await readRoom(this.#code);
    if (this.#stopped) return { ok: false };
    // A directory we cannot read tells us nothing; the entry we would have
    // written stands or lapses on its own either way.
    if (room.status === 'unknown') return { ok: false };
    // Someone is keeping it fresh — the host is writing again, or another
    // keeper got there first.
    if (room.status !== 'idle' && room.age < WARM_AFTER_MS) return { ok: true, held: false };

    const fields = this.#fields();
    let result;
    try {
      result = await claimRoom(this.#code, {
        secret: this.#secret,
        invite: fields.invite,
        grant: fields.grant,
        // Whose meeting it is does not change because we are holding it.
        host: room.host ?? fields.host,
        participants: fields.participants,
        term: fields.term,
      });
    } catch (error) {
      result = { ok: false, error };
    }
    // The meeting has moved on without us, or the room is somebody else's:
    // either way it is not ours to hold any more.
    if (result.stale || result.held) this.stop();
    try {
      this.emit('warm', {
        ok: !!result.ok,
        stale: !!result.stale,
        held: !!result.held,
        error: result.error ?? null,
      });
    } catch {
      /* a listener's failure is not ours */
    }
    return result;
  }
}
