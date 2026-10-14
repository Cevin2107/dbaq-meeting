/**
 * Wire protocol for meeting data channels (v4 — Puter-peer mesh with a
 * migrating host).
 *
 * One participant is the host: it owns the meeting server and relays
 * guest-to-guest traffic, and guest-to-guest Puter peer invite codes are
 * negotiated over that host connection:
 *
 *   guest --plain broadcastable--> host --FROM{id,msg}--> other guests
 *   guest --TO{to,link-invite}---> host --FROM{id,link-invite}--> target guest
 *
 * Plain (unwrapped) content messages received by a guest come from the
 * host itself.
 *
 * The host role is not fixed. When the host leaves, the survivors elect a
 * successor (lowest participant id, among those with a Puter account while
 * any is left) which serves a fresh room and floods HOST_CLAIM across the
 * mesh; everyone else re-points their host link at it. `term` counts
 * migrations so a late or duplicate claim can't unseat a newer host —
 * highest term wins, lowest id breaks a tie.
 *
 * Guests need no Puter account. The host's GUEST GRANT — its word that lets
 * someone without a session use the relays on its account — reaches them
 * in WELCOME, and again in GRANT whenever the host renews it, so a redial
 * or a guest<->guest link hours in still gets a relay. An identity's `acct`
 * says whether an account stands behind that participant: only such a one
 * can mint grants, so elections prefer it.
 *
 * Every message is a JSON envelope: { v, t, ...payload }.
 * Unknown or malformed messages are dropped by parse().
 */

export const PROTOCOL_VERSION = 4;

export const MSG = Object.freeze({
  HELLO: 'hello', //             guest -> host: introduce self
  WELCOME: 'welcome', //         host -> guest: host identity + current roster
  PEER_JOINED: 'peer-joined', // host -> guests: someone joined
  PEER_LEFT: 'peer-left', //     host -> guests: someone left
  TO: 'to', //                   guest -> host: route a targeted peer message
  FROM: 'from', //               host -> guest: relayed message with sender id
  LINK_INVITE: 'link-invite', // guest -> guest via host: temp Puter invite code
  LINK_HELLO: 'link-hello', //   guest -> guest direct: identify on temp link
  LINK_READY: 'link-ready', //   guest -> guest direct: temp link accepted
  STATE: 'state', //             name/media/hand state update
  CHAT: 'chat', //               chat message
  REACTION: 'reaction', //       emoji reaction
  BYE: 'bye', //                 graceful leave
  HOST_CLAIM: 'host-claim', //   a survivor has taken over as host (flooded)
  GRANT: 'grant', //             host -> guests: the guest grant, renewed
});

/** Message types the host relays to the other guests (fan-out). */
export const BROADCASTABLE = Object.freeze([
  MSG.STATE,
  MSG.CHAT,
  MSG.REACTION,
]);

/** Message types allowed inside a FROM envelope. */
const RELAYABLE = Object.freeze([...BROADCASTABLE, MSG.LINK_INVITE]);

/**
 * Shape of the participant identity carried by hello / welcome / peer-joined.
 * `acct` — a Puter account stands behind this participant — is read as true
 * when absent: a peer on a build that never said had to have one.
 */
export function makeIdentity({ id, name, mic, cam, hand, presenting, acct }) {
  return {
    id: String(id),
    name: sanitizeName(name),
    mic: !!mic,
    cam: !!cam,
    hand: !!hand,
    presenting: !!presenting,
    acct: acct !== false,
  };
}

/** Longest guest grant we carry (Puter caps its own at 512). */
export const MAX_GRANT_CHARS = 512;

/** Longest secret a HELLO may carry (ours is a UUID, 36 chars). */
export const MAX_TOKEN_CHARS = 128;

/**
 * A guest's HELLO carries a per-session secret alongside its identity. The
 * host keeps it, and only a later HELLO for the same id that presents it
 * again is taken as that participant coming back on a fresh connection —
 * everyone learns everyone else's id from WELCOME and PEER_JOINED, so the
 * id alone would let any participant evict, and stand in for, any other.
 * The secret goes to the host and no further.
 */
export function makeHello(identity, token = '') {
  return { v: PROTOCOL_VERSION, t: MSG.HELLO, peer: identity, token: normalizeToken(token) };
}

