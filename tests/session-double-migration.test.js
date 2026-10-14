import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RoomSession } from '../src/net/session.js';

/* Same in-memory Puter peer mock as session.test.js — trimmed to what the
 * double-migration repro needs. */

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

function mockStreamTracks(stream) {
  if (!stream) return [];
  if (typeof stream.getTracks === 'function') return stream.getTracks();
  return [...(stream.getAudioTracks?.() ?? []), ...(stream.getVideoTracks?.() ?? [])];
}

class MockConn extends MockEventTarget {
  peer = null;
  isOpen = false;
  closed = false;
  publications = new Map();
  media = new Map();
  #pc = null;

  get peerconnection() {
    return this.#pc;
  }

  set peerconnection(pc) {
    this.#pc = pc;
    this.#watchTransport(pc);
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

  static pair() {
    const a = new MockConn();
    const b = new MockConn();
    a.peer = b;
    b.peer = a;
    a.peerconnection = new FakeRTCPeerConnection();
    b.peerconnection = new FakeRTCPeerConnection();
    return [a, b];
  }

  open() {
    if (this.closed) return;
    this.isOpen = true;
    this.dispatch('open', {});
  }

  send(data) {
    if (!this.isOpen || this.closed) throw new Error('connection not open');
    const remote = this.peer;
    queueMicrotask(() => {
      if (!remote.closed) remote.dispatch('message', { data });
    });
  }


  // -- named media slots --

  publish(name, stream) {
    this.publications.set(name, stream);
    const tracks = mockStreamTracks(stream);
    for (const track of tracks) this.peerconnection?.addTrack?.(track);
    if (this.closed) return;
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
    if (this.closed) return;
    const remote = this.peer;
    queueMicrotask(() => {
      if (!remote || remote.closed) return;
      remote.media.delete(name);
      remote.dispatch('mediaended', { name, stream });
    });
  }

  configure() {}

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.peerconnection?.close();
    const remote = this.peer;
    queueMicrotask(() => {
      if (remote && !remote.closed) {
        remote.closed = true;
        remote.peerconnection?.close();
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
  return {
    peer: {
      _pairs: pairs,
      serve: async () => {
        const server = new MockServer();
        registry.set(server.inviteCode, server);
        return server;
      },
      connect: async (inviteCode, opts) => {
        const server = registry.get(inviteCode);
        if (!server || server.closed) throw new Error('no such meeting');
        const [dialer, listener] = MockConn.pair();
        pairs.push({ dialer, listener });
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
}

class FakeRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.appliedParams = [];
    this.senders = [];
    this.listeners = new Map();
  }
  addEventListener() {}
  removeEventListener() {}
  addTrack(track) {
    if (this.signalingState === 'closed') {
      const err = new Error("addTrack on closed pc");
      err.name = 'InvalidStateError';
      throw err;
    }
    const pc = this;
    const sender = {
      track,
      replaceTrack: async (nextTrack) => {
        sender.track = nextTrack;
      },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async (params) => {
        pc.appliedParams.push(params);
      },
    };
    pc.senders.push(sender);
    return sender;
  }
  removeTrack() {}
  getConfiguration() {
    return this.config ?? {};
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  restartIce() {}
  close() {
    this.signalingState = 'closed';
  }
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

async function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let savedWindow;
let savedRTC;

beforeAll(() => {
  savedWindow = globalThis.window;
  savedRTC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection;
});

afterAll(() => {
  globalThis.window = savedWindow;
  globalThis.RTCPeerConnection = savedRTC;
});

beforeEach(() => {
  globalThis.window = { puter: installMockPuter() };
});

const sessions = [];
function makeSession(name) {
  const s = new RoomSession({ media: fakeMedia(), name });
  sessions.push(s);
  return s;
}

afterAll(() => {
  for (const s of sessions) {
    try {
      s.leave();
    } catch {
      /* already gone */
    }
  }
});

describe('double host migration (user repro)', () => {
  it('2p: Alice hosts, leaves; Bob hosts; Alice rejoins; Bob leaves; Alice hosts; Bob rejoins', async () => {
    // Alice starts the meeting, Bob joins.
    const alice1 = makeSession('Alice');
    const code1 = await alice1.host();
    const bob = makeSession('Bob');
    await bob.join(code1);
    await waitFor(() => alice1.roster.size === 2 && bob.roster.size === 2, 3000, 'initial join');

    const bobCodes = [];
    bob.on('code-changed', ({ code }) => bobCodes.push(code));
    const bobEnded = [];
    bob.on('ended', ({ reason }) => bobEnded.push(reason));

    // Migration 1: Alice leaves, Bob takes over with a fresh invite.
    alice1.leave();
    await waitFor(() => bob.isHost && bobCodes.length === 1, 3000, 'bob takes over');
    expect(bobEnded).toEqual([]);
    const code2 = bobCodes[0];
    expect(code2).not.toBe(code1);

    // Alice comes back (new session, like a fresh tab/lobby join).
    const alice2 = makeSession('Alice');
    await alice2.join(code2);
    await waitFor(() => bob.roster.size === 2 && alice2.roster.size === 2, 3000, 'alice rejoins');

    const aliceCodes = [];
    alice2.on('code-changed', ({ code }) => aliceCodes.push(code));
    const aliceEnded = [];
    alice2.on('ended', ({ reason }) => aliceEnded.push(reason));

    // Migration 2: Bob leaves, Alice should take over with a fresh invite.
    bob.leave();
    await waitFor(() => alice2.isHost, 3000, 'alice takes over');
    await waitFor(() => aliceCodes.length === 1, 3000, 'alice serves a fresh invite');
    expect(aliceEnded).toEqual([]);
    const code3 = aliceCodes[0];
    expect(code3).not.toBe(code2);
    expect(alice2.roster.size).toBe(1);

    // Bob comes back through the newest invite.
    const bob2 = makeSession('Bob');
    await bob2.join(code3);
    await waitFor(() => alice2.roster.size === 2 && bob2.roster.size === 2, 3000, 'bob rejoins');
    expect(bob2.roster.get(alice2.selfId).name).toBe('Alice');
  });

  it('3p: two consecutive migrations with a rejoiner in between converge', async () => {
    const alice1 = makeSession('Alice');
    const code1 = await alice1.host();
    const bob = makeSession('Bob');
    await bob.join(code1);
    const carol = makeSession('Carol');
    await carol.join(code1);
    await waitFor(() => [alice1, bob, carol].every((s) => s.roster.size === 3), 4000, '3p mesh');
    await waitFor(
      () => bob.connectedPeerIds().length === 2 && carol.connectedPeerIds().length === 2,
      4000,
      'guest<->guest links up'
    );

    const codes = new Map(); // session -> last announced code
    for (const s of [bob, carol]) s.on('code-changed', ({ code }) => codes.set(s, code));
    const endedReasons = [];
    for (const s of [bob, carol]) s.on('ended', ({ reason }) => endedReasons.push(reason));

    // Migration 1: Alice (original host) leaves.
    alice1.leave();
    const [lo, hi] = [bob, carol].sort((a, b) => (a.selfId < b.selfId ? -1 : 1));
    await waitFor(() => lo.isHost && hi.hostId === lo.selfId, 5000, 'first successor claims');
    await waitFor(() => codes.get(lo), 3000, 'first successor serves');
    expect(endedReasons).toEqual([]);

    // Alice rejoins through the new invite.
    const alice2 = makeSession('Alice');
    await alice2.join(codes.get(lo));
    await waitFor(() => [lo, hi, alice2].every((s) => s.roster.size === 3), 5000, 'alice back, 3p again');
    await waitFor(
      () => alice2.connectedPeerIds().length === 2,
      5000,
      'alice2 linked to both survivors'
    );
    alice2.on('code-changed', ({ code }) => codes.set(alice2, code));
    alice2.on('ended', ({ reason }) => endedReasons.push(reason));

    // Migration 2: the current host (lo) leaves.
    lo.leave();
    const survivors = [hi, alice2];
    const [lo2, hi2] = survivors.sort((a, b) => (a.selfId < b.selfId ? -1 : 1));
    await waitFor(() => lo2.isHost && hi2.hostId === lo2.selfId, 8000, 'second successor claims');
    await waitFor(() => codes.get(lo2), 3000, 'second successor serves');
    expect(endedReasons).toEqual([]);
    expect(lo2.roster.size).toBe(2);
    expect(hi2.roster.size).toBe(2);

    // The departed second host rejoins through the newest invite.
    const back = makeSession('Returnee');
    await back.join(codes.get(lo2));
    await waitFor(() => back.roster.size === 3 && lo2.roster.size === 3, 5000, 'returnee joins');

    // Chat still flows end to end.
    const seen = [];
    hi2.on('chat', ({ text }) => seen.push(text));
    back.on('chat', ({ text }) => seen.push(text));
    lo2.sendChat('all good?');
    await waitFor(() => seen.length === 2, 3000, 'chat relays to everyone');
  });
});
