import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mintRoomCode,
  mintOpenRoomCode,
  normalizeRoomCode,
  isRoomCode,
  isOpenRoomCode,
  readRoom,
  claimRoom,
  endRoom,
  endRoomOnUnload,
  RoomLease,
  RoomWarmer,
  hostFields,
  ROOMS_ORIGIN,
  HEARTBEAT_MS,
  BEAT_RETRY_MS,
  VERIFY_CLAIM_AFTER_MS,
  READ_TIMEOUT_MS,
  WARM_CHECK_MS,
  WARM_AFTER_MS,
} from '../src/lib/rooms.js';
import { resetTickerForTests } from '../src/lib/timers.js';

/* ------------------------------------------------------------------ *
 * An in-memory room directory with the worker's own rules              *
 * (worker/rooms.js): one entry per room, a lease under a secret, fresh *
 * for 60 s (20 s with no invite), 409 `held` for a stranger's write.    *
 * ------------------------------------------------------------------ */

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

function fakeDirectory({ ttlMs = 60_000, startingTtlMs = 20_000 } = {}) {
  const store = new Map();
  const calls = [];
  const state = { failing: false, hang: false };
  const fresh = (e) => !!e && Date.now() - e.at < (e.invite ? ttlMs : startingTtlMs);
  const view = (e) => ({
    code: e.code,
    invite: e.invite,
    grant: e.grant,
    host: e.host,
    participants: e.participants,
    startedAt: e.startedAt,
    term: e.term,
    age: Date.now() - e.at,
  });
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const m = new URL(url).pathname.match(/^\/v1\/rooms\/([^/]+)(\/end)?$/);
    const code = decodeURIComponent(m[1]);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, code, end: !!m[2], body, init });
    if (state.hang) return new Promise(() => {});
    if (state.failing) throw new TypeError('Failed to fetch');
    const e = store.get(code);
    if (method === 'GET') return json(200, { ok: true, now: Date.now(), room: fresh(e) ? view(e) : null });
    if (m[2]) {
      if (e && fresh(e) && e.secret === body.secret && (body.term ?? 0) < (e.term ?? 0)) {
        return json(409, { ok: false, reason: 'stale_term', ended: false, now: Date.now(), room: view(e) });
      }
      const ours = !!e && (e.secret === body.secret || !fresh(e));
      if (ours) store.delete(code);
      return json(200, { ok: true, now: Date.now(), ended: ours });
    }
    if (fresh(e) && e.secret !== body.secret) return json(409, { ok: false, reason: 'held', now: Date.now(), room: view(e) });
    if (e && e.secret === body.secret && fresh(e) && (body.term ?? 0) < (e.term ?? 0)) {
      return json(409, { ok: false, reason: 'stale_term', now: Date.now(), room: view(e) });
    }
    const entry = {
      code,
      secret: body.secret,
      invite: body.invite ?? null,
      grant: body.grant ?? null,
      host: body.host ?? null,
      participants: body.participants ?? 1,
      term: body.term ?? 0,
      startedAt: e && e.secret === body.secret ? e.startedAt : Date.now(),
      at: Date.now(),
    };
    store.set(code, entry);
    return json(200, { ok: true, now: Date.now(), room: view(entry) });
  });
  return {
    store,
    calls,
    state,
    writes: (code) => calls.filter((c) => c.method === 'POST' && !c.end && (!code || c.code === code)),
    entry: (code) => store.get(code) ?? null,
  };
}

let savedFetch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  resetTickerForTests();
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  vi.useRealTimers();
  resetTickerForTests();
});

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/* ------------------------------------------------------------------ */

