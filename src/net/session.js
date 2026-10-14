import { Emitter } from '../lib/emitter.js';
import { Roster } from '../lib/roster.js';
import { getPuter } from '../lib/env.js';
import { isAnonymous, mintGuestGrant } from '../lib/account.js';
import * as P from '../lib/protocol.js';
import { cameraSendProfile, SCREEN_SEND_PROFILE, LINK_RECOVERY_BUDGET_MS, LINK_DROP_MS } from './rtc.js';
import { steadyInterval, steadyTimeout } from '../lib/timers.js';

const CONNECT_TIMEOUT_MS = 15000;
const HANDSHAKE_TIMEOUT_MS = 20000;
const HELLO_TIMEOUT_MS = 20000;
const HELLO_RETRY_MS = 2000;
const DIRECT_LINK_TIMEOUT_MS = 20000;
/** How long a survivor waits for the elected successor to claim the meeting. */
const HOST_CLAIM_TIMEOUT_MS = 12000;
/**
 * Dial attempts against a new host's invite before writing that host off.
 * One transient connect timeout must not fail over: writing off a healthy
 * host elects a rival that peers with working links shelve but never
 * correct, permanently splitting the meeting.
 */
const HOST_DIAL_ATTEMPTS = 2;
/** Re-shouts of a takeover, for links that were still forming at the time. */
const HOST_CLAIM_REPEATS_MS = [2000, 5000];
/**
 * A host's invite lives only as long as puter.peer's signaller socket. The
 * signaller mints a code per socket, so when the socket dies — a restart
 * of the signaller, a network blip — the invite dies with it, and the
 * meeting notices nothing: the calls already up ride their own WebRTC
 * transports, untouched. The invite still sits in the room directory
 * looking live, but a guest dialing it is told "Invalid invite code" and
 * waits for a host who is right there. Newer puter.js reopens the socket by
 * itself and comes back under a NEW code (a `reconnect` event, which
 * #adoptServer follows at once); older builds swallow the close and serve
 * nothing. Either way, a host cannot trust the code it published to still
 * work, so for as long as it hosts it periodically dials its OWN invite.
 * The signaller routes a live one straight back to our server — a
 * `connection` event carrying the probe's token (#onServerConnection) —
 * while a dead one never comes back; a run of misses means the invite is
 * gone, and we serve a fresh room and announce the new code ('code-changed',
 * which the app writes to the directory), exactly as a takeover does. NOT only while alone: a call in progress is no proof the invite
 * is reachable — it is exactly the case where a dead invite went unnoticed
 * for good, with newcomers stuck outside a meeting that carried on fine.
 * The probe never touches the call: its connection is recognised and
 * dropped on arrival, and a re-serve keeps the old server (and everyone on
 * it) alive, only pointing newcomers and redials at the new code.
 */
export const SELF_PROBE_INTERVAL_MS = 15_000;
export const SELF_PROBE_SEEN_TIMEOUT_MS = 8000;
export const SELF_PROBE_MISSES_BEFORE_RESERVE = 2;

/**
 * The signaller's answer to a dial of a code it does not serve. Unlike a
 * probe that simply never comes back — which may be our own network — this
 * is definitive, and arrives in about a hundred milliseconds: the invite is
 * gone, and there is nothing to wait a second interval for. The newer
 * signaller names it in `error.code` too.
 */
export function isInvalidInviteError(error) {
  if (!error) return false;
  if (error.code === 'invalid_invite') return true;
  return /invalid invite/i.test(messageOf(error));
}

/**
 * A dial that never reached the signaller, so the invite was never even
 * looked at: the dialer's own socket to the signaller would not open (the
 * network on this side, or a signaller outage — which hits the host just
 * the same), or Puter's API could not say where the signaller is. No
 * verdict on the invite, then: the meeting may be running fine, and the
 * same code is worth dialing again once the way there is back.
 *
 * `puter.peer.connect()` rejects in exactly these cases — the current
 * library with the socket's own error event, which carries no message, an
 * older one with a message — and only then, so join() tags every such
 * rejection `kind: 'unreachable'` (an old library that rejects an invalid
 * invite outright excepted). Read alongside isInvalidInviteError: the two
 * are the two definite things a failed dial can say.
 */
export function isSignallerUnreachableError(error) {
  if (!error) return false;
  if (error.kind === 'unreachable') return true;
  if (isInvalidInviteError(error)) return false;
  return /could not reach the signaller|connection closed unexpectedly|failed to get signaller info/i.test(
    messageOf(error)
  );
}

/**
 * connect() rejected: mark the error as one of never having reached the
 * signaller. Not for an invalid invite an older library rejects with, nor
 * for a sign-in the library could not get — neither is a matter of reach.
 */
function tagUnreachable(error) {
  if (isInvalidInviteError(error) || /authenticat/i.test(messageOf(error))) return error;
  // The current library rejects with the WebSocket's error event itself —
  // no message, and String() of it is "[object Event]" — so give it words.
  const tagged = error instanceof Error ? error : new Error('Could not reach the signaller.');
  tagged.kind = 'unreachable';
  return tagged;
}

function messageOf(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return String(error.message ?? error.msg ?? '');
}
/**
 * How long a guest keeps dialing a host whose link has died before taking
 * the host as gone. A window of time, not a number of attempts: with the
 * network down, connect() rejects at once, and a handful of attempts would
 * be over in seconds — long before a Wi‑Fi switch or a laptop waking up
 * has its network back.
 *
 * It opens once puter.peer gives the link up and has to close early enough
 * that the last attempt can get through before the host drops us.
 */
const HOST_REDIAL_WINDOW_MS = LINK_DROP_MS - LINK_RECOVERY_BUDGET_MS - 10_000;
const HOST_REDIAL_RETRY_MS = 2000;
/**
 * A guest<->guest link attempt that fails or times out is tried again while
 * the peer is still in the meeting: the invite travels through the host,
 * and is lost if the peer's own host link happened to be down just then.
 * Backs off, so a peer that can never be reached costs a serve() a minute.
 */
const DIRECT_LINK_RETRY_MS = 5000;
const DIRECT_LINK_RETRY_MAX_MS = 60_000;
/**
 * Chat is sent again over a link that has been rebuilt or healed, because a
 * link that is dying still takes messages: the data channel reads open and
 * queues them on a transport that is gone, and they go down with it. What
 * is sent again is everything from a little before the link first showed
 * trouble - browsers notice a dead network some seconds after it goes - and
 * every message carries an id, so one that did get through is not shown
 * twice. The log it is sent from is bounded in size and age.
 */
const CHAT_RESEND_LEAD_MS = 15_000;
const CHAT_LOG_MAX = 200;
const CHAT_LOG_MAX_AGE_MS = 10 * 60_000;
/** Ids of chat already shown, remembered for long enough to outlast any re-send. */
const SEEN_CHAT_MAX = 2000;
/**
 * How long a wobbling link is given before we say so on the tile.
 *
 * puter.peer reports 'unstable' the moment ICE stops getting through and
 * takes no action, because ICE usually heals it within a second or two.
 * That is the right call for recovery and the wrong one for a badge: hold
 * it back long enough not to flash at every stutter, and no longer, or
 * frozen video goes unexplained.
 */
const LINK_UNSTABLE_BADGE_MS = 6_000;
/**
 * The guest grant (see src/lib/account.js) is renewed once half its life is
 * gone — an hour by default, so every half hour — which keeps the copy in
 * the room directory's entry, and the copy guests hold, good for a long
 * while yet at any moment. Never more often than once a minute, and a mint
 * that failed is tried again after one.
 */
const GRANT_RENEW_FRACTION = 0.5;
const GRANT_RENEW_MIN_MS = 60_000;
/**
 * A mint that failed is tried again soon, then less often: an API hiccup
 * is over in seconds, and every minute without a grant is a minute in
 * which a guest with no account behind a NAT that needs a relay cannot get
 * in. The browser coming back online is tried on at once.
 */
export const GRANT_RETRY_BACKOFF_MS = [5000, 15_000, 60_000];
/** How long hosting waits on the first mint before going ahead without it. */
const GRANT_MINT_WAIT_MS = 5000;

/** Terse handshake diagnostics — kept on in production for remote debugging. */
function trace(...args) {
  console.info('[meet]', ...args);
}

/**
 * RoomSession — a meeting with Puter-peer signaling and mesh media.
 *
 * Topology:
 *  - The HOST creates the room with `puter.peer.serve()`. Its invite code
 *    is the meeting code, and every guest joins that room with
 *    `puter.peer.connect(code)`. Hosting is done on a Puter account; a
 *    guest needs none — it joins on an anonymous token, and reaches the
 *    relays on the host's GUEST GRANT (see src/lib/account.js), which the
 *    host mints, hands out in WELCOME, renews, and re-announces in GRANT.
 *  - The host relays guest<->guest traffic: broadcastables (chat, state,
 *    reactions, stream metadata) fan out wrapped in FROM{id}.
 *  - Host<->guest media is added directly to the existing Puter peer
 *    connection.
 *  - Guest<->guest media uses temporary Puter peer servers whose invite
 *    codes are exchanged through the host connection. Renegotiation then
 *    travels over that guest<->guest Puter data channel.
 *
 * Links can die without closing: the Puter connection only reports `close`
 * when its data channel closes, and a data channel outlives the network
 * path under it (see MediaLink). A link whose transport is gone is rebuilt
 * on a fresh Puter connection — a guest dials the host again, the side
 * that served a guest<->guest link serves it again — while the peer keeps
 * its place in the roster. The host cannot dial anyone; it waits for the
 * guest to come back and only then, after a while, gives them up as gone.
 *
 * The host role MIGRATES. When the host leaves, the survivors elect the
 * one with the lowest participant id; it serves a fresh room for newcomers
 * and floods HOST_CLAIM across the mesh. Everyone who already has a direct
 * link to the new host simply promotes that link to be their host link —
 * no renegotiation, no interruption to media — and anyone without one
 * dials the invite the claim carries. The meeting only ends ('ended') when
 * the last participant is left with no way to serve a room.
 *
 * Events:
 *  - 'status'          {phase: 'connecting'|'connected'|'failed', error?}
 *  - 'peer-joined'     {participant}
 *  - 'peer-left'       {participant, reason}
 *  - 'host-migrating'  {hostId}        the host went away; waiting on a successor
 *  - 'host-changed'    {hostId, name, self}
 *  - 'code-changed'    {code, reason}  newcomers now reach us at a new invite
 *  - 'grant-changed'   {grant}         the guest grant in force changed (host: minted or renewed)
 *  - 'grant-failed'    {error, inForce, retryInMs}  host: a mint failed; `inForce` whether the
 *                                      previous grant still holds (guests keep their relays until it expires)
 *  - 'chat'            {peerId, name, text, ts, self}
 *  - 'reaction'        {peerId, name, emoji, self}
 *  - 'stream'          {peerId, kind: 'camera'|'screen', stream}
 *  - 'stream-removed'  {peerId, kind, stream}
 *  - 'peer-link'       {peerId, state: 'lost'|'connected'}  a link's transport died / is back
 *  - 'ended'           {reason}   nothing of the meeting is left
 *  - 'left'            {}         self left
 *  - 'error'           {message, error}
 */
export class RoomSession extends Emitter {
  selfId = crypto.randomUUID();
  roster = new Roster();
  /** The meeting code (host's invite code). */
  code = null;
  isHost = false;
  hand = false;
  startedAt = null;

