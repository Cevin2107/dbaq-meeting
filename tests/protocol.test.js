import { describe, it, expect } from 'vitest';
import * as P from '../src/lib/protocol.js';

const identity = () =>
  P.makeIdentity({ id: 'peer-1', name: 'Ada', mic: true, cam: false, hand: false, presenting: false });

describe('hello / welcome / peer-joined / peer-left', () => {
  it('hello round-trips through encode/parse', () => {
    const msg = P.parse(P.encode(P.makeHello(identity())));
    expect(msg.t).toBe(P.MSG.HELLO);
    expect(msg.peer).toMatchObject({ id: 'peer-1', name: 'Ada', mic: true, cam: false });
  });

  it('sanitizes names on parse', () => {
    const raw = P.encode({ v: P.PROTOCOL_VERSION, t: 'hello', peer: { id: 'x', name: '  A   B  ' } });
    expect(P.parse(raw).peer.name).toBe('A B');
  });

  it('hello carries the guest\'s secret to the host, bounded, and nothing else takes one', () => {
    expect(P.parse(P.encode(P.makeHello(identity(), 'shh'))).token).toBe('shh');
    expect(P.parse(P.encode(P.makeHello(identity()))).token).toBe('');
    // Not a string, or absurdly long: read as none rather than dropped.
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'hello', peer: identity(), token: 42 })).token).toBe('');
    expect(
      P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'hello', peer: identity(), token: 'x'.repeat(P.MAX_TOKEN_CHARS + 1) }))
        .token
    ).toBe('');
    // The roster messages never carry it on, so it cannot leak to other guests.
    expect(P.parse(P.encode(P.makePeerJoined(identity())))).not.toHaveProperty('token');
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'peer-joined', peer: identity(), token: 'shh' }))).not.toHaveProperty(
      'token'
    );
  });

  it('drops hellos without a valid identity', () => {
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'hello', peer: { name: 'no id' } }))).toBeNull();
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'hello' }))).toBeNull();
  });

  it('welcome carries the host identity and filters malformed roster entries', () => {
    const raw = P.encode(
      P.makeWelcome(identity(), [
        P.makeIdentity({ id: 'p2', name: 'Bo' }),
        { name: 'no id' },
        null,
      ])
    );
    const msg = P.parse(raw);
    expect(msg.t).toBe(P.MSG.WELCOME);
    expect(msg.peer.id).toBe('peer-1');
    expect(msg.peers).toHaveLength(1);
    expect(msg.peers[0]).toMatchObject({ id: 'p2', name: 'Bo' });
  });

  it('welcome without a peers array is dropped', () => {
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'welcome', peer: identity() }))).toBeNull();
  });

  it('an identity says whether an account stands behind it, and assumes one when unsaid', () => {
    expect(identity().acct).toBe(true);
    expect(P.makeIdentity({ id: 'p', name: 'A', acct: false }).acct).toBe(false);
    // A peer on a build that never said had to have one.
    const legacy = P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'hello', peer: { id: 'x', name: 'Old' } }));
    expect(legacy.peer.acct).toBe(true);
    const anon = P.parse(P.encode(P.makeHello(P.makeIdentity({ id: 'x', name: 'Anon', acct: false }))));
    expect(anon.peer.acct).toBe(false);
  });

  it('welcome carries the meeting secret, bounded, and reads none when absent', () => {
    expect(P.parse(P.encode(P.makeWelcome(identity(), [], 2, '', 'meeting-secret-1'))).secret).toBe('meeting-secret-1');
    expect(P.parse(P.encode(P.makeWelcome(identity(), []))).secret).toBe('');
    expect(
      P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'welcome', peer: identity(), peers: [], secret: 'x'.repeat(200) }))
        .secret
    ).toBe('');
    expect(
      P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'welcome', peer: identity(), peers: [], secret: 42 })).secret
    ).toBe('');
  });

  it('welcome carries the host’s guest grant, bounded, and reads none when absent', () => {
    expect(P.parse(P.encode(P.makeWelcome(identity(), [], 2, 'pg1.abc.def'))).grant).toBe('pg1.abc.def');
    expect(P.parse(P.encode(P.makeWelcome(identity(), []))).grant).toBe('');
    expect(
      P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'welcome', peer: identity(), peers: [], grant: 42 })).grant
    ).toBe('');
    expect(
      P.parse(
        P.encode({ v: P.PROTOCOL_VERSION, t: 'welcome', peer: identity(), peers: [], grant: 'x'.repeat(P.MAX_GRANT_CHARS + 1) })
      ).grant
    ).toBe('');
  });

  it('grant renewals come from the host alone — never relayed, never routed', () => {
    expect(P.parse(P.encode(P.makeGrant('pg1.new')))).toEqual({ v: P.PROTOCOL_VERSION, t: P.MSG.GRANT, grant: 'pg1.new' });
    expect(P.parse(P.encode(P.makeGrant('')))).toBeNull();
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'grant', grant: 'x'.repeat(P.MAX_GRANT_CHARS + 1) }))).toBeNull();
    expect(P.parse(P.encode(P.makeFrom('p2', P.makeGrant('pg1.forged'))))).toBeNull();
    expect(P.parse(P.encode(P.makeTo('p2', P.makeGrant('pg1.forged'))))).toBeNull();
    expect(P.BROADCASTABLE).not.toContain(P.MSG.GRANT);
  });

  it('peer-joined and peer-left validate their payloads', () => {
    expect(P.parse(P.encode(P.makePeerJoined(identity()))).peer.id).toBe('peer-1');
    const left = P.parse(P.encode(P.makePeerLeft('p9', 'connection lost')));
    expect(left).toMatchObject({ id: 'p9', reason: 'connection lost' });
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'peer-left' }))).toBeNull();
  });
});