describe('room codes', () => {
  it('mints codes in abc-defg-hij form', () => {
    for (let i = 0; i < 20; i++) expect(mintRoomCode()).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  });

  it('mints distinct codes', () => {
    const codes = new Set(Array.from({ length: 50 }, mintRoomCode));
    expect(codes.size).toBe(50);
  });

  it('normalizes dashes, case, and whitespace', () => {
    expect(normalizeRoomCode('ABC DEFG HIJ')).toBe('abc-defg-hij');
    expect(normalizeRoomCode(' abcdefghij ')).toBe('abc-defg-hij');
    expect(normalizeRoomCode('abc-defg-hij')).toBe('abc-defg-hij');
  });

  it('rejects everything that is not ten or twelve letters', () => {
    expect(normalizeRoomCode('abc-defg-hi')).toBeNull();
    expect(normalizeRoomCode('abc-defg-hij1')).toBeNull();
    expect(normalizeRoomCode('NJ-7F3A9C')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
    expect(isRoomCode('abc-defg-hij')).toBe(true);
    expect(isRoomCode('abcd-efgh-ijkl')).toBe(true);
    expect(isRoomCode('invite-1')).toBe(false);
  });
});

describe('open room codes', () => {
  it('mints distinct codes in abcd-efgh-ijkl form', () => {
    const codes = new Set(Array.from({ length: 50 }, mintOpenRoomCode));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
  });

  it('normalizes twelve-letter input like classic codes', () => {
    expect(normalizeRoomCode('ABCD EFGH IJKL')).toBe('abcd-efgh-ijkl');
    expect(normalizeRoomCode('abcdefghijkl')).toBe('abcd-efgh-ijkl');
  });

  it('tells open codes apart from classic and legacy ones', () => {
    expect(isOpenRoomCode('abcd-efgh-ijkl')).toBe(true);
    expect(isOpenRoomCode('abc-defg-hij')).toBe(false);
    expect(isOpenRoomCode('NJ-7F3A9C')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('readRoom', () => {
  it('asks the directory, with nothing cached and no preflight-provoking header', async () => {
    const dir = fakeDirectory();
    expect(await readRoom('abc-defg-hij')).toEqual({ status: 'idle' });
    const [call] = dir.calls;
    expect(call.method).toBe('GET');
    expect(call.code).toBe('abc-defg-hij');
    expect(call.init.cache).toBe('no-store');
    expect(call.init.headers).toBeUndefined();
    expect(globalThis.fetch.mock.calls[0][0]).toBe(`${ROOMS_ORIGIN}/v1/rooms/abc-defg-hij`);
  });

  it('reports a running meeting with everything the entry carries', async () => {
    fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-123456', grant: 'pg1.abc', host: 'Ada', participants: 3, term: 2 });
    const room = await readRoom('abc-defg-hij');
    expect(room).toMatchObject({ status: 'live', invite: 'NJ-123456', grant: 'pg1.abc', host: 'Ada', participants: 3 });
    expect(typeof room.startedAt).toBe('number');
    expect(typeof room.age).toBe('number');
  });

  it('reports a claim whose invite is not known yet as starting', async () => {
    fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 's1', host: 'Ada' });
    expect(await readRoom('abc-defg-hij')).toMatchObject({ status: 'starting', host: 'Ada' });
  });

  it('reads anything but a bounded string as no grant', async () => {
    fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-123456', grant: 'x'.repeat(600) });
    expect((await readRoom('abc-defg-hij')).grant).toBeNull();
  });

  it('is unknown when the directory cannot be reached, answers oddly, or does not answer', async () => {
    const dir = fakeDirectory();
    dir.state.failing = true;
    expect(await readRoom('abc-defg-hij')).toEqual({ status: 'unknown' });

    globalThis.fetch = vi.fn(async () => json(503, { ok: false, reason: 'store' }));
    expect(await readRoom('abc-defg-hij')).toEqual({ status: 'unknown' });

    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => 'not json we expect' }));
    expect(await readRoom('abc-defg-hij')).toEqual({ status: 'unknown' });
  });

  it('gives up on a hung request instead of stalling the poll loop', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    dir.state.hang = true;
    const pending = readRoom('abc-defg-hij');
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 50);
    expect(await pending).toEqual({ status: 'unknown' });
  });
});

