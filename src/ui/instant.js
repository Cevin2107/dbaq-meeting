import { toast } from './toast.js';
import { RoomSession } from '../net/session.js';
import { mintRoomCode, RoomLease, hostFields, ROOM_SETUP_TIMEOUT_MS } from '../lib/rooms.js';
import { withDeadline } from '../lib/timers.js';
import { getPref } from '../lib/prefs.js';
import { hasPuter } from '../lib/env.js';
import { isAnonymous } from '../lib/account.js';

/**
 * Instant meeting: host now, on a room minted on the spot. Shared by the
 * pre-join screen and the home screen's direct start (src/main.js).
 *
 * The room's entry is written once the server is up; should the directory
 * be out of reach, the meeting still runs — on its one-time invite as the
 * code, since a link nobody can resolve is no link.
 *
 * @param {{media: import('../net/media.js').LocalMedia, name: string}} args
 * @returns {Promise<{session: RoomSession, roomCode: string|null, lease: RoomLease|null}>}
 */
export async function startInstant({ media, name }) {
  const code = mintRoomCode();
  const session = new RoomSession({ media, name, secret: crypto.randomUUID() });
  await session.host();
  const lease = new RoomLease(code, session.meetingSecret, () => hostFields(session));
  const first = await withDeadline(lease.start(), ROOM_SETUP_TIMEOUT_MS).catch((error) => ({ ok: false, error }));
  if (first.ok) return { session, roomCode: code, lease };
  // A fresh random code is nobody else's (56 bits say so); what is left is
  // the directory being out of reach — or, once in a lifetime, a collision.
  console.warn('[start] could not publish the meeting under a room code', first.error ?? first.room);
  lease.stop();
  toast('Could not set up a reusable link, so this meeting uses a one-time link.', { icon: 'info' });
  return { session, roomCode: null, lease: null };
}

/**
 * Whether "Start an instant meeting" can skip the pre-join screen and put
 * the user straight into the call: they are signed in (hosting takes a
 * Puter account, and asking for one is the screen's job), and they have
 * told us their name before — the saved name is what they will be
 * introduced by, and there is no renaming once inside, so the account
 * username is never sprung on someone who has not chosen it.
 */
export function canStartWithoutPrejoin() {
  return hasPuter() && !isAnonymous() && !!getPref('name');
}
