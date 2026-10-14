import { getPuter, hasPuter } from './env.js';

/**
 * The Puter session a meeting runs on — or the lack of one.
 *
 * Hosting takes an account: the host serves the room, publishes its link,
 * and pays for the relays. Joining takes none. A guest goes in with an
 * `anonToken` — any uuid; it names them to the signaller for the session
 * and no sign-in is asked for — and the host's GUEST GRANT, which lets
 * someone without a session use the Puter-managed TURN relays on the host's
 * account (`puter.peer.createGuestGrant()`). Without a grant a guest still
 * joins, but only where a direct connection is possible.
 *
 * A grant is short-lived (an hour by default) and anyone holding it can
 * mint relay credentials against the host's account until it expires. That
 * is the trust already extended to anyone holding the invite code, so it
 * travels with the invite — in the room directory's entry, then in WELCOME and
 * GRANT over the host link — and the host renews it rather than reusing
 * one indefinitely (src/net/session.js).
 *
 * The one flow that still signs in is a one-time link from an older deploy:
 * there is no room to carry a grant, so a guest without a session has Puter
 * make them an account on the spot instead (`attempt_temp_user_creation`).
 * What comes back is a full Puter user — `/whoami` reports it as `is_temp`,
 * which means only that it has no email or password yet — so nothing here
 * treats such a session as second class.
 */

/**
 * Whether this page has no Puter session: puter.js is here, does accounts,
 * and says nobody is signed in. A puter.js with no auth module (a stub, or
 * a build that doesn't do accounts) is not anonymous by this measure — the
 * peer API then speaks for itself.
 */
export function isAnonymous() {
  const auth = hasPuter() ? getPuter().auth : null;
  return typeof auth?.isSignedIn === 'function' && !auth.isSignedIn();
}

/**
 * Make sure there is a Puter session. Call it straight from a click:
 * signing in is a popup, and browsers only allow those during a gesture.
 *
 * With `autoCreate`, a visitor who isn't signed in has an account made for
 * them instead of being shown a sign-up form. Where Puter declines to make
 * one (it only does so for a browser that has never seen it before) it
 * falls back to that form by itself, so this is never worse than asking.
 *
 * @param {{autoCreate?: boolean}} [opts]
 */
export async function ensureSession({ autoCreate = false } = {}) {
  // Do not pop up sign-in unless specifically auto-creating for legacy one-time links
  if (!autoCreate) return;
  const puter = getPuter();
  if (!puter.auth?.signIn) return;
  if (puter.auth.isSignedIn?.()) return;
  await puter.auth.signIn({ attempt_temp_user_creation: true });
}

/**
 * Mint a guest grant on this account. Resolves with the grant and when it
 * stops being accepted (ms since the epoch), or null where there is no
 * account to mint on or this puter.js cannot. Rejects on a failed request,
 * so the caller can tell "try again later" from "never".
 *
 * @returns {Promise<{grant: string, expiresAt: number|null}|null>}
 */
export async function mintGuestGrant() {
  if (isAnonymous()) return null;
  const peer = getPuter().peer;
  if (typeof peer?.createGuestGrant !== 'function') return null;
  const { grant, expiresAt } = (await peer.createGuestGrant()) ?? {};
  if (typeof grant !== 'string' || !grant) return null;
  const expires = Number(expiresAt);
  return { grant, expiresAt: Number.isFinite(expires) && expires > 0 ? expires * 1000 : null };
}
