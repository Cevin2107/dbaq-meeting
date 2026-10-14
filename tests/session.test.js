import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  RoomSession,
  SELF_PROBE_INTERVAL_MS,
  SELF_PROBE_SEEN_TIMEOUT_MS,
  GRANT_RETRY_BACKOFF_MS,
  isInvalidInviteError,
  isSignallerUnreachableError,
} from '../src/net/session.js';
import { LINK_RECOVERY_BUDGET_MS } from '../src/net/rtc.js';
import * as P from '../src/lib/protocol.js';

/* ------------------------------------------------------------------ *
 * In-memory mock of the Puter Peer API + just enough WebRTC surface   *
 * for RoomSession's mesh logic to run under node.                     *
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

function mockStreamTracks(stream) {
  if (!stream) return [];
  if (typeof stream.getTracks === 'function') return stream.getTracks();
  return [...(stream.getAudioTracks?.() ?? []), ...(stream.getVideoTracks?.() ?? [])];
}

class MockConn extends MockEventTarget {
  peer = null; // the other end
  isOpen = false;
  closed = false;
  publications = new Map();
  media = new Map();
  #senders = new Map();
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
      if (remote && !remote.closed) remote.dispatch('message', { data });
    });
  }


  // -- named media slots --

  publish(name, stream, options) {
    this.publications.set(name, stream);
    const tracks = mockStreamTracks(stream);
    let senders = this.#senders.get(name);
    if (!senders) this.#senders.set(name, (senders = []));
    if (!senders.length) {
      for (const track of tracks) {
        const sender = this.peerconnection?.addTrack?.(track);
        if (sender) senders.push(sender);
      }
    }
    if (options) this.configure(name, options);
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

  /** Mirrors the SDK: remembered limits land on the named slot's senders. */
  configure(name, options) {
    const cfg = options?.video;
    if (!cfg) return;
    for (const sender of this.#senders.get(name) ?? []) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      const { degradationPreference, ...encoding } = cfg;
      Object.assign(params.encodings[0], encoding);
      if (degradationPreference) params.degradationPreference = degradationPreference;
      sender.setParameters(params);
    }
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    // Mirror puter's Zn.#O(): closing a connection closes its underlying
    // RTCPeerConnection (and the far end's, once the datachannel close
    // propagates).
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
  // Mirror puter's Kn: the server tracks every accepted connection...
  connections = new Set();
  close() {
    this.closed = true;
    // ...and close() tears each one down (which closes its RTCPeerConnection).
    for (const conn of this.connections) conn.close('server-closed');
    this.connections.clear();
  }
}