describe('claimRoom', () => {
  it('claims a free room under a secret, and posts the body as text', async () => {
    const dir = fakeDirectory();
    const result = await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-123456', host: 'Ada' });
    expect(result.ok).toBe(true);
    expect(result.room).toMatchObject({ status: 'live', invite: 'NJ-123456', host: 'Ada' });
    const [write] = dir.writes();
    expect(write.body).toEqual({ secret: 's1', invite: 'NJ-123456', grant: null, host: 'Ada', participants: 1, term: 0 });
    expect(write.init.headers).toBeUndefined(); // text/plain by default: no CORS preflight
    expect(typeof write.init.body).toBe('string');
  });

  it('is refused while another meeting holds the room, and told whose it is', async () => {
    fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-111111' });
    const result = await claimRoom('abc-defg-hij', { secret: 's2', invite: 'NJ-222222' });
    expect(result).toMatchObject({ ok: false, held: true, room: { status: 'live', invite: 'NJ-111111' } });
    expect((await readRoom('abc-defg-hij')).invite).toBe('NJ-111111');
  });

  it('takes over a lease nobody has kept fresh', async () => {
    vi.useFakeTimers();
    fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-111111' });
    vi.advanceTimersByTime(61_000);
    const result = await claimRoom('abc-defg-hij', { secret: 's2', invite: 'NJ-222222' });
    expect(result.ok).toBe(true);
    expect((await readRoom('abc-defg-hij')).invite).toBe('NJ-222222');
  });

  it('rejects when the directory cannot be reached or refuses, and without a secret', async () => {
    const dir = fakeDirectory();
    dir.state.failing = true;
    await expect(claimRoom('abc-defg-hij', { secret: 's1', invite: 'x' })).rejects.toThrow();
    globalThis.fetch = vi.fn(async () => json(400, { ok: false, reason: 'bad_body' }));
    await expect(claimRoom('abc-defg-hij', { secret: 's1', invite: 'x' })).rejects.toThrow(/bad_body/);
    await expect(claimRoom('abc-defg-hij', { invite: 'x' })).rejects.toThrow(/secret/);
  });
});

describe('endRoom', () => {
  it('releases our own entry, never someone else’s, and never rejects', async () => {
    const dir = fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-111111' });
    expect(await endRoom('abc-defg-hij', 's2')).toBe(false);
    expect(dir.entry('abc-defg-hij')).not.toBeNull();
    expect(await endRoom('abc-defg-hij', 's1')).toBe(true);
    expect(dir.entry('abc-defg-hij')).toBeNull();
    dir.state.failing = true;
    expect(await endRoom('abc-defg-hij', 's1')).toBe(false);
    expect(await endRoom('abc-defg-hij', null)).toBe(false);
  });

  it('cannot end a meeting that has moved on to a later term', async () => {
    // Everyone in the meeting holds its secret; the old host coming back
    // alone after a successor took over must not end the successor's entry.
    const dir = fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-OLD', term: 0 });
    await claimRoom('abc-defg-hij', { secret: 's1', invite: 'NJ-NEW', term: 1 });
    expect(await endRoom('abc-defg-hij', 's1', 0)).toBe(false);
    expect(await endRoom('abc-defg-hij', 's1')).toBe(false);
    expect(dir.entry('abc-defg-hij')?.invite).toBe('NJ-NEW');
    expect(await endRoom('abc-defg-hij', 's1', 1)).toBe(true);
    expect(dir.entry('abc-defg-hij')).toBeNull();
  });

  it('goes out as a beacon on unload', () => {
    const sendBeacon = vi.fn(() => true);
    const saved = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon }, configurable: true });
    try {
      expect(endRoomOnUnload('abc-defg-hij', 's1')).toBe(true);
      expect(sendBeacon).toHaveBeenCalledWith(
        `${ROOMS_ORIGIN}/v1/rooms/abc-defg-hij/end`,
        JSON.stringify({ secret: 's1', term: 0 })
      );
      expect(endRoomOnUnload('abc-defg-hij', 's1', 3)).toBe(true);
      expect(sendBeacon).toHaveBeenLastCalledWith(
        `${ROOMS_ORIGIN}/v1/rooms/abc-defg-hij/end`,
        JSON.stringify({ secret: 's1', term: 3 })
      );
      expect(endRoomOnUnload('abc-defg-hij', '')).toBe(false);
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
      expect(endRoomOnUnload('abc-defg-hij', 's1')).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
    }
  });
});

