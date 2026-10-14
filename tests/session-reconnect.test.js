import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { RoomSession } from '../src/net/session.js';
import { LINK_RECOVERY_BUDGET_MS, LINK_DROP_MS } from '../src/net/rtc.js';
import * as P from '../src/lib/protocol.js';

/* ------------------------------------------------------------------ *
 * The in-memory Puter peer mock from session.test.js, plus a fake      *
 * RTCPeerConnection whose connectionState the test can drive.          *
 *                                                                      *
 * What these tests model: puter.peer watches the transport itself. It   *
 * restarts ICE when a path fails and, only once that has not worked,   *
 * closes the connection with a reason. So a dead transport reaches the *
 * session as a `close`, not as a silently-open link.                   *
 * ------------------------------------------------------------------ */

class MockEventTarget {
  #listeners = new Map();
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
}

class FakeRTCPeerConnection extends MockEventTarget {
  connectionState = 'new';
  signalingState = 'stable';
  senders = [];
  addTrack(track) {
    if (this.signalingState === 'closed') {
      const err = new Error("The RTCPeerConnection's signalingState is 'closed'.");
      err.name = 'InvalidStateError';
      throw err;
    }
    const sender = {
      track,
      replaceTrack: async (next) => {
        sender.track = next;
      },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {},
    };
    this.senders.push(sender);
    return sender;
  }
  removeTrack() {}
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  restartIce() {}
  close() {
    this.signalingState = 'closed';
  }
  /** Drive the transport state the way the browser would. */
  setConnectionState(state) {
    this.connectionState = state;
    this.dispatch('connectionstatechange', {});
  }
}

class MockConn extends MockEventTarget {
  peer = null;
  isOpen = false;
  closed = false;
  #pc = null;

  get peerconnection() {
    return this.#pc;
  }

  set peerconnection(pc) {
    this.#pc = pc;
    this.#watchTransport(pc);
  }