function installMockPuter() {
  const registry = new Map();
  const pairs = [];
  // Who is signed in is a property of the page, not of a session, so tests
  // flip it around the host()/join() call that reads it (see asAnonymous).
  const state = { signedIn: true, grants: 0 };
  const calls = []; // every serve()/connect(), with the options it was given
  // Invites the signaller answers with "Invalid invite code" outright (what
  // the real one says for a code whose socket is gone), as opposed to ones
  // a dial of simply never comes back from (the registry lookup failing).
  const disowned = new Set();
  // Invites whose dial goes through the signaller and gets the host's
  // answer, but whose transport never comes up: ICE finds no path (the
  // dialer's network has no relay it can reach), so the channel never opens
  // on either side. `hostSees`: the host's server is told of the connection
  // (and waits for a HELLO that never comes); `failAfterMs`: when the
  // dialer's peer connection reports 'failed' (Infinity: it just hangs).
  const blocked = new Map();
  return {
    _state: state,
    _calls: calls,
    auth: { isSignedIn: () => state.signedIn },
    peer: {
      _pairs: pairs,
      createGuestGrant: async () => ({
        grant: `pg1.grant-${++state.grants}`,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
      serve: async (opts) => {
        const server = new MockServer();
        registry.set(server.inviteCode, server);
        calls.push({ op: 'serve', invite: server.inviteCode, opts, server });
        return server;
      },
      connect: async (inviteCode, opts) => {
        calls.push({ op: 'connect', invite: inviteCode, opts });
        if (disowned.has(inviteCode)) {
          // As the real library: connect() resolves once the request is
          // sent, and the signaller's refusal arrives as an error event a
          // network round-trip later (~100ms live).
          const dialer = new MockConn();
          setTimeout(() => {
            const error = new Error('Invalid invite code');
            dialer.dispatch('error', { error });
            dialer.close(undefined);
          }, 100);
          return dialer;
        }
        const server = registry.get(inviteCode);
        if (!server || server.closed) throw new Error('no such meeting');
        const block = blocked.get(inviteCode);
        if (block) {
          const [dialer, listener] = MockConn.pair();
          pairs.push({ dialer, listener });
          if (block.hostSees) {
            server.connections.add(listener);
            queueMicrotask(() => server.dispatch('connection', { conn: listener, user: { uuid: opts?.anonToken } }));
          }
          const pc = dialer.peerconnection;
          pc.remoteDescription = { type: 'answer', sdp: '' }; // the host answered the offer
          pc.connectionState = 'connecting';
          pc.iceConnectionState = 'checking';
          if (Number.isFinite(block.failAfterMs)) {
            setTimeout(() => {
              pc.connectionState = 'failed';
              pc.iceConnectionState = 'failed';
              pc.dispatch('iceconnectionstatechange');
              pc.dispatch('connectionstatechange');
            }, block.failAfterMs);
          }
          return dialer;
        }
        const [dialer, listener] = MockConn.pair();
        pairs.push({ dialer, listener });
        // The accepted (listener) side lives in the server's connections set,
        // so server.close() will tear it down — exactly as the real lib does.
        server.connections.add(listener);
        queueMicrotask(() => {
          // The real server-side connection event names the dialer by the
          // anonToken it dialed with (user.uuid) — this is how a host tells
          // its own self-probe apart from a newcomer.
          server.dispatch('connection', { conn: listener, user: { uuid: opts?.anonToken } });
          dialer.open();
          listener.open();
        });
        return dialer;
      },
    },
    // Make a served invite unreachable, as puter's signaller does when a
    // host's socket dies: the code stays advertised but no one can dial it.
    _killInvite: (inviteCode, { explicit = false } = {}) => {
      registry.delete(inviteCode);
      if (explicit) disowned.add(inviteCode);
    },
    // Make every dial of an invite one whose transport never comes up.
    _blockTransport: (inviteCode, opts = {}) => {
      blocked.set(inviteCode, { hostSees: true, failAfterMs: 100, ...opts });
    },
    // What newer puter.js does when the signaller socket dies under a
    // server: it reopens the socket and creates the server again, which the
    // signaller answers with a NEW invite code — the old one is dead from
    // then on. The library then fires 'reconnect' with the new code.
    _reconnectServer: (inviteCode) => {
      const server = registry.get(inviteCode);
      if (!server) throw new Error(`no server at ${inviteCode}`);
      registry.delete(inviteCode);
      server.inviteCode = `invite-${++MockServer.count}`;
      registry.set(server.inviteCode, server);
      server.dispatch('reconnect', { inviteCode: server.inviteCode });
      return server.inviteCode;
    },
    // The same socket drop, but the signaller still held the session: the
    // library reclaims it, so the invite code and the clients on it stand.
    _resumeServer: (inviteCode) => {
      const server = registry.get(inviteCode);
      if (!server) throw new Error(`no server at ${inviteCode}`);
      server.dispatch('reconnect', { inviteCode, resumed: true });
      return inviteCode;
    },
  };
}

class FakeRTCPeerConnection {
  static instances = [];
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.remoteDescription = null;
    this.appliedParams = [];
    this.senders = [];
    this.listeners = new Map();
    FakeRTCPeerConnection.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  addTrack(track) {
    // The real RTCPeerConnection throws here once it's been closed — this is
    // the crash that killed guest<->guest media (see session regression test).
    if (this.signalingState === 'closed') {
      const err = new Error(
        "Failed to execute 'addTrack' on 'RTCPeerConnection': The RTCPeerConnection's signalingState is 'closed'."
      );
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

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ------------------------------------------------------------------ */

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
  FakeRTCPeerConnection.instances = [];
});

const sessions = [];
function makeSession(name, options = {}) {
  const s = new RoomSession({ media: fakeMedia(), name, ...options });
  sessions.push(s);
  return s;
}

/** Run a host()/join() as a visitor with no Puter session. */
function asAnonymous(start) {
  window.puter._state.signedIn = false;
  try {
    return start();
  } finally {
    window.puter._state.signedIn = true;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  for (const s of sessions) {
    try {
      s.leave();
    } catch {
      /* already gone */
    }
  }
});

describe('RoomSession mesh', () => {
  it('host + guest handshake and exchange identities', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    expect(code).toMatch(/^invite-/);
    expect(host.isHost).toBe(true);
    expect(host.roster.self().name).toBe('Host');

    const guest = makeSession('Guest');
    await guest.join(code);

    await waitFor(() => host.roster.size === 2 && guest.roster.size === 2);
    expect(host.roster.get(guest.selfId).name).toBe('Guest');
    expect(guest.roster.get(host.selfId).name).toBe('Host');
    expect(host.peerCount).toBe(1);
    expect(guest.peerCount).toBe(1);
  });

  it('announces a name again for every track that lands in it', async () => {
    // A name's tracks arrive one at a time. Something downstream reads the
    // stream on each announcement — the audio-level monitor cannot see a
    // microphone that landed after the one announcement it was given.
    const withMicAndCamera = () => {
      const media = fakeMedia();
      media.stream.getAudioTracks = () => [{ kind: 'audio', readyState: 'live' }];
      return media;
    };
    const host = makeSession('Host', { media: withMicAndCamera() });
    const code = await host.host();

    const guest = makeSession('Guest', { media: withMicAndCamera() });
    const announced = [];
    guest.on('stream', ({ kind }) => announced.push(kind));
    await guest.join(code);

    await waitFor(() => announced.filter((kind) => kind === 'camera').length >= 2);
  });

  it('rides out a negotiation error without pulling the link down', async () => {
    // puter.peer reports a description the browser refused and carries on;
    // when a connection is really finished it closes instead.
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.roster.size === 2 && guest.roster.size === 2);

    const linkEvents = [];
    host.on('peer-link', (event) => linkEvents.push(event));
    const { listener } = window.puter.peer._pairs.at(-1);
    listener.dispatch('error', { error: new Error('Failed to set remote answer sdp') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(linkEvents).toEqual([]);
    expect(host.roster.size).toBe(2);
    expect(host.roster.get(guest.selfId).reconnecting).toBeFalsy();
  });

  it('chat reaches the host, other guests (via relay), and echoes locally', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    await g1.join(code);
    const g2 = makeSession('Two');
    await g2.join(code);
    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));

    const atHost = [];
    const atG2 = [];
    const localEcho = [];
    host.on('chat', (m) => atHost.push(m));
    g2.on('chat', (m) => atG2.push(m));
    g1.on('chat', (m) => localEcho.push(m));

    g1.sendChat('hello there');
    await waitFor(() => atHost.length === 1 && atG2.length === 1);
    expect(atHost[0]).toMatchObject({ text: 'hello there', name: 'One', self: false });
    expect(atG2[0]).toMatchObject({ text: 'hello there', name: 'One', self: false, peerId: g1.selfId });
    expect(localEcho[0]).toMatchObject({ text: 'hello there', self: true });

    // And the host's own messages reach guests as plain (unwrapped) sends.
    host.sendChat('welcome all');
    await waitFor(() => atG2.length === 2);
    expect(atG2[1]).toMatchObject({ text: 'welcome all', name: 'Host', peerId: host.selfId });
  });

  it('sequential joiners form a full mesh', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    await g1.join(code);
    const g2 = makeSession('Two');
    await g2.join(code);

    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));
    expect(host.peerCount).toBe(2);
    expect(g1.peerCount).toBe(2);
    expect(g2.peerCount).toBe(2);
    // g1 and g2 get their own Puter peer connection, negotiated via the host.
    await waitFor(() => window.puter.peer._pairs.length === 3);
    expect(window.puter.peer._pairs).toHaveLength(3);
    expect(g1.roster.get(g2.selfId)).toBeTruthy();
    expect(g2.roster.get(g1.selfId)).toBeTruthy();
  });

  it('simultaneous joiners still form a full mesh (announcement race)', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    const g2 = makeSession('Two');
    await Promise.all([g1.join(code), g2.join(code)]);

    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));
    expect(g1.peerCount).toBe(2);
    expect(g2.peerCount).toBe(2);
  });

  it('a larger simultaneous wave converges without duplicate links', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guests = ['A', 'B', 'C', 'D'].map(makeSession);
    await Promise.all(guests.map((g) => g.join(code)));

    const all = [host, ...guests];
    await waitFor(() => all.every((s) => s.roster.size === 5), 4000);
    for (const s of all) expect(s.peerCount).toBe(4);
  });

  it('state changes (hand raise, mute) propagate', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);

    guest.setHand(true);
    await waitFor(() => host.roster.get(guest.selfId)?.hand === true);
    expect(guest.roster.self().hand).toBe(true);

    guest.setHand(false);
    await waitFor(() => host.roster.get(guest.selfId)?.hand === false);
  });

  it('nickname changes reach everyone, future chat, and newcomers', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    const other = makeSession('Other');
    await other.join(code);
    await waitFor(() => [host, guest, other].every((s) => s.roster.size === 3));

    guest.setName('  Ada   Lovelace  ');
    host.setName('Grace');
    await waitFor(() => [host, guest, other].every((s) =>
      s.roster.get(guest.selfId)?.name === 'Ada Lovelace' && s.roster.get(host.selfId)?.name === 'Grace'));
    expect(guest.name).toBe('Ada Lovelace');

    const messages = [];
    other.on('chat', (m) => messages.push(m));
    guest.sendChat('Hello');
    await waitFor(() => messages.length === 1);
    expect(messages[0].name).toBe('Ada Lovelace');

    const newcomer = makeSession('Newcomer');
    await newcomer.join(code);
    expect(newcomer.roster.get(guest.selfId).name).toBe('Ada Lovelace');
    expect(newcomer.roster.get(host.selfId).name).toBe('Grace');
  });

  it('reactions reach peers with sender identity', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);

    const reactions = [];
    host.on('reaction', (r) => reactions.push(r));

    guest.sendReaction('🎉');
    await waitFor(() => reactions.length === 1);
    expect(reactions[0]).toMatchObject({ emoji: '🎉', name: 'Guest' });
  });

  it('graceful leave removes the participant everywhere', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    await g1.join(code);
    const g2 = makeSession('Two');
    await g2.join(code);
    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));

    const left = [];
    host.on('peer-left', ({ participant }) => left.push(participant.name));

    g1.leave();
    await waitFor(() => host.roster.size === 2 && g2.roster.size === 2);
    expect(left).toContain('One');
    expect(host.roster.get(g1.selfId)).toBeNull();
    expect(g2.roster.get(g1.selfId)).toBeNull();
  });

  it('scales outgoing video with call size and relaxes when peers leave', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guests = [];
    for (const name of ['A', 'B', 'C', 'D']) {
      const g = makeSession(name);
      await g.join(code);
      guests.push(g);
    }
    const all = [host, ...guests];
    await waitFor(() => all.every((s) => s.roster.size === 5));

    // 5 sessions x 4 peers = 20 media links, each capped for a 4-peer call.
    const lastBitrate = (pc) => pc.appliedParams.at(-1)?.encodings[0].maxBitrate;
    await waitFor(
      () =>
        FakeRTCPeerConnection.instances.length === 20 &&
        FakeRTCPeerConnection.instances.every((pc) => lastBitrate(pc) === 400_000)
    );
    expect(
      FakeRTCPeerConnection.instances.every(
        (pc) => pc.appliedParams.at(-1).degradationPreference === 'maintain-framerate'
      )
    ).toBe(true);

    // One guest leaves -> everyone else re-tunes for a 3-peer call on
    // their 3 remaining live links (4 sessions x 3 links = 12).
    guests[0].leave();
    await waitFor(
      () => FakeRTCPeerConnection.instances.filter((pc) => lastBitrate(pc) === 700_000).length === 12
    );
  });

  it('joining a nonexistent meeting fails cleanly', async () => {
    const guest = makeSession('Guest');
    const statuses = [];
    guest.on('status', (s) => statuses.push(s.phase));
    await expect(guest.join('invite-does-not-exist')).rejects.toThrow();
    expect(statuses).toContain('failed');
  });

  it('keeps the meeting running when the host leaves — a survivor takes over', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    await g1.join(code);
    const g2 = makeSession('Two');
    await g2.join(code);
    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));
    // The guest<->guest link has to be up before the host goes, or the mesh
    // has nothing to carry the takeover on.
    await waitFor(() => g1.connectedPeerIds().length === 2 && g2.connectedPeerIds().length === 2);

    const ended = [];
    g1.on('ended', ({ reason }) => ended.push(reason));
    g2.on('ended', ({ reason }) => ended.push(reason));

    host.leave();

    // Lowest participant id wins the election; everyone agrees on that.
    const [lo, hi] = [g1, g2].sort((a, b) => (a.selfId < b.selfId ? -1 : 1));
    await waitFor(() => lo.isHost && hi.hostId === lo.selfId);
    expect(ended).toEqual([]);
    expect(hi.isHost).toBe(false);
    expect(lo.roster.size).toBe(2);
    expect(hi.roster.size).toBe(2);

    // The promoted link relays exactly like the old host connection did.
    const seen = [];
    hi.on('chat', ({ text }) => seen.push(text));
    lo.sendChat('still here');
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toBe('still here');
  });

  it('the survivor that takes over serves a fresh invite newcomers can join', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);

    const codes = [];
    guest.on('code-changed', ({ code: next }) => codes.push(next));
    const hostChanges = [];
    guest.on('host-changed', (event) => hostChanges.push(event));

    host.leave();
    await waitFor(() => guest.isHost && codes.length === 1);
    expect(guest.code).not.toBe(code);
    expect(hostChanges).toEqual([{ hostId: guest.selfId, name: 'Guest', self: true }]);

    const late = makeSession('Late');
    await late.join(guest.code);
    await waitFor(() => guest.roster.size === 2 && late.roster.size === 2);
    expect(late.roster.get(guest.selfId).name).toBe('Guest');
  });

  it('hands the meeting’s secret to every guest, so a successor carries the room’s lease on', async () => {
    // The room directory's lease on the link is held under this secret
    // (src/lib/rooms.js); whoever ends up hosting has to know it.
    const host = makeSession('Host', { secret: 'lease-secret-1' });
    const code = await host.host();
    expect(host.meetingSecret).toBe('lease-secret-1');
    const g1 = makeSession('One');
    await g1.join(code);
    const g2 = makeSession('Two');
    await g2.join(code);
    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));
    expect(g1.meetingSecret).toBe('lease-secret-1');
    expect(g2.meetingSecret).toBe('lease-secret-1');
    await waitFor(() => g1.connectedPeerIds().length === 2 && g2.connectedPeerIds().length === 2);

    host.leave();
    const [lo, hi] = [g1, g2].sort((a, b) => (a.selfId < b.selfId ? -1 : 1));
    await waitFor(() => lo.isHost && hi.hostId === lo.selfId);
    expect(lo.meetingSecret).toBe('lease-secret-1');
    expect(lo.term).toBe(1);

    // A newcomer welcomed by the successor learns the same secret.
    const late = makeSession('Late');
    await late.join(lo.code);
    await waitFor(() => late.roster.size === 3);
    expect(late.meetingSecret).toBe('lease-secret-1');
  });

  it('mints a secret of its own when starting a meeting without one', async () => {
    const host = makeSession('Host');
    expect(host.meetingSecret).toBeNull();
    const code = await host.host();
    expect(host.meetingSecret).toMatch(/^[0-9a-f-]{36}$/);
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => guest.roster.size === 2);
    expect(guest.meetingSecret).toBe(host.meetingSecret);
  });

  it('holds a takeover claim while its own host still answers, then dials in', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);

    // Someone elsewhere in the mesh lost the host before we did and took
    // over. We have no link to them — all we get is the flooded claim.
    const successor = makeSession('Successor');
    const newCode = await successor.host();
    const { dialer } = window.puter.peer._pairs[0]; // our link to the old host
    dialer.dispatch('message', {
      data: P.encode(P.makeHostClaim({ hostId: successor.selfId, term: 1, invite: newCode })),
    });

    // Our host is still answering, so we stay put rather than tearing a
    // live meeting apart on someone else's say-so.
    await new Promise((r) => setTimeout(r, 30));
    expect(guest.hostId).toBe(host.selfId);

    // Once our own link goes, the held claim answers the election for us.
    host.leave();
    await waitFor(() => guest.hostId === successor.selfId && successor.peerCount === 1);
    expect(successor.roster.get(guest.selfId).name).toBe('Guest');
    expect(guest.roster.has(host.selfId)).toBe(false);
  });

  it('a live host keeps the meeting when a peer that lost touch claims it', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);

    // The guest's link to us broke one-sidedly and it declared us gone.
    const { listener } = window.puter.peer._pairs[0]; // our side of that link
    listener.dispatch('message', {
      data: P.encode(P.makeHostClaim({ hostId: guest.selfId, term: 1, invite: 'invite-elsewhere' })),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(host.isHost).toBe(true);
    expect(host.code).toBe(code);
    expect(host.hostId).toBe(host.selfId);
  });

  it('ignores a host claim that does not outrank the host we already follow', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);

    // Same term, higher id ('~' sorts after every character a uuid uses).
    const { dialer } = window.puter.peer._pairs[0];
    dialer.dispatch('message', {
      data: P.encode(P.makeHostClaim({ hostId: '~~~~', term: 0, invite: 'invite-nope' })),
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(guest.hostId).toBe(host.selfId);
    expect(guest.code).toBe(code);
  });

  it('re-answers retried HELLOs with a fresh WELCOME (lost-message resilience)', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);

    // Simulate a guest whose WELCOME was lost: it would re-send HELLO
    // on its existing connection. The host must answer again.
    const { dialer } = window.puter.peer._pairs[0];
    const welcomes = [];
    dialer.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.t === 'welcome') welcomes.push(msg);
    });
    dialer.send(
      JSON.stringify({
        v: P.PROTOCOL_VERSION,
        t: 'hello',
        peer: { id: guest.selfId, name: 'Guest' },
      })
    );
    await waitFor(() => welcomes.length === 1);
    expect(welcomes[0].peer.id).toBe(host.selfId);
  });

  it('guests use temporary Puter peer servers for guest-guest direct links', async () => {
    let serveCalls = 0;
    const realServe = window.puter.peer.serve;
    window.puter.peer.serve = async (...args) => {
      serveCalls++;
      return realServe(...args);
    };

    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    await g1.join(code);
    const g2 = makeSession('Two');
    await g2.join(code);
    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));

    await waitFor(() => window.puter.peer._pairs.length === 3);
    expect(serveCalls).toBe(2);
  });

  it('guest<->guest media survives temp-server cleanup (regression: addTrack on closed pc)', async () => {
    // Repro of the 3-party bug: the guest that *serves* the direct link used
    // to close its temp Puter server the moment the peer connected. Puter's
    // server.close() closes every accepted connection, which closed the
    // just-accepted RTCPeerConnection — so the next addTrack threw
    // InvalidStateError and the two guests never exchanged media (while the
    // host, on its own long-lived link, saw both).
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    await g1.join(code);
    const g2 = makeSession('Two');
    await g2.join(code);
    await waitFor(() => [host, g1, g2].every((s) => s.roster.size === 3));

    // host<->g1, host<->g2, g1<->g2 => 3 connection pairs => 6 pc endpoints.
    await waitFor(() => window.puter.peer._pairs.length === 3);
    await waitFor(() => FakeRTCPeerConnection.instances.length === 6);

    // Every endpoint must be live (none torn down by a premature server close)
    // and must have had the local camera track attached without throwing.
    await waitFor(() =>
      FakeRTCPeerConnection.instances.every(
        (pc) => pc.signalingState !== 'closed' && pc.senders.length >= 1
      )
    );
    expect(FakeRTCPeerConnection.instances.filter((pc) => pc.signalingState === 'closed')).toHaveLength(0);
    expect(FakeRTCPeerConnection.instances.every((pc) => pc.senders.length >= 1)).toBe(true);
  });

  it('drops an oversized handshake frame unread, and still welcomes a real HELLO', async () => {
    const host = makeSession('Host');
    const code = await host.host();

    const conn = await window.puter.peer.connect(code);
    await waitFor(() => conn.isOpen);

    // A version-mismatch frame inflated past the ceiling. Reading it to
    // fish out the version would defeat the cap, so it goes unread — and
    // an oversized frame is not a version mismatch in any case.
    const huge = JSON.stringify({
      v: P.PROTOCOL_VERSION + 1,
      t: P.MSG.HELLO,
      pad: 'x'.repeat(P.MAX_FRAME_CHARS),
    });
    expect(huge.length).toBeGreaterThan(P.MAX_FRAME_CHARS);
    conn.send(huge);
    await new Promise((r) => setTimeout(r, 20));
    expect(conn.closed).toBe(false);

    // The connection survived, so the handshake can still go ahead.
    conn.send(P.encode(P.makeHello(P.makeIdentity({ id: 'guest-1', name: 'Guest' }))));
    await waitFor(() => host.peerCount === 1);
    expect(host.roster.get('guest-1').name).toBe('Guest');
  });

  it('still reports a version mismatch on a frame within the size cap', async () => {
    const host = makeSession('Host');
    const code = await host.host();

    const conn = await window.puter.peer.connect(code);
    await waitFor(() => conn.isOpen);

    conn.send(JSON.stringify({ v: P.PROTOCOL_VERSION + 1, t: P.MSG.HELLO }));
    await waitFor(() => conn.closed);
    expect(host.peerCount).toBe(0);
  });

  it('names are sanitized before broadcast', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('   Messy    Name   ');
    await guest.join(code);
    await waitFor(() => host.peerCount === 1);
    expect(host.roster.get(guest.selfId).name).toBe('Messy Name');
  });
});

