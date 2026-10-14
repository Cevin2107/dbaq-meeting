// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as P from '../src/lib/protocol.js';
import { LINK_RECOVERY_BUDGET_MS } from '../src/net/rtc.js';

/*
 * Joining a meeting link needs no Puter session at all: the guest goes in
 * anonymously, on the guest grant the host published next to the invite. A
 * one-time link from an older deploy has no room to carry a grant, so a
 * visitor without a session on one of those still gets a session — Puter
 * creates the account, and the guest never sees a form. The account it hands
 * back is a full one; these cases only check who we end up signed in as (or
 * not), and that a username nobody chose doesn't become the name the meeting
 * introduces them by.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Enough of MediaStream for LocalMedia to construct in jsdom. */
class FakeMediaStream {
  getTracks() {
    return [];
  }
  getAudioTracks() {
    return [];
  }
  getVideoTracks() {
    return [];
  }
  addTrack() {}
  removeTrack() {}
}

/**
 * A Puter that can sign in. `signIn` records its options and lands on the kind
 * of account they asked for, as the real popup does: `attempt_temp_user_creation`
 * comes back as an account Puter made (`is_temp`), the sign-in window as one
 * its owner made. Deliberately no `peer`, so a join fails right after the
 * sign-in step — that failure is the signal the step is behind us.
 */
function fakePuter({ signedIn = false, isTemp = false, username = 'ada-42' } = {}) {
  const state = { signedIn, isTemp, username };
  const signIn = vi.fn(async (opts = {}) => {
    Object.assign(state, { signedIn: true, isTemp: !!opts.attempt_temp_user_creation });
    return { success: true };
  });
  return {
    signIn,
    state,
    auth: {
      isSignedIn: () => state.signedIn,
      getUser: vi.fn(async () => {
        if (!state.signedIn) throw { status: 401 };
        return { username: state.username, is_temp: state.isTemp };
      }),
      signIn,
      signOut: async () => void (state.signedIn = false),
    },
    kv: { get: async () => null, set: async () => true, del: async () => true },
  };
}

/**
 * A stand-in for the room directory (src/lib/rooms.js → worker/rooms.js).
 * `room` is what a read answers — null: nothing running; an entry: what is;
 * a function: asked on every read. A claim is answered `claim`: 'ok' — the
 * room is the caller's; 'held' — `room` is someone else's meeting.
 * `unreachable` fails every request.
 */
function directory({ room = null, claim = 'ok', unreachable = false } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const state = { room, claim, unreachable };
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const end = /\/end$/.test(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, end, body });
    if (state.unreachable) throw new TypeError('Failed to fetch');
    const current = typeof state.room === 'function' ? state.room() : state.room;
    if (method === 'GET') return reply(200, { ok: true, now: Date.now(), room: current });
    if (end) return reply(200, { ok: true, now: Date.now(), ended: true });
    if (state.claim === 'held') return reply(409, { ok: false, reason: 'held', now: Date.now(), room: current });
    return reply(200, { ok: true, now: Date.now(), room: entry({ invite: body.invite ?? null, host: body.host ?? null }) });
  });
  return {
    state,
    calls,
    reads: () => calls.filter((c) => c.method === 'GET'),
    claims: () => calls.filter((c) => c.method === 'POST' && !c.end),
    releases: () => calls.filter((c) => c.end),
  };
}

/** A directory entry for a running meeting (`invite` null: one being started). */
function entry({ invite = 'invite-live', grant = null, host = 'Host', participants = 1 } = {}) {
  return { code: 'abc-defg-hij', invite, grant, host, participants, startedAt: Date.now() - 60_000, term: 0, age: 1000 };
}

let mountPrejoin;
let prefs;
let dispose = null;
let root;

const ctx = {
  getUserName: () => null,
  setUserName: vi.fn(),
  goHome: vi.fn(),
  startCall: vi.fn(),
};

const nameField = () => root.querySelector('.prejoin-side input[type="text"]');
const errorLine = () => root.querySelector('.prejoin-error');

