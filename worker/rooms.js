/**
 * Puter Meetings — the room directory.
 *
 * A Puter Worker (https://docs.puter.com/Workers/) that answers one
 * question for every meeting link: what is running behind this room code
 * right now? It is the single place a room's live invite is written and
 * read, backed by the worker's own key-value store (`me.puter.kv` — the
 * store of the `sandbox-puter-meetings-rooms` app the deploy makes), so
 * there is exactly one record per room, one clock (this one), and one
 * answer for everyone who asks.
 *
 *   GET  /v1/rooms/:code        what is running: `room` (live entry) or null
 *   POST /v1/rooms/:code        claim the room, or heartbeat/update a claim
 *   POST /v1/rooms/:code/end    release the room (fenced by term, like a write)
 *   GET  /v1/health             liveness
 *
 * A LEASE, not a lock. The first host to POST claims the room and picks a
 * `secret` that every later write must repeat. Anyone in the meeting learns
 * the secret (the host hands it out in WELCOME), so when the host role
 * moves to another participant, the successor's heartbeats simply continue
 * the same lease. A lease that is not heartbeated for TTL_MS is gone — a
 * host whose tab died holds nothing for long — and whoever POSTs next
 * takes the room over. A fresh lease under a different secret answers
 * 409 `held`, with the live entry, so the loser knows whose meeting to
 * join instead of hosting a second one.
 *
 * Freshness is judged HERE, with this clock, and reported in ages: a
 * client never compares its own clock to anyone else's. Two claims that
 * land in the same instant are settled by a read-back — whoever's write
 * stands is the holder; the other is told so — and every holder's first
 * heartbeat re-checks.
 *
 * Bodies are JSON sent as text/plain, so browsers make no CORS preflight
 * and `navigator.sendBeacon` can post the same thing on the way out. The
 * runtime adds `Access-Control-Allow-Origin: *`; nothing here needs a
 * Puter session — a room code is the capability, as the link already is.
 *
 * Deploy (once; later deploys overwrite the file behind the same name):
 *   puter worker deploy worker/rooms.js puter-meetings-rooms
 */

/** A live entry not heartbeated for this long is a host that vanished. */
const TTL_MS = 60_000;
/** An entry claimed with no invite yet: the host is serving as we speak. */
const STARTING_TTL_MS = 20_000;
/** How long the store keeps a record at most — a backstop, never the rule. */
const KEEP_S = 10 * 60;
const MAX_BODY_CHARS = 4096;
const MAX_SECRET_CHARS = 128;
const MAX_INVITE_CHARS = 128;
const MAX_GRANT_CHARS = 512;
const MAX_HOST_CHARS = 80;
const MAX_PARTICIPANTS = 10_000;
/**
 * Ceiling on a meeting's term. It counts host handovers, not people, so it
 * needs a bound of its own: sharing the participant cap silently read an
 * overflowing term as 0, which under the fencing below would wedge the room
 * for good.
 */
const MAX_TERM = 1_000_000;

/** Room codes: abc-defg-hij (this app) and abcd-efgh-ijkl (minted elsewhere). */
const LETTERS_BY_LENGTH = { 10: [3, 4, 3], 12: [4, 4, 4] };

function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const letters = input.trim().toLowerCase().replace(/[\s-]/g, '');
  const groups = LETTERS_BY_LENGTH[letters.length];
  if (!groups || /[^a-z]/.test(letters)) return null;
  let i = 0;
  return groups.map((len) => letters.slice(i, (i += len))).join('-');
}

const keyFor = (code) => `room:${code}`;

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const text = (value, max) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);
const count = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);

/** Whether an entry still speaks for the room. */
function isFresh(entry, now) {
  if (!entry || typeof entry.at !== 'number') return false;
  return now - entry.at < (entry.invite ? TTL_MS : STARTING_TTL_MS);
}

/** The entry as everyone may see it: everything but the secret, plus its age. */
function publicView(entry, now) {
  return {
    code: entry.code,
    invite: entry.invite ?? null,
    grant: entry.grant ?? null,
    host: entry.host ?? null,
    participants: entry.participants ?? 1,
    startedAt: entry.startedAt ?? null,
    term: entry.term ?? 0,
    age: Math.max(0, now - entry.at),
  };
}