  #media;
  #name;
  /**
   * Proof that a HELLO for our id is ours. Everyone learns everyone else's
   * id from WELCOME and PEER_JOINED, so a host taking a returning HELLO on
   * the id alone would let any participant evict and stand in for any
   * other. It goes to the host in our HELLO and nowhere else.
   */
  #secret = crypto.randomUUID();
  #server = null; //        host only: the Puter peer server we serve
  /**
   * Servers from hostings we stood down from. They stay up — guests that
   * dialed in through them still talk to us over their connections — but
   * they must not leak past the session (#teardownEverything closes them).
   */
  #retiredServers = [];
  /** Self-probe of our served invite (host only): stops its timer. */
  #stopProbeTimer = null;
  #probing = false;
  #probeMisses = 0;
  /** In-flight self-probe tokens -> resolver, matched in #onServerConnection. */
  #pendingProbes = new Map();
  #servedInvite = null; //  host only: its invite code (null until it is up)
  #hostConn = null; //      guest only: the link we reach the host through
  #hostId = null; //        whoever is hosting right now (ourselves included)
  /** Migration counter — bumped by each takeover, highest wins. */
  #term = 0;
  #migrationTimer = null;
  /** Candidates that were elected but never claimed the meeting. */
  #failedHosts = new Set();
  #connectingHostId = null;
  #claimRepeatTimers = [];
  /** A takeover we couldn't act on yet because our own host still answered. */
  #pendingClaim = null;
  /** @type {Map<string, object>} peerId -> peer record */
  #peers = new Map();
  #pendingLinkInvites = new Map();
  /** Recent chat, ours and everyone's, to send again after a link comes back: {from, msg, at}. */
  #chatLog = [];
  /** Ids of chat already shown here — a re-send is never shown twice. */
  #seenChat = new Set();
  /** Guest: since when our link to the host has been in doubt (null while it is fine). */
  #hostDoubtSince = null;
  #left = false;
  /**
   * Whether a Puter account stands behind us. Hosting is done on one; a
   * guest may have none, and then takes part on an anonymous token with
   * the host's grant for relays. Read once, as the meeting starts.
   */
  #acct = true;
  /** Names an anonymous participant to the signaller for this session. */
  #anonToken = crypto.randomUUID();
  /**
   * The guest grant in force: minted (and renewed) by us as a host with an
   * account; otherwise whatever the host gave us — in WELCOME, in GRANT,
   * or, before either, the one the room's link carried in.
   */
  #grant = null;
  #grantTimer = null;
  /** When the grant we minted stops being accepted (host only; null: unknown). */
  #grantExpiresAt = null;
  /** Consecutive mints that failed — sets the retry backoff. */
  #grantFailures = 0;
  /**
   * The meeting's secret: what the room directory's lease on this meeting's
   * link is held under (lib/rooms.js). Chosen by whoever starts the meeting,
   * handed to every guest in WELCOME, and kept by a successor, so the lease
   * follows the host role. Null until we host or are welcomed.
   */
  #meetingSecret = null;
  #minting = false;
  /** Retry a failed mint the moment the browser is back online. */
  #onOnline = null;
  /** Host: a guest was given up for a link that died rather than a goodbye. */
  #lostTouch = false;
  /**
   * Our subscriptions on the local media, let go of on leave: the media
   * outlives a session — the call keeps it when its host yields to a
   * meeting started at the same moment and a new session takes over.
   */
  #mediaDisposers = [];

