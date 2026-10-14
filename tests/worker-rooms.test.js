import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/*
 * The room directory worker (worker/rooms.js), run against a stand-in for
 * the Puter Workers runtime: the `router` it registers its routes on, and
 * `me.puter.kv`, the worker's own key-value store. What is checked is the
 * contract the app builds on (src/lib/rooms.js): one entry per room, a
 * lease under a secret, freshness judged by the worker's clock, a stranger
 * refused with the live entry while the lease is fresh and let in once it
 * is not, and a release only the meeting itself can make.
 */

const routes = new Map();
globalThis.router = {
  get: (path, handler) => routes.set(`GET ${path}`, handler),
  post: (path, handler) => routes.set(`POST ${path}`, handler),
};

let kv;
function installStore() {
  kv = new Map(); // key -> {value, expireAt}
  globalThis.me = {
    puter: {
      kv: {
        get: vi.fn(async (key) => (kv.has(key) ? kv.get(key).value : null)),
        set: vi.fn(async (key, value, expireAt) => {
          kv.set(key, { value, expireAt });
          return true;
        }),
        del: vi.fn(async (key) => {
          kv.delete(key);
          return true;
        }),
      },
    },
  };
}

beforeAll(async () => {
  installStore();
  await import('../worker/rooms.js');
});