/* ------------------------------------------------------------------ */

describe('RoomLease', () => {
  /** A session-shaped stand-in, as hostFields() reads it. */
  function fakeSession(overrides = {}) {
    return { code: 'NJ-123456', guestGrant: 'pg1.abc', name: 'Ada', peerCount: 0, term: 0, ...overrides };
  }

  it('claims the room with the host’s fields, checks the claim soon after, and heartbeats from then on', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    const session = fakeSession();
    const lease = new RoomLease('abc-defg-hij', 's1', () => hostFields(session));
    const beats = [];
    lease.on('beat', (beat) => beats.push(beat));

    const first = await lease.start();
    expect(first.ok).toBe(true);
    expect(lease.last).toBe('ok');
    expect(dir.writes()).toHaveLength(1);
    expect(dir.writes()[0].body).toEqual({
      secret: 's1',
      invite: 'NJ-123456',
      grant: 'pg1.abc',
      host: 'Ada',
      participants: 1,
      term: 0,
    });
    expect(beats).toEqual([{ ok: true, held: false, stale: false, room: expect.objectContaining({ status: 'live' }), error: null }]);

    await vi.advanceTimersByTimeAsync(VERIFY_CLAIM_AFTER_MS + 50);
    expect(dir.writes()).toHaveLength(2); // the check
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(dir.writes()).toHaveLength(3); // the first heartbeat
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(dir.writes()).toHaveLength(4);
    expect(beats.every((beat) => beat.ok)).toBe(true);
    lease.stop();
  });

  it('writes what the session says now — a new invite, grant or headcount goes out on the next write', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    const session = fakeSession();
    const lease = new RoomLease('abc-defg-hij', 's1', () => hostFields(session));
    await lease.start();
    session.code = 'NJ-654321';
    session.guestGrant = 'pg1.two';
    session.peerCount = 2;
    session.term = 1;
    await lease.refresh();
    expect(dir.writes().at(-1).body).toEqual({
      secret: 's1',
      invite: 'NJ-654321',
      grant: 'pg1.two',
      host: 'Ada',
      participants: 3,
      term: 1,
    });
    expect(dir.entry('abc-defg-hij')).toMatchObject({ invite: 'NJ-654321', participants: 3 });
    lease.stop();
  });

  it('is told when another meeting holds the room, keeps beating, and takes the room once that lease is gone', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    await claimRoom('abc-defg-hij', { secret: 'theirs', invite: 'NJ-000000', host: 'Bob' });
    const lease = new RoomLease('abc-defg-hij', 's1', () => hostFields(fakeSession()));
    const beats = [];
    lease.on('beat', (beat) => beats.push(beat));

    const first = await lease.start();
    expect(first).toMatchObject({ ok: false, held: true, room: { status: 'live', invite: 'NJ-000000', host: 'Bob' } });
    expect(lease.last).toBe('held');
    expect(beats.at(-1)).toMatchObject({ ok: false, held: true, room: { invite: 'NJ-000000' } });
    // No check follows a claim that did not land; the heartbeat goes on.
    await vi.advanceTimersByTimeAsync(VERIFY_CLAIM_AFTER_MS + 50);
    expect(dir.writes()).toHaveLength(2); // theirs + ours
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(dir.writes()).toHaveLength(3);
    expect(dir.entry('abc-defg-hij').secret).toBe('theirs');

    // Their meeting ends: the next beat takes the room.
    await endRoom('abc-defg-hij', 'theirs');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(dir.entry('abc-defg-hij')).toMatchObject({ secret: 's1', invite: 'NJ-123456' });
    expect(beats.at(-1).ok).toBe(true);
    expect(lease.last).toBe('ok');
    lease.stop();
  });

  it('reports a write that could not reach the directory, tries again soon, and recovers', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    const lease = new RoomLease('abc-defg-hij', 's1', () => hostFields(fakeSession()));
    const beats = [];
    lease.on('beat', (beat) => beats.push(beat));
    await lease.start();
    dir.state.failing = true;
    await vi.advanceTimersByTimeAsync(VERIFY_CLAIM_AFTER_MS + 50);
    expect(beats.at(-1)).toMatchObject({ ok: false, held: false });
    expect(beats.at(-1).error).toBeInstanceOf(Error);
    expect(lease.last).toBe('error');
    // Not a full heartbeat later: soon.
    const failed = dir.writes().length;
    dir.state.failing = false;
    await vi.advanceTimersByTimeAsync(BEAT_RETRY_MS + 50);
    expect(dir.writes().length).toBe(failed + 1);
    expect(beats.at(-1).ok).toBe(true);
    lease.stop();
  });

  it('coalesces refreshes with a write in flight into one more write, and none after stop()', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    dir.state.hang = true;
    const lease = new RoomLease('abc-defg-hij', 's1', () => hostFields(fakeSession()));
    const starting = lease.start();
    lease.refresh();
    lease.refresh();
    lease.refresh();
    expect(dir.writes()).toHaveLength(1); // one in flight; the rest wait for it
    dir.state.hang = false;
    await vi.advanceTimersByTimeAsync(9000); // the hung write times out
    await starting;
    await flush();
    expect(dir.writes()).toHaveLength(2); // exactly one follow-up
    lease.stop();
    await lease.refresh();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(dir.writes()).toHaveLength(2);
    expect(lease.stopped).toBe(true);
  });

  it('end() stops the heartbeat and releases the room; stop() leaves the entry for a successor', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    const lease = new RoomLease('abc-defg-hij', 's1', () => hostFields(fakeSession()));
    await lease.start();
    lease.stop();
    expect(dir.entry('abc-defg-hij')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(dir.writes()).toHaveLength(1);

    const successor = new RoomLease('abc-defg-hij', 's1', () => hostFields(fakeSession({ code: 'NJ-999999' })));
    expect((await successor.start()).ok).toBe(true); // the same secret carries the lease on
    expect(dir.entry('abc-defg-hij').invite).toBe('NJ-999999');
    expect(await successor.end()).toBe(true);
    expect(dir.entry('abc-defg-hij')).toBeNull();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(dir.writes().filter((w) => w.body.invite === 'NJ-999999')).toHaveLength(1);
    expect((await successor.start()).ok).toBe(false); // a stopped lease stays stopped
  });

  it('endOnUnload() sends the release as a beacon', async () => {
    fakeDirectory();
    const sendBeacon = vi.fn(() => true);
    const saved = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value: { sendBeacon }, configurable: true });
    try {
      const lease = new RoomLease('abc-defg-hij', 's1', () => hostFields(fakeSession({ term: 2 })));
      await lease.start();
      expect(lease.endOnUnload()).toBe(true);
      expect(sendBeacon).toHaveBeenCalledWith(
        `${ROOMS_ORIGIN}/v1/rooms/abc-defg-hij/end`,
        JSON.stringify({ secret: 's1', term: 2 })
      );
      expect(lease.stopped).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
    }
  });
});