  constructor() {
    super();
    this.peerconnection = new FakeRTCPeerConnection();
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
  publications = new Map();
  media = new Map();

  static pair() {
    const a = new MockConn();
    const b = new MockConn();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  open() {
    if (this.closed) return;
    this.isOpen = true;
    this.dispatch('open', {});
  }

  send(data) {
    if (!this.isOpen || this.closed) throw new Error('connection not open');
    // A dead transport delivers nothing — but stays "open".
    if (this.transportDead) return;
    const remote = this.peer;
    queueMicrotask(() => {
      if (!remote.closed) remote.dispatch('message', { data });
    });
  }

  // -- named media slots --

  publish(name, stream) {
    this.publications.set(name, stream);
    const tracks = streamTracks(stream);
    for (const track of tracks) this.peerconnection.addTrack(track);
    if (this.transportDead || this.closed) return;
    const remote = this.peer;
    queueMicrotask(() => {
      if (!remote || remote.closed) return;
      remote.media.set(name, stream);
      for (const track of tracks) remote.dispatch('media', { name, stream, track });
    });
  }

  unpublish(name) {
    const stream = this.publications.get(name);
    this.publications.delete(name);
    if (this.transportDead || this.closed) return;
    const remote = this.peer;
    queueMicrotask(() => {
      if (!remote || remote.closed) return;
      remote.media.delete(name);
      remote.dispatch('mediaended', { name, stream });
    });
  }

  configure() {}

  /** puter.peer gave up rescuing this link and closed it from our side. */
  giveUp(reason = 'could not restore the connection') {
    if (this.closed) return;
    this.closed = true;
    this.peerconnection.close();
    this.dispatch('close', { reason });
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.peerconnection.close();
    const remote = this.peer;
    // The far end only learns of a close if the path can still carry it.
    if (this.transportDead) return;
    queueMicrotask(() => {
      if (remote && !remote.closed) {
        remote.closed = true;
        remote.peerconnection.close();
        remote.dispatch('close', { reason });
      }
    });
  }
}

class MockServer extends MockEventTarget {
  static count = 0;
  inviteCode = `invite-${++MockServer.count}`;
  closed = false;
  connections = new Set();
  close() {
    this.closed = true;
    for (const conn of this.connections) conn.close('server-closed');
    this.connections.clear();
  }
}

function installMockPuter() {
  const registry = new Map();
  const pairs = [];
  // The host's self-probe dials its own invite every so often, whoever is
  // connected. Every session here is signed in, so a dial carrying an
  // anonToken is a probe — kept apart from the links the tests count.
  const probes = [];
  const puter = {
    peer: {
      _pairs: pairs,
      _probes: probes,
      _registry: registry,
      /** With the network down a connect() fails at once, as it does in a browser. */
      _offline: false,
      serve: async () => {
        const server = new MockServer();
        registry.set(server.inviteCode, server);
        return server;
      },
      connect: async (inviteCode, opts) => {
        if (puter.peer._offline) throw new Error('network unreachable');
        const server = registry.get(inviteCode);
        if (!server || server.closed) throw new Error('no such meeting');
        const [dialer, listener] = MockConn.pair();
        (opts?.anonToken ? probes : pairs).push({ dialer, listener, inviteCode });
        server.connections.add(listener);
        queueMicrotask(() => {
          server.dispatch('connection', { conn: listener, user: { uuid: opts?.anonToken } });
          dialer.open();
          listener.open();
        });
        return dialer;
      },
    },
  };
  return puter;
}

function fakeMedia() {
  return {
    micOn: true,
    camOn: true,
    presenting: false,
    screenStream: null,
    stream: {
      id: `stream-${Math.random().toString(36).slice(2)}`,
      getAudioTracks: () => [],
      getVideoTracks: () => [{ kind: 'video', readyState: 'live' }],
    },
    on: () => () => {},
  };
}

/** Bring the link's transport up, so the session sees a healthy call. */
function bringUp(pair) {
  pair.dialer.peerconnection.setConnectionState('connected');
  pair.listener.peerconnection.setConnectionState('connected');
}

function streamTracks(stream) {
  if (!stream) return [];
  if (typeof stream.getTracks === 'function') return stream.getTracks();
  return [...(stream.getAudioTracks?.() ?? []), ...(stream.getVideoTracks?.() ?? [])];
}

/**
 * Kill the path under a link: nothing gets through any more, on either
 * side, and puter.peer gives the link up once its ICE restarts go
 * unanswered — which reaches the session as a close.
 */
function killTransport(pair, { sides = ['dialer', 'listener'], giveUp = true } = {}) {
  pair.dialer.transportDead = true;
  pair.listener.transportDead = true;
  for (const side of sides) pair[side].peerconnection.setConnectionState('failed');
  if (giveUp) for (const side of sides) pair[side].giveUp();
}

/** Advance fake time in steps until the condition holds. */
async function until(predicate, { step = 50, max = 120_000 } = {}) {
  for (let elapsed = 0; elapsed <= max; elapsed += step) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(step);
  }
  if (!predicate()) throw new Error('condition not met in time');
}

const settle = () => vi.advanceTimersByTimeAsync(100);

/* ------------------------------------------------------------------ */

let savedWindow;
let puter;
const sessions = [];

beforeAll(() => {
  savedWindow = globalThis.window;
});

afterAll(() => {
  globalThis.window = savedWindow;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  puter = installMockPuter();
  globalThis.window = { puter };
});

afterEach(() => {
  for (const s of sessions.splice(0)) {
    try {
      s.leave();
    } catch {
      /* already gone */
    }
  }
  vi.useRealTimers();
});

function makeSession(name) {
  const media = fakeMedia();
  const s = new RoomSession({ media, name });
  s._media = media; // so a test can name the stream this side sends
  sessions.push(s);
  return s;
}

/** A remote camera stream of `from` lands on `pc` (the far end has announced its id already). */
/** A camera stream arrives on a link, under the name puter.peer gives it. */
function arriveCamera(conn, from) {
  const stream = { id: from._media.stream.id, getTracks: () => [] };
  conn.dispatch('media', { name: 'camera', stream, track: {} });
  return stream;
}

function record(session, events) {
  const seen = [];
  for (const type of events) session.on(type, (payload) => seen.push({ type, ...payload }));
  return seen;
}

async function twoPartyCall() {
  const host = makeSession('Host');
  const code = await host.host();
  const guest = makeSession('Guest');
  const joined = guest.join(code);
  await until(() => host.roster.size === 2 && guest.roster.size === 2);
  await joined;
  const link = puter.peer._pairs[0];
  bringUp(link);
  await settle();
  return { host, guest, code, link };
}

describe('a two-person call whose link dies under it', () => {
  it('is rebuilt on a fresh connection, with nobody leaving or joining', async () => {
    const { host, guest, link } = await twoPartyCall();
    const hostEvents = record(host, ['peer-left', 'peer-joined', 'peer-link']);
    const guestEvents = record(guest, ['peer-left', 'peer-joined', 'peer-link', 'host-migrating', 'host-changed']);

    // Both browsers report the transport gone; neither puter connection closes.
    killTransport(link);

    await until(() => puter.peer._pairs.length === 2 && !guest.roster.get(host.selfId)?.reconnecting);
    const fresh = puter.peer._pairs[1];
    bringUp(fresh);
    await settle();

    // Same two people, the whole time.
    expect(host.roster.size).toBe(2);
    expect(guest.roster.size).toBe(2);
    expect(hostEvents.filter((e) => e.type === 'peer-left')).toEqual([]);
    expect(hostEvents.filter((e) => e.type === 'peer-joined')).toEqual([]);
    expect(guestEvents.filter((e) => ['peer-left', 'peer-joined', 'host-migrating', 'host-changed'].includes(e.type))).toEqual([]);

    // Each side said the link was lost, then that it was back.
    expect(guestEvents.filter((e) => e.type === 'peer-link').map((e) => e.state)).toEqual(['lost', 'connected']);
    expect(hostEvents.filter((e) => e.type === 'peer-link').map((e) => e.state)).toEqual(['lost', 'connected']);
    expect(guest.roster.get(host.selfId).reconnecting).toBe(false);
    expect(host.roster.get(guest.selfId).reconnecting).toBe(false);

    // Media was added again on the new connection, and the old one is gone.
    expect(fresh.dialer.peerconnection.senders.length).toBeGreaterThan(0);
    expect(fresh.listener.peerconnection.senders.length).toBeGreaterThan(0);
    expect(link.dialer.closed).toBe(true);
    expect(link.listener.closed).toBe(true);
    expect(host.connectedPeerIds()).toEqual([guest.selfId]);
    expect(guest.connectedPeerIds()).toEqual([host.selfId]);

    // And the call works: chat goes both ways over the new link.
    const atHost = [];
    const atGuest = [];
    host.on('chat', (m) => atHost.push(m.text));
    guest.on('chat', (m) => atGuest.push(m.text));
    guest.sendChat('back?');
    host.sendChat('back.');
    await settle();
    expect(atHost).toContain('back?');
    expect(atGuest).toContain('back.');
  });

  it('holds the last frame that got through while the link is rebuilt, and lets go of it only for the new link', async () => {
    const { host, guest, link } = await twoPartyCall();
    const stream = arriveCamera(link.dialer, host);
    await settle();
    expect(guest.getStream(host.selfId)).toBe(stream);
    const removed = [];
    guest.on('stream-removed', (e) => removed.push(e.kind));

    killTransport(link);
    await until(() => guest.roster.get(host.selfId).reconnecting);
    // Nothing new can arrive; what is there stays up, marked stale.
    expect(guest.getStream(host.selfId)).toBe(stream);
    expect(removed).toEqual([]);

    await until(() => puter.peer._pairs.length === 2 && !guest.roster.get(host.selfId)?.reconnecting);
    expect(removed).toEqual(['camera']);
    expect(guest.getStream(host.selfId)).not.toBe(stream);
  });

  it('takes a returning guest back even when only the guest noticed the loss', async () => {
    const { host, guest, link } = await twoPartyCall();
    const hostEvents = record(host, ['peer-left', 'peer-joined', 'peer-link']);
    const guestEvents = record(guest, ['peer-link']);

    // Only the guest's browser reports the transport gone; the host's says
    // nothing (the loss is one-sided, or slower to show up there).
    killTransport(link, { sides: ['dialer'] });

    await until(() => puter.peer._pairs.length === 2 && !guest.roster.get(host.selfId)?.reconnecting);
    expect(guestEvents.map((e) => e.state)).toEqual(['lost', 'connected']);
    // The host never had a reason to call the link lost, and never treated
    // the fresh HELLO as anyone leaving or joining.
    expect(hostEvents).toEqual([]);
    expect(host.roster.size).toBe(2);
    expect(host.connectedPeerIds()).toEqual([guest.selfId]);
    expect(link.listener.closed).toBe(true); // the host let go of the old connection
  });

  it('shrugs off a blip, without so much as a badge', async () => {
    const { host, guest, link } = await twoPartyCall();
    const guestEvents = record(guest, ['peer-link']);

    // 'disconnected' is transient — ICE heals it or escalates to 'failed',
    // and puter.peer is the one watching, so the session never reacts.
    link.dialer.peerconnection.setConnectionState('disconnected');
    link.listener.peerconnection.setConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    link.dialer.peerconnection.setConnectionState('connected');
    link.listener.peerconnection.setConnectionState('connected');
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_BUDGET_MS);

    expect(puter.peer._pairs.length).toBe(1);
    expect(guestEvents).toEqual([]);
    expect(host.roster.get(guest.selfId).reconnecting).toBe(false);
    expect(guest.roster.get(host.selfId).reconnecting).toBe(false);
  });

  it('rebuilds a link puter.peer could not rescue', async () => {
    const { guest, host, link } = await twoPartyCall();
    killTransport(link);

    await until(() => puter.peer._pairs.length === 2 && !guest.roster.get(host.selfId)?.reconnecting);
    expect(guest.roster.size).toBe(2);
    expect(host.roster.size).toBe(2);
  });

  it('has the host give up a guest who never dials back in', async () => {
    const { host, guest, link } = await twoPartyCall();
    const hostEvents = record(host, ['peer-left', 'peer-link']);

    // Only the host's browser notices; the guest's side is silent (say, the
    // guest's machine went to sleep).
    killTransport(link, { sides: ['listener'] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.roster.size).toBe(2);
    expect(host.roster.get(guest.selfId).reconnecting).toBe(true);

    expect(host.mayContinueElsewhere).toBe(false);
    await until(() => host.roster.size === 1);
    expect(hostEvents.filter((e) => e.type === 'peer-left').map((e) => e.reason)).toEqual(['connection lost']);
    // The guest may be meeting under a successor now: this host must not
    // release the room on its way out.
    expect(host.mayContinueElsewhere).toBe(true);
    expect(puter.peer._pairs.length).toBe(1); // nobody dialed
  });

  it('keeps a guest who dials back in before the deadline', async () => {
    const { host, guest, link } = await twoPartyCall();
    const hostEvents = record(host, ['peer-left', 'peer-joined']);

    link.dialer.transportDead = link.listener.transportDead = true;
    link.listener.peerconnection.setConnectionState('failed');
    link.listener.giveUp();
    link.dialer.peerconnection.setConnectionState('failed');
    puter.peer._offline = true;
    // The guest's side spends its recovery budget before it dials, and is
    // then off the network for part of the redial window...
    await vi.advanceTimersByTimeAsync(LINK_RECOVERY_BUDGET_MS);
    link.dialer.giveUp();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(host.roster.get(guest.selfId).reconnecting).toBe(true);
    // ...and when it is back, the signaller is slow to put it through.
    puter.peer._offline = false;
    const realConnect = puter.peer.connect;
    puter.peer.connect = async (invite) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return realConnect(invite);
    };

    await until(() => puter.peer._pairs.length === 2 && !guest.roster.get(host.selfId)?.reconnecting, { max: 20_000 });
    bringUp(puter.peer._pairs[1]);
    await settle();
    // The host was still waiting: the same two people, no leave, no join.
    expect(hostEvents).toEqual([]);
    expect(host.roster.size).toBe(2);
    expect(host.roster.get(guest.selfId).reconnecting).toBe(false);
  });

  it('drops a vanished guest a minute after the link first showed trouble', async () => {
    const { host, guest, link } = await twoPartyCall();

    // The guest's network is gone. The host's browser notices the silence
    // and reports the link unstable, then failed; puter.peer is still
    // trying to rescue it.
    link.dialer.transportDead = link.listener.transportDead = true;
    puter.peer._offline = true;
    link.listener.peerconnection.setConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(10_000);
    link.listener.peerconnection.setConnectionState('failed');
    await vi.advanceTimersByTimeAsync(LINK_DROP_MS - 11_000);
    expect(host.roster.get(guest.selfId)).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.roster.get(guest.selfId)).toBeFalsy();
  });