/**
 * The host's answer to a HELLO: who it is, who else is here, how many times
 * the meeting has changed hands — the guest grant, for a guest joining with
 * no Puter session to reach the relays on (empty when the host has none to
 * give) — and the MEETING SECRET: what the room directory's lease on this
 * meeting's link is held under (lib/rooms.js). Every participant learns it
 * so that whoever inherits the host role can carry the lease on. It is as
 * confidential as the link itself: anyone in the meeting may end up
 * hosting it.
 */
export function makeWelcome(hostIdentity, peers, term = 0, grant = '', secret = '') {
  return {
    v: PROTOCOL_VERSION,
    t: MSG.WELCOME,
    peer: hostIdentity,
    peers,
    term: normalizeTerm(term),
    grant: normalizeGrant(grant),
    secret: normalizeToken(secret),
  };
}

/** Host -> guests: a fresh guest grant, replacing the one WELCOME carried. */
export function makeGrant(grant) {
  return { v: PROTOCOL_VERSION, t: MSG.GRANT, grant: normalizeGrant(grant) };
}

/**
 * Announce that `hostId` is now the meeting's host, serving newcomers at
 * `invite`. Flooded over every link so it also reaches participants with
 * no direct link to the new host. `invite` may be empty: the successor
 * claims the role immediately and re-announces once its server is up.
 */
export function makeHostClaim({ hostId, term, invite }) {
  return {
    v: PROTOCOL_VERSION,
    t: MSG.HOST_CLAIM,
    hostId: String(hostId),
    term: normalizeTerm(term),
    invite: invite ? String(invite) : '',
  };
}

export function makePeerJoined(identity) {
  return { v: PROTOCOL_VERSION, t: MSG.PEER_JOINED, peer: identity };
}

export function makePeerLeft(id, reason = 'left') {
  return { v: PROTOCOL_VERSION, t: MSG.PEER_LEFT, id: String(id), reason: String(reason).slice(0, 200) };
}

export function makeLinkInvite(inviteCode) {
  return { v: PROTOCOL_VERSION, t: MSG.LINK_INVITE, inviteCode: String(inviteCode) };
}

export function makeLinkHello(identity) {
  return { v: PROTOCOL_VERSION, t: MSG.LINK_HELLO, peer: identity };
}

export function makeLinkReady(identity) {
  return { v: PROTOCOL_VERSION, t: MSG.LINK_READY, peer: identity };
}

export function makeTo(to, msg) {
  return { v: PROTOCOL_VERSION, t: MSG.TO, to: String(to), msg };
}

export function makeFrom(id, msg) {
  return { v: PROTOCOL_VERSION, t: MSG.FROM, id: String(id), msg };
}

export function makeState({ name, mic, cam, hand, presenting }) {
  return {
    v: PROTOCOL_VERSION, t: MSG.STATE, mic: !!mic, cam: !!cam, hand: !!hand, presenting: !!presenting,
    // Optional so older clients' state updates preserve the current name.
    ...(typeof name === 'string' ? { name: sanitizeName(name) } : {}),
  };
}

/**
 * A chat message. Its `id` lets a message be sent again over a rebuilt link
 * without anyone seeing it twice; peers on an older build drop it and show
 * the message as they always have.
 */
export function makeChat(text, ts, id) {
  return {
    v: PROTOCOL_VERSION,
    t: MSG.CHAT,
    text: String(text).slice(0, 4000),
    ts: ts ?? Date.now(),
    id: typeof id === 'string' && id ? id.slice(0, 64) : crypto.randomUUID(),
  };
}

export function makeReaction(emoji) {
  return { v: PROTOCOL_VERSION, t: MSG.REACTION, emoji: String(emoji).slice(0, 8) };
}

export function makeBye(reason = 'left') {
  return { v: PROTOCOL_VERSION, t: MSG.BYE, reason: String(reason).slice(0, 200) };
}

export function encode(msg) {
  return JSON.stringify(msg);
}

/** The names we publish media under, and the only ones we adopt. */
export const STREAM_KINDS = Object.freeze(['camera', 'screen']);

/**
 * Ceiling on an incoming frame, in characters.
 *
 * Every field the validator sees is bounded — names at 60, chat at 4000,
 * invite codes at 512 — now that SDP travels over the signaller rather than
 * through here. WELCOME is the largest thing left, and it grows only with
 * the roster, so this needs to clear a big meeting and nothing more.
 */
export const MAX_FRAME_CHARS = 65_536;

/**
 * Parse and validate an incoming raw message.
 * Returns the message object, or null if it should be dropped.
 */
export function parse(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_FRAME_CHARS) return null; // dropped unread
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  return validate(msg, /* allowEnvelope */ true);
}