describe('hostFields', () => {
  it('reads the entry’s fields off a session', () => {
    expect(hostFields({ code: 'NJ-1', guestGrant: null, name: 'Ada', peerCount: 4, term: 2 })).toEqual({
      invite: 'NJ-1',
      grant: null,
      host: 'Ada',
      participants: 5,
      term: 2,
    });
  });
});

describe('RoomWarmer', () => {
  const session = (overrides = {}) => ({
    code: 'NJ-123456',
    guestGrant: 'pg1.abc',
    name: 'Ada',
    peerCount: 1,
    term: 0,
    ...overrides,
  });

  /** An entry written `age` ago by the host, as the directory would hold it. */
  const seed = (dir, { age = 0, term = 0, host = 'Hostname', invite = 'NJ-HOST' } = {}) => {
    dir.store.set('abc-defg-hij', {
      code: 'abc-defg-hij',
      secret: 's1',
      invite,
      grant: null,
      host,
      participants: 2,
      term,
      startedAt: Date.now() - age,
      at: Date.now() - age,
    });
  };

  it('leaves an entry alone while the host is still writing to it', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    seed(dir, { age: 5_000 });
    const warmer = new RoomWarmer('abc-defg-hij', 's1', () => hostFields(session()));

    warmer.start();
    await flush();

    expect(dir.writes()).toHaveLength(0);
    warmer.stop();
  });

  it('holds an entry that is going stale, keeping whose meeting it is', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    seed(dir, { age: WARM_AFTER_MS + 1_000 });
    const warmer = new RoomWarmer('abc-defg-hij', 's1', () => hostFields(session()));

    warmer.start();
    await flush();

    expect(dir.writes()).toHaveLength(1);
    expect(dir.writes()[0].body.host).toBe('Hostname');
    expect(dir.entry('abc-defg-hij').at).toBe(Date.now());
    warmer.stop();
  });

  it('claims a code whose entry has already lapsed, so nobody starts a meeting on it', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    const warmer = new RoomWarmer('abc-defg-hij', 's1', () => hostFields(session()));

    warmer.start();
    await flush();

    expect(dir.writes()).toHaveLength(1);
    expect(dir.entry('abc-defg-hij').invite).toBe('NJ-123456');
    warmer.stop();
  });

  it('keeps looking on its own cadence', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    seed(dir, { age: WARM_AFTER_MS + 1_000 });
    const warmer = new RoomWarmer('abc-defg-hij', 's1', () => hostFields(session()));

    warmer.start();
    await flush();
    expect(dir.writes()).toHaveLength(1);

    // Its own write made the entry fresh, so the next look leaves it be.
    await vi.advanceTimersByTimeAsync(WARM_CHECK_MS);
    await flush();
    expect(dir.writes()).toHaveLength(1);
    warmer.stop();
  });

  it('stands down when the meeting has moved on to a later term', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    seed(dir, { age: WARM_AFTER_MS + 1_000, term: 3, invite: 'NJ-SUCCESSOR' });
    const warmer = new RoomWarmer('abc-defg-hij', 's1', () => hostFields(session({ term: 0 })));
    const warmed = [];
    warmer.on('warm', (event) => warmed.push(event));

    warmer.start();
    await flush(20);

    expect(warmed).toEqual([expect.objectContaining({ ok: false, stale: true })]);
    expect(warmer.stopped).toBe(true);
    // The successor's address stands.
    expect(dir.entry('abc-defg-hij').invite).toBe('NJ-SUCCESSOR');
  });

  it('writes nothing once stopped', async () => {
    vi.useFakeTimers();
    const dir = fakeDirectory();
    seed(dir, { age: WARM_AFTER_MS + 1_000 });
    const warmer = new RoomWarmer('abc-defg-hij', 's1', () => hostFields(session()));

    warmer.start();
    warmer.stop();
    await vi.advanceTimersByTimeAsync(WARM_CHECK_MS * 3);
    await flush();

    expect(dir.writes()).toHaveLength(0);
  });
});