  it('keeps dialing while the guest is offline, instead of giving the host up after a few quick failures', async () => {
    const { host, guest, link } = await twoPartyCall();
    const guestEvents = record(guest, ['peer-left', 'peer-joined', 'host-migrating', 'host-changed', 'peer-link']);
    const hostEvents = record(host, ['peer-left', 'peer-joined']);

    // The guest's machine is off the network for a while — a Wi‑Fi switch,
    // a laptop waking up. Every dial fails at once until it is back.
    puter.peer._offline = true;
    killTransport(link);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(guest.roster.size).toBe(2);
    expect(guest.isHost).toBe(false);
    expect(guest.roster.get(host.selfId).reconnecting).toBe(true);
    puter.peer._offline = false;

    await until(() => puter.peer._pairs.length === 2 && !guest.roster.get(host.selfId)?.reconnecting);
    bringUp(puter.peer._pairs[1]);
    await settle();

    expect(guest.isHost).toBe(false);
    expect(guest.hostId).toBe(host.selfId);
    expect([host, guest].map((s) => s.roster.size)).toEqual([2, 2]);
    expect(guestEvents.filter((e) => e.type !== 'peer-link')).toEqual([]);
    expect(hostEvents).toEqual([]);
    expect(guestEvents.filter((e) => e.type === 'peer-link').map((e) => e.state)).toEqual(['lost', 'connected']);
  });