async function readEntry(code) {
  const raw = await me.puter.kv.get(keyFor(code));
  if (raw === null || raw === undefined) return null;
  try {
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

async function writeEntry(code, entry, now) {
  await me.puter.kv.set(keyFor(code), JSON.stringify(entry), Math.floor(now / 1000) + KEEP_S);
}

async function readBody(request) {
  const body = await request.text();
  if (body.length > MAX_BODY_CHARS) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

router.get('/v1/health', () => reply(200, { ok: true, now: Date.now() }));

router.get('/v1/rooms/:code', async ({ params }) => {
  const code = normalizeCode(params.code);
  if (!code) return reply(400, { ok: false, reason: 'bad_code' });
  const now = Date.now();
  try {
    const entry = await readEntry(code);
    return reply(200, { ok: true, now, room: isFresh(entry, now) ? publicView(entry, now) : null });
  } catch (error) {
    return reply(503, { ok: false, reason: 'store', message: String(error?.message ?? error) });
  }
});

router.post('/v1/rooms/:code', async ({ request, params }) => {
  const code = normalizeCode(params.code);
  if (!code) return reply(400, { ok: false, reason: 'bad_code' });
  const body = await readBody(request);
  const secret = body ? text(body.secret, MAX_SECRET_CHARS) : null;
  if (!secret) return reply(400, { ok: false, reason: 'bad_body' });
  if (body.invite !== undefined && body.invite !== null && !text(body.invite, MAX_INVITE_CHARS)) {
    return reply(400, { ok: false, reason: 'bad_body' });
  }
  const now = Date.now();
  try {
    // Dropped rather than fatal, like every other optional field. A term
    // that does not read as one counts as 0, so the fencing below turns it
    // away instead of letting it write.
    const claimedTerm = count(body.term, MAX_TERM) ?? 0;
    const current = await readEntry(code);
    if (isFresh(current, now) && current.secret !== secret) {
      return reply(409, { ok: false, reason: 'held', now, room: publicView(current, now) });
    }
    const continues = !!current && current.secret === secret;
    // The term fences the meeting's own writers against each other. Everyone
    // in a meeting holds its secret, so more than one of them may be writing
    // at once - a participant holding the room while the host is unreachable,
    // and the successor that took over from it, and the old host coming back
    // to find it has been replaced. Only the newest term may write, so none
    // of them can put a meeting's address back to an older one, whatever
    // order their writes arrive in.
    //
    // A stale entry is nobody's, so a meeting starting fresh on the code is
    // not fenced by whatever used to be there.
    if (continues && isFresh(current, now) && claimedTerm < (current.term ?? 0)) {
      return reply(409, { ok: false, reason: 'stale_term', now, room: publicView(current, now) });
    }
    const entry = {
      code,
      secret,
      invite: body.invite ?? null,
      grant: text(body.grant, MAX_GRANT_CHARS),
      host: text(body.host, MAX_HOST_CHARS),
      participants: count(body.participants, MAX_PARTICIPANTS) ?? 1,
      term: claimedTerm,
      // The meeting's start is the lease's start: a successor continues it.
      startedAt: continues && typeof current.startedAt === 'number' ? current.startedAt : now,
      at: now,
    };
    await writeEntry(code, entry, now);
    // Two claims in the same instant: whoever's write stands holds the room.
    const written = await readEntry(code);
    if (!written || written.secret !== secret) {
      return reply(409, {
        ok: false,
        reason: 'held',
        now,
        room: isFresh(written, now) ? publicView(written, now) : null,
      });
    }
    return reply(200, { ok: true, now, room: publicView(entry, now) });
  } catch (error) {
    return reply(503, { ok: false, reason: 'store', message: String(error?.message ?? error) });
  }
});

router.post('/v1/rooms/:code/end', async ({ request, params }) => {
  const code = normalizeCode(params.code);
  if (!code) return reply(400, { ok: false, reason: 'bad_code' });
  const body = await readBody(request);
  const secret = body ? text(body.secret, MAX_SECRET_CHARS) : null;
  if (!secret) return reply(400, { ok: false, reason: 'bad_body' });
  const claimedTerm = count(body.term, MAX_TERM) ?? 0;
  const now = Date.now();
  try {
    const current = await readEntry(code);
    // The term fences a release exactly as it fences a write. Everyone in
    // the meeting holds its secret, so without it an old host coming back
    // alone after a successor took over would end the successor's live
    // meeting on its way out - and the next person to open the link would
    // find the room free and start a second meeting on it.
    if (current && isFresh(current, now) && current.secret === secret && claimedTerm < (current.term ?? 0)) {
      return reply(409, { ok: false, reason: 'stale_term', ended: false, now, room: publicView(current, now) });
    }
    // Only the meeting itself may end its entry; a stranger's request is a
    // no-op, not an error. A stale entry is nobody's — anyone may clear it.
    const ours = !!current && (current.secret === secret || !isFresh(current, now));
    if (ours) await me.puter.kv.del(keyFor(code));
    return reply(200, { ok: true, now, ended: ours });
  } catch (error) {
    return reply(503, { ok: false, reason: 'store', message: String(error?.message ?? error) });
  }
});