  constructor({ media, name, grant = null, secret = null }) {
    super();
    this.#media = media;
    this.#name = P.sanitizeName(name);
    this.#grant = typeof grant === 'string' && grant ? grant : null;
    this.#meetingSecret = typeof secret === 'string' && secret ? secret : null;

    // Keep peers in sync with local media.
    this.#mediaDisposers = [
      media.on('change', () => this.#broadcastState()),
      media.on('audio-track', () => this.#syncLocalTracks()),
      media.on('video-track', () => this.#syncLocalTracks()),
      media.on('screen', ({ on, stream }) => {
        for (const peer of this.#peers.values()) {
          if (on) peer.conn?.publish('screen', stream, { video: SCREEN_SEND_PROFILE });
          else peer.conn?.unpublish('screen');
        }
        this.#broadcastState();
      }),
    ];
  }

  get name() {
    return this.#name;
  }

  get peerCount() {
    return this.#peers.size;
  }

  /** Id of the participant hosting the meeting right now (null mid-migration). */
  get hostId() {
    return this.#hostId;
  }

  /** The guest grant in force — what the room's directory entry should carry. */
  get guestGrant() {
    return this.#grant;
  }

  /** The meeting's secret (see the field): ours from host(), the host's once welcomed. */
  get meetingSecret() {
    return this.#meetingSecret;
  }

  /** How many times the meeting has changed hands. */
  /**
   * Who should hold the room's directory entry while the host is out of
   * reach — the successor this side would elect, the unreachable host
   * excluded. Everyone computes the same answer from the same roster, so
   * one participant writes; the directory fences the rest out by term if a
   * divided roster ever makes it more than one.
   */
  get roomKeeperId() {
    if (this.isHost) return this.selfId;
    return this.#electHost(this.#hostId ? [this.#hostId] : []);
  }

  get term() {
    return this.#term;
  }

  /**
   * Whether the meeting may be carrying on without us: as host we gave a
   * guest up because their link died, not because they said goodbye, so
   * they may have elected a successor among themselves and be meeting
   * under it now. Such a host must never release the room on its way out -
   * that would end the successor's meeting in the directory - only stop
   * writing for it.
   */
  get mayContinueElsewhere() {
    return this.#lostTouch;
  }

  /** Ids of the participants we hold a live connection to. */
  connectedPeerIds() {
    return [...this.#peers.values()].filter((peer) => peer.conn && !peer.closed).map((peer) => peer.id);
  }

  /** Start a new meeting (become the host). Resolves with the meeting code. */
  async host() {
    this.#acct = !isAnonymous();
    this.#meetingSecret ??= crypto.randomUUID();
    const puter = getPuter();
    // The grant is minted alongside the server so that the room's very first
    // status write can carry it; a slow mint is not waited for past a moment.
    const [server] = await Promise.all([puter.peer.serve(this.#peerOptions()), this.#mintGrant()]);
    this.#adoptServer(server);
    this.code = this.#servedInvite;
    this.isHost = true;
    this.#hostId = this.selfId;
    this.startedAt = Date.now();
    this.#addSelfToRoster();
    this.#startSelfProbe();
    trace('host: serving meeting', this.code, '(protocol', P.PROTOCOL_VERSION + ')');
    this.emit('status', { phase: 'connected' });
    return this.code;
  }

  /** Join an existing meeting by code. Resolves once welcomed by the host. */
  async join(code) {
    this.emit('status', { phase: 'connecting' });
    this.code = code;
    this.startedAt = Date.now();
    try {
      const puter = getPuter();
      this.#acct = !isAnonymous();
      if (!this.#acct) {
        trace(
          'guest: no Puter session — joining anonymously,',
          this.#grant ? 'with the host’s grant for relays' : 'with no grant (direct connections only)'
        );
      }
      // connect() itself can hang on a dead code — never trust it to settle.
      const connectPromise = puter.peer.connect(code, this.#peerOptions());
      let conn;
      try {
        conn = await withTimeout(
          connectPromise,
          CONNECT_TIMEOUT_MS,
          'Could not reach the meeting. Check the code and try again.'
        );
      } catch (err) {
        // If it settles late, don't leak the connection.
        connectPromise.then((c) => c?.close?.('timeout')).catch(() => {});
        // connect() resolves the moment its socket to the signaller is open,
        // before the signaller has said a word about the invite — so a
        // rejection (or a hang) here is about reaching the signaller, not
        // about the code (see isSignallerUnreachableError).
        throw tagUnreachable(err);
      }
      this.#hostConn = conn;
      trace('guest: connected to signaler for', code, '(protocol', P.PROTOCOL_VERSION + ') — starting handshake');
      this.#addSelfToRoster();
      await this.#handshakeWithHost(conn);
      this.emit('status', { phase: 'connected' });
    } catch (error) {
      this.emit('status', { phase: 'failed', error });
      throw error;
    }
  }

  sendChat(text) {
    const msg = P.makeChat(text);
    this.#firstSight(msg);
    this.#logChat(this.selfId, msg);
    this.#sendBroadcast(msg);
    this.emit('chat', { peerId: this.selfId, name: this.#name, text: msg.text, ts: msg.ts, self: true });
    return msg;
  }

  sendReaction(emoji) {
    this.#sendBroadcast(P.makeReaction(emoji));
    this.emit('reaction', { peerId: this.selfId, name: this.#name, emoji, self: true });
  }

  setHand(on) {
    this.hand = !!on;
    this.#broadcastState();
  }

  setName(name) {
    if (this.#left) return;
    this.#name = P.sanitizeName(name);
    this.#broadcastState();
  }

  /** Remote media stream for a peer, if it has arrived. */
  getStream(peerId, kind = 'camera') {
    return this.#peers.get(peerId)?.streams.get(kind) ?? null;
  }

  /** Leave the meeting and tear everything down. */
  leave(reason = 'left') {
    if (this.#left) return;
    this.#left = true;
    // Say goodbye on every link we hold — the host link so we're dropped
    // from the roster at once, and the guest<->guest links so survivors
    // electing a successor don't wait on us.
    const bye = P.encode(P.makeBye(reason));
    const sent = new Set();
    const sendBye = (conn) => {
      if (!conn || sent.has(conn)) return;
      sent.add(conn);
      this.#sendRawOnConn(conn, bye);
    };
    if (!this.isHost) sendBye(this.#hostConn);
    for (const peer of this.#peers.values()) {
      if (!peer.closed) sendBye(peer.conn);
    }
    this.#teardownEverything(reason);
    this.emit('left', {});
  }

  // ---- host side ----

  /** Wait for HELLO from an inbound guest connection, then register it. */
  #setupInboundGuest(conn) {
    if (!this.isHost) {
      // We served this room but have since stood down (a lower-id survivor
      // claimed the meeting in the same migration). Send the newcomer back
      // to the lobby rather than welcoming them into an empty room.
      try {
        conn.close?.('not-the-host');
      } catch {
        /* noop */
      }
      return;
    }
    trace('host: inbound connection, waiting for HELLO');
    const timeout = setTimeout(() => {
      trace('host: no HELLO within', HELLO_TIMEOUT_MS, 'ms — closing');
      cleanup();
      try {
        conn.close?.('handshake-timeout');
      } catch {
        /* noop */
      }
    }, HELLO_TIMEOUT_MS);

    const onGone = () => cleanup();
    const cleanup = () => {
      clearTimeout(timeout);
      conn.removeEventListener('message', onMessage);
      conn.removeEventListener('close', onGone);
      conn.removeEventListener('error', onGone);
    };
    conn.addEventListener('close', onGone);
    conn.addEventListener('error', onGone);

    const onMessage = (event) => {
      const msg = P.parse(event.data);
      if (!msg || msg.t !== P.MSG.HELLO) {
        // A well-formed message on a different protocol version means a
        // stale deploy on one side — say so instead of timing out.
        const v = rawVersion(event.data);
        if (v !== null && v !== P.PROTOCOL_VERSION) {
          trace('host: HELLO with protocol', v, '— version mismatch, closing');
          cleanup();
          try {
            conn.close?.('version-mismatch');
          } catch {
            /* noop */
          }
        }
        return;
      }
      trace('host: HELLO from', msg.peer.id, '— welcoming');
      cleanup();

      // Someone we already list dialing in afresh is coming back: their
      // link to us died, or — after a takeover — they only ever reached us
      // through the old host. Put them on this connection; the roster, and
      // everyone else's picture of the meeting, stay as they are.
      const known = this.#peers.get(msg.peer.id);
      const returning = !!known && !known.closed && this.#isReturningGuest(known, msg);
      const peer = returning
        ? this.#reattachPeer(known, conn, msg.peer)
        : this.#registerPeer(conn, msg.peer, {
          });
      if (!peer) return;
      if (msg.token) peer.token = msg.token;
      if (returning) trace('host:', peer.id, 'is back on a new connection');

      // Welcome the newcomer with the current roster...
      const others = [...this.#peers.values()].filter((p) => p.id !== peer.id).map((p) => p.identity);
      this.#sendRawTo(
        peer,
        P.encode(P.makeWelcome(this.identity(), others, this.#term, this.#grant ?? '', this.#meetingSecret ?? ''))
      );
      // ...hand a returning peer the chat that may not have reached them
      // while their link was down (after the WELCOME: only then are they
      // listening)...
      if (returning) this.#resendChatTo(peer);
      // ...announce them to everyone else. The others already list a
      // returning peer, but the announcement carries their current state
      // (changes made while they were out of reach never got relayed) and
      // tells the others they can be reached through us again — a direct
      // link that went down with theirs, or an invite that was lost while
      // it was down, is renewed on the strength of it.
      const joined = P.encode(P.makePeerJoined(peer.identity));
      for (const other of this.#peers.values()) {
        if (other.id !== peer.id) this.#sendRaw(other, joined);
      }
      // ...and add media to the Puter-owned room connection.
      this.#startMediaWith(peer);
    };

    conn.addEventListener('message', onMessage);
  }

  /** Host: handle a message from a registered guest. */
  #onGuestMessage(peer, msg) {
    if (msg.t === P.MSG.HELLO) {
      // The guest retries HELLO until it sees WELCOME — ours may have
      // been lost while the channel settled. Re-send, idempotently.
      // A guest whose link to us was promoted by a takeover says HELLO
      // over it for the secret's sake: nothing else has told us theirs.
      if (!peer.token && msg.token && msg.peer.id === peer.id) peer.token = msg.token;
      trace('host: repeat HELLO from', peer.id, '— re-sending WELCOME');
      const others = [...this.#peers.values()].filter((p) => p.id !== peer.id).map((p) => p.identity);
      this.#sendRaw(
        peer,
        P.encode(P.makeWelcome(this.identity(), others, this.#term, this.#grant ?? '', this.#meetingSecret ?? ''))
      );
      return;
    }

    if (msg.t === P.MSG.TO) {
      // Route a targeted peer message to another guest, stamped with the sender.
      const target = this.#peers.get(msg.to);
      if (target && !target.closed) {
        this.#sendRaw(target, P.encode(P.makeFrom(peer.id, msg.msg)));
      }
      return;
    }

    if (msg.t === P.MSG.BYE) {
      this.#onPeerGone(peer, msg.reason || 'left');
      return;
    }

    // A chat we have already passed on is a re-send over a rebuilt link.
    if (this.#applyPeerMessage(peer, msg) === false) return;
    if (P.BROADCASTABLE.includes(msg.t)) {
      const wrapped = P.encode(P.makeFrom(peer.id, msg));
      for (const other of this.#peers.values()) {
        if (other.id === peer.id || other.closed) continue;
        // A guest whose link is down gets chat when it is back (#resendChatTo).
        if (msg.t === P.MSG.CHAT && other.linkLost) continue;
        this.#sendRaw(other, wrapped);
      }
    }
  }

  // ---- guest side ----

  /**
   * Guest: introduce ourselves and wait for the host's WELCOME.
   *
   * A handshake that never gets one has failed in one of two ways, and the
   * rejection says which. Either the transport under the connection never
   * came up — the signaller took the dial and the host answered the offer
   * (the remote description is set), yet ICE found no path: no relay
   * reachable, a symmetric NAT, a corporate network — which is tagged
   * `kind: 'no-media-path'`, because waiting will not fix it and the host
   * cannot help. Or the channel did open (or nothing ever answered) and the
   * WELCOME simply never came: a host that is gone, or not listening. ICE
   * reporting `failed` is definitive and is not waited out.
   */
  #handshakeWithHost(conn) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let helloTimer = null;
      let opened = false; // the data channel came up: whatever else fails, the transport did not
      const pc = conn.peerconnection;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(helloTimer);
        conn.removeEventListener('open', onOpen);
        conn.removeEventListener('message', onMessage);
        conn.removeEventListener('close', onClose);
        conn.removeEventListener('error', onError);
        conn.removeEventListener('linkstate', onTransportState);
        fn(value);
      };

      const transportFailed = () => pc?.connectionState === 'failed' || pc?.iceConnectionState === 'failed';
      const transportNeverCameUp = () => {
        if (opened || !pc) return false;
        if (transportFailed()) return true;
        // The host answered, and still no path was built by the time we gave up.
        const connected = pc.connectionState === 'connected' || /^(connected|completed)$/.test(pc.iceConnectionState ?? '');
        return !!pc.remoteDescription && !connected;
      };
      /** A failure of ours to report — tagged when the transport is what failed. */
      const failure = (message) => {
        const error = new Error(message);
        if (transportNeverCameUp()) error.kind = 'no-media-path';
        return error;
      };

      const timer = setTimeout(() => {
        trace(
          'guest: no WELCOME within',
          HANDSHAKE_TIMEOUT_MS,
          'ms (channel',
          opened ? 'open,' : 'never opened,',
          'connection',
          pc?.connectionState ?? '?',
          'ice',
          (pc?.iceConnectionState ?? '?') + ')'
        );
        // Reject first — closing may synchronously fire our own close
        // handler, and its generic reason would mask this message.
        finish(reject, failure('Timed out connecting to the meeting.'));
        try {
          conn.close?.('handshake-timeout');
        } catch {
          /* noop */
        }
      }, HANDSHAKE_TIMEOUT_MS);

      const sendHello = () => {
        try {
          conn.send(P.encode(P.makeHello(this.identity(), this.#secret)));
          trace('guest: HELLO sent');
        } catch {
          /* channel not open yet — retried below */
        }
      };
      const onOpen = () => {
        opened = true;
        sendHello();
      };
      const onTransportState = ({ state }) => {
        if (opened || (state !== 'recovering' && state !== 'closed')) return;
        trace('guest: the transport to the host failed before the handshake — no media path from here');
        finish(reject, failure('No connection to the meeting could be built from this network.'));
        try {
          conn.close?.('no-media-path');
        } catch {
          /* noop */
        }
      };
      const onMessage = (event) => {
        const msg = P.parse(event.data);
        if (!msg || msg.t !== P.MSG.WELCOME) {
          const v = rawVersion(event.data);
          if (v !== null && v !== P.PROTOCOL_VERSION) {
            trace('guest: host speaks protocol', v, '— version mismatch');
            finish(reject, new Error('version-mismatch'));
          }
          return;
        }
        trace('guest: WELCOME from host', msg.peer.id, 'with', msg.peers.length, 'other participant(s)');
        this.#onWelcome(conn, msg);
        finish(resolve, msg);
      };
      // A close with a reason is the far side's doing (the host turning us
      // away, say) — that is not our network. One without is whatever the
      // transport left us with.
      const onClose = (event) =>
        finish(
          reject,
          event?.reason ? new Error(event.reason) : failure('The meeting is unavailable. The host may have left.')
        );
      // Before the channel opens, the only negotiation under way is the one
      // that builds it, so an error there is the join failing. After it, the
      // error belongs to a renegotiation and the handshake is unaffected.
      const onError = (event) => {
        if (!opened) finish(reject, event?.error ?? new Error('Connection error.'));
      };

      conn.addEventListener('open', onOpen);
      conn.addEventListener('message', onMessage);
      conn.addEventListener('close', onClose);
      conn.addEventListener('error', onError);
      conn.addEventListener('linkstate', onTransportState);
      if (conn.connected) opened = true; // the library's flag: the channel was already up
      sendHello(); // the channel may already be open
      // Retry until WELCOME arrives: the first HELLO can be silently
      // dropped while the data channel is still settling, and the
      // host's WELCOME can be lost the same way.
      helloTimer = setInterval(sendHello, HELLO_RETRY_MS);
    });
  }

  /** Guest: process the host's WELCOME — register host + existing peers. */
  #onWelcome(conn, msg) {
    this.#hostId = msg.peer.id;
    // A meeting that has already migrated hands us its term, so a later
    // claim of ours can't be mistaken for an older one.
    if (msg.term > this.#term) this.#term = msg.term;
    this.#failedHosts.delete(msg.peer.id);
    // The host's grant is the meeting's: it is what our next redial, and
    // every guest<->guest link of ours, reaches the relays on.
    if (msg.grant) this.#adoptGrant(msg.grant);
    // So is its secret: should the host role fall to us, the room's lease
    // is ours to carry on under it.
    if (msg.secret) this.#meetingSecret = msg.secret;

    const known = this.#peers.get(msg.peer.id);
    // Dialing the same host again after our link to it died? Then this
    // WELCOME also tells us what we missed while nothing could reach us.
    const redialed = !!known && !known.closed && !known.conn && known.redialing;
    let host;
    if (known && !known.closed && !known.conn) {
      // We already list them without a way to reach them: as the host whose
      // link we are rebuilding, or as a survivor we only knew through the
      // host that left. This connection is the way now.
      host = this.#reattachPeer(known, conn, msg.peer);
    } else {
      host = this.#registerPeer(conn, msg.peer, {
      });
    }
    if (!host) {
      // We are already linked to them — a direct guest<->guest link that
      // landed while we were dialing. Keep it and drop this second
      // connection, rather than leaving the host link on a conn nothing
      // is listening to.
      if (known?.conn && known.conn !== conn) {
        this.#hostConn = known.conn;
        try {
          conn.close?.('already-linked');
        } catch {
          /* noop */
        }
        this.#resendOwnChat();
      }
      return;
    }

    for (const identity of msg.peers) {
      const listed = this.#peers.get(identity.id);
      // Someone we list already is told to us as they are now — what they
      // changed while our link was down never reached us.
      if (listed && !listed.closed) this.#adoptIdentity(listed, identity);
      else this.#registerRelayedPeer(identity);
    }
    if (redialed) {
      // Whoever we still list that the host no longer does left while we
      // were out of reach; their PEER_LEFT went the way of everything else
      // on the dead link. The host's roster is the meeting's.
      const present = new Set(msg.peers.map((p) => p.id));
      for (const peer of [...this.#peers.values()]) {
        if (peer !== host && !present.has(peer.id)) this.#teardownPeer(peer, 'left', /* silent */ false);
      }
    }
    // Direct links that went down with the host link can be rebuilt now
    // that invites have a way to travel again — and one we sent as the
    // link was dying went nowhere, so say it again.
    for (const peer of this.#peers.values()) {
      if (peer !== host) this.#renewDirectGuestLink(peer);
    }

    // Announce our streams, then add media to the Puter-owned host connection.
    this.#startMediaWith(host);
    // Chat typed while the link was in doubt goes out again now.
    this.#resendOwnChat();
  }

  /** Guest: handle a message arriving on the host connection. */
  #onHostMessage(peer, msg) {
    switch (msg.t) {
      case P.MSG.PEER_JOINED: {
        if (msg.peer.id === this.selfId) return;
        const known = this.#peers.get(msg.peer.id);
        if (known && !known.closed) {
          // Someone we list is back on the host after their link to it
          // died. Take their state as it stands now, and see to our own
          // link with them: an invite we sent while they were out of
          // reach never arrived.
          this.#adoptIdentity(known, msg.peer);
          this.#renewDirectGuestLink(known);
          return;
        }
        this.#registerRelayedPeer(msg.peer);
        break;
      }

      case P.MSG.PEER_LEFT: {
        const peer = this.#peers.get(msg.id);
        if (peer) this.#onPeerGone(peer, msg.reason);
        break;
      }

      case P.MSG.FROM: {
        const peer = this.#peers.get(msg.id);
        if (peer && !peer.closed) {
          this.#applyPeerMessage(peer, msg.msg);
        } else if (msg.msg.t === P.MSG.LINK_INVITE) {
          this.#queueLinkInvite(msg.id, msg.msg);
        }
        break;
      }

      case P.MSG.GRANT:
        // The host renewed its grant — ours, for the next redial or link.
        this.#adoptGrant(msg.grant);
        break;

      case P.MSG.BYE:
        this.#onHostLost(msg.reason || 'host left');
        break;

      default:
        // Plain content message — it's from the host itself.
        this.#applyPeerMessage(peer, msg);
    }
  }

  // ---- host migration ----

  /**
   * The host is gone. The meeting outlives it: drop the departed host and
   * elect a successor from the survivors.
   */
  #onHostLost(reason) {
    if (this.#left || this.isHost) return;
    const goneId = this.#hostId;
    this.#hostId = null;
    this.#hostConn = null;
    const host = goneId ? this.#peers.get(goneId) : null;
    if (host) this.#teardownPeer(host, reason, /* silent */ false);
    trace('mesh: host', goneId ?? '(unknown)', 'gone:', reason);

    // Someone noticed before we did and has already taken over — we set
    // their claim aside while our own link still answered. Act on it now
    // rather than running an election whose answer we already have.
    const pending = this.#pendingClaim;
    this.#pendingClaim = null;
    if (pending && pending.hostId !== goneId && pending.term > this.#term) {
      trace('mesh: applying the takeover we held back:', pending.hostId);
      this.#onHostClaim(pending, null);
      return;
    }
    trace('mesh: electing a successor');
    this.#migrate();
  }

  /**
   * The survivor that should take over: the lowest participant id among
   * those with a Puter account — only such a one can mint guest grants, so
   * guests without an account keep their relays — and, once no account is
   * left, the lowest id outright: the room directory takes anyone's writes,
   * so an anonymous host keeps the link alive for newcomers too.
   */
  #electHost(exclude = []) {
    const candidates = [
      { id: this.selfId, acct: this.#acct },
      ...[...this.#peers.values()].map((peer) => ({ id: peer.id, acct: peer.identity.acct !== false })),
    ].filter((candidate) => !this.#failedHosts.has(candidate.id) && !exclude.includes(candidate.id));
    candidates.sort((a, b) => (a.acct !== b.acct ? (a.acct ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return candidates[0]?.id ?? this.selfId;
  }

  /** Run (or re-run) the election after losing the host. */
  #migrate() {
    if (this.#left || this.isHost || this.#hostId) return;
    clearTimeout(this.#migrationTimer);
    this.#migrationTimer = null;

    const successor = this.#electHost();
    if (successor === this.selfId) {
      void this.#assumeHost(this.#term + 1);
      return;
    }
    trace('mesh: waiting for', successor, 'to claim the meeting');
    this.emit('host-migrating', { hostId: successor });
    // Everyone elects the same successor, so a claim should arrive almost
    // at once. If it doesn't, that candidate went down with the host —
    // strike it off and elect again rather than stalling forever.
    this.#migrationTimer = setTimeout(() => {
      this.#migrationTimer = null;
      if (this.#left || this.isHost || this.#hostId) return;
      trace('mesh:', successor, 'never claimed the meeting — re-electing');
      this.#failedHosts.add(successor);
      const stalled = this.#peers.get(successor);
      if (stalled) this.#teardownPeer(stalled, 'host-claim-timeout', /* silent */ false);
      this.#migrate();
    }, HOST_CLAIM_TIMEOUT_MS);
  }

  /** Take over the meeting: tell the mesh, then serve a room for newcomers. */
  async #assumeHost(term) {
    if (this.#left || this.isHost) return;
    this.#term = term;
    this.isHost = true;
    this.#hostId = this.selfId;
    this.#hostConn = null;
    this.#servedInvite = null;
    this.#pendingClaim = null;
    this.#failedHosts.clear();
    clearTimeout(this.#migrationTimer);
    this.#migrationTimer = null;
    trace('mesh: taking over as host (term', term + ')');

    // Claim the role before serving: the other survivors are on a claim
    // deadline, and standing up a Puter peer server can take seconds.
    this.#announceHostClaim();
    this.#repeatHostClaim();
    // Survivors we hold no link to — known only through the host that left,
    // or across a direct link that is down — can reach us only by dialing
    // the room we are about to serve. Give them a while to, as with any
    // guest whose link died; a survivor that never makes it (it may not
    // even have heard the claim) must not stay in the roster for good.
    for (const peer of this.#peers.values()) {
      if (peer.closed || peer.conn) continue;
      // What they may have missed goes back to when we lost the old host:
      // chat of ours, and chat relayed to us, from then on.
      peer.doubtSince ??= this.#hostDoubtSince ?? Date.now();
      // Their clock starts with the claim: they had no reason to dial us before.
      peer.troubleSince = Date.now();
      clearTimeout(peer.reconnectTimer);
      peer.reconnectTimer = null;
      this.#awaitGuestReturn(peer);
    }
    this.emit('host-changed', { hostId: this.selfId, name: this.#name, self: true });
    // Chat typed while the meeting had no host goes out behind the claim,
    // so the others read it as the host's by the time it lands.
    this.#resendOwnChat();

    let server;
    try {
      // With an account, a grant of our own goes with the room we serve; an
      // anonymous successor keeps handing on the one it was given.
      [server] = await Promise.all([getPuter().peer.serve(this.#peerOptions()), this.#mintGrant()]);
    } catch (error) {
      console.warn('[session] could not serve the meeting after taking over', error);
      if (this.#peers.size === 0) {
        // Alone, and unreachable by anyone else — nothing is left to hold open.
        this.#endMeeting('The meeting could not continue after the host left.');
        return;
      }
      this.emit('error', {
        message: 'The meeting is still running, but new participants can’t join right now.',
        error,
      });
      return;
    }
    if (this.#left || !this.isHost) {
      closePuterServer(server);
      return;
    }
    // A server kept alive by an earlier stand-down would otherwise be
    // orphaned by the overwrite and leak for the tab's lifetime.
    if (this.#server) this.#retiredServers.push(this.#server);
    this.#adoptServer(server);
    trace('mesh: serving the meeting at', server.inviteCode);
    // Now that newcomers have somewhere to land, publish the address.
    this.#setCode(server.inviteCode, 'takeover');
    this.#announceHostClaim();
    this.#startSelfProbe();
  }

  /**
   * Say it again, twice, a few seconds apart. A guest<->guest link that was
   * still being negotiated when we took over cannot carry the first claim,
   * and the peer on the far end would otherwise sit out its claim deadline
   * and split the meeting in two.
   */
  #repeatHostClaim() {
    this.#clearClaimRepeats();
    for (const delay of HOST_CLAIM_REPEATS_MS) {
      this.#claimRepeatTimers.push(
        setTimeout(() => {
          if (this.#left || !this.isHost) return;
          this.#announceHostClaim();
        }, delay)
      );
    }
  }

  #clearClaimRepeats() {
    for (const timer of this.#claimRepeatTimers) clearTimeout(timer);
    this.#claimRepeatTimers = [];
  }

  /** Stop hosting, having been outranked mid-migration. */
  #standDown() {
    // The server stays up — guests that dialed in through it are still
    // connected, and the claim we relay tells them where the meeting went.
    // #setupInboundGuest turns away anyone new while we aren't the host.
    this.isHost = false;
    this.#servedInvite = null;
    this.#stopSelfProbe();
  }

  #announceHostClaim() {
    const raw = P.encode(
      P.makeHostClaim({ hostId: this.selfId, term: this.#term, invite: this.#servedInvite ?? '' })
    );
    for (const peer of this.#peers.values()) {
      if (!peer.closed && peer.conn) this.#sendRawOnConn(peer.conn, raw);
    }
  }

  /**
   * Someone has taken over as host. Highest term wins; within a term the
   * lowest id wins, which settles the rare split where two survivors each
   * elected themselves.
   */
  #onHostClaim(msg, viaPeer) {
    if (this.#left || msg.hostId === this.selfId) return;
    if (msg.term < this.#term) return; // a straggler from an older term

    if (this.isHost) {
      // Someone else wants the meeting. At the same term that is a genuine
      // split election — two survivors elected themselves, lowest id wins.
      // A higher term means they decided we were gone, and they can only
      // have got that wrong: we are right here, still serving.
      if (msg.term !== this.#term || msg.hostId > this.selfId) return;
    } else if (this.#hostId && this.#hostId !== msg.hostId) {
      if (this.#hostConn) {
        // Our host is answering us. Whoever sent this lost their link to it,
        // not us — but our own link may simply be slower to notice, so keep
        // the claim for #onHostLost instead of tearing a live meeting apart.
        if (msg.term > (this.#pendingClaim?.term ?? -1)) this.#pendingClaim = msg;
        return;
      }
      // Already following someone this claim doesn't outrank.
      if (msg.term === this.#term && msg.hostId > this.#hostId) return;
    } else if (this.#hostId === msg.hostId) {
      // A re-announcement — it may carry the invite it couldn't include
      // the first time. Pass that on; ignore anything already known.
      if (msg.term > this.#term) this.#term = msg.term;
      if (!msg.invite || msg.invite === this.code) return;
      this.#setCode(msg.invite, 'claim');
      if (!this.#hostConn) void this.#connectToNewHost(msg.hostId, msg.invite);
      this.#relayHostClaim(msg, viaPeer);
      return;
    }

    const previousId = this.#hostId;
    this.#pendingClaim = null;
    this.#term = msg.term;
    this.#hostId = msg.hostId;
    this.#failedHosts.clear();
    clearTimeout(this.#migrationTimer);
    this.#migrationTimer = null;
    if (this.isHost) this.#standDown();
    if (previousId && previousId !== msg.hostId) {
      const previous = this.#peers.get(previousId);
      if (previous) this.#teardownPeer(previous, 'host left', /* silent */ false);
    }

    const host = this.#peers.get(msg.hostId);
    if (host?.conn) {
      // We already talk to them directly: that link simply becomes the host
      // link. Nothing is renegotiated, so media never stops.
      this.#hostConn = host.conn;
      trace('mesh:', msg.hostId, 'is now the host — promoted our direct link');
      this.#broadcastState(); // the new host needs our current state
      // ...and our secret, or it could not tell a return of ours from a
      // stranger dialing in with our id (this link never carried a HELLO).
      this.#sendRawToHost(P.encode(P.makeHello(this.identity(), this.#secret)));
      this.#resendOwnChat();
    } else {
      this.#hostConn = null;
      trace('mesh:', msg.hostId, 'is now the host — dialing in');
      if (msg.invite) void this.#connectToNewHost(msg.hostId, msg.invite);
    }
    if (msg.invite) this.#setCode(msg.invite, 'claim');
    this.emit('host-changed', { hostId: msg.hostId, name: host?.identity.name ?? 'Someone', self: false });
    this.#relayHostClaim(msg, viaPeer);
  }

  /**
   * Flood a claim onward, so participants with no direct link to the new
   * host hear about it from someone who has one.
   */
  #relayHostClaim(msg, viaPeer) {
    const raw = P.encode(P.makeHostClaim(msg));
    for (const peer of this.#peers.values()) {
      if (peer === viaPeer || peer.closed || !peer.conn || peer.id === msg.hostId) continue;
      this.#sendRawOnConn(peer.conn, raw);
    }
  }

  /** Dial the new host's fresh room, for survivors with no link to them. */
  async #connectToNewHost(hostId, invite) {
    if (this.#left || this.isHost || this.#hostConn) return;
    if (this.#hostId !== hostId || this.#connectingHostId === hostId) return;
    this.#connectingHostId = hostId;
    // We may list them already, with no connection of our own to them (we
    // knew them through the host that left, or our direct link went down).
    // That record stays: the WELCOME puts them onto the new connection in
    // place (#onWelcome -> #reattachPeer), so their tile never blinks out
    // and back in as a "join".

    try {
      for (let attempt = 1; attempt <= HOST_DIAL_ATTEMPTS; attempt++) {
        if (this.#left || this.#hostId !== hostId || this.#hostConn) return;
        const connecting = getPuter().peer.connect(invite, this.#peerOptions());
        let conn = null;
        try {
          conn = await withTimeout(connecting, CONNECT_TIMEOUT_MS, 'Could not reach the new host.');
          if (this.#left || this.#hostId !== hostId || this.#hostConn) {
            conn.close?.('stale-host-link');
            return;
          }
          this.#hostConn = conn;
          await this.#handshakeWithHost(conn);
          trace('mesh: joined the new host', hostId);
          return;
        } catch (error) {
          connecting.then((late) => late?.close?.('unreachable')).catch(() => {});
          // Undo only what we set — a competing path may own #hostConn now.
          if (conn && this.#hostConn === conn) this.#hostConn = null;
          if (this.#left || this.#hostId !== hostId) return;
          if (attempt < HOST_DIAL_ATTEMPTS) {
            trace('mesh: dialing the new host failed — retrying:', error?.message ?? error);
            continue;
          }
          // Another path (say, a promoted direct link) reached them while we
          // were failing — then there is nothing to fail over from.
          if (this.#hostConn) return;
          console.warn('[session] could not reach the new host', error);
          // Unreachable, and no longer in the running: they leave our
          // roster the way anyone we cannot get back to does.
          const unreachable = this.#peers.get(hostId);
          if (unreachable && !unreachable.conn) this.#teardownPeer(unreachable, 'unreachable', /* silent */ false);
          this.#hostId = null;
          this.#failedHosts.add(hostId);
          this.#migrate();
        }
      }
    } finally {
      if (this.#connectingHostId === hostId) this.#connectingHostId = null;
    }
  }

  /**
   * Take a freshly served room as the one newcomers reach us through, and
   * watch it for the two ways the library moves it under us. `reconnect`:
   * puter.js reopened a lost signaller socket and, the signaller minting a
   * code per socket, is now serving under a new invite — the published one
   * is dead from that moment, so the new one goes out at once, to the
   * room directory (#setCode, via 'code-changed') and to everyone in the call (a claim
   * re-announcement, so their redials use it too). `close`: the library
   * gave the room up for good — serve another.
   */
  #adoptServer(server) {
    this.#server = server;
    this.#servedInvite = server.inviteCode;
    server.addEventListener('connection', (event) => this.#onServerConnection(event));
    server.addEventListener('reconnect', (event) => this.#onServerReconnected(server, event));
  }

  /**
   * The library's signaller socket came back. It reclaims the session it
   * left behind where it can, and then the invite is the same one and the
   * guests already connected were never addressed by anything else — there
   * is nothing to publish and nobody to tell.
   *
   * A reclaim that failed is a different meeting address, so the directory
   * and everyone still in the call have to hear the new one.
   */
  #onServerReconnected(server, event) {
    if (this.#left || !this.isHost || server !== this.#server) return;
    this.#probeMisses = 0;
    if (event?.resumed) return;
    const invite = event?.inviteCode || server.inviteCode;
    if (!invite || invite === this.#servedInvite) return;
    trace(
      'host: the signaller session could not be reclaimed',
      // Absent means no token was presented at all, which is a client that
      // never had one — a server object that is not the one that registered.
      event?.refused ? `(${event.refused})` : '(no token was presented)',
      '— now serving at',
      invite,
      '(was',
      this.#servedInvite + ')'
    );
    this.#servedInvite = invite;
    this.#setCode(invite, 'reconnect');
    if (this.#peers.size) this.#announceHostClaim();
  }


  /** Route an inbound connection: our own self-probe, or a real newcomer. */
  #onServerConnection(event) {
    if (this.#left) return;
    const token = event?.user?.uuid;
    const seen = token ? this.#pendingProbes.get(token) : null;
    if (seen) {
      // Our probe reached us — the invite is alive. Drop the throwaway
      // connection; the probe needs nothing more than having been seen.
      seen();
      closeConn(event.conn, 'probe');
      return;
    }
    this.#setupInboundGuest(event.conn);
  }

  #startSelfProbe() {
    if (this.#stopProbeTimer) return;
    this.#probeMisses = 0;
    // A timer that keeps its cadence in a hidden tab: a host waiting alone
    // in a background tab is the one whose dead invite would otherwise go
    // unnoticed for a minute at a time (lib/timers.js).
    this.#stopProbeTimer = steadyInterval(() => void this.#probeServedInvite(), SELF_PROBE_INTERVAL_MS);
  }

  #stopSelfProbe() {
    this.#stopProbeTimer?.();
    this.#stopProbeTimer = null;
    this.#probing = false;
    this.#probeMisses = 0;
    for (const resolve of this.#pendingProbes.values()) resolve();
    this.#pendingProbes.clear();
  }

  /**
   * Dial our own invite to see whether the signaller still serves it — for
   * as long as we host, whoever is connected. The connections already up
   * say nothing about the invite (they outlive the socket that minted it),
   * and a dead invite under a live call is the one nobody in the meeting
   * would ever notice.
   */
  async #probeServedInvite() {
    if (this.#left || !this.isHost || !this.#servedInvite || this.#probing) return;
    this.#probing = true;
    const invite = this.#servedInvite;
    const token = crypto.randomUUID();
    // What the probe learns: 'alive' (the dial came back to our server),
    // 'dead' (the signaller said so outright), or 'missed' (nothing within
    // the timeout — the signaller, or our own network, may be the reason).
    let settle;
    const outcome = new Promise((resolve) => {
      settle = resolve;
    });
    this.#pendingProbes.set(token, () => settle('alive'));
    // Name the dial with a token so our server knows the connection for ours
    // (and so connect() skips the sign-in gate it runs for an account). We
    // only care about the signaller step — whether the dial comes back — not
    // about the data channel, so there is nothing to wait on past that, and
    // NO turnGrant: the probe is answered at signalling time, before ICE, so
    // it never needs a relay. Handing it one made every host mint guest-TURN
    // credentials and briefly hold a relay allocation every 15 s, for a
    // connection torn down at once — wasted metered relay usage that, on a
    // relay-bound network, competes with the real call's media.
    const opts = { anonToken: token };
    let dialer = null;
    let finished = false;
    const onDialError = (error) => {
      if (isInvalidInviteError(error)) settle('dead');
    };
    getPuter()
      .peer.connect(invite, opts)
      .then(
        (conn) => {
          dialer = conn;
          if (finished) {
            closeConn(conn, 'probe');
            return;
          }
          // The library resolves connect() as soon as the request is sent;
          // an invalid code is reported a moment later, as an error event.
          conn.addEventListener?.('error', (event) => onDialError(event?.error));
        },
        (error) => onDialError(error) // an older library may reject instead
      );
    try {
      const cancelMiss = steadyTimeout(() => settle('missed'), SELF_PROBE_SEEN_TIMEOUT_MS);
      const result = await outcome;
      cancelMiss();
      if (this.#left || !this.isHost || this.#servedInvite !== invite) return;
      if (result === 'alive') {
        this.#probeMisses = 0;
        return;
      }
      if (result === 'dead') {
        // The signaller has said it: no one can reach this invite. Not a
        // hiccup to wait out — serve another now.
        trace('host: the signaller no longer serves', invite, '— re-serving at once');
        this.#probeMisses = 0;
        await this.#reserve();
        return;
      }
      // A lone miss can be a passing signaller hiccup; only a run of them is
      // the socket being gone for good and worth rotating the invite over.
      this.#probeMisses += 1;
      trace('host: self-probe missed', this.#probeMisses, 'of', SELF_PROBE_MISSES_BEFORE_RESERVE, 'for', invite);
      if (this.#probeMisses >= SELF_PROBE_MISSES_BEFORE_RESERVE) {
        this.#probeMisses = 0;
        await this.#reserve();
      }
    } finally {
      this.#pendingProbes.delete(token);
      finished = true;
      closeConn(dialer, 'probe');
      this.#probing = false;
    }
  }

  /**
   * Serve the meeting afresh after our invite went dead, keeping the old
   * server alive for anyone still on it. Same host, same term — only the
   * address newcomers use changes, which #setCode announces for the
   * directory.
   */
  async #reserve() {
    if (this.#left || !this.isHost || !this.#server) return;
    let server;
    try {
      server = await getPuter().peer.serve(this.#peerOptions());
    } catch (error) {
      console.warn('[session] could not re-serve after the invite went dead', error);
      return; // the next probe tries again
    }
    if (this.#left || !this.isHost) {
      closePuterServer(server);
      return;
    }
    this.#retiredServers.push(this.#server);
    this.#adoptServer(server);
    trace('host: the served invite went dead — re-served at', server.inviteCode);
    this.#setCode(server.inviteCode, 'dead');
    // Anyone still holding only the dead invite is pointed at the new server.
    if (this.#peers.size) this.#announceHostClaim();
  }

  /**
   * The invite newcomers should use to reach the meeting right now. The
   * reason says why it moved: 'takeover' (we became the host), 'reconnect'
   * (the library reopened our signaller socket under a new code), 'dead'
   * (we re-served a dead invite), 'claim' (a guest following its host).
   */
  #setCode(code, reason) {
    if (!code || code === this.code) return;
    this.code = code;
    this.emit('code-changed', { code, reason });
  }

  #endMeeting(reason) {
    if (this.#left) return;
    this.#left = true;
    this.#teardownEverything(reason);
    this.emit('ended', { reason: reason || 'The meeting has ended.' });
  }

  // ---- guest grant ----

  /**
   * Options for puter.peer.serve() / connect(). With an account behind us,
   * none: the account speaks for itself. Without one, the anonymous token
   * that names us to the signaller, and the grant that gets us relays.
   */
  #peerOptions() {
    const options = { recoveryTimeout: LINK_RECOVERY_BUDGET_MS };
    if (this.#acct) return options;
    options.anonToken = this.#anonToken;
    if (this.#grant) options.turnGrant = this.#grant;
    return options;
  }

  /**
   * Host with an account: mint the grant guests use for relays, and keep
   * it renewed. Never rejects — a meeting is worth having with no relays
   * for its guests. A mint that fails is tried again in a while; one that
   * is merely slow is not waited for past a moment, and its grant is taken
   * up when it lands.
   */
  #mintGrant() {
    if (!this.#acct || this.#minting) return Promise.resolve();
    this.#minting = true;
    clearTimeout(this.#grantTimer);
    this.#grantTimer = null;
    const minting = mintGuestGrant()
      .then(
        (minted) => {
          this.#minting = false;
          // null: nothing to mint on, or a puter.js that cannot — for good.
          if (this.#left || !minted) return;
          const until = minted.expiresAt ? `(good until ${new Date(minted.expiresAt).toLocaleTimeString()})` : '';
          trace('host: guest grant ready', until);
          this.#grantFailures = 0;
          this.#stopRetryingGrantOnline();
          this.#adoptGrant(minted.grant, minted.expiresAt);
        },
        (error) => {
          this.#minting = false;
          if (this.#left) return;
          this.#grantFailures += 1;
          const delay = GRANT_RETRY_BACKOFF_MS[Math.min(this.#grantFailures, GRANT_RETRY_BACKOFF_MS.length) - 1];
          const inForce = this.#grantInForce();
          console.warn(
            `[session] could not mint a guest grant — ${inForce ? 'the current one still holds' : 'guests without an account get no relays'}; trying again in ${delay / 1000} s`,
            error
          );
          this.#scheduleGrantRenewal(delay);
          this.#retryGrantWhenOnline();
          this.emit('grant-failed', { error, inForce, retryInMs: delay });
        }
      )
      .catch(() => {});
    return withTimeout(minting, GRANT_MINT_WAIT_MS, 'The guest grant is taking a while.').catch(() => {});
  }

  /** Whether the grant we hand out is still accepted — guests have relays until it is not. */
  #grantInForce() {
    if (!this.#grant) return false;
    return this.#grantExpiresAt === null || Date.now() < this.#grantExpiresAt;
  }

  /**
   * A failed mint is most often the host briefly offline; the browser says
   * when that is over, and a minute's backoff is a long time to a guest
   * stuck outside. One listener, until a mint lands or the session ends.
   */
  #retryGrantWhenOnline() {
    if (this.#onOnline || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this.#onOnline = () => {
      this.#stopRetryingGrantOnline();
      if (this.#left || !this.isHost) return;
      trace('host: back online — minting the guest grant again');
      void this.#mintGrant();
    };
    window.addEventListener('online', this.#onOnline);
  }

  #stopRetryingGrantOnline() {
    if (!this.#onOnline) return;
    window.removeEventListener?.('online', this.#onOnline);
    this.#onOnline = null;
  }

  /**
   * A grant is in force: ours, freshly minted, or the host's, handed to us.
   * As host, everyone here hears of a change at once — the copy WELCOME
   * gave them would otherwise be what they redial on after it has expired.
   */
  #adoptGrant(grant, expiresAt = null) {
    if (this.#left || !grant) return;
    const changed = grant !== this.#grant;
    this.#grant = grant;
    this.#grantExpiresAt = expiresAt || null;
    if (expiresAt) {
      this.#scheduleGrantRenewal(Math.max(GRANT_RENEW_MIN_MS, (expiresAt - Date.now()) * GRANT_RENEW_FRACTION));
    }
    if (!changed) return;
    if (this.isHost) this.#sendToAllGuests(P.makeGrant(grant));
    this.emit('grant-changed', { grant });
  }

  #scheduleGrantRenewal(delay) {
    clearTimeout(this.#grantTimer);
    this.#grantTimer = setTimeout(() => {
      this.#grantTimer = null;
      if (this.#left || !this.isHost) return;
      void this.#mintGrant();
    }, delay);
  }

  // ---- shared peer lifecycle ----

  /** Register a peer backed by a Puter peer connection (host<->guest). */
  #registerPeer(conn, identity) {
    if (this.#left || identity.id === this.selfId || this.#peers.has(identity.id)) {
      if (this.isHost) {
        if (this.#peers.has(identity.id)) trace('host: HELLO for an id already in the meeting, without its secret — turning it away');
        try {
          conn.close?.('duplicate-or-self');
        } catch {
          /* noop */
        }
      }
      return null;
    }

    const peer = this.#makePeerRecord(identity, conn);
    this.#peers.set(peer.id, peer);

    this.#attachConnHandlers(peer, conn);
    this.#wireMedia(peer, conn);
    this.#addPeerToRoster(peer);
    return peer;
  }

  /** Register a guest peer whose direct Puter link is negotiated via the host. */
  #registerRelayedPeer(identity) {
    if (this.#left || identity.id === this.selfId || this.#peers.has(identity.id)) return null;

    const peer = this.#makePeerRecord(identity, null);
    this.#peers.set(peer.id, peer);

    this.#addPeerToRoster(peer);
    this.#drainQueuedLinkInvites(peer);
    this.#ensureDirectGuestLink(peer);
    return peer;
  }

  #makePeerRecord(identity, conn) {
    return {
      id: identity.id,
      identity,
      conn, // null until a relayed guest<->guest Puter link is ready
      mediaStarted: false,
      joinedEmitted: false,
      directConnecting: false,
      directServer: null,
      directInvite: null, //       connect side: the invite the current direct link came from
      directRetryTimer: null, //   serve side: next attempt at a direct link that failed
      directRetries: 0,
      streams: new Map(), //        name -> MediaStream
      linkLost: false, //          transport gone; a rebuild is under way or awaited
      troubleSince: null, //       when the link first showed trouble; LINK_DROP_MS runs from here
      unstableTimer: null, //      grace before a wobbling link earns its badge
      reconnectTimer: null, //     host only: deadline for the guest to dial back in
      token: '', //                host only: the secret their HELLO carried; a return must show it
      doubtSince: null, //         since when chat to them may not have got through (cleared once re-sent)
      redialing: false, //         guest only: dialing the host again right now
      closed: false,
    };
  }

  /**
   * Wire a connection's events to role-aware handlers. What a link means
   * can change under us — a guest<->guest link becomes the host link when
   * its far end takes the meeting over — so every event is dispatched
   * against the roles as they stand now, not as they stood at attach time.
   */
  #attachConnHandlers(peer, conn) {
    // A peer's connection is replaced when its link is rebuilt; the old
    // one's late events (its close, above all) must not be taken for the
    // new one's.
    const current = () => peer.conn === conn;
    conn.addEventListener('message', (event) => {
      if (current()) this.#onPeerMessage(peer, event);
    });
    conn.addEventListener('close', (event) => {
      if (current()) this.#onPeerConnLost(peer, event?.reason || 'connection closed');
    });
    // Not a link loss. puter.peer reports a negotiation that went wrong —
    // a description the browser refused, say — and then carries on; when
    // the connection is really finished it closes, and close is above.
    // Tearing the link down here turned every SDP hiccup into a rebuild.
    conn.addEventListener('error', (event) => {
      if (current()) trace('link to', peer.id, 'reported', event?.error?.message ?? 'an error');
    });
  }

  #onPeerMessage(peer, event) {
    if (this.#left || peer.closed) return;
    const msg = P.parse(event.data);
    if (!msg) return;
    if (msg.t === P.MSG.HOST_CLAIM) this.#onHostClaim(msg, peer);
    else if (this.isHost) this.#onGuestMessage(peer, msg);
    else if (peer.id === this.#hostId) this.#onHostMessage(peer, msg);
    else this.#onDirectPeerMessage(peer, msg);
  }

  /**
   * A connection closed. puter.peer restarts ICE by itself and only closes
   * once that has failed, so this is a transport that is genuinely gone
   * rather than merely stalled — but the participant may still be there.
   * An intentional leave arrives as BYE instead, and tears down for real.
   *
   * Who rebuilds depends on the link: a guest dials the host again; the
   * host cannot dial anyone, so it waits for the guest to come back; a
   * guest<->guest link is served again by whichever side served it first.
   */
  #onPeerConnLost(peer, reason) {
    if (this.#left || peer.closed) return;
    trace('link to', peer.id, 'closed:', reason);
    this.#markLinkLost(peer);
    if (this.isHost) {
      this.#awaitGuestReturn(peer);
    } else if (peer.id === this.#hostId) {
      void this.#redialHost(peer);
    } else {
      // Their last frame stays on the tile, marked stale, until the new
      // link has something to show instead.
      this.#dropDirectGuestLink(peer, reason, { keepStreams: true });
      this.#ensureDirectGuestLink(peer);
    }
  }

  /**
   * Adopt a connection's media. puter.peer names each slot, so a track says
   * what it is on arrival and there is nothing to announce or guess.
   *
   * The transport watch here is for the roster badge only: the SDK restarts
   * ICE by itself and closes the connection if that fails, so recovery is
   * driven off 'close', not off this.
   */
  #wireMedia(peer, conn) {
    peer.conn = conn;
    const current = () => peer.conn === conn;

    conn.addEventListener('media', ({ name, stream }) => {
      if (current()) this.#adoptRemoteStream(peer, name, stream);
    });
    conn.addEventListener('mediaended', ({ name }) => {
      if (current()) this.#onRemoteStreamEnded(peer, name);
    });

    conn.addEventListener('linkstate', ({ state }) => {
      if (!current()) return;
      if (state === 'connected') {
        const doubtSince = peer.doubtSince;
        this.#markLinkConnected(peer);
        // An ICE restart healed the link in place — no rebuild, so this is
        // the only chance to send again the chat it may have swallowed. A
        // rebuilt link does so after its WELCOME, once the far side listens.
        if (this.isHost) this.#resendChatTo(peer, doubtSince);
        else if (peer.id === this.#hostId) this.#resendOwnChat();
      } else if (state === 'recovering') {
        this.#noteTrouble(peer);
        // A restart is under way: say so now rather than sit out the grace.
        this.#clearUnstableGrace(peer);
        this.#markLinkLost(peer);
      } else if (state === 'unstable') {
        this.#noteTrouble(peer);
        this.#badgeWhenWobbleLasts(peer);
      }
    });
  }

  // ---- link loss & recovery ----

  /**
   * Host: a guest we have no working link to has until LINK_DROP_MS after
   * their link first showed trouble to come back, whether puter.peer heals
   * it in place or they dial back in (#markLinkConnected clears the
   * deadline), and is then given up as gone. The host cannot dial anyone,
   * so waiting is all it can do — but not for long, or the roster keeps a
   * ghost: a tile nobody is behind, and a participant count that is off by
   * one.
   */
  #awaitGuestReturn(peer) {
    this.#markLinkLost(peer);
    if (peer.reconnectTimer || peer.closed) return;
    const deadline = (peer.troubleSince ?? Date.now()) + LINK_DROP_MS;
    peer.reconnectTimer = setTimeout(() => {
      peer.reconnectTimer = null;
      // Stood down meanwhile: the host decides who has left, not us.
      if (this.#left || !this.isHost || peer.closed || !peer.linkLost) return;
      trace('link:', peer.id, 'never came back — dropping them');
      this.#lostTouch = true;
      this.#onPeerGone(peer, 'connection lost');
    }, Math.max(0, deadline - Date.now()));
  }

  /** A wobble that outlasts the grace is worth telling the user about. */
  #badgeWhenWobbleLasts(peer) {
    if (peer.linkLost || peer.unstableTimer) return;
    peer.unstableTimer = setTimeout(() => {
      peer.unstableTimer = null;
      if (!peer.closed && !this.#left) this.#markLinkLost(peer);
    }, LINK_UNSTABLE_BADGE_MS);
  }

  #clearUnstableGrace(peer) {
    clearTimeout(peer.unstableTimer);
    peer.unstableTimer = null;
  }

  #markLinkLost(peer) {
    this.#clearUnstableGrace(peer);
    this.#noteTrouble(peer);
    if (peer.linkLost) return;
    peer.linkLost = true;
    // The deadline starts with the trouble, not with puter.peer giving the
    // link up, so a guest that vanished is gone a minute later.
    if (this.isHost) this.#awaitGuestReturn(peer);
    this.roster.update(peer.id, { reconnecting: true });
    this.emit('peer-link', { peerId: peer.id, state: 'lost' });
    // Nobody is writing for the room while its host is unreachable, and the
    // entry lapses long before a successor is elected. Said as soon as the
    // link looks lost, which is well inside the directory's patience.
    if (!this.isHost && peer.id === this.#hostId) {
      this.emit('host-unreachable', { keeper: this.roomKeeperId });
    }
  }

  #markLinkConnected(peer) {
    this.#clearUnstableGrace(peer);
    clearTimeout(peer.reconnectTimer);
    peer.reconnectTimer = null;
    peer.troubleSince = null;
    if (!peer.linkLost) return;
    peer.linkLost = false;
    this.roster.update(peer.id, { reconnecting: false });
    this.emit('peer-link', { peerId: peer.id, state: 'connected' });
    if (!this.isHost && peer.id === this.#hostId) this.emit('host-reachable', {});
  }

  /**
   * A link has shown trouble: note since when, for the deadline that runs
   * from it and for the chat that may have to be sent again once it is back.
   */
  #noteTrouble(peer) {
    peer.troubleSince ??= Date.now();
    peer.doubtSince ??= peer.troubleSince;
    if (!this.isHost && peer.id === this.#hostId) this.#hostDoubtSince ??= peer.doubtSince;
  }

  /** Whether this chat is new here; remembers it either way. Chat with no id is always new. */
  #firstSight(msg) {
    if (!msg.id) return true;
    if (this.#seenChat.has(msg.id)) return false;
    this.#seenChat.add(msg.id);
    if (this.#seenChat.size > SEEN_CHAT_MAX) this.#seenChat.delete(this.#seenChat.values().next().value);
    return true;
  }

  #logChat(from, msg) {
    if (!msg.id) return; // nothing a re-send of it could be told apart by
    const now = Date.now();
    this.#chatLog.push({ from, msg, at: now });
    while (this.#chatLog.length > CHAT_LOG_MAX || now - this.#chatLog[0].at > CHAT_LOG_MAX_AGE_MS) {
      this.#chatLog.shift();
    }
  }

  #chatSince(since) {
    const from = since - CHAT_RESEND_LEAD_MS;
    return this.#chatLog.filter((entry) => entry.at >= from);
  }

  /**
   * Host: send a guest whose link came back every chat it may have missed
   * while the link was in doubt — ours plainly, everyone else's wrapped as
   * theirs, as it would have gone out the first time.
   */
  #resendChatTo(peer, since = peer.doubtSince) {
    peer.doubtSince = null;
    if (!this.isHost || peer.closed || !peer.conn || since == null) return;
    for (const { from, msg } of this.#chatSince(since)) {
      if (from === peer.id) continue;
      this.#sendRaw(peer, P.encode(from === this.selfId ? msg : P.makeFrom(from, msg)));
    }
  }

  /**
   * Guest (or a guest just become host): our link to the host was in doubt,
   * and there is a host to reach again — send again the chat we sent while
   * it was, which may have gone down with the old link.
   */
  #resendOwnChat() {
    const since = this.#hostDoubtSince;
    if (this.#left || since == null) return;
    if (!this.isHost && !this.#hostConn) return;
    this.#hostDoubtSince = null;
    for (const { from, msg } of this.#chatSince(since)) {
      if (from === this.selfId) this.#sendBroadcast(msg);
    }
  }

  /**
   * Host: is a HELLO for an id we already list from the participant we
   * list, dialing in afresh — and not someone else using their id? Every
   * participant learns every other id from WELCOME and PEER_JOINED, so the
   * id proves nothing; the secret their own HELLO carried does. A record
   * we never had a HELLO for (a survivor known only through the host that
   * left, a guest<->guest link a takeover promoted) has no secret to hold
   * this one against yet, and this HELLO's becomes theirs.
   */
  #isReturningGuest(peer, msg) {
    if (!peer.token) return true;
    return !!msg.token && msg.token === peer.token;
  }

  /**
   * Put a peer we already list onto a fresh connection. The old link is
   * closed and its streams withdrawn (new ones follow the negotiation on
   * the new link); the roster entry — name, pin, place in the grid — and
   * everything the rest of the meeting knows about them carry on.
   */
  #reattachPeer(peer, conn, identity) {
    const old = peer.conn;
    peer.conn = null; // from here the old connection's late events are ignored
    this.#closeDirectServer(peer);
    peer.mediaStarted = false;
    peer.directConnecting = false;
    this.#removePeerStreams(peer);
    if (old && old !== conn) {
      if (this.#hostConn === old) this.#hostConn = null;
      try {
        old.close?.('replaced');
      } catch {
        /* noop */
      }
    }
    this.#clearDirectRetry(peer);
    this.#adoptIdentity(peer, identity);
    this.#attachConnHandlers(peer, conn);
    this.#wireMedia(peer, conn);
    this.#markLinkConnected(peer);
    return peer;
  }

  /** A peer's identity as they just announced it — name and state. */
  #adoptIdentity(peer, identity) {
    peer.identity = identity;
    this.roster.update(peer.id, {
      name: identity.name,
      mic: identity.mic,
      cam: identity.cam,
      hand: identity.hand,
      presenting: identity.presenting,
    });
  }

  /**
   * Our link to the host died. Dial the meeting again — the host's server
   * is still up and its invite unchanged — and its WELCOME puts the host
   * back onto the new connection. Only once attempts have failed for the
   * whole redial window is the host taken to be gone for real, and the
   * meeting moves on without it the usual way.
   */
  async #redialHost(peer) {
    if (peer.redialing) return;
    peer.redialing = true;
    const hostId = peer.id;
    const old = peer.conn;
    peer.conn = null; // from here the old connection's late events are ignored
    peer.mediaStarted = false;
    // Their streams are kept: the tile holds the last frame that got
    // through, dimmed under "Reconnecting…", until the new link replaces
    // it (#reattachPeer) or we give the host up (#teardownPeer).
    if (this.#hostConn === old) this.#hostConn = null;
    // The old connection stays open until the outcome is known. Closing it
    // now would, on a path that still half-works, read as a hang-up at the
    // host's end and have it drop us just as we dial back in. The host
    // closes it itself once our HELLO lands on the new connection.
    const dropOld = () => {
      try {
        old?.close?.('reconnecting');
      } catch {
        /* noop */
      }
    };

    const moot = () => this.#left || peer.closed || this.isHost || this.#hostId !== hostId;
    // Attempts keep starting until the window closes; one already under way
    // runs to its own timeout.
    let windowClosed = false;
    const windowTimer = setTimeout(() => {
      windowClosed = true;
    }, HOST_REDIAL_WINDOW_MS);
    try {
      for (let attempt = 1; !windowClosed; attempt++) {
        // Another path may have reached the host meanwhile (a promoted
        // direct link, say) — then there is nothing left to rebuild.
        if (moot() || this.#hostConn) return;
        const invite = this.code;
        trace('link: dialing the host again at', invite, '(attempt', attempt + ')');
        const connecting = getPuter().peer.connect(invite, this.#peerOptions());
        let conn = null;
        try {
          conn = await withTimeout(connecting, CONNECT_TIMEOUT_MS, 'Could not reach the meeting.');
          if (moot() || this.#hostConn) {
            conn.close?.('stale-host-link');
            return;
          }
          this.#hostConn = conn;
          await this.#handshakeWithHost(conn);
          trace('link: back with the host');
          return;
        } catch (error) {
          connecting.then((late) => late?.close?.('unreachable')).catch(() => {});
          // Undo only what we set — a competing path may own #hostConn now.
          if (conn && this.#hostConn === conn) this.#hostConn = null;
          if (moot()) return;
          trace('link: dialing the host again failed:', error?.message ?? error);
          await sleep(HOST_REDIAL_RETRY_MS);
        }
      }
      if (moot() || this.#hostConn) return;
      console.warn('[session] could not get back to the host');
      this.#onHostLost('connection lost');
    } finally {
      clearTimeout(windowTimer);
      peer.redialing = false;
      dropOld();
    }
  }

  #addPeerToRoster(peer) {
    this.roster.add({
      id: peer.identity.id,
      name: peer.identity.name,
      mic: peer.identity.mic,
      cam: peer.identity.cam,
      hand: peer.identity.hand,
      presenting: peer.identity.presenting,
    });
    this.#emitPeerJoined(peer);
  }

  #emitPeerJoined(peer) {
    if (peer.joinedEmitted) return;
    const participant = this.roster.get(peer.id);
    if (!participant) return;
    peer.joinedEmitted = true;
    this.emit('peer-joined', { participant });
  }

  /** Start sending media to this peer. The names travel with the SDP. */
  #startMediaWith(peer) {
    if (!peer.conn || peer.closed) return;
    peer.conn.publish('camera', this.#media.stream);
    if (this.#media.screenStream) {
      peer.conn.publish('screen', this.#media.screenStream, { video: SCREEN_SEND_PROFILE });
    }
    peer.mediaStarted = true;
    this.#updateSendProfiles();
  }

  #ensureDirectGuestLink(peer) {
    if (this.isHost || this.#left || peer.closed || peer.conn || peer.directConnecting) return;
    if (!this.#hostConn) return;
    // Deterministic ownership avoids dueling temporary servers.
    if (this.selfId < peer.id) void this.#serveDirectGuestLink(peer);
  }

  /**
   * See to a direct link with a guest we have none with. Where a temp
   * server of ours is still waiting for them, its invite is sent again
   * rather than a new server stood up: the first copy went through the
   * host, and was lost if their host link was down at the time.
   */
  #renewDirectGuestLink(peer) {
    if (this.isHost || this.#left || peer.closed || peer.conn || !this.#hostConn) return;
    if (peer.directServer && this.selfId < peer.id) {
      trace('guest: re-sending direct Puter invite to', peer.id);
      this.#sendRawToHost(P.encode(P.makeTo(peer.id, P.makeLinkInvite(peer.directServer.inviteCode))));
      return;
    }
    this.#ensureDirectGuestLink(peer);
  }

  /**
   * A direct link attempt came to nothing. The serving side tries again
   * after a while, for as long as the peer is in the meeting — the host
   * drops a peer that has really gone, and that ends the retries.
   */
  #retryDirectGuestLink(peer) {
    if (this.isHost || this.#left || peer.closed || peer.conn || peer.directRetryTimer) return;
    if (this.selfId > peer.id) return; // the serving side owns the retry
    const delay = Math.min(DIRECT_LINK_RETRY_MS * 2 ** peer.directRetries, DIRECT_LINK_RETRY_MAX_MS);
    peer.directRetries++;
    trace('guest: direct link to', peer.id, 'failed — trying again in', delay, 'ms');
    peer.directRetryTimer = setTimeout(() => {
      peer.directRetryTimer = null;
      this.#ensureDirectGuestLink(peer);
    }, delay);
  }

  #clearDirectRetry(peer) {
    clearTimeout(peer.directRetryTimer);
    peer.directRetryTimer = null;
    peer.directRetries = 0;
  }

  async #serveDirectGuestLink(peer) {
    peer.directConnecting = true;
    let server = null;
    try {
      const puter = getPuter();
      // An anonymous guest serves this link on the host's grant too — the
      // options go into the relay lookup a serve() makes, same as connect().
      server = await puter.peer.serve(this.#peerOptions());
      if (this.#left || peer.closed || peer.conn) {
        closePuterServer(server);
        peer.directConnecting = false;
        return;
      }

      peer.directServer = server;
      const timeout = setTimeout(() => {
        if (peer.directServer !== server) return;
        trace('guest: direct link invite to', peer.id, 'timed out');
        cleanup();
        this.#closeDirectServer(peer, server);
        peer.directConnecting = false;
        this.#retryDirectGuestLink(peer);
      }, DIRECT_LINK_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        server.removeEventListener?.('connection', onConnection);
      };
      const onConnection = (event) => {
        cleanup();
        this.#acceptDirectGuestLink(peer, event.conn, server);
      };

      server.addEventListener('connection', onConnection);
      this.#sendRawToHost(P.encode(P.makeTo(peer.id, P.makeLinkInvite(server.inviteCode))));
      trace('guest: sent direct Puter invite to', peer.id);
    } catch (error) {
      if (server) closePuterServer(server);
      peer.directConnecting = false;
      console.warn('[session] direct peer serve failed', error);
      // Say so once; the retries are quiet about it.
      if (!peer.directRetries) this.emit('error', { message: 'Could not create a direct peer link.', error });
      this.#retryDirectGuestLink(peer);
    }
  }

  #acceptDirectGuestLink(peer, conn, server) {
    if (this.#left || peer.closed) {
      conn?.close?.('left');
      this.#closeDirectServer(peer, server);
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      this.#closeDirectServer(peer, server);
      peer.directConnecting = false;
      conn.close?.('direct-handshake-timeout');
      this.#retryDirectGuestLink(peer);
    }, HANDSHAKE_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      conn.removeEventListener('message', onMessage);
      conn.removeEventListener('close', onGone);
      conn.removeEventListener('error', onGone);
    };
    const onGone = () => {
      cleanup();
      this.#closeDirectServer(peer, server);
      peer.directConnecting = false;
      this.#retryDirectGuestLink(peer);
    };
    const onMessage = (event) => {
      const msg = P.parse(event.data);
      if (!msg || msg.t !== P.MSG.LINK_HELLO) return;
      if (msg.peer.id !== peer.id) {
        cleanup();
        this.#closeDirectServer(peer, server);
        peer.directConnecting = false;
        conn.close?.('wrong-peer');
        this.#retryDirectGuestLink(peer);
        return;
      }

      cleanup();
      peer.identity = msg.peer;
      // Do NOT close the temp server here: puter's server.close() iterates
      // its `connections` and closes each one — including the connection we
      // just accepted — which closes `conn.peerconnection`. The imminent
      // addTrack would then throw InvalidStateError (signalingState
      // 'closed'), killing guest<->guest media. We already stopped accepting
      // new connections in cleanup(); the server is torn down together with
      // the link (#dropDirectGuestLink / #teardownPeer -> #closeDirectServer).
      this.#activateDirectGuestLink(peer, conn);
      this.#sendRawOnConn(conn, P.encode(P.makeLinkReady(this.identity())));
      this.#startMediaWith(peer);
      trace('guest: accepted direct Puter link from', peer.id);
    };

    conn.addEventListener('message', onMessage);
    conn.addEventListener('close', onGone);
    conn.addEventListener('error', onGone);
  }

  async #connectDirectGuestLink(peer, inviteCode) {
    if (this.isHost || this.#left || peer.closed || peer.conn || peer.directConnecting) return;
    peer.directConnecting = true;

    const puter = getPuter();
    const connectPromise = puter.peer.connect(inviteCode, this.#peerOptions());
    let conn;
    try {
      conn = await withTimeout(connectPromise, CONNECT_TIMEOUT_MS, 'Could not connect to a direct peer link.');
    } catch (error) {
      connectPromise.then((c) => c?.close?.('timeout')).catch(() => {});
      peer.directConnecting = false;
      console.warn('[session] direct peer connect failed', error);
      this.emit('error', { message: 'Could not connect to a direct peer link.', error });
      return;
    }

    if (this.#left || peer.closed || peer.conn) {
      conn.close?.('stale-direct-link');
      peer.directConnecting = false;
      return;
    }

    peer.directInvite = inviteCode;
    try {
      await this.#handshakeDirectGuestLink(peer, conn);
    } catch (error) {
      peer.directConnecting = false;
      conn.close?.('direct-handshake-failed');
      console.warn('[session] direct peer handshake failed', error);
    }
  }

  #handshakeDirectGuestLink(peer, conn) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let helloTimer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(helloTimer);
        conn.removeEventListener('open', sendHello);
        conn.removeEventListener('message', onMessage);
        conn.removeEventListener('close', onClose);
        conn.removeEventListener('error', onError);
        fn(value);
      };

      const timer = setTimeout(
        () => finish(reject, new Error('Timed out connecting to a direct peer link.')),
        HANDSHAKE_TIMEOUT_MS
      );
      const sendHello = () => {
        try {
          conn.send(P.encode(P.makeLinkHello(this.identity())));
        } catch {
          /* channel not open yet */
        }
      };
      const onMessage = (event) => {
        const msg = P.parse(event.data);
        if (!msg || msg.t !== P.MSG.LINK_READY) return;
        if (msg.peer.id !== peer.id) {
          finish(reject, new Error('Direct peer link answered with the wrong participant.'));
          return;
        }
        peer.identity = msg.peer;
        this.#activateDirectGuestLink(peer, conn);
        this.#startMediaWith(peer);
        trace('guest: connected direct Puter link to', peer.id);
        finish(resolve, msg);
      };
      const onClose = (event) => finish(reject, new Error(event?.reason || 'Direct peer link closed.'));
      const onError = (event) => finish(reject, event?.error ?? new Error('Direct peer link error.'));

      conn.addEventListener('open', sendHello);
      conn.addEventListener('message', onMessage);
      conn.addEventListener('close', onClose);
      conn.addEventListener('error', onError);
      sendHello();
      helloTimer = setInterval(sendHello, HELLO_RETRY_MS);
    });
  }

  #activateDirectGuestLink(peer, conn) {
    if (this.#left || peer.closed) {
      conn.close?.('left');
      return;
    }
    peer.directConnecting = false;
    this.#clearDirectRetry(peer);
    // Whatever the old link left on the tile makes way for the new one's
    // streams — and must not be mistaken for them when they arrive.
    this.#removePeerStreams(peer);
    this.#attachConnHandlers(peer, conn);
    this.#wireMedia(peer, conn);
    this.#markLinkConnected(peer);
    // This link was being negotiated while the meeting changed hands — the
    // far end still has to hear about it from us.
    if (this.isHost && this.#term > 0) {
      this.#sendRawOnConn(
        conn,
        P.encode(P.makeHostClaim({ hostId: this.selfId, term: this.#term, invite: this.#servedInvite ?? '' }))
      );
    }
  }

  #onDirectPeerMessage(peer, msg) {
    switch (msg.t) {
      case P.MSG.BYE: {
        // BYE is only ever sent by leave(): the peer is leaving the meeting,
        // not just this link. Drop them entirely — with the host also gone
        // nobody will relay a PEER_LEFT for them, and a mere link-drop would
        // leave a ghost in the roster that elections wait 12s on.
        this.#teardownPeer(peer, msg.reason || 'left', /* silent */ false);
        // If we were waiting on this very peer to claim the meeting, don't
        // sit out the claim deadline — elect again without them.
        if (!this.isHost && !this.#hostId) this.#migrate();
        break;
      }
    }
  }

  /**
   * Let go of a direct link. Its streams go with it unless `keepStreams`:
   * a link lost to a dead transport is rebuilt, and until then the tile
   * holds the last frame, marked stale (#activateDirectGuestLink clears
   * it for the new link's streams).
   */
  #dropDirectGuestLink(peer, reason, { keepStreams = false } = {}) {
    if (peer.closed) return;
    // Free the temp server we kept open for this link's lifetime (serve
    // side only; a no-op on the connect side, where directServer is null).
    this.#closeDirectServer(peer);
    const conn = peer.conn;
    peer.conn = null;
    // Closed already when the far end hung up; not when the transport under
    // it died — then this is what frees the peer connection.
    try {
      conn?.close?.(reason);
    } catch {
      /* noop */
    }
    peer.mediaStarted = false;
    peer.directConnecting = false;
    peer.directInvite = null;
    if (!keepStreams) this.#removePeerStreams(peer);
    trace('guest: direct Puter link to', peer.id, 'closed:', reason);
  }

  #closeDirectServer(peer, server = peer.directServer) {
    if (peer.directServer === server) peer.directServer = null;
    closePuterServer(server);
  }

  #queueLinkInvite(peerId, msg) {
    if (!this.#pendingLinkInvites.has(peerId)) this.#pendingLinkInvites.set(peerId, []);
    this.#pendingLinkInvites.get(peerId).push(msg);
  }

  #drainQueuedLinkInvites(peer) {
    const queued = this.#pendingLinkInvites.get(peer.id);
    if (!queued?.length) return;
    this.#pendingLinkInvites.delete(peer.id);
    for (const msg of queued) this.#applyPeerMessage(peer, msg);
  }

  /** Content messages from a known peer (direct or relayed). */
  #applyPeerMessage(peer, msg) {
    switch (msg.t) {
      case P.MSG.STATE: {
        const state = { mic: msg.mic, cam: msg.cam, hand: msg.hand, presenting: msg.presenting };
        if (typeof msg.name === 'string') state.name = msg.name;
        // The identity we pass on in WELCOME and PEER_JOINED has to move
        // with it, or a newcomer is told the state this peer joined in.
        peer.identity = { ...peer.identity, ...state };
        this.roster.update(peer.id, state);
        break;
      }

      case P.MSG.CHAT:
        // Sent again over a rebuilt link, and already shown: say so, so the
        // host does not pass it on a second time either.
        if (!this.#firstSight(msg)) return false;
        this.#logChat(peer.id, msg);
        this.emit('chat', { peerId: peer.id, name: peer.identity.name, text: msg.text, ts: msg.ts, self: false });
        break;

      case P.MSG.REACTION:
        this.emit('reaction', { peerId: peer.id, name: peer.identity.name, emoji: msg.emoji, self: false });
        break;


      case P.MSG.LINK_INVITE:
        // The invite our current link came from, said again (a re-send
        // that crossed with our connecting) — nothing to do.
        if (peer.conn && msg.inviteCode === peer.directInvite) break;
        // A fresh invite from a peer we are already linked to means they
        // have given that link up as dead — follow them onto the new one
        // rather than clinging to a connection that no longer delivers.
        if (!this.isHost && peer.conn && !peer.directConnecting && peer.id !== this.#hostId) {
          this.#dropDirectGuestLink(peer, 'replaced by a fresh invite');
        }
        void this.#connectDirectGuestLink(peer, msg.inviteCode);
        break;
    }
  }

  /** Our identity, as carried in HELLO / WELCOME / PEER_JOINED. */
  identity() {
    return P.makeIdentity({
      id: this.selfId,
      name: this.#name,
      mic: this.#media.micOn,
      cam: this.#media.camOn,
      hand: this.hand,
      presenting: this.#media.presenting,
      acct: this.#acct,
    });
  }

  #addSelfToRoster() {
    this.roster.add({
      id: this.selfId,
      name: this.#name,
      isSelf: true,
      mic: this.#media.micOn,
      cam: this.#media.camOn,
      hand: this.hand,
      presenting: this.#media.presenting,
    });
  }

  // ---- remote streams ----

  #adoptRemoteStream(peer, kind, stream) {
    // A peer publishing a name we don't know about gets no tile.
    if (!P.STREAM_KINDS.includes(kind)) return;
    peer.streams.set(kind, stream);
    // Announced again for every track that lands in the stream, not only
    // the first: a name's tracks arrive one at a time, and the audio-level
    // monitor can only pick up a microphone once the track is actually in
    // the stream it was handed. Consumers adopt idempotently.
    this.emit('stream', { peerId: peer.id, kind, stream });
  }

  #onRemoteStreamEnded(peer, kind) {
    const stream = peer.streams.get(kind);
    if (!stream) return;
    peer.streams.delete(kind);
    this.emit('stream-removed', { peerId: peer.id, kind, stream });
  }

  #removePeerStreams(peer) {
    for (const [kind, stream] of peer.streams) {
      this.emit('stream-removed', { peerId: peer.id, kind, stream });
    }
    peer.streams.clear();
  }

  // ---- teardown ----

  #onPeerGone(peer, reason) {
    if (this.#peers.get(peer.id) !== peer || peer.closed) return;
    this.#teardownPeer(peer, reason, false);
    if (this.isHost && !this.#left) {
      // Tell the remaining guests.
      this.#sendToAllGuests(P.makePeerLeft(peer.id, reason));
    }
  }

  #teardownPeer(peer, reason, silent) {
    peer.closed = true;
    clearTimeout(peer.reconnectTimer);
    peer.reconnectTimer = null;
    this.#clearUnstableGrace(peer);
    this.#clearDirectRetry(peer);
    if (this.#peers.get(peer.id) === peer) this.#peers.delete(peer.id);
    this.#closeDirectServer(peer);
    this.#removePeerStreams(peer);
    const conn = peer.conn;
    peer.conn = null;
    if (conn && (this.isHost || conn !== this.#hostConn)) {
      try {
        conn.close?.(reason);
      } catch {
        /* noop */
      }
    }
    const participant = this.roster.remove(peer.id);
    this.#updateSendProfiles(); // fewer peers -> more bandwidth headroom each
    if (!silent && participant) {
      this.emit('peer-left', { participant, reason });
    }
  }

  #teardownEverything(reason) {
    for (const dispose of this.#mediaDisposers.splice(0)) dispose();
    clearTimeout(this.#migrationTimer);
    this.#migrationTimer = null;
    this.#clearClaimRepeats();
    this.#stopSelfProbe();
    clearTimeout(this.#grantTimer);
    this.#grantTimer = null;
    this.#stopRetryingGrantOnline();
    for (const peer of [...this.#peers.values()]) {
      this.#teardownPeer(peer, reason, /* silent */ true);
    }
    this.#peers.clear();
    this.#pendingLinkInvites.clear();
    this.#chatLog = [];
    if (this.#server) {
      closePuterServer(this.#server);
      this.#server = null;
    }
    for (const server of this.#retiredServers.splice(0)) closePuterServer(server);
    if (this.#hostConn) {
      try {
        this.#hostConn.close?.(reason);
      } catch {
        /* noop */
      }
      this.#hostConn = null;
    }
  }

  // ---- local state propagation ----

  #syncLocalTracks() {
    // Republishing a name swaps the tracks in place — no renegotiation, so
    // toggling camera or mic costs nothing.
    for (const peer of this.#peers.values()) peer.conn?.publish('camera', this.#media.stream);
    this.#broadcastState();
  }

  #broadcastState() {
    if (this.#left) return;
    this.roster.update(this.selfId, {
      name: this.#name,
      mic: this.#media.micOn,
      cam: this.#media.camOn,
      hand: this.hand,
      presenting: this.#media.presenting,
    });
    this.#sendBroadcast(
      P.makeState({
        name: this.#name,
        mic: this.#media.micOn,
        cam: this.#media.camOn,
        hand: this.hand,
        presenting: this.#media.presenting,
      })
    );
  }

  /** Rescale outgoing video to the call size (mesh upload = bitrate × peers). */
  #updateSendProfiles() {
    if (this.#left) return;
    const camera = cameraSendProfile(this.#peers.size);
    for (const peer of this.#peers.values()) {
      peer.conn?.configure('camera', { video: camera });
    }
  }

  // ---- transport helpers ----

  /**
   * Send a content message to everyone. As host: directly to each guest
   * (they know plain messages are ours). As guest: to the host, which
   * processes it and relays it wrapped in FROM{our id}.
   */
  #sendBroadcast(msg) {
    const raw = P.encode(msg);
    // Chat is worth delivering late; state and reactions are not — state
    // travels with the HELLO that rebuilds a link, a reaction is of its
    // moment.
    const holdable = msg.t === P.MSG.CHAT;
    if (this.isHost) {
      for (const peer of this.#peers.values()) {
        if (peer.closed) continue;
        // Chat for a guest whose link is down goes when it is back (#resendChatTo).
        if (holdable && peer.linkLost) continue;
        this.#sendRaw(peer, raw);
      }
    } else if (!this.#hostConn) {
      // No link to carry it: the host link is being rebuilt, or the meeting
      // is between hosts. Chat goes out with the next one (#resendOwnChat),
      // which our link being in doubt since now guarantees.
      if (holdable) this.#hostDoubtSince ??= Date.now();
    } else {
      this.#sendRawToHost(raw);
    }
  }

  #sendToAllGuests(msg) {
    const raw = P.encode(msg);
    for (const peer of this.#peers.values()) {
      if (!peer.closed) this.#sendRaw(peer, raw);
    }
  }

  #sendRawTo(peer, raw) {
    this.#sendRaw(peer, raw);
  }

  #sendRaw(peer, raw) {
    const conn = this.isHost ? peer.conn : this.#hostConn;
    this.#sendRawOnConn(conn, raw);
  }

  #sendRawToHost(raw) {
    this.#sendRawOnConn(this.#hostConn, raw, 'send to host failed');
  }

  #sendRawOnConn(conn, raw, label = 'send failed') {
    if (!conn) return;
    try {
      conn.send(raw);
    } catch (err) {
      console.warn(`[session] ${label}`, err);
    }
  }
}

/**
 * Best-effort protocol version of a raw frame ('null' if not ours).
 *
 * Only ever called on a frame P.parse() already rejected, which includes
 * one over P.MAX_FRAME_CHARS — so it has to honour that ceiling too, or
 * the cap would be no cap at all on the two handshake paths that ask for
 * a version. An oversized frame is not a version mismatch anyway.
 */
function rawVersion(raw) {
  if (typeof raw !== 'string' || raw.length > P.MAX_FRAME_CHARS) return null;
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg === 'object' && typeof msg.v === 'number' ? msg.v : null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeConn(conn, reason) {
  try {
    conn?.close?.(reason);
  } catch {
    /* noop */
  }
}

function closePuterServer(server) {
  if (!server) return;
  try {
    if (typeof server.close === 'function') server.close();
    else if (typeof server.stop === 'function') server.stop();
  } catch {
    /* noop */
  }
}