/** Validate an already-decoded message object. */
export function validate(msg, allowEnvelope = true) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (msg.v !== PROTOCOL_VERSION) return null;

  switch (msg.t) {
    case MSG.HELLO:
      if (!isIdentity(msg.peer)) return null;
      return { v: msg.v, t: msg.t, peer: makeIdentity(msg.peer), token: normalizeToken(msg.token) };

    case MSG.LINK_HELLO:
    case MSG.LINK_READY:
    case MSG.PEER_JOINED:
      if (!isIdentity(msg.peer)) return null;
      return { v: msg.v, t: msg.t, peer: makeIdentity(msg.peer) };

    case MSG.WELCOME: {
      if (!isIdentity(msg.peer) || !Array.isArray(msg.peers)) return null;
      const peers = msg.peers.filter(isIdentity).map(makeIdentity);
      return {
        v: msg.v,
        t: msg.t,
        peer: makeIdentity(msg.peer),
        peers,
        term: normalizeTerm(msg.term),
        grant: normalizeGrant(msg.grant),
        secret: normalizeToken(msg.secret),
      };
    }

    case MSG.GRANT: {
      const grant = normalizeGrant(msg.grant);
      if (!grant) return null;
      return { v: msg.v, t: msg.t, grant };
    }

    case MSG.HOST_CLAIM: {
      if (typeof msg.hostId !== 'string' || !msg.hostId || msg.hostId.length > 128) return null;
      if (typeof msg.invite !== 'string' || msg.invite.length > 512) return null;
      return { v: msg.v, t: msg.t, hostId: msg.hostId, term: normalizeTerm(msg.term), invite: msg.invite };
    }

    case MSG.PEER_LEFT:
      if (typeof msg.id !== 'string' || !msg.id) return null;
      return {
        v: msg.v,
        t: msg.t,
        id: msg.id,
        reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : 'left',
      };

    case MSG.TO: {
      if (!allowEnvelope || typeof msg.to !== 'string' || !msg.to) return null;
      const inner = validate(msg.msg, false);
      if (!inner || inner.t !== MSG.LINK_INVITE) return null;
      return { v: msg.v, t: msg.t, to: msg.to, msg: inner };
    }

    case MSG.FROM: {
      if (!allowEnvelope || typeof msg.id !== 'string' || !msg.id) return null;
      const inner = validate(msg.msg, false);
      if (!inner || !RELAYABLE.includes(inner.t)) return null;
      return { v: msg.v, t: msg.t, id: msg.id, msg: inner };
    }

    case MSG.STATE:
      return makeState(msg);

    case MSG.CHAT: {
      if (typeof msg.text !== 'string' || !msg.text.trim()) return null;
      const chat = { v: msg.v, t: msg.t, text: msg.text.slice(0, 4000), ts: Number(msg.ts) || Date.now() };
      if (typeof msg.id === 'string' && msg.id && msg.id.length <= 64) chat.id = msg.id;
      return chat;
    }

    case MSG.REACTION:
      if (typeof msg.emoji !== 'string' || !msg.emoji) return null;
      return { v: msg.v, t: msg.t, emoji: msg.emoji.slice(0, 8) };

    case MSG.LINK_INVITE:
      if (typeof msg.inviteCode !== 'string' || !msg.inviteCode || msg.inviteCode.length > 512) return null;
      return { v: msg.v, t: msg.t, inviteCode: msg.inviteCode };

    case MSG.BYE:
      return { v: msg.v, t: msg.t, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : 'left' };

    default:
      return null;
  }
}

/** A HELLO secret is a bounded string; anything else reads as none. */
function normalizeToken(token) {
  return typeof token === 'string' && token.length <= MAX_TOKEN_CHARS ? token : '';
}

/** A guest grant is a bounded string; anything else reads as none. */
function normalizeGrant(grant) {
  return typeof grant === 'string' && grant.length <= MAX_GRANT_CHARS ? grant : '';
}

/** Migration terms are non-negative integers; anything else reads as 0. */
function normalizeTerm(term) {
  const n = Number(term);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isIdentity(peer) {
  return (
    peer &&
    typeof peer === 'object' &&
    typeof peer.id === 'string' &&
    peer.id.length > 0 &&
    peer.id.length <= 128 &&
    typeof peer.name === 'string'
  );
}

/** Trim, collapse whitespace, and bound the length of display names. */
export function sanitizeName(name) {
  const cleaned = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || 'Guest';
}