  it('gives the host up once the redial window has passed with the network still down', async () => {
    const { host, guest, link } = await twoPartyCall();
    puter.peer._offline = true;
    killTransport(link, { sides: ['dialer'] });
    await until(() => guest.isHost, { max: 90_000 });
    expect(guest.roster.size).toBe(1);
    void host;
  });

  it('lets a guest that cannot get back treat the host as gone', async () => {
    const { host, guest, link, code } = await twoPartyCall();
    const guestEvents = record(guest, ['host-migrating', 'host-changed', 'peer-left']);

    // The host's server is unreachable now (its machine dropped off the
    // network), though its connection to us never said so.
    puter.peer._registry.get(code).closed = true;
    killTransport(link, { sides: ['dialer'] });

    await until(() => guest.isHost);
    expect(guest.roster.size).toBe(1);
    expect(guestEvents.filter((e) => e.type === 'peer-left').map((e) => e.reason)).toEqual(['connection lost']);
    expect(guestEvents.some((e) => e.type === 'host-changed' && e.self)).toBe(true);
    void host;
  });
});

describe('a guest<->guest link that dies under a three-person call', () => {
  it('is served again by the same side and rejoined by the other', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    const g2 = makeSession('Two');
    const j1 = g1.join(code);
    await until(() => host.roster.size === 2);
    await j1;
    const j2 = g2.join(code);
    await until(() => [host, g1, g2].every((s) => s.roster.size === 3));
    await j2;
    // host<->g1, host<->g2, then the direct g1<->g2 link.
    await until(() => puter.peer._pairs.length === 3);
    await until(() => g1.connectedPeerIds().includes(g2.selfId) && g2.connectedPeerIds().includes(g1.selfId));
    for (const pair of puter.peer._pairs) bringUp(pair);
    await settle();

    const direct = puter.peer._pairs[2];
    const events1 = record(g1, ['peer-left', 'peer-joined', 'peer-link']);
    const events2 = record(g2, ['peer-left', 'peer-joined', 'peer-link']);
    const hostEvents = record(host, ['peer-left', 'peer-joined']);

    killTransport(direct);

    await until(() => puter.peer._pairs.length === 4);
    const fresh = puter.peer._pairs[3];
    bringUp(fresh);
    await until(() => g1.connectedPeerIds().includes(g2.selfId) && g2.connectedPeerIds().includes(g1.selfId));
    await until(() => !g1.roster.get(g2.selfId).reconnecting && !g2.roster.get(g1.selfId).reconnecting);

    // The meeting never saw anyone leave; the host's links were untouched.
    expect([host, g1, g2].map((s) => s.roster.size)).toEqual([3, 3, 3]);
    expect(hostEvents).toEqual([]);
    expect(events1.filter((e) => e.type !== 'peer-link')).toEqual([]);
    expect(events2.filter((e) => e.type !== 'peer-link')).toEqual([]);
    expect(events1.filter((e) => e.type === 'peer-link').map((e) => e.state)).toEqual(['lost', 'connected']);
    expect(events2.filter((e) => e.type === 'peer-link').map((e) => e.state)).toEqual(['lost', 'connected']);

    // Media is flowing on the new direct link.
    expect(fresh.dialer.peerconnection.senders.length).toBeGreaterThan(0);
    expect(fresh.listener.peerconnection.senders.length).toBeGreaterThan(0);
    expect(direct.dialer.closed).toBe(true);
    expect(direct.listener.closed).toBe(true);
  });
});