beforeEach(async () => {
  localStorage.clear();
  delete window.puter;
  globalThis.MediaStream = FakeMediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: () => Promise.reject(new Error('no devices in jsdom')),
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
  });

  // prefs.js memoizes its cloud pull, so each case needs a fresh module graph.
  vi.resetModules();
  prefs = await import('../src/lib/prefs.js');
  ({ mountPrejoin } = await import('../src/ui/prejoin.js'));

  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  root.remove();
});

function mount(params) {
  dispose = mountPrejoin(root, params, ctx);
}

/** Click Join with a name filled in, and wait for the attempt to settle. */
async function join(params = { mode: 'join', code: 'inv-9f2a' }) {
  mount(params);
  nameField().value = 'Ada';
  root.querySelector('.btn-primary').click();
  await vi.waitFor(() => expect(errorLine().textContent).not.toBe(''));
}

describe('joining a meeting link', () => {
  let savedFetch;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  /** The directory says a meeting is running. */
  function liveRoom(extra = {}) {
    directory({ room: entry(extra) });
  }

  /** Click Join on a room link and wait for the dial to the host. */
  async function joinRoom(connect) {
    window.puter.peer = { connect };
    mount({ mode: 'join', code: 'abc-defg-hij' });
    nameField().value = 'Ada';
    root.querySelector('.btn-primary').click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalled());
  }

  it('lets a visitor with no session in anonymously, on the host’s grant — no sign-in', async () => {
    window.puter = fakePuter();
    liveRoom({ grant: 'pg1.host.grant' });
    const connect = vi.fn(async () => {
      throw new Error('no such meeting');
    });
    await joinRoom(connect);

    expect(window.puter.signIn).not.toHaveBeenCalled();
    expect(window.puter.state.signedIn).toBe(false);
    expect(connect).toHaveBeenCalledWith('invite-live', {
      recoveryTimeout: LINK_RECOVERY_BUDGET_MS,
      anonToken: expect.stringMatching(UUID),
      turnGrant: 'pg1.host.grant',
    });
  });

  it('still goes in anonymously when the host published no grant (direct connections only)', async () => {
    window.puter = fakePuter();
    liveRoom();
    const connect = vi.fn(async () => {
      throw new Error('no such meeting');
    });
    await joinRoom(connect);

    expect(window.puter.signIn).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith('invite-live', { recoveryTimeout: LINK_RECOVERY_BUDGET_MS, anonToken: expect.stringMatching(UUID) });
  });

  it('joins on the visitor’s own account when they are signed in', async () => {
    window.puter = fakePuter({ signedIn: true });
    liveRoom({ grant: 'pg1.host.grant' });
    const connect = vi.fn(async () => {
      throw new Error('no such meeting');
    });
    await joinRoom(connect);

    expect(window.puter.signIn).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith('invite-live', { recoveryTimeout: LINK_RECOVERY_BUDGET_MS });
  });
});