describe('routing envelopes (to / from)', () => {
  it('to routes Puter link invites, and nothing else', () => {
    const invite = P.parse(P.encode(P.makeTo('p2', P.makeLinkInvite('invite-123'))));
    expect(invite).toMatchObject({ t: P.MSG.TO, to: 'p2' });
    expect(invite.msg).toMatchObject({ t: P.MSG.LINK_INVITE, inviteCode: 'invite-123' });

    const chatInside = P.parse(P.encode(P.makeTo('p2', P.makeChat('hi'))));
    expect(chatInside).toBeNull();
  });

  it('from relays broadcastables and link invites stamped with the sender', () => {
    const chat = P.parse(P.encode(P.makeFrom('p1', P.makeChat('hello'))));
    expect(chat).toMatchObject({ t: P.MSG.FROM, id: 'p1' });
    expect(chat.msg).toMatchObject({ t: P.MSG.CHAT, text: 'hello' });

    const invite = P.parse(P.encode(P.makeFrom('p1', P.makeLinkInvite('invite-abc'))));
    expect(invite.msg).toMatchObject({ t: P.MSG.LINK_INVITE, inviteCode: 'invite-abc' });
  });

  it('rejects nested envelopes', () => {
    const nested = P.makeFrom('p1', P.makeFrom('p2', P.makeChat('x')));
    expect(P.parse(P.encode(nested))).toBeNull();
    const toInTo = P.makeTo('p1', P.makeTo('p2', P.makeLinkInvite('invite-x')));
    expect(P.parse(P.encode(toInTo))).toBeNull();
  });

  it('rejects envelopes without ids and non-relayable inners', () => {
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'from', msg: P.makeChat('x') }))).toBeNull();
    expect(P.parse(P.encode(P.makeFrom('p1', P.makeBye())))).toBeNull();
    expect(P.parse(P.encode(P.makeFrom('p1', P.makeHello(identity()))))).toBeNull();
  });
});

describe('state / chat / reaction', () => {
  it('normalizes state to booleans', () => {
    const msg = P.parse(
      P.encode({ v: P.PROTOCOL_VERSION, t: 'state', mic: 1, cam: 0, hand: 'yes', presenting: undefined })
    );
    expect(msg).toEqual({ v: P.PROTOCOL_VERSION, t: 'state', mic: true, cam: false, hand: true, presenting: false });
  });

  it('drops empty chat messages and bounds length', () => {
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'chat', text: '   ' }))).toBeNull();
    const long = P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'chat', text: 'x'.repeat(9000), ts: 5 }));
    expect(long.text.length).toBe(4000);
    expect(long.ts).toBe(5);
  });

  it('parses reactions and rejects empty ones', () => {
    expect(P.parse(P.encode(P.makeReaction('🎉'))).emoji).toBe('🎉');
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'reaction', emoji: '' }))).toBeNull();
  });
});

describe('frame ceiling', () => {
  it('drops a frame too big to be real, without parsing it', () => {
    const huge = P.encode(P.makeChat('x')).replace('"x"', `"${'x'.repeat(P.MAX_FRAME_CHARS)}"`);
    expect(P.parse(huge)).toBeNull();
  });

  it('clears a roster big enough for any real meeting', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      P.makeIdentity({ id: `peer-${i}`, name: `Participant ${i}`, mic: true, cam: true })
    );
    const welcome = P.encode(P.makeWelcome(identity(), many, 1, 'grant', 'secret'));
    expect(welcome.length).toBeLessThan(P.MAX_FRAME_CHARS);
    expect(P.parse(welcome)).not.toBeNull();
  });
});

describe('direct Puter link messages', () => {
  it('validates guest-guest link invites', () => {
    expect(P.parse(P.encode(P.makeLinkInvite('invite-1'))).inviteCode).toBe('invite-1');
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'link-invite', inviteCode: '' }))).toBeNull();
  });

  it('validates direct link hello and ready identities', () => {
    expect(P.parse(P.encode(P.makeLinkHello(identity()))).peer.id).toBe('peer-1');
    expect(P.parse(P.encode(P.makeLinkReady(identity()))).peer.id).toBe('peer-1');
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'link-ready', peer: { name: 'no id' } }))).toBeNull();
  });
});

describe('envelope validation', () => {
  it('drops non-JSON, wrong version, and unknown types', () => {
    expect(P.parse('not json')).toBeNull();
    expect(P.parse(P.encode({ v: 99, t: 'chat', text: 'hi' }))).toBeNull();
    expect(P.parse(P.encode({ v: 1, t: 'chat', text: 'hi' }))).toBeNull(); // old protocol
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'mystery' }))).toBeNull();
    expect(P.parse(P.encode([1, 2, 3]))).toBeNull();
    expect(P.parse(42)).toBeNull();
  });

  it('defaults bye reason', () => {
    expect(P.parse(P.encode({ v: P.PROTOCOL_VERSION, t: 'bye' })).reason).toBe('left');
    expect(P.parse(P.encode(P.makeBye('host-ended'))).reason).toBe('host-ended');
  });
});

describe('sanitizeName', () => {
  it('collapses whitespace and trims', () => {
    expect(P.sanitizeName('  Ada   Lovelace ')).toBe('Ada Lovelace');
  });

  it('bounds length to 60 chars', () => {
    expect(P.sanitizeName('x'.repeat(200)).length).toBe(60);
  });

  it('falls back to Guest', () => {
    expect(P.sanitizeName('')).toBe('Guest');
    expect(P.sanitizeName(null)).toBe('Guest');
    expect(P.sanitizeName('    ')).toBe('Guest');
  });
});