describe('a guest whose whole network blips in a three-person call', () => {
  async function threePartyCall() {
    const host = makeSession('Host');
    host.selfId = 'host-0000';
    const code = await host.host();
    const low = makeSession('Low');
    low.selfId = 'a-low';
    const high = makeSession('High');
    high.selfId = 'b-high';
    const j1 = low.join(code);
    await until(() => host.roster.size === 2);
    await j1;
    const j2 = high.join(code);
    await until(() => [host, low, high].every((s) => s.roster.size === 3));
    await j2;
    await until(() => puter.peer._pairs.length === 3);
    await until(() => low.connectedPeerIds().includes(high.selfId) && high.connectedPeerIds().includes(low.selfId));
    for (const pair of puter.peer._pairs) bringUp(pair);
    await settle();
    // host<->low, host<->high, then the direct low<->high link (served by low).
    return { host, low, high, code, hostHigh: puter.peer._pairs[1], direct: puter.peer._pairs[2] };
  }

  /** Both of the guest's links die, and they cannot dial anyone for a while. */
  async function blip(pairs, ms) {
    puter.peer._offline = true;
    for (const pair of pairs) killTransport(pair);
    await vi.advanceTimersByTimeAsync(ms);
    puter.peer._offline = false;
  }

  async function reconnected(low, high, host) {
    await until(() => !high.roster.get(host.selfId)?.reconnecting, { max: 60_000 });
    await until(
      () => low.connectedPeerIds().includes(high.selfId) && high.connectedPeerIds().includes(low.selfId),
      { max: 60_000 }
    );
    for (const pair of puter.peer._pairs) if (!pair.dialer.closed) bringUp(pair);
    await until(() => !low.roster.get(high.selfId).reconnecting && !high.roster.get(low.selfId).reconnecting);
  }

  it('gets both links back — including the one the other guest serves, whose invite was lost', async () => {
    const { host, low, high, hostHigh, direct } = await threePartyCall();
    const lowEvents = record(low, ['peer-left', 'peer-joined']);
    const highEvents = record(high, ['peer-left', 'peer-joined', 'host-migrating']);

    // The higher-id guest — the one that cannot serve the direct link.
    await blip([hostHigh, direct], 6_000);
    await reconnected(low, high, host);

    expect([host, low, high].map((s) => s.roster.size)).toEqual([3, 3, 3]);
    expect(lowEvents).toEqual([]);
    expect(highEvents).toEqual([]);
    expect(low.connectedPeerIds().sort()).toEqual([high.selfId, host.selfId].sort());
    expect(high.connectedPeerIds().sort()).toEqual([low.selfId, host.selfId].sort());
  });

  it('holds the last frame over a lost direct link until the rebuilt one takes over', async () => {
    const { low, high, direct } = await threePartyCall();
    // Low's camera arrived at High over the direct link (High dialed it).
    const stream = arriveCamera(direct.dialer, low);
    await settle();
    expect(high.getStream(low.selfId)).toBe(stream);
    const removed = [];
    high.on('stream-removed', (e) => removed.push(e.kind));

    killTransport(direct);
    await until(() => high.roster.get(low.selfId).reconnecting);
    expect(high.getStream(low.selfId)).toBe(stream);
    expect(removed).toEqual([]);

    await until(() => high.connectedPeerIds().includes(low.selfId) && !high.roster.get(low.selfId).reconnecting, {
      max: 60_000,
    });
    expect(removed).toEqual(['camera']);
    expect(high.getStream(low.selfId)).not.toBe(stream);
  });

  it('gets both links back when it is the serving guest that blipped', async () => {
    const { host, low, high, direct } = await threePartyCall();
    const hostLow = puter.peer._pairs[0];
    await blip([hostLow, direct], 6_000);
    await until(() => !low.roster.get(host.selfId)?.reconnecting, { max: 60_000 });
    await reconnected(low, high, host);
    expect([host, low, high].map((s) => s.roster.size)).toEqual([3, 3, 3]);
  });

  it('carries the state a returning guest changed while out of reach to the other guests', async () => {
    const { host, low, high, hostHigh, direct } = await threePartyCall();
    expect(low.roster.get(high.selfId).mic).toBe(true);

    puter.peer._offline = true;
    killTransport(hostHigh);
    killTransport(direct);
    await vi.advanceTimersByTimeAsync(3_000);
    // Muted and raised a hand while nothing could get through.
    high.setHand(true);
    puter.peer._offline = false;
    await reconnected(low, high, host);

    expect(low.roster.get(high.selfId).hand).toBe(true);
    expect(host.roster.get(high.selfId).hand).toBe(true);
  });

  it('drops a guest who left while the returning guest was out of reach', async () => {
    const { host, low, high, hostHigh, direct } = await threePartyCall();
    const highEvents = record(high, ['peer-left']);

    puter.peer._offline = true;
    killTransport(hostHigh);
    killTransport(direct);
    await vi.advanceTimersByTimeAsync(3_000);
    // Their goodbye, and the host's PEER_LEFT, both go over dead links.
    low.leave();
    await settle();
    expect(host.roster.size).toBe(2);
    expect(high.roster.size).toBe(3);
    puter.peer._offline = false;

    await until(() => !high.roster.get(host.selfId)?.reconnecting, { max: 60_000 });
    await settle();
    expect(high.roster.size).toBe(2);
    expect(high.roster.has(low.selfId)).toBe(false);
    expect(highEvents.map((e) => e.participant.id)).toEqual([low.selfId]);
  });

  it('takes the state the others changed while it was out of reach from the WELCOME', async () => {
    const { host, low, high, hostHigh, direct } = await threePartyCall();
    puter.peer._offline = true;
    killTransport(hostHigh);
    killTransport(direct);
    await vi.advanceTimersByTimeAsync(3_000);
    low.setHand(true);
    await settle();
    expect(host.roster.get(low.selfId).hand).toBe(true);
    expect(high.roster.get(low.selfId).hand).toBe(false);
    puter.peer._offline = false;

    await reconnected(low, high, host);
    expect(high.roster.get(low.selfId).hand).toBe(true);
  });

  it('tries a direct link again when an attempt comes to nothing, while the peer is still in the meeting', async () => {
    const { low, high, direct } = await threePartyCall();
    const before = puter.peer._pairs.length;

    // The direct link dies while the far end cannot connect to anything;
    // the invite the serving side sends goes unanswered until it times out.
    puter.peer._offline = true;
    killTransport(direct);
    await until(() => !low.connectedPeerIds().includes(high.selfId));
    await vi.advanceTimersByTimeAsync(20_000 + 100); // DIRECT_LINK_TIMEOUT_MS
    expect(low.connectedPeerIds().includes(high.selfId)).toBe(false);
    puter.peer._offline = false;

    // The serving side comes back for another go rather than giving up.
    await until(() => low.connectedPeerIds().includes(high.selfId) && high.connectedPeerIds().includes(low.selfId), {
      max: 60_000,
    });
    expect(puter.peer._pairs.length).toBeGreaterThan(before);
    for (const pair of puter.peer._pairs) if (!pair.dialer.closed) bringUp(pair);
    await until(() => !low.roster.get(high.selfId).reconnecting && !high.roster.get(low.selfId).reconnecting);
  });
});