/**
 * What a failed dial says about the invite. A connect() that rejects never
 * reached the signaller — the library resolves it the moment its socket is
 * open, before the signaller has said a word about the code — so that is
 * the guest's own way there, not a verdict on the meeting. The lobby keeps
 * dialing such an invite (src/ui/prejoin.js); it must be told apart from
 * an invite the signaller disowned, and from a dial that went through and
 * was never answered.
 */
describe('what a failed dial says', () => {
  it('tags a connect() that never reached the signaller, whatever it rejected with', async () => {
    // The current library rejects with the WebSocket's error event: no message at all.
    window.puter.peer.connect = async () => {
      throw { type: 'error' };
    };
    const error = await makeSession('Guest').join('invite-x').then(
      () => null,
      (e) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('unreachable');
    expect(isSignallerUnreachableError(error)).toBe(true);
    expect(isInvalidInviteError(error)).toBe(false);
  });

  it('leaves an invalid invite an older library rejects with as what it is', async () => {
    window.puter.peer.connect = async () => {
      throw new Error('Invalid invite code');
    };
    const error = await makeSession('Guest').join('invite-x').then(
      () => null,
      (e) => e
    );
    expect(isInvalidInviteError(error)).toBe(true);
    expect(isSignallerUnreachableError(error)).toBe(false);
    expect(error.kind).toBeUndefined();
  });

  it('does not tag a dial that went through and was never answered', async () => {
    vi.useFakeTimers();
    // The signaller took the dial; nothing ever comes back on the connection
    // — no answer to the offer, no channel. A host that is gone, not a
    // network that blocks.
    window.puter.peer.connect = async () => Object.assign(new MockConn(), { peerconnection: new FakeRTCPeerConnection() });
    const failed = makeSession('Guest').join('invite-x').then(
      () => null,
      (e) => e
    );
    await vi.advanceTimersByTimeAsync(25_000);
    const error = await failed;
    expect(error.message).toMatch(/Timed out connecting to the meeting/);
    expect(isSignallerUnreachableError(error)).toBe(false);
    expect(isInvalidInviteError(error)).toBe(false);
  });

  it('reads the messages the library uses for never having reached the signaller', () => {
    for (const message of [
      'Could not reach the signaller',
      'Connection closed unexpectedly',
      'Connection closed unexpectedly before peer offer was sent',
      'Failed to get signaller info from Puter.',
    ]) {
      expect(isSignallerUnreachableError(new Error(message))).toBe(true);
    }
    for (const message of ['Invalid invite code', 'Timed out connecting to the meeting.', 'handshake-timeout']) {
      expect(isSignallerUnreachableError(new Error(message))).toBe(false);
    }
    expect(isSignallerUnreachableError(Object.assign(new Error('nope'), { code: 'invalid_invite' }))).toBe(false);
    expect(isSignallerUnreachableError(null)).toBe(false);
  });
});

/**
 * A dial can go through the signaller and reach the host — the host sees
 * the connection and waits for HELLO — and still never open a channel,
 * because ICE fails: no relay reachable, a symmetric NAT, a corporate
 * network. That is the guest's network, and the rejection says so.
 */
describe('a dial whose transport never comes up', () => {
  it('rejects with kind no-media-path the moment ICE fails, after the server saw the connection', async () => {
    vi.useFakeTimers();
    const host = makeSession('Host');
    const code = await host.host();
    let seenByHost = 0;
    window.puter._calls.find((c) => c.op === 'serve').server.addEventListener('connection', () => seenByHost++);
    window.puter._blockTransport(code, { failAfterMs: 100 });

    const failed = makeSession('Guest').join(code).then(
      () => null,
      (e) => e
    );
    await vi.advanceTimersByTimeAsync(500);
    const error = await failed;
    expect(seenByHost).toBe(1);
    expect(error.kind).toBe('no-media-path');
    expect(isSignallerUnreachableError(error)).toBe(false);
    expect(isInvalidInviteError(error)).toBe(false);
    // Not waited out: well before the handshake's own timeout.
    expect(host.roster.size).toBe(1);
  });

  it('rejects with kind no-media-path when the host answered but no path was built by the time the handshake gave up', async () => {
    vi.useFakeTimers();
    const host = makeSession('Host');
    const code = await host.host();
    window.puter._blockTransport(code, { hostSees: false, failAfterMs: Infinity });

    const failed = makeSession('Guest').join(code).then(
      () => null,
      (e) => e
    );
    await vi.advanceTimersByTimeAsync(25_000);
    const error = await failed;
    expect(error.message).toMatch(/Timed out connecting to the meeting/);
    expect(error.kind).toBe('no-media-path');
  });

  it('tags nothing when the channel opened and the host simply never answered', async () => {
    vi.useFakeTimers();
    window.puter.peer.connect = async () => {
      const conn = new MockConn();
      conn.peerconnection = new FakeRTCPeerConnection();
      conn.peerconnection.remoteDescription = { type: 'answer', sdp: '' };
      conn.peerconnection.connectionState = 'connected';
      queueMicrotask(() => conn.open()); // the transport is fine; nobody is listening at the other end
      return conn;
    };
    const failed = makeSession('Guest').join('invite-x').then(
      () => null,
      (e) => e
    );
    await vi.advanceTimersByTimeAsync(25_000);
    const error = await failed;
    expect(error.message).toMatch(/Timed out connecting to the meeting/);
    expect(error.kind).toBeUndefined();
  });

  it('tags nothing when the far side closed the connection for a reason of its own', async () => {
    vi.useFakeTimers();
    window.puter.peer.connect = async () => {
      const conn = new MockConn();
      conn.peerconnection = new FakeRTCPeerConnection();
      conn.peerconnection.remoteDescription = { type: 'answer', sdp: '' };
      conn.peerconnection.connectionState = 'connecting';
      setTimeout(() => conn.dispatch('close', { reason: 'not-the-host' }), 50);
      return conn;
    };
    const failed = makeSession('Guest').join('invite-x').then(
      () => null,
      (e) => e
    );
    await vi.advanceTimersByTimeAsync(500);
    const error = await failed;
    expect(error.message).toBe('not-the-host');
    expect(error.kind).toBeUndefined();
  });
});

describe('guests without a Puter account', () => {
  it('a host with an account mints a guest grant and hands it out in WELCOME', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    expect(host.guestGrant).toMatch(/^pg1\./);
    // The host itself joins nothing anonymously — its account speaks.
    expect(window.puter._calls.find((c) => c.op === 'serve').opts).toEqual({ recoveryTimeout: LINK_RECOVERY_BUDGET_MS });

    const guest = makeSession('Guest');
    await asAnonymous(() => guest.join(code));
    await waitFor(() => guest.guestGrant === host.guestGrant);

    // Nothing came with the link, so the first dial went out with the token
    // alone; the grant WELCOME brought is what every later dial rides on.
    const dial = window.puter._calls.find((c) => c.op === 'connect' && c.invite === code);
    expect(dial.opts).toEqual({ recoveryTimeout: LINK_RECOVERY_BUDGET_MS, anonToken: expect.stringMatching(UUID) });
  });

  it('a guest joining with the grant the room link carried dials on it, without a session', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest', { grant: host.guestGrant });
    await asAnonymous(() => guest.join(code));

    const dial = window.puter._calls.find((c) => c.op === 'connect' && c.invite === code);
    expect(dial.opts).toEqual({ recoveryTimeout: LINK_RECOVERY_BUDGET_MS, anonToken: expect.stringMatching(UUID), turnGrant: host.guestGrant });
    await waitFor(() => host.roster.size === 2);
    expect(host.roster.get(guest.selfId).name).toBe('Guest');
  });

  it('a guest with an account joins on it and never goes anonymous', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest', { grant: host.guestGrant });
    await guest.join(code);

    const dial = window.puter._calls.find((c) => c.op === 'connect' && c.invite === code);
    expect(dial.opts).toEqual({ recoveryTimeout: LINK_RECOVERY_BUDGET_MS });
  });

  it('guest<->guest links between anonymous guests ride the host’s grant, on both ends', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const g1 = makeSession('One');
    await asAnonymous(() => g1.join(code));
    const g2 = makeSession('Two');
    await asAnonymous(() => g2.join(code));
    // peerCount counts roster entries; the direct link between the guests is
    // up only once each holds a connection to the other.
    await waitFor(() => g1.connectedPeerIds().length === 2 && g2.connectedPeerIds().length === 2);

    const grant = host.guestGrant;
    const link = window.puter._calls.filter((c) => c.invite !== code);
    const served = link.filter((c) => c.op === 'serve');
    const dialed = link.filter((c) => c.op === 'connect');
    expect(served.length).toBeGreaterThan(0);
    expect(dialed.length).toBeGreaterThan(0);
    for (const call of [...served, ...dialed]) {
      expect(call.opts).toEqual({ recoveryTimeout: LINK_RECOVERY_BUDGET_MS, anonToken: expect.stringMatching(UUID), turnGrant: grant });
    }
  });

  it('the host renews its grant at half-life and every guest takes up the new one', async () => {
    // The mock channel runs on microtasks alone, so the whole meeting can
    // live on fake timers — which the renewal timer has to be created under.
    vi.useFakeTimers();
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await asAnonymous(() => guest.join(code));
    await vi.advanceTimersByTimeAsync(0);
    const first = host.guestGrant;
    expect(first).toMatch(/^pg1\./);
    expect(guest.guestGrant).toBe(first);
    const changes = [];
    guest.on('grant-changed', ({ grant }) => changes.push(grant));

    // A grant lives an hour; the host renews at the half-hour, not the last minute.
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(host.guestGrant).toBe(first);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(host.guestGrant).not.toBe(first);
    expect(guest.guestGrant).toBe(host.guestGrant);
    expect(changes).toEqual([host.guestGrant]);
  });

  it('the meeting falls to a participant with an account before an anonymous one', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    // Ids decide elections; make the anonymous guest the one a plain
    // lowest-id rule would have picked.
    const anon = makeSession('Anon');
    anon.selfId = '0000-anonymous';
    const holder = makeSession('Holder');
    holder.selfId = '1111-account';
    await asAnonymous(() => anon.join(code));
    await holder.join(code);
    await waitFor(() => anon.connectedPeerIds().length === 2 && holder.connectedPeerIds().length === 2);

    host.leave();
    await waitFor(() => holder.isHost && anon.hostId === holder.selfId);
    expect(anon.isHost).toBe(false);
    expect(holder.guestGrant).toMatch(/^pg1\./);
  });

  it('an anonymous survivor still takes over when no account is left, serving on the grant it holds', async () => {
    const host = makeSession('Host');
    const code = await host.host();
    const grant = host.guestGrant;
    const g1 = makeSession('One');
    const g2 = makeSession('Two');
    await asAnonymous(() => g1.join(code));
    await asAnonymous(() => g2.join(code));
    await waitFor(() => g1.connectedPeerIds().length === 2 && g2.connectedPeerIds().length === 2);

    host.leave();
    await waitFor(() => g1.isHost || g2.isHost);
    const successor = g1.isHost ? g1 : g2;
    const other = successor === g1 ? g2 : g1;
    // The other guest hears the claim over the promoted direct link.
    await waitFor(() => other.hostId === successor.selfId && !other.isHost);
    // No account to mint on: the room is served anonymously, on the grant the
    // old host gave out, and that grant is still what newcomers are handed.
    const takeover = window.puter._calls.filter((c) => c.op === 'serve').at(-1);
    expect(takeover.opts).toEqual({ recoveryTimeout: LINK_RECOVERY_BUDGET_MS, anonToken: expect.stringMatching(UUID), turnGrant: grant });
    expect(successor.guestGrant).toBe(grant);
  });
});