describe('joining a one-time link from an older deploy', () => {
  it('has Puter make an account for a visitor who is not signed in', async () => {
    window.puter = fakePuter();
    await join();

    expect(window.puter.signIn).toHaveBeenCalledTimes(1);
    expect(window.puter.signIn).toHaveBeenCalledWith({ attempt_temp_user_creation: true });
    expect(window.puter.state.signedIn).toBe(true);
  });

  it('asks nothing of someone already signed in', async () => {
    window.puter = fakePuter({ signedIn: true });
    await join();

    expect(window.puter.signIn).not.toHaveBeenCalled();
  });

  it('asks nothing of a guest whose account Puter made earlier', async () => {
    window.puter = fakePuter({ signedIn: true, isTemp: true });
    await join();

    expect(window.puter.signIn).not.toHaveBeenCalled();
  });

  it('leaves a puter.js with no accounts to the peer API', async () => {
    // A stub, or a build that doesn't do accounts. Sign-in used to be skipped
    // wholesale in that case, and still is — failing here on the peer API's
    // behalf would be inventing a problem it may not have.
    window.puter = { kv: { get: async () => null, set: async () => true } };
    await join();

    expect(errorLine().textContent).not.toMatch(/Puter window/i);
  });

  it('says what happened when the Puter window is blocked', async () => {
    window.puter = fakePuter();
    // The real rejection is a plain object, not an Error — reading only
    // `.message` off it used to show the user "[object Object]".
    window.puter.signIn.mockRejectedValueOnce({ error: 'popup_blocked', msg: 'The sign-in popup was blocked.' });
    await join();

    expect(errorLine().textContent).toMatch(/blocked the Puter window/i);
  });

  it('says what happened when the Puter window is closed', async () => {
    window.puter = fakePuter();
    window.puter.signIn.mockRejectedValueOnce({ error: 'auth_window_closed', msg: 'Window was closed.' });
    await join();

    expect(errorLine().textContent).toMatch(/closed before we could get you in/i);
  });
});

describe('starting a meeting', () => {
  it('does not require signing in to start a meeting', async () => {
    window.puter = fakePuter();
    await join({ mode: 'create' });

    expect(window.puter.signIn).not.toHaveBeenCalled();
  });

  it('asks nothing of someone already signed in', async () => {
    window.puter = fakePuter({ signedIn: true });
    await join({ mode: 'create' });

    expect(window.puter.signIn).not.toHaveBeenCalled();
  });
});

/**
 * Enough Puter for a start to get as far as serving; serving then fails,
 * which ends the attempt right after the point under test instead of
 * leaving a heartbeat running.
 */
function armStart() {
  window.puter.peer = {
    serve: vi.fn(async () => {
      throw new Error('no peer in this test');
    }),
  };
}

const joinBtn = () => root.querySelector('.btn-primary');
const startBtn = () => [...root.querySelectorAll('button')].find((b) => /Start this meeting|Starting…/.test(b.textContent));

/** Click Join on a room link, as a visitor who could start it. */
function clickJoin(code = 'abc-defg-hij') {
  armStart();
  mount({ mode: 'join', code });
  nameField().value = 'Ada';
  joinBtn().click();
}

/** Where in fetch's call order a directory call sits (to compare with other mocks). */
const orderOf = (dir, call) => globalThis.fetch.mock.invocationCallOrder[dir.calls.indexOf(call)];