describe('a HELLO for an id already in the meeting', () => {
  /** Someone dials the room afresh and introduces themselves as `victim`. */
  async function rogueHello(code, victim, { token = '' } = {}) {
    const rogue = await puter.peer.connect(code);
    await settle();
    rogue.send(P.encode(P.makeHello(P.makeIdentity({ id: victim.selfId, name: 'Someone else', mic: true, cam: true }), token)));
    await settle();
    return rogue;
  }

  it('is turned away unless it carries that participant\'s secret — nobody is evicted or renamed', async () => {
    const { host, guest, code, link } = await twoPartyCall();
    const guestEvents = record(guest, ['peer-left', 'host-migrating', 'host-changed', 'peer-link']);
    const hostEvents = record(host, ['peer-left', 'peer-joined', 'peer-link']);

    const rogue = await rogueHello(code, guest);
    expect(rogue.closed).toBe(true);
    const wrong = await rogueHello(code, guest, { token: 'not-theirs' });
    expect(wrong.closed).toBe(true);

    // The real guest was never touched.
    expect(link.dialer.closed).toBe(false);
    expect(host.roster.get(guest.selfId).name).toBe('Guest');
    expect(host.connectedPeerIds()).toEqual([guest.selfId]);
    expect(guestEvents).toEqual([]);
    expect(hostEvents).toEqual([]);

    // Whereas the guest itself still gets back in after a loss (its HELLO carries the secret).
    killTransport(link);
    await until(() => puter.peer._pairs.length === 4 && !guest.roster.get(host.selfId)?.reconnecting);
    expect(host.roster.size).toBe(2);
    expect(hostEvents.filter((e) => e.type !== 'peer-link')).toEqual([]);
  });

  it('is turned away by a host that took over, whose link to the participant never carried a HELLO', async () => {
    const host = makeSession('Host');
    host.selfId = 'host-0000';
    const code = await host.host();
    const low = makeSession('Low');
    low.selfId = 'a-low';
    const high = makeSession('High');
    high.selfId = 'b-high';
    const j1 = low.join(code);
    await until(() => host.roster.size === 2);
    await j1;
    const j2 = high.join(code);
    await until(() => [host, low, high].every((s) => s.roster.size === 3));
    await j2;
    await until(() => low.connectedPeerIds().includes(high.selfId) && high.connectedPeerIds().includes(low.selfId));
    for (const pair of puter.peer._pairs) bringUp(pair);
    await settle();

    // The host leaves; Low takes over and High's direct link to Low becomes its host link.
    host.leave();
    await until(() => low.isHost && high.hostId === low.selfId && low.code && low.code !== code, { max: 20_000 });
    await settle();
    expect(low.connectedPeerIds()).toEqual([high.selfId]);
    const highEvents = record(high, ['peer-left', 'host-migrating', 'host-changed']);
    const lowEvents = record(low, ['peer-left', 'peer-joined']);

    const rogue = await rogueHello(low.code, high);
    expect(rogue.closed).toBe(true);
    expect(low.roster.get(high.selfId).name).toBe('High');
    expect(low.connectedPeerIds()).toEqual([high.selfId]);
    expect(highEvents).toEqual([]);
    expect(lowEvents).toEqual([]);

    // High itself can still come back to Low after a loss.
    const promoted = puter.peer._pairs.find((p) => !p.dialer.closed && p.inviteCode !== code && p.inviteCode !== low.code);
    expect(promoted).toBeTruthy();
    const before = puter.peer._pairs.length;
    killTransport(promoted);
    await until(() => puter.peer._pairs.length > before && !high.roster.get(low.selfId)?.reconnecting, { max: 60_000 });
    expect(low.roster.size).toBe(2);
    expect(high.roster.size).toBe(2);
    expect(lowEvents).toEqual([]);
    expect(highEvents).toEqual([]);
  });
});