/**
 * Anonymous guests reach Puter's relays only through the host's guest
 * grant. A mint that fails — an API hiccup, a host briefly offline — used
 * to get a console.warn and a flat minute's wait, and nobody in the meeting
 * knew why a guest was stuck outside.
 */
describe('a guest grant that cannot be minted', () => {
  /** A createGuestGrant that fails while `broken.now` is set, counting attempts. */
  function flakyMint() {
    const broken = { now: true, attempts: 0 };
    window.puter.peer.createGuestGrant = async () => {
      broken.attempts++;
      if (broken.now) throw new Error('503 from /peer/turn-grant');
      return { grant: `pg1.late-${broken.attempts}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    };
    return broken;
  }

  it('says so, tries again on a backoff, and once a grant is minted tells guests and stops', async () => {
    vi.useFakeTimers();
    const broken = flakyMint();
    const host = makeSession('Host');
    const failures = [];
    host.on('grant-failed', (e) => failures.push(e));
    const changes = [];
    host.on('grant-changed', ({ grant }) => changes.push(grant));
    const code = await host.host();
    expect(host.guestGrant).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ inForce: false, retryInMs: GRANT_RETRY_BACKOFF_MS[0] });
    expect(failures[0].error).toBeInstanceOf(Error);

    // A guest arriving meanwhile gets no grant with the WELCOME.
    const guest = makeSession('Guest');
    await asAnonymous(() => guest.join(code));
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.guestGrant).toBeNull();

    // 5 s, 15 s, 60 s, 60 s — not a flat minute.
    for (const [i, delay] of [...GRANT_RETRY_BACKOFF_MS, GRANT_RETRY_BACKOFF_MS.at(-1)].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 100);
      expect(broken.attempts).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(100);
      expect(broken.attempts).toBe(i + 2);
    }
    expect(failures.map((f) => f.retryInMs)).toEqual([5000, 15_000, 60_000, 60_000, 60_000]);
    expect(failures.every((f) => f.inForce === false)).toBe(true);

    // Puter is back: the next try lands, guests hear of it, the alerts stop.
    broken.now = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(broken.attempts).toBe(6);
    expect(host.guestGrant).toBe('pg1.late-6');
    expect(changes).toEqual(['pg1.late-6']);
    expect(guest.guestGrant).toBe('pg1.late-6');
    const seen = failures.length;
    // Back on the renewal schedule: no further failures, and a renewal at the half-hour.
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(failures).toHaveLength(seen);
    expect(broken.attempts).toBe(7);
    expect(host.guestGrant).toBe('pg1.late-7');
  });

  it('is quiet about a renewal that fails while the grant in force still holds — until it expires', async () => {
    vi.useFakeTimers();
    const host = makeSession('Host');
    const failures = [];
    host.on('grant-failed', (e) => failures.push(e));
    await host.host();
    const first = host.guestGrant;
    expect(first).toMatch(/^pg1\./);

    // Puter goes away before the half-life renewal.
    const broken = flakyMint();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(broken.attempts).toBeGreaterThanOrEqual(1);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    // The grant minted an hour ago still holds: guests have relays.
    expect(failures.every((f) => f.inForce === true)).toBe(true);
    expect(host.guestGrant).toBe(first);

    // Past the hour it no longer does, and the failures say so.
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(failures.at(-1).inForce).toBe(false);
  });

  it('mints again the moment the browser comes back online', async () => {
    vi.useFakeTimers();
    const listeners = new Map();
    window.addEventListener = (type, fn) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn);
    window.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
    const broken = flakyMint();
    const host = makeSession('Host');
    await host.host();
    expect(broken.attempts).toBe(1);
    expect(listeners.get('online')?.size).toBe(1);

    // Back online well before the backoff would have tried again.
    broken.now = false;
    for (const fn of [...listeners.get('online')]) fn();
    await vi.advanceTimersByTimeAsync(0);
    expect(broken.attempts).toBe(2);
    expect(host.guestGrant).toBe('pg1.late-2');
    // The listener is let go of, and the backoff retry is cancelled.
    expect(listeners.get('online').size).toBe(0);
    await vi.advanceTimersByTimeAsync(GRANT_RETRY_BACKOFF_MS[0] + 1000);
    expect(broken.attempts).toBe(2);
  });

  it('lets go of the online listener with the session', async () => {
    const listeners = new Map();
    window.addEventListener = (type, fn) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn);
    window.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
    flakyMint();
    const host = makeSession('Host');
    await host.host();
    expect(listeners.get('online')?.size).toBe(1);
    host.leave();
    expect(listeners.get('online').size).toBe(0);
  });
});

describe('host self-probe (a dead invite while waiting alone)', () => {
  it('leaves a reachable invite alone', async () => {
    vi.useFakeTimers();
    const host = makeSession('Host');
    const code = await host.host();
    const codes = [];
    host.on('code-changed', ({ code: next }) => codes.push(next));

    // Several probe intervals pass with no one connected; the invite is
    // reachable, so nothing is re-served and the code never changes.
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS * 3 + 1000);
    expect(host.code).toBe(code);
    expect(codes).toEqual([]);
    // The probe dials its own invite but must never enter the roster.
    expect(host.roster.size).toBe(1);
    const serves = window.puter._calls.filter((c) => c.op === 'serve');
    expect(serves).toHaveLength(1);
  });

  it('probes its own invite without a turnGrant — the probe never needs a relay', async () => {
    vi.useFakeTimers();
    const host = makeSession('Host');
    await host.host();
    const grant = host.guestGrant;
    expect(grant).toBeTruthy(); // the host minted one, and real dials carry it
    window.puter._calls.length = 0;
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS + 100);
    const probes = window.puter._calls.filter((c) => c.op === 'connect');
    expect(probes.length).toBeGreaterThanOrEqual(1);
    for (const probe of probes) {
      expect(probe.opts.turnGrant).toBeUndefined();
      expect(probe.opts).toEqual({ anonToken: expect.stringMatching(UUID) });
    }
  });

  it('re-serves and republishes once the invite goes dead', async () => {
    vi.useFakeTimers();
    const host = makeSession('Host');
    const code = await host.host();
    const codes = [];
    host.on('code-changed', ({ code: next }) => codes.push(next));

    // The host's signaller socket dies: the invite is still advertised but
    // no one can dial it any more.
    window.puter._killInvite(code);

    // One miss isn't enough — a passing hiccup shouldn't rotate the invite.
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS + SELF_PROBE_SEEN_TIMEOUT_MS + 500);
    expect(host.code).toBe(code);
    expect(codes).toEqual([]);

    // A second consecutive miss is the socket being gone for good: the host
    // serves a fresh room and the new invite is announced for republishing.
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS + SELF_PROBE_SEEN_TIMEOUT_MS + 500);
    expect(host.code).not.toBe(code);
    expect(codes).toEqual([host.code]);
    expect(host.isHost).toBe(true);

    // The freshly served invite is live: a guest can now join through it.
    const newInvite = host.code;
    const guest = makeSession('Guest');
    await asAnonymous(() => guest.join(newInvite));
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.hostId).toBe(host.selfId);
    expect(host.roster.size).toBe(2);
  });

  it('keeps probing with someone connected, without touching the call', async () => {
    vi.useFakeTimers();
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await asAnonymous(() => guest.join(code));
    await vi.advanceTimersByTimeAsync(0);
    const pairsAfterJoin = window.puter.peer._pairs.length;
    const events = [];
    host.on('peer-left', (e) => events.push(['host', 'peer-left', e.participant.id]));
    guest.on('peer-left', (e) => events.push(['guest', 'peer-left', e.participant.id]));
    guest.on('host-changed', (e) => events.push(['guest', 'host-changed', e.hostId]));

    // A connected guest says nothing about the invite (their link outlives
    // the socket that minted it), so the probe keeps dialing...
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS * 3 + 1000);
    expect(window.puter.peer._pairs.length).toBeGreaterThan(pairsAfterJoin);
    // ...and, the invite being reachable, changes nothing: same code, same
    // two people, the probe's own connections never entering the roster.
    expect(host.code).toBe(code);
    expect(host.roster.size).toBe(2);
    expect(guest.roster.size).toBe(2);
    expect(guest.hostId).toBe(host.selfId);
    expect(guest.roster.get(host.selfId)?.reconnecting).toBeFalsy();
    expect(events).toEqual([]);
    expect(window.puter._calls.filter((c) => c.op === 'serve')).toHaveLength(1);
  });
});

/**
 * The incident of 2026-08-27: two people in a call, a third stuck at
 * "Waiting for the host…" for good. The host's signaller socket had died
 * — the call carried on over its own transport, so nobody noticed — and
 * the invite the room directory advertised was dead. Two ways the
 * meeting has to come back from that, neither of which may disturb the
 * call in progress.
 */
describe('the served invite changing under a live call', () => {
  async function callInProgress() {
    const host = makeSession('Host');
    const code = await host.host();
    const guest = makeSession('Guest');
    await asAnonymous(() => guest.join(code));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.roster.size).toBe(2);
    const codes = [];
    host.on('code-changed', ({ code: next }) => codes.push(next));
    const disturbed = [];
    host.on('peer-left', (e) => disturbed.push(['host', 'peer-left', e.participant.id]));
    guest.on('peer-left', (e) => disturbed.push(['guest', 'peer-left', e.participant.id]));
    guest.on('host-changed', (e) => disturbed.push(['guest', 'host-changed', e.hostId]));
    return { host, guest, code, codes, disturbed };
  }

  async function newcomerJoinsAt(invite, host, present) {
    const newcomer = makeSession('Newcomer');
    await asAnonymous(() => newcomer.join(invite));
    await vi.advanceTimersByTimeAsync(0);
    expect(newcomer.hostId).toBe(host.selfId);
    expect(host.roster.size).toBe(present + 1);
    return newcomer;
  }

  it('follows the library reopening the socket under a new invite, at once', async () => {
    vi.useFakeTimers();
    const { host, guest, code, codes, disturbed } = await callInProgress();

    // The socket dies and puter.js brings the server back under a new code.
    const next = window.puter._reconnectServer(code);
    await vi.advanceTimersByTimeAsync(0);

    // The new invite is the meeting's address now — announced for
    // republishing, and handed to the guest so a redial of theirs uses it.
    expect(host.code).toBe(next);
    expect(codes).toEqual([next]);
    expect(guest.code).toBe(next);
    // Nothing else moved: same host, same link, no one left or reconnected.
    expect(host.isHost).toBe(true);
    expect(guest.hostId).toBe(host.selfId);
    expect(guest.roster.get(host.selfId)?.reconnecting).toBeFalsy();
    expect(disturbed).toEqual([]);
    expect(window.puter._calls.filter((c) => c.op === 'serve')).toHaveLength(1);
    // Chat still flows over the untouched link.
    const heard = [];
    guest.on('chat', (m) => heard.push(m.text));
    host.sendChat('still here');
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual(['still here']);

    // Someone arriving now gets in — through the new code.
    await newcomerJoinsAt(next, host, 2);
  });

  it('re-serves a dead invite while people are in the call', async () => {
    vi.useFakeTimers();
    const { host, guest, code, codes, disturbed } = await callInProgress();

    // The socket dies under an older puter.js: nothing reopens it, the
    // published invite is simply dead, and the call carries on unaware.
    window.puter._killInvite(code);

    // One miss is a hiccup; two are the invite gone for good.
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS + SELF_PROBE_SEEN_TIMEOUT_MS + 500);
    expect(host.code).toBe(code);
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS + SELF_PROBE_SEEN_TIMEOUT_MS + 500);
    const next = host.code;
    expect(next).not.toBe(code);
    expect(codes).toEqual([next]);
    expect(guest.code).toBe(next);
    // The call in progress is untouched by the re-serve.
    expect(host.isHost).toBe(true);
    expect(guest.hostId).toBe(host.selfId);
    expect(guest.roster.get(host.selfId)?.reconnecting).toBeFalsy();
    expect(host.roster.size).toBe(2);
    expect(disturbed).toEqual([]);

    await newcomerJoinsAt(next, host, 2);
  });

  it('re-serves at once when the signaller disowns the invite outright, mid-call', async () => {
    vi.useFakeTimers();
    const { host, guest, code, codes, disturbed } = await callInProgress();

    // The live signaller's answer for a code whose socket is gone comes in
    // ~100ms and is definitive — no second miss to wait for.
    window.puter._killInvite(code, { explicit: true });
    await vi.advanceTimersByTimeAsync(SELF_PROBE_INTERVAL_MS + 500);

    const next = host.code;
    expect(next).not.toBe(code);
    expect(codes).toEqual([next]);
    expect(guest.code).toBe(next);
    expect(disturbed).toEqual([]);
    expect(host.roster.size).toBe(2);
    expect(window.puter._calls.filter((c) => c.op === 'serve')).toHaveLength(2);

    await newcomerJoinsAt(next, host, 2);
  });

  it('says nothing when the library reclaims the session it dropped', async () => {
    // The invite is the one already published and the guests were never
    // addressed by anything else, so a reclaimed session is not news.
    vi.useFakeTimers();
    const { host, guest, code, codes, disturbed } = await callInProgress();

    window.puter._resumeServer(code);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.code).toBe(code);
    expect(guest.code).toBe(code);
    expect(codes).toEqual([]);
    expect(disturbed).toEqual([]);
    expect(host.roster.size).toBe(2);

    await newcomerJoinsAt(code, host, 2);
  });

  it('ignores a reconnect of a server it has already retired', async () => {
    vi.useFakeTimers();
    const { host, code, codes } = await callInProgress();

    window.puter._killInvite(code);
    await vi.advanceTimersByTimeAsync(2 * (SELF_PROBE_INTERVAL_MS + SELF_PROBE_SEEN_TIMEOUT_MS + 500));
    const next = host.code;
    expect(next).not.toBe(code);

    // The retired server (kept alive for the guest on it) comes back under
    // yet another code — that is not the meeting's address.
    const serves = window.puter._calls.filter((c) => c.op === 'serve');
    expect(serves).toHaveLength(2);
    const retired = serves[0].server;
    retired.inviteCode = 'invite-stale';
    retired.dispatch('reconnect', { inviteCode: 'invite-stale' });
    await vi.advanceTimersByTimeAsync(0);
    expect(host.code).toBe(next);
    expect(codes).toEqual([next]);
  });
});