describe('joining a room where nothing is running', () => {
  let savedFetch;
  let dir;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    dir = directory();
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  it('has a signed-in visitor start the meeting on the spot — no waiting room, no second button', async () => {
    // The complaint this answers: someone opens a link, clicks Join, and is
    // told to wait for a host — when the host could simply be them.
    window.puter = fakePuter({ signedIn: true });
    clickJoin();

    await vi.waitFor(() => expect(window.puter.peer.serve).toHaveBeenCalled());
    // The room was claimed in the directory — with no invite yet — before
    // anything was served, so nobody else starts it in the same breath.
    expect(dir.claims()).toHaveLength(1);
    expect(dir.claims()[0].body).toMatchObject({ host: 'Ada', invite: null });
    expect(typeof dir.claims()[0].body.secret).toBe('string');
    expect(orderOf(dir, dir.claims()[0])).toBeLessThan(window.puter.peer.serve.mock.invocationCallOrder[0]);
    expect(window.puter.signIn).not.toHaveBeenCalled();
    expect(joinBtn().textContent).not.toMatch(/Waiting for the host/);
    expect(startBtn().style.display).toBe('none');
  });

  it('starts a link nobody has ever started — minted elsewhere or here, nothing has to exist first', async () => {
    window.puter = fakePuter({ signedIn: true });
    clickJoin('abcd-efgh-ijkl');

    await vi.waitFor(() => expect(window.puter.peer.serve).toHaveBeenCalled());
    expect(dir.claims()).toHaveLength(1);
    expect(joinBtn().textContent).not.toMatch(/Waiting for the host/);
  });

  it('waits, rather than starting, while the directory cannot be reached', async () => {
    // A claim needs the directory; without one a start could only fork.
    window.puter = fakePuter({ signedIn: true });
    dir.state.unreachable = true;
    clickJoin();

    await vi.waitFor(() => expect(joinBtn().textContent).toMatch(/Waiting for the host/));
    expect(startBtn().style.display).toBe('');
    expect(window.puter.peer.serve).not.toHaveBeenCalled();
    expect(dir.claims()).toHaveLength(0);
  });

  it('keeps a visitor with no session in the waiting room, with Start on offer', async () => {
    // Hosting takes an account, and the sign-in is a popup only a click may
    // open — so the wait, and the button, stay for them.
    window.puter = fakePuter();
    clickJoin();

    await vi.waitFor(() => expect(joinBtn().textContent).toMatch(/Waiting for the host/));
    expect(startBtn().style.display).toBe('');
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/sign in with Puter to start it/i);
    expect(window.puter.signIn).not.toHaveBeenCalled();
    expect(window.puter.peer.serve).not.toHaveBeenCalled();
    expect(dir.claims()).toHaveLength(0);
  });

  it('joins the meeting someone else started in the same breath, instead of hosting a second one', async () => {
    window.puter = fakePuter({ signedIn: true });
    // Nothing running when we look; by the time we claim, someone has.
    dir.state.room = () => (dir.claims().length ? entry({ invite: 'invite-theirs', host: 'Bob' }) : null);
    dir.state.claim = 'held';
    const connect = vi.fn(() => new Promise(() => {})); // the dial is in flight
    clickJoin();
    window.puter.peer.connect = connect;

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(connect.mock.calls[0][0]).toBe('invite-theirs');
    expect(window.puter.peer.serve).not.toHaveBeenCalled();
    expect(dir.claims()).toHaveLength(1);
  });

  it('does not start over a meeting someone is starting this very moment', async () => {
    window.puter = fakePuter({ signedIn: true });
    dir.state.room = entry({ invite: null, host: 'Bob' });
    clickJoin();

    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    expect(root.textContent).toMatch(/The meeting is starting/);
    expect(window.puter.peer.serve).not.toHaveBeenCalled();
    expect(dir.claims()).toHaveLength(0);
  });

  it('frees the link again when serving fails right after the claim', async () => {
    window.puter = fakePuter({ signedIn: true });
    clickJoin();

    await vi.waitFor(() => expect(errorLine().textContent).not.toBe(''));
    await vi.waitFor(() => expect(dir.releases()).toHaveLength(1));
    expect(dir.releases()[0].body.secret).toBe(dir.claims()[0].body.secret);
  });
});

describe('starting a room meeting from the waiting room', () => {
  let savedFetch;
  let dir;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    // Nothing is running, so Join lands a visitor with no session in the
    // waiting room, where Start is on offer.
    dir = directory();
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  /** Join the idle room, wait for the waiting room, and click Start. */
  async function clickStart() {
    clickJoin();
    await vi.waitFor(() => expect(startBtn().style.display).toBe(''));
    startBtn().click();
  }

  it('allows a visitor with no session to start immediately without popup', async () => {
    window.puter = fakePuter();
    await clickStart();

    expect(window.puter.signIn).toHaveBeenCalledWith({ attempt_temp_user_creation: true });
    await vi.waitFor(() => expect(dir.claims()).toHaveLength(1));
  });
});

describe('the name a guest is introduced by', () => {
  it('never falls back to a username Puter generated', async () => {
    window.puter = fakePuter({ signedIn: true, isTemp: true, username: 'temp-8f21c0' });
    prefs.syncPrefsFromCloud();
    mount({ mode: 'join', code: 'inv-9f2a' });

    await vi.waitFor(() => expect(window.puter.auth.getUser).toHaveBeenCalled());
    expect(nameField().value).toBe('');
  });

  it('still falls back to the username of an account its owner made', async () => {
    window.puter = fakePuter({ signedIn: true, username: 'ada-42' });
    prefs.syncPrefsFromCloud();
    mount({ mode: 'join', code: 'inv-9f2a' });

    await vi.waitFor(() => expect(nameField().value).toBe('ada-42'));
  });
});