describe('a survivor with no link to the host that takes over', () => {
  /**
   * Four parties whose mesh is missing one link: A (the lowest id, so the
   * one to take over) and C have lost their direct link and cannot get it
   * back, while every other link is fine. The claim then reaches C only
   * through B, and C has nothing to promote — it has to dial A's room.
   */
  async function meshMissingAC() {
    const host = makeSession('Host');
    host.selfId = 'host-0000';
    const code = await host.host();
    const a = makeSession('A');
    a.selfId = 'a-0001';
    const b = makeSession('B');
    b.selfId = 'b-0002';
    const c = makeSession('C');
    c.selfId = 'c-0003';
    for (const g of [a, b, c]) {
      const j = g.join(code);
      await until(() => host.roster.size === [a, b, c].indexOf(g) + 2);
      await j;
    }
    await until(() => [a, b, c].every((s) => s.connectedPeerIds().length === 3), { max: 30_000 });
    for (const pair of puter.peer._pairs) bringUp(pair);
    await settle();

    // Servers stood up from here on cannot be reached, so the A<->C link
    // A re-serves never forms again; the room A serves later is let through.
    const realServe = puter.peer.serve;
    const realConnect = puter.peer.connect;
    const unreachable = new Set();
    const servers = [];
    let blockNewServers = true;
    puter.peer.serve = async () => {
      const server = await realServe();
      servers.push(server);
      if (blockNewServers) unreachable.add(server.inviteCode);
      return server;
    };
    puter.peer.connect = async (invite) => {
      if (unreachable.has(invite)) throw new Error('unreachable');
      return realConnect(invite);
    };

    // host<->A, host<->B, A<->B, host<->C, A<->C, B<->C — checked, not assumed.
    const ac = puter.peer._pairs[4];
    killTransport(ac);
    expect(c.connectedPeerIds().includes(a.selfId)).toBe(false);
    expect(b.connectedPeerIds().sort()).toEqual([a.selfId, c.selfId, host.selfId].sort());
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.connectedPeerIds().includes(a.selfId)).toBe(false);
    expect(c.roster.has(a.selfId)).toBe(true);
    blockNewServers = false;

    return { host, a, b, c, code, servers, unreachable };
  }

  it('is put onto the new host in place — nobody joins, and their place in the roster is kept', async () => {
    const { host, a, b, c } = await meshMissingAC();
    const cEvents = record(c, ['peer-left', 'peer-joined', 'host-changed', 'peer-link']);
    const aEvents = record(a, ['peer-left', 'peer-joined', 'peer-link']);
    const orderBefore = c.roster.sorted().map((p) => p.id);

    host.leave();
    await until(() => a.isHost, { max: 20_000 });
    await until(() => c.connectedPeerIds().includes(a.selfId) && c.hostId === a.selfId, { max: 20_000 });
    await settle();

    // Only the host that left is gone; A was there the whole time.
    expect(cEvents.filter((e) => e.type === 'peer-left').map((e) => e.participant.id)).toEqual([host.selfId]);
    expect(cEvents.filter((e) => e.type === 'peer-joined')).toEqual([]);
    expect(aEvents.filter((e) => e.type === 'peer-joined')).toEqual([]);
    expect(c.roster.sorted().map((p) => p.id)).toEqual(orderBefore.filter((id) => id !== host.selfId));
    expect([a, b, c].map((s) => s.roster.size)).toEqual([3, 3, 3]);
    // And the link C had marked as being rebuilt is reported back.
    expect(c.roster.get(a.selfId).reconnecting).toBe(false);
    expect(cEvents.filter((e) => e.type === 'peer-link').at(-1)).toMatchObject({ peerId: a.selfId, state: 'connected' });
    // A, which had no link to C when it took over, showed C as reconnecting
    // until C dialed in — and did not give them up meanwhile.
    expect(aEvents.filter((e) => e.type === 'peer-left').map((e) => e.participant.id)).toEqual([host.selfId]);
    expect(a.roster.get(c.selfId).reconnecting).toBe(false);
    expect(aEvents.filter((e) => e.type === 'peer-link' && e.peerId === c.selfId).at(-1)).toMatchObject({
      state: 'connected',
    });
  });

  it('drops the new host from its roster if its room cannot be reached, rather than keeping a ghost', async () => {
    const { host, a, c, servers, unreachable } = await meshMissingAC();
    const cEvents = record(c, ['peer-left', 'peer-joined']);
    // A's room comes up fine, but C cannot get to it.
    const served = servers.length;
    puter.peer.serve = (function (inner) {
      return async () => {
        const server = await inner();
        if (servers.length > served) unreachable.add(server.inviteCode);
        return server;
      };
    })(puter.peer.serve);

    host.leave();
    await until(() => a.isHost && a.code !== null, { max: 20_000 });
    await until(() => !c.roster.has(a.selfId), { max: 60_000 });

    expect(cEvents.filter((e) => e.type === 'peer-left').map((e) => [e.participant.id, e.reason])).toEqual([
      [host.selfId, 'left'],
      [a.selfId, 'unreachable'],
    ]);
    expect(cEvents.filter((e) => e.type === 'peer-joined')).toEqual([]);
  });

  it('is given up by the new host if it never reaches its room, rather than listed as a ghost for good', async () => {
    const { host, a, c, servers, unreachable } = await meshMissingAC();
    const served = servers.length;
    puter.peer.serve = (function (inner) {
      return async () => {
        const server = await inner();
        if (servers.length > served) unreachable.add(server.inviteCode);
        return server;
      };
    })(puter.peer.serve);

    const aEvents = record(a, ['peer-left', 'peer-link']);

    host.leave();
    await until(() => a.isHost && a.code !== null, { max: 20_000 });
    await until(() => !c.roster.has(a.selfId), { max: 60_000 });
    // C has given A up. A still lists C — shown as reconnecting, since A has
    // no link to them — and waits a while for them to dial in...
    expect(a.roster.get(c.selfId)?.reconnecting).toBe(true);
    // ...but not forever: a ghost would inflate the count and hold a
    // blank tile.
    await until(() => !a.roster.has(c.selfId), { max: 120_000 });
    expect(aEvents.filter((e) => e.type === 'peer-left').map((e) => [e.participant.id, e.reason])).toEqual([
      [host.selfId, 'left'],
      [c.selfId, 'connection lost'],
    ]);
    expect(a.roster.size).toBe(2); // A and B
  });
});