beforeEach(() => {
  installStore();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

async function call(method, path, body) {
  const [, code, end] = path.match(/^\/v1\/rooms\/([^/]+)(\/end)?$/) ?? [];
  const key = path === '/v1/health' ? 'GET /v1/health' : `${method} /v1/rooms/:code${end ?? ''}`;
  const handler = routes.get(key);
  if (!handler) throw new Error(`no route for ${key}`);
  const request = new Request(`https://rooms.test${path}`, {
    method,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const response = await handler({ request, params: code ? { code } : {} });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const get = (code) => call('GET', `/v1/rooms/${code}`);
const post = (code, body) => call('POST', `/v1/rooms/${code}`, body);
const end = (code, body) => call('POST', `/v1/rooms/${code}/end`, body);

describe('the room directory worker', () => {
  it('answers health with its clock', async () => {
    const { status, body } = await call('GET', '/v1/health');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, now: Date.now() });
  });

  it('serves every answer uncached and as JSON', async () => {
    const { headers } = await get('abc-defg-hij');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('rejects anything that is not a room code', async () => {
    expect((await get('nope')).status).toBe(400);
    expect((await get('NJ-7F3A9C')).status).toBe(400);
    expect((await post('nope', { secret: 's1' })).status).toBe(400);
    expect((await end('nope', { secret: 's1' })).status).toBe(400);
  });

  it('normalizes the code it is given, so every spelling of a room is one room', async () => {
    await post('ABC-DEFG-HIJ', { secret: 's1', invite: 'NJ-1' });
    expect((await get('abcdefghij')).body.room).toMatchObject({ code: 'abc-defg-hij', invite: 'NJ-1' });
  });

  it('has nothing for a room nobody has started', async () => {
    const { status, body } = await get('abc-defg-hij');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, now: Date.now(), room: null });
  });

  it('lets the first host claim a room, and shows the entry — without the secret', async () => {
    const { status, body } = await post('abc-defg-hij', {
      secret: 's1',
      invite: 'NJ-123456',
      grant: 'pg1.abc',
      host: 'Ada',
      participants: 1,
      term: 0,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.room).toEqual({
      code: 'abc-defg-hij',
      invite: 'NJ-123456',
      grant: 'pg1.abc',
      host: 'Ada',
      participants: 1,
      startedAt: Date.now(),
      term: 0,
      age: 0,
    });
    expect(JSON.stringify(body)).not.toContain('s1');
    vi.advanceTimersByTime(5000);
    const read = await get('abc-defg-hij');
    expect(read.body.room).toMatchObject({ invite: 'NJ-123456', age: 5000 });
    expect(JSON.stringify(read.body)).not.toContain('s1');
  });

  it('keeps the record in the store with an expiry well past the lease, as a backstop', async () => {
    await post('abc-defg-hij', { secret: 's1', invite: 'NJ-123456' });
    const [key, value, expireAt] = me.puter.kv.set.mock.calls[0];
    expect(key).toBe('room:abc-defg-hij');
    expect(JSON.parse(value)).toMatchObject({ code: 'abc-defg-hij', secret: 's1', invite: 'NJ-123456' });
    expect(expireAt).toBe(Math.floor(Date.now() / 1000) + 600);
  });

  it('refuses a stranger while the lease is fresh, telling them whose meeting it is', async () => {
    await post('abc-defg-hij', { secret: 's1', invite: 'NJ-111111', host: 'Ada' });
    vi.advanceTimersByTime(59_000);
    const { status, body } = await post('abc-defg-hij', { secret: 's2', invite: 'NJ-222222', host: 'Bob' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, reason: 'held', room: { invite: 'NJ-111111', host: 'Ada', age: 59_000 } });
    expect((await get('abc-defg-hij')).body.room.invite).toBe('NJ-111111');
  });

  it('lets the holder heartbeat and update the entry, keeping when the meeting started', async () => {
    await post('abc-defg-hij', { secret: 's1', invite: 'NJ-111111', host: 'Ada' });
    const startedAt = Date.now();
    vi.advanceTimersByTime(20_000);
    const { status, body } = await post('abc-defg-hij', {
      secret: 's1',
      invite: 'NJ-333333',
      grant: 'pg1.two',
      host: 'Ada',
      participants: 4,
      term: 1,
    });
    expect(status).toBe(200);
    expect(body.room).toMatchObject({ invite: 'NJ-333333', grant: 'pg1.two', participants: 4, term: 1, startedAt, age: 0 });
  });

  it('forgets a lease nobody has kept fresh, and lets the next host take the room', async () => {
    await post('abc-defg-hij', { secret: 's1', invite: 'NJ-111111' });
    vi.advanceTimersByTime(59_000);
    expect((await get('abc-defg-hij')).body.room).not.toBeNull();
    vi.advanceTimersByTime(1000);
    expect((await get('abc-defg-hij')).body.room).toBeNull();
    const taken = await post('abc-defg-hij', { secret: 's2', invite: 'NJ-222222' });
    expect(taken.status).toBe(200);
    expect(taken.body.room).toMatchObject({ invite: 'NJ-222222', startedAt: Date.now() }); // a new meeting's start
  });

  it('keeps a claim with no invite yet for a short while only', async () => {
    await post('abc-defg-hij', { secret: 's1', host: 'Ada' });
    expect((await get('abc-defg-hij')).body.room).toMatchObject({ invite: null, host: 'Ada' });
    vi.advanceTimersByTime(19_000);
    expect((await post('abc-defg-hij', { secret: 's2', invite: 'NJ-2' })).status).toBe(409);
    vi.advanceTimersByTime(1000);
    expect((await get('abc-defg-hij')).body.room).toBeNull();
    expect((await post('abc-defg-hij', { secret: 's2', invite: 'NJ-2' })).status).toBe(200);
  });

  it('is released only by the meeting itself — or by anyone once it has lapsed', async () => {
    await post('abc-defg-hij', { secret: 's1', invite: 'NJ-111111' });
    expect((await end('abc-defg-hij', { secret: 's2' })).body).toMatchObject({ ok: true, ended: false });
    expect((await get('abc-defg-hij')).body.room).not.toBeNull();
    expect((await end('abc-defg-hij', { secret: 's1' })).body).toMatchObject({ ok: true, ended: true });
    expect((await get('abc-defg-hij')).body.room).toBeNull();
    expect(me.puter.kv.del).toHaveBeenCalledWith('room:abc-defg-hij');

    await post('abc-defg-hij', { secret: 's1', invite: 'NJ-111111' });
    vi.advanceTimersByTime(61_000);
    expect((await end('abc-defg-hij', { secret: 's2' })).body.ended).toBe(true);
  });

  it('settles two claims that land in the same instant by whose write stands', async () => {
    // The store hands the loser's write to the winner: whatever this
    // request wrote, the read-back shows the other secret.
    me.puter.kv.set.mockImplementationOnce(async (key) => {
      kv.set(key, { value: JSON.stringify({ code: 'abc-defg-hij', secret: 'other', invite: 'NJ-9', at: Date.now() }) });
      return true;
    });
    const { status, body } = await post('abc-defg-hij', { secret: 's1', invite: 'NJ-1' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, reason: 'held', room: { invite: 'NJ-9' } });
  });

  it('validates what it is given', async () => {
    expect((await post('abc-defg-hij', { invite: 'NJ-1' })).status).toBe(400); // no secret
    expect((await post('abc-defg-hij', 'not json')).status).toBe(400);
    expect((await post('abc-defg-hij', { secret: 's1', invite: 'x'.repeat(200) })).status).toBe(400);
    expect((await post('abc-defg-hij', { secret: 's1', invite: 'NJ-1', pad: 'x'.repeat(5000) })).status).toBe(400);
    expect((await end('abc-defg-hij', {})).status).toBe(400);
    // Oversized or odd optional fields are dropped, not fatal.
    const { body } = await post('abc-defg-hij', {
      secret: 's1',
      invite: 'NJ-1',
      grant: 'g'.repeat(600),
      host: 'h'.repeat(100),
      participants: -3,
      term: 'two',
    });
    expect(body.room).toMatchObject({ grant: null, host: null, participants: 1, term: 0 });
  });

  it('reports a store it cannot reach as such, rather than as an empty room', async () => {
    me.puter.kv.get.mockRejectedValueOnce(new Error('kv down'));
    const { status, body } = await get('abc-defg-hij');
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, reason: 'store' });
    me.puter.kv.set.mockRejectedValueOnce(new Error('kv down'));
    expect((await post('abc-defg-hij', { secret: 's1', invite: 'NJ-1' })).status).toBe(503);
  });

  describe('fencing a meeting against its own writers', () => {
    it('turns away a write from a term the meeting has left behind', async () => {
      // Everyone in a meeting holds its secret, so the term is what keeps a
      // participant holding the room while the host was unreachable from
      // putting the address back after the successor has written its own.
      await post('abc-defg-hij', { secret: 's1', invite: 'NJ-OLD', term: 0 });
      const taken = await post('abc-defg-hij', { secret: 's1', invite: 'NJ-NEW', term: 1 });
      expect(taken.status).toBe(200);

      const late = await post('abc-defg-hij', { secret: 's1', invite: 'NJ-OLD', term: 0 });
      expect(late.status).toBe(409);
      expect(late.body.reason).toBe('stale_term');
      expect(late.body.room.invite).toBe('NJ-NEW');

      const { body } = await get('abc-defg-hij');
      expect(body.room.invite).toBe('NJ-NEW');
      expect(body.room.term).toBe(1);
    });

    it('lets the term that holds the room keep writing', async () => {
      await post('abc-defg-hij', { secret: 's1', invite: 'NJ-NEW', term: 2 });
      const again = await post('abc-defg-hij', { secret: 's1', invite: 'NJ-NEWER', term: 2 });
      expect(again.status).toBe(200);
      const { body } = await get('abc-defg-hij');
      expect(body.room.invite).toBe('NJ-NEWER');
    });

    it('refuses a release from a term the meeting has left behind', async () => {
      // The old host, back alone after a successor took over, holds the
      // secret too: its way out must not end the successor's meeting.
      await post('abc-defg-hij', { secret: 's1', invite: 'NJ-OLD', term: 0 });
      await post('abc-defg-hij', { secret: 's1', invite: 'NJ-NEW', term: 1 });

      const late = await end('abc-defg-hij', { secret: 's1', term: 0 });
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({ ok: false, reason: 'stale_term', ended: false });
      expect(late.body.room.invite).toBe('NJ-NEW');
      // A client that sends no term at all counts as term 0.
      expect((await end('abc-defg-hij', { secret: 's1' })).body.ended).toBe(false);
      expect((await get('abc-defg-hij')).body.room.invite).toBe('NJ-NEW');

      // The term holding the room may end it, and anyone may clear it once stale.
      expect((await end('abc-defg-hij', { secret: 's1', term: 1 })).body.ended).toBe(true);
      await post('abc-defg-hij', { secret: 's1', invite: 'NJ-NEW', term: 4 });
      vi.advanceTimersByTime(61_000);
      expect((await end('abc-defg-hij', { secret: 's1', term: 0 })).body.ended).toBe(true);
    });

    it('does not fence a meeting starting fresh on a code that has gone stale', async () => {
      await post('abc-defg-hij', { secret: 's1', invite: 'NJ-OLD', term: 7 });
      vi.advanceTimersByTime(61_000);
      const fresh = await post('abc-defg-hij', { secret: 's2', invite: 'NJ-FRESH', term: 0 });
      expect(fresh.status).toBe(200);
      const { body } = await get('abc-defg-hij');
      expect(body.room.invite).toBe('NJ-FRESH');
    });
  });
});