/**
 * The lobby, when the meeting IS running but its published invite cannot be
 * reached (2026-08-27: a host whose signaller socket died sits in a working
 * call while the link names a dead code). The guest is told what is
 * actually happening, a quick failure gets one more try, a definitive one
 * none — and the moment the host republishes, the guest is dialing the new
 * code.
 */
/** Just enough of an RTCPeerConnection for the session to judge a failed dial by. */
class FakePC {
  #listeners = new Map();
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  remoteDescription = null;
  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(event);
  }
  addTrack() {
    return { replaceTrack: async () => {}, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} };
  }
  removeTrack() {}
  getConfiguration() {
    return {};
  }
  close() {}
}

class FakeConn {
  publications = new Map();
  media = new Map();
  #listeners = new Map();
  #pc = null;

  get peerconnection() {
    return this.#pc;
  }

  set peerconnection(pc) {
    this.#pc = pc;
    this.#watchTransport(pc);
  }

  constructor() {
    this.peerconnection = new FakePC();
  }

  /** Mirrors puter.peer: transport state becomes a link-health signal. */
  #watchTransport(pc) {
    pc?.addEventListener?.('connectionstatechange', () => {
      const state = { connected: 'connected', disconnected: 'unstable', failed: 'recovering' }[
        pc.connectionState
      ];
      if (state) this.dispatch('linkstate', { state, attempt: 1, of: 3 });
    });
  }

  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }
  dispatch(type, event) {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn(event);
  }
  send() {}
  // Named media slots — nothing here watches what is sent, but the session
  // publishes to every connection it has, and a connection that cannot take
  // it turns a media call into a swallowed exception.
  publish(name, stream) {
    this.publications.set(name, stream);
  }
  unpublish(name) {
    this.publications.delete(name);
  }
  configure() {}
  close() {}
}