describe('chat sent while a link is being rebuilt', () => {
  it('reaches the host once the guest is back, and not before', async () => {
    const { host, guest, link } = await twoPartyCall();
    const atHost = [];
    host.on('chat', (m) => atHost.push(m.text));
    const atGuest = [];
    guest.on('chat', (m) => atGuest.push(m));

    // The guest is off the network for a while, so nothing can be rebuilt yet.
    puter.peer._offline = true;
    killTransport(link);
    await until(() => guest.roster.get(host.selfId).reconnecting);
    // Typed while nothing could get through; the guest sees it in its own
    // chat at once, as ever.
    guest.sendChat('are you there?');
    guest.sendReaction('👋'); // ephemeral — not worth delivering late
    await vi.advanceTimersByTimeAsync(5_000);
    expect(atGuest.map((m) => m.text)).toEqual(['are you there?']);
    expect(atHost).toEqual([]);
    puter.peer._offline = false;

    await until(() => puter.peer._pairs.length === 2 && !guest.roster.get(host.selfId)?.reconnecting);
    await settle();
    expect(atHost).toEqual(['are you there?']);
  });

  it('reaches a guest who was out of reach once they are back — from the host and from the other guests', async () => {
    const host = makeSession('Host');
    host.selfId = 'host-0000';
    const code = await host.host();
    const low = makeSession('Low');
    low.selfId = 'a-low';
    const high = makeSession('High');
    high.selfId = 'b-high';
    const j1 = low.join(code);
    await until(() => host.roster.size === 2);
    await j1;
    const j2 = high.join(code);
    await until(() => [host, low, high].every((s) => s.roster.size === 3));
    await j2;
    await until(() => low.connectedPeerIds().includes(high.selfId) && high.connectedPeerIds().includes(low.selfId));
    for (const pair of puter.peer._pairs) bringUp(pair);
    await settle();
    const hostHigh = puter.peer._pairs[1];
    const direct = puter.peer._pairs[2];
    const atHigh = [];
    high.on('chat', (m) => atHigh.push(`${m.name}: ${m.text}`));

    puter.peer._offline = true;
    killTransport(hostHigh);
    killTransport(direct);
    await until(() => host.roster.get(high.selfId).reconnecting && low.roster.get(high.selfId).reconnecting);
    host.sendChat('everyone still here?');
    low.sendChat('I am');
    await settle();
    expect(atHigh).toEqual([]);
    puter.peer._offline = false;

    await until(() => !high.roster.get(host.selfId)?.reconnecting, { max: 60_000 });
    await settle();
    expect(atHigh).toEqual(['Host: everyone still here?', 'Low: I am']);
  });

  it('sent into a host link that is dying, still reaches everyone — once — after a new host takes over', async () => {
    const host = makeSession('Host');
    host.selfId = 'host-0000';
    const code = await host.host();
    const low = makeSession('Low');
    low.selfId = 'a-low';
    const high = makeSession('High');
    high.selfId = 'b-high';
    const j1 = low.join(code);
    await until(() => host.roster.size === 2);
    await j1;
    const j2 = high.join(code);
    await until(() => [host, low, high].every((s) => s.roster.size === 3));
    await j2;
    await until(() => low.connectedPeerIds().includes(high.selfId) && high.connectedPeerIds().includes(low.selfId));
    for (const pair of puter.peer._pairs) bringUp(pair);
    await settle();
    const heard = { low: [], high: [] };
    low.on('chat', (m) => heard.low.push(`${m.name}: ${m.text}`));
    high.on('chat', (m) => heard.high.push(`${m.name}: ${m.text}`));

    // The host drops off the network. Its links still read open for a while
    // and take what is sent on them — into a transport that is gone.
    const hostLinks = puter.peer._pairs.filter((pair) => pair.inviteCode === code);
    expect(hostLinks).toHaveLength(2);
    for (const pair of hostLinks) pair.dialer.transportDead = pair.listener.transportDead = true;
    puter.peer._registry.delete(code); // nothing reaches its invite either
    low.sendChat('anyone?');
    high.sendChat('hello?');
    await settle();
    expect(heard.low).toEqual(['Low: anyone?']);
    expect(heard.high).toEqual(['High: hello?']);

    // The browsers notice, puter.peer gives the links up, and the guests
    // elect a successor.
    for (const pair of hostLinks) pair.dialer.peerconnection.setConnectionState('disconnected');
    await vi.advanceTimersByTimeAsync(10_000);
    for (const pair of hostLinks) pair.dialer.giveUp('the peer is no longer reachable');
    await until(() => low.isHost && high.hostId === low.selfId, { max: 120_000 });
    await until(() => heard.low.includes('High: hello?') && heard.high.includes('Low: anyone?'), { max: 30_000 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(heard.low.sort()).toEqual(['High: hello?', 'Low: anyone?']);
    expect(heard.high.sort()).toEqual(['High: hello?', 'Low: anyone?']);
  });

  it('is shown once, however often it is sent again', async () => {
    const { host, guest, link } = await twoPartyCall();
    const atHost = [];
    host.on('chat', (m) => atHost.push(m.text));

    // The link wobbles and heals in place twice; each time the guest sends
    // its chat from the wobble again.
    guest.sendChat('one');
    for (let i = 0; i < 2; i++) {
      link.dialer.peerconnection.setConnectionState('disconnected');
      link.listener.peerconnection.setConnectionState('disconnected');
      await vi.advanceTimersByTimeAsync(2_000);
      link.dialer.peerconnection.setConnectionState('connected');
      link.listener.peerconnection.setConnectionState('connected');
      await settle();
    }
    expect(atHost).toEqual(['one']);
  });

  it('is let go of when the meeting is left instead', async () => {
    const { host, guest, link } = await twoPartyCall();
    const atHost = [];
    host.on('chat', (m) => atHost.push(m.text));
    killTransport(link);
    await until(() => guest.roster.get(host.selfId).reconnecting);
    guest.sendChat('never mind');
    guest.leave();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(atHost).toEqual([]);
  });
});

describe('a newcomer to a call', () => {
  it('is welcomed with the state the others are in now, not the state they joined in', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const first = makeSession('First');
    const j1 = first.join(code);
    await until(() => host.roster.size === 2);
    await j1;
    first.setHand(true);
    await settle();
    expect(host.roster.get(first.selfId).hand).toBe(true);

    const second = makeSession('Second');
    const j2 = second.join(code);
    await until(() => second.roster.size === 3);
    await j2;
    expect(second.roster.get(first.selfId).hand).toBe(true);
  });
});