describe('a meeting that is running but out of reach', () => {
  let savedFetch;
  let invite;
  let grant;
  let dir;
  beforeEach(() => {
    savedFetch = globalThis.fetch;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invite = 'invite-dead';
    grant = null;
    // The directory: a fresh entry — the host is heartbeating right now.
    dir = directory({ room: () => entry({ invite, grant }) });
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = savedFetch;
  });

  /**
   * A dial whose connection fails `how` after `afterMs`: 'invalid' — the
   * signaller disowns the invite; 'dropped' — the channel closes on us;
   * 'blocked' — the host answered the offer but ICE finds no path from here.
   */
  function failingConnect(how, afterMs = 5) {
    return vi.fn(async () => {
      const conn = new FakeConn();
      setTimeout(() => {
        if (how === 'invalid') conn.dispatch('error', { error: new Error('Invalid invite code') });
        else if (how === 'blocked') {
          const pc = conn.peerconnection;
          pc.remoteDescription = { type: 'answer', sdp: '' };
          pc.connectionState = 'failed';
          pc.iceConnectionState = 'failed';
          pc.dispatch('connectionstatechange');
        } else conn.dispatch('close', { reason: 'connection dropped' });
      }, afterMs);
      return conn;
    });
  }

  async function joinAs(connect) {
    window.puter = fakePuter(); // no session: a plain guest
    window.puter.peer = { connect };
    mount({ mode: 'join', code: 'abc-defg-hij' });
    nameField().value = 'Ada';
    joinBtn().click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  }

  it('tells the guest the meeting is running, not that the host is missing', async () => {
    const connect = failingConnect('invalid');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    expect(root.textContent).toMatch(/The meeting is running/);
    expect(root.textContent).not.toMatch(/Waiting for the host/);
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/link is being refreshed/);
  });

  it('writes off an invite the signaller disowns at once, and dials the new one the host publishes', async () => {
    const connect = failingConnect('invalid');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    // Polls go on; the dead invite is not dialed again.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(5);

    // The host re-served and republished.
    invite = 'invite-next';
    await vi.advanceTimersByTimeAsync(7000);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(connect.mock.calls[1][0]).toBe('invite-next');
  });

  it('gives a quickly dropped dial one more try, then looks elsewhere', async () => {
    const connect = failingConnect('dropped');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    // Not straight away...
    await vi.advanceTimersByTimeAsync(3000);
    expect(connect).toHaveBeenCalledTimes(1);
    // ...but after the retry delay, the same invite once more.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(connect.mock.calls[1][0]).toBe('invite-dead');
    // Two failures are a verdict: no third dial while the entry stands.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(root.textContent).toMatch(/The meeting is running/);
  });

  it('does not retry a dial that ran its course unanswered', async () => {
    // Fails late (past the quick-failure window) though not by our own
    // handshake timeout — a host that is gone, or a path that cannot be
    // built. Trying the same invite again would only cost as long again.
    const connect = failingConnect('dropped', 9000);
    await joinAs(connect);
    await vi.advanceTimersByTimeAsync(9500);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('after a while, tells the guest how to get help', async () => {
    const { UNREACHABLE_HELP_AFTER_MS } = await import('../src/ui/prejoin.js');
    const connect = failingConnect('invalid');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    expect(root.querySelector('.prejoin-sub').textContent).not.toMatch(/Still trying/);
    await vi.advanceTimersByTimeAsync(UNREACHABLE_HELP_AFTER_MS + 8000);
    await vi.waitFor(() => expect(root.querySelector('.prejoin-sub').textContent).toMatch(/Still trying to get you in/));
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/share the link again/);
    expect(joinBtn().textContent).toBe('Connecting…');
  });

  it('goes back to plain waiting once the host is really gone', async () => {
    const connect = failingConnect('invalid');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    // The entry is gone: nothing is running any more.
    dir.state.room = null;
    await vi.advanceTimersByTimeAsync(7000);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Waiting for the host…'));
    expect(root.textContent).toMatch(/Waiting for the host/);
    expect(root.textContent).not.toMatch(/The meeting is running/);
  });

  /**
   * A connection the host answers on: the guest's HELLO gets a WELCOME back,
   * so the join completes. Enough of a peer connection underneath for the
   * media link to attach to (no tracks are live in jsdom, so nothing is sent).
   */
  function welcomingConn() {
    const conn = new FakeConn();
    conn.peerconnection.connectionState = 'connected';
    conn.send = (raw) => {
      const msg = P.parse(raw);
      if (msg?.t !== P.MSG.HELLO) return;
      const host = P.makeIdentity({ id: 'host-1', name: 'Host', mic: true, cam: true });
      queueMicrotask(() => conn.dispatch('message', { data: P.encode(P.makeWelcome(host, [], 0, '')) }));
    };
    return conn;
  }

  it('never writes an invite off for a signaller it could not reach itself — it dials again with backoff, and is in the moment the way there is back', async () => {
    const { SIGNALLER_RETRY_MS } = await import('../src/ui/prejoin.js');
    ctx.startCall.mockClear();
    // The guest's own socket to the signaller will not open: connect()
    // rejects before the signaller has heard of the invite. The current
    // library rejects with the socket's error event, which has no message.
    let reachable = false;
    const connect = vi.fn(async () => {
      if (!reachable) throw { type: 'error' };
      return welcomingConn();
    });
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    // The entry is fresh, so the meeting is running — and the trouble is
    // named for what it is, not blamed on the host's link.
    expect(root.textContent).toMatch(/The meeting is running/);
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/Can’t reach Puter’s connection service/);

    // Dialed again after the first backoff step, not before...
    await vi.advanceTimersByTimeAsync(SIGNALLER_RETRY_MS[0] - 1000);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    // ...then after the next, and the same invite every time: nothing
    // written off, no looking elsewhere, no count towards a verdict.
    await vi.advanceTimersByTimeAsync(SIGNALLER_RETRY_MS[1] - 1000);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(SIGNALLER_RETRY_MS[2] + 500);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(4));
    expect(connect.mock.calls.every(([invite]) => invite === 'invite-dead')).toBe(true);
    expect(ctx.startCall).not.toHaveBeenCalled();

    // The network is back: the very next dial goes through, and the guest is in.
    reachable = true;
    await vi.advanceTimersByTimeAsync(SIGNALLER_RETRY_MS[2] + 500);
    await vi.waitFor(() => expect(ctx.startCall).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledTimes(5);
    expect(ctx.startCall.mock.calls[0][0]).toMatchObject({ roomCode: 'abc-defg-hij' });
  });

  it('polls every couple of seconds while the meeting is out of reach, then settles back to the usual cadence', async () => {
    const { UNREACHABLE_POLL_MS, UNREACHABLE_FAST_POLL_FOR_MS } = await import('../src/ui/prejoin.js');
    const polls = () => dir.reads().length;
    const connect = failingConnect('invalid');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));

    // The host is re-serving and republishing right now — look often.
    const before = polls();
    await vi.advanceTimersByTimeAsync(20_000);
    const hurried = polls() - before;
    expect(hurried).toBeGreaterThanOrEqual(Math.floor(20_000 / (UNREACHABLE_POLL_MS + 500)) - 1); // ≥ 7
    expect(hurried).toBeLessThanOrEqual(20_000 / UNREACHABLE_POLL_MS + 1); // ≤ 11

    // Two minutes on, whatever is wrong is not fixed by reading faster.
    await vi.advanceTimersByTimeAsync(UNREACHABLE_FAST_POLL_FOR_MS);
    const later = polls();
    await vi.advanceTimersByTimeAsync(20_000);
    const settled = polls() - later;
    expect(settled).toBeGreaterThanOrEqual(3); // 4.5–6 s apart
    expect(settled).toBeLessThanOrEqual(5);
    // The invite aged out of the skip set every INVITE_DEAD_FOR_MS meanwhile
    // and got a fresh look each time — the faster polling itself never
    // redialed it.
    expect(connect.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('polls the moment the tab comes back into view, and otherwise keeps the plain cadence while nothing is running', async () => {
    // Nothing running: the plain wait.
    dir = directory();
    const polls = () => dir.reads().length;
    window.puter = fakePuter();
    mount({ mode: 'join', code: 'abc-defg-hij' });
    nameField().value = 'Ada';
    joinBtn().click();
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Waiting for the host…'));

    const before = polls();
    await vi.advanceTimersByTimeAsync(20_000);
    const plain = polls() - before;
    expect(plain).toBeGreaterThanOrEqual(3);
    expect(plain).toBeLessThanOrEqual(5);

    // Mid-sleep, the guest switches back to this tab: a poll runs at once.
    await vi.advanceTimersByTimeAsync(1000);
    const seen = polls();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);
    expect(polls()).toBe(seen + 1);

    // A listener that outlived the view would go on polling for nobody.
    dispose();
    dispose = null;
    const after = polls();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(50);
    expect(polls()).toBe(after);
  });

  const retryBtn = () => [...root.querySelectorAll('button')].find((b) => b.textContent === 'Try again');

  it('offers "Try again" once an invite is written off, and dials it right away when clicked', async () => {
    const connect = failingConnect('invalid');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    // Written off: no dial for as long as the entry stands...
    await vi.advanceTimersByTimeAsync(13_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(retryBtn().style.display).toBe('');
    expect(retryBtn().disabled).toBe(false);
    expect(retryBtn().getAttribute('aria-label')).toMatch(/try connecting/i);

    // ...until the guest asks: the same invite is dialed at once, and the
    // button is out of action while that dial is under way.
    retryBtn().focus();
    retryBtn().click();
    expect(retryBtn().disabled).toBe(true);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(connect.mock.calls[1][0]).toBe('invite-dead');
    // A second click while it is disabled does nothing.
    retryBtn().click();
    expect(connect).toHaveBeenCalledTimes(2);

    // The dial fails again; the button comes back, with focus where it was.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(retryBtn().disabled).toBe(false));
    expect(document.activeElement).toBe(retryBtn());
    expect(root.textContent).toMatch(/The meeting is running/);
  });

  it('tells a guest whose own network blocks the way, writes the invite off, and keeps Try again on offer', async () => {
    const { UNREACHABLE_HELP_AFTER_MS } = await import('../src/ui/prejoin.js');
    const connect = failingConnect('blocked', 300);
    await joinAs(connect);
    await vi.waitFor(() =>
      expect(root.querySelector('.prejoin-sub').textContent).toMatch(/Your network is blocking the connection/)
    );
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/another network or a phone hotspot/);
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/guests can use relays/);
    expect(root.textContent).toMatch(/The meeting is running/);
    expect(joinBtn().textContent).toBe('Connecting…');
    expect(retryBtn().style.display).toBe('');
    // The invite will not work from here: no second dial while the entry
    // stands, and the copy stays — the 45 s "ask the host" line would send
    // the guest after the wrong fix.
    await vi.advanceTimersByTimeAsync(UNREACHABLE_HELP_AFTER_MS + 5000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/Your network is blocking the connection/);
    // Until the guest, on another network now, asks.
    retryBtn().click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  });

  it('shows the generic copy for a failure that is not the network', async () => {
    const connect = failingConnect('dropped');
    await joinAs(connect);
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Connecting…'));
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/link is being refreshed/);
    expect(root.querySelector('.prejoin-sub').textContent).not.toMatch(/Your network/);
  });

  it('warns up front when an anonymous guest dials an entry that carries no grant', async () => {
    // A host on an older build published no grant: with no session of our
    // own there is nothing to reach the relays on.
    const connect = vi.fn(() => new Promise(() => {})); // the dial is in flight
    await joinAs(connect);
    await vi.waitFor(() => expect(root.querySelector('.prejoin-sub').textContent).toMatch(/started on an older version/));
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/may not work from every network/);
    dispose();
    dispose = null;

    // With the host's grant alongside the invite, nothing to warn about.
    grant = 'pg1.host.grant';
    const connect2 = vi.fn(() => new Promise(() => {}));
    await joinAs(connect2);
    await vi.advanceTimersByTimeAsync(100);
    expect(root.querySelector('.prejoin-sub').textContent).not.toMatch(/older version/);
  });

  it('offers no "Try again" while nothing is running', async () => {
    dir = directory();
    window.puter = fakePuter();
    mount({ mode: 'join', code: 'abc-defg-hij' });
    nameField().value = 'Ada';
    joinBtn().click();
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Waiting for the host…'));
    expect(retryBtn().style.display).toBe('none');
    // Stop waiting takes it all away.
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Stop waiting').click();
    await vi.waitFor(() => expect(joinBtn().textContent).toBe('Join now'));
    expect(retryBtn().style.display).toBe('none');
  });

  it('keeps saying the meeting is running while its own network is down, rather than "waiting for the host"', async () => {
    const connect = vi.fn(async () => {
      throw new Error('Could not reach the signaller');
    });
    await joinAs(connect);
    await vi.waitFor(() => expect(root.querySelector('.prejoin-sub').textContent).toMatch(/connection service/));
    // With the network gone the room cannot be read either — one outage,
    // not a host who left. The entry seen running a moment ago still stands.
    dir.state.unreachable = true;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(root.textContent).toMatch(/The meeting is running/);
    expect(root.textContent).not.toMatch(/Waiting for the host/);
    expect(root.querySelector('.prejoin-sub').textContent).toMatch(/Can’t reach Puter’s connection service/);
  });
});
