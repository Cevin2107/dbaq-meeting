import '@fontsource-variable/inter';
import './styles/base.css';
import './styles/home.css';
import './styles/agenda.css';
import './styles/prejoin.css';
import './styles/meeting.css';
import './styles/panels.css';
import './styles/pip.css';

import { el, clear } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { initTheme } from './ui/theme.js';
import { mountHome } from './ui/home.js';
import { brandLockup } from './ui/brand.js';
import { mountPrejoin, friendlyError } from './ui/prejoin.js';
import { mountMeeting } from './ui/meeting.js';
import { startInstant, canStartWithoutPrejoin } from './ui/instant.js';
import { savedBackground, preloadBackgroundEngine } from './ui/effects.js';
import { parseHash } from './lib/codes.js';
import { isRoomCode, normalizeRoomCode, RoomLease, RoomWarmer, endRoom, hostFields } from './lib/rooms.js';
import { RoomSession } from './net/session.js';
import { LocalMedia } from './net/media.js';
import { LinkHealth } from './lib/link-health.js';
import { getPref, prefsReady, syncPrefsFromCloud } from './lib/prefs.js';
import { hasPuter } from './lib/env.js';
import { silenceClosedPeerConnectionNoise } from './lib/webrtc-noise.js';
import { createCalendar } from './lib/calendar.js';

initTheme();
// Quiet the one benign uncaught rejection puter.js's peer layer throws when a
// connection is torn down mid-handshake (the host self-probe does, every 15 s).
silenceClosedPeerConnectionNoise();

const root = document.getElementById('app');

/** @type {{media, session, roomCode, lease, warmer, linkHealth, disposers}|null} the active call */
let activeCall = null;
/** @type {(() => void)|null} cleanup for the mounted view */
let unmount = null;
/** In-memory name (the Puter account username, when we have nothing else). */
let userName = null;

const ctx = {
  // The Calendar app, for the home screen's list of the day's meetings.
  // Inert outside the Puter desktop (see lib/calendar.js).
  calendar: createCalendar(),

  // A name the user actually entered outranks the account username: it is
  // stored locally the moment they join, and synced down from puter.kv on a
  // device that has never joined here.
  getUserName: () => getPref('name') ?? userName,
  setUserName: (name) => {
    userName = name;
  },

  goHome() {
    setHashSilently('');
    show((r) => mountHome(r, ctx));
  },

  /** @param {{mode: 'create'|'join', code?: string}} params */
  openPrejoin(params) {
    if (params.mode === 'join' && params.code) {
      params = { ...params, code: canonicalCode(params.code) };
      setHashSilently(`/m/${encodeURIComponent(params.code)}`);
    }
    show((r) => mountPrejoin(r, params, ctx));
  },

  /**
   * "Start an instant meeting". The pre-join screen is for checking how you
   * look before other people see you; the host of a brand-new meeting is
   * alone in it, so for them the screen only stood between the click and
   * the call. A signed-in user whose name is already remembered goes
   * straight in: their devices come up on the way, under the same saved
   * preferences pre-join applied (muted, camera off, background, noise
   * suppression), and every control the screen offered is in the meeting's
   * own settings. Everyone else — signed out, or never having told us a
   * name (see canStartWithoutPrejoin) — gets the pre-join screen as before.
   *
   * Resolves once the call is up, the pre-join screen is showing, or the
   * start has failed (and been reported); the caller only needs to know
   * when to stop saying "Starting…".
   */
  async startInstantMeeting() {
    const from = unmount; // the view the click came from
    // A device that has never joined from here may still be waiting on the
    // saved name to come down from puter.kv.
    await prefsReady();
    if (unmount !== from) return; // they went elsewhere meanwhile
    if (!canStartWithoutPrejoin()) {
      ctx.openPrejoin({ mode: 'create' });
      return;
    }
    const name = getPref('name');
    ctx.setUserName(name);

    // The devices, as pre-join brings them up: the saved background before
    // the camera starts so it wraps the very first track, likewise noise
    // suppression for the mic. Device errors are toasted here until the
    // meeting view takes over the listening.
    const media = new LocalMedia();
    const stopToasting = media.on('error', ({ message }) => toast(message, { icon: 'info' }));
    const bg = savedBackground();
    if (bg.type !== 'none') {
      preloadBackgroundEngine();
      media.setBackground(bg);
    }
    if (getPref('noiseSuppression', true)) media.setNoiseSuppression(true);

    // Hosting does not need the camera, so the two run side by side: the
    // permission prompt, when there is one, no longer delays the room.
    // Settled, not raced — the media must not be stopped while its devices
    // are still being acquired, or a track adopted afterwards stays hot.
    const [, started] = await Promise.allSettled([
      media.init({
        micId: getPref('micId'),
        camId: getPref('camId'),
        micOn: !getPref('joinMuted', false),
        camOn: !getPref('joinCamOff', false),
      }),
      startInstant({ media, name }),
    ]);
    stopToasting();
    if (started.status === 'rejected') {
      console.error('[app] could not start an instant meeting', started.reason);
      media.stopAll();
      if (unmount === from) toast(friendlyError(started.reason), { icon: 'info' });
      return;
    }
    const call = started.value;
    if (unmount !== from || activeCall) {
      // The user went elsewhere while we were starting (a link, Back). A
      // meeting we were hosting alone is over before anyone saw it: free
      // its link.
      stopWarming(call);
      void call.lease?.end();
      call.session.leave();
      media.stopAll();
      return;
    }
    ctx.startCall({ media, session: call.session, roomCode: call.roomCode, lease: call.lease });
  },

  /**
   * Called by prejoin once the session is live.
   * @param {{media, session: RoomSession, roomCode: string|null, lease: RoomLease|null}} call
   *   `lease` is the room's entry in the directory, when we host one and
   *   prejoin has already taken it (see lib/rooms.js).
   */
  startCall(call) {
    activeCall = call;
    // The shareable meeting code: the persistent room when there is one,
    // otherwise the (one-time) peer invite code.
    call.meetingCode = call.roomCode ?? call.session.code;
    setHashSilently(`/m/${encodeURIComponent(call.meetingCode)}`);
    // How the room's link is doing, for the meeting info panel: fed by the
    // lease's every write (see lib/link-health.js). A meeting with no room
    // has no link to keep — the invite is the link.
    call.linkHealth = call.roomCode ? new LinkHealth() : null;
    call.linkHealth?.role({ host: call.session.isHost });
    call.disposers = [];
    if (call.lease) attachLease(call, call.lease);
    call.disposers.push(
      call.session.on('left', onSessionEnded),
      call.session.on('ended', ({ reason }) => {
        // Nothing of the meeting is left to hold on to — the link is free.
        void releaseRoom(call);
        if (activeCall) ctx.endCall({ meetingEnded: true, reason });
      }),
      // The invite newcomers need changed: the host role moved to us, or we
      // serve under a new code. The link has to say so.
      call.session.on('code-changed', ({ code }) => onCodeChanged(call, code)),
      call.session.on('host-changed', ({ self }) => {
        if (call !== activeCall) return;
        // A host, whoever it is, writes for the room from here — holding it
        // on their behalf is done.
        stopWarming(call);
        if (self) {
          // The link is ours to keep now; the code-changed that follows,
          // once our server is up, takes the lease over.
          call.linkHealth?.role({ host: true });
          return;
        }
        // Someone else is hosting now — they carry the lease on.
        call.lease?.stop();
        call.lease = null;
        call.linkHealth?.role({ host: false });
      }),
      // The host has gone quiet. Nobody writes for the room while it has no
      // host, and the directory forgets an entry long before a successor is
      // elected — then the next person to open the link finds the code free
      // and starts a meeting of their own on it. Whoever this side would
      // elect holds the entry until a host writes again.
      call.session.on('host-unreachable', ({ keeper }) => {
        if (call !== activeCall || !call.roomCode || call.lease) return;
        if (keeper !== call.session.selfId || call.warmer) return;
        call.warmer = new RoomWarmer(call.roomCode, call.session.meetingSecret, () =>
          hostFields(call.session)
        );
        call.warmer.start();
      }),
      call.session.on('host-reachable', () => stopWarming(call)),
      // Anonymous guests reach the relays only through our guest grant: a
      // mint that keeps failing leaves them with direct connections only,
      // and nobody in the meeting would know why someone is stuck outside.
      call.session.on('grant-failed', ({ inForce }) => onGrantFailed(call, inForce)),
      call.session.on('grant-changed', () => {
        onGrantRestored(call);
        void call.lease?.refresh(); // the grant travels with the invite
      }),
      // The entry carries a headcount, for whoever is looking at the link.
      call.session.on('peer-joined', () => void call.lease?.refresh()),
      call.session.on('peer-left', () => void call.lease?.refresh())
    );
    show((r) => mountMeeting(r, call, ctx));
  },

  /** Leave the current call and show the post-call screen. */
  endCall({ meetingEnded = false, reason = null } = {}) {
    const call = activeCall;
    if (!call) {
      ctx.goHome();
      return;
    }
    activeCall = null;
    for (const dispose of call.disposers ?? []) dispose();
    const code = call.meetingCode ?? call.session.code;
    const wasHost = call.session.isHost;
    if (call.lease) {
      // Alone, the meeting ends with us: free the link. With people still
      // in, the successor carries the lease on — leave the entry to them.
      // So too when we lost touch with the people who were in: they may
      // be meeting under a successor now, whose entry this would end.
      if (wasHost && call.session.peerCount === 0 && !call.session.mayContinueElsewhere) void call.lease.end();
      else call.lease.stop();
      call.lease = null;
    }
    try {
      call.session.leave();
    } catch {
      /* noop */
    }
    call.media.stopAll();
    setHashSilently('');
    show((r) => mountLeft(r, { code, wasHost, meetingEnded, reason }, ctx));
  },
};

/**
 * The meeting's live invite changed — the host role moved to us, or the
 * invite we serve was replaced under us (the library reopened its signaller
 * socket under a new code, or we re-served a dead one). Write it to the
 * room's entry so the link keeps working; for a meeting with no room the
 * invite *is* the link, so just follow it.
 */
function onCodeChanged(call, code) {
  if (call !== activeCall) return;
  if (!call.roomCode) {
    call.meetingCode = code;
    setHashSilently(`/m/${encodeURIComponent(code)}`);
    return;
  }
  if (!call.session.isHost) return;
  // The invite rotated under us (a routine signaller-socket reconnect, or a
  // dead invite we re-served). Write the new one to the link and move on —
  // no toast: nothing is wrong that the host can see or act on, and the
  // info panel's Link line already reflects the state for anyone who looks.
  call.linkHealth?.codeChanged();
  const lease = ensureLease(call);
  if (lease) void lease.refresh();
}

/**
 * The lease on the room's entry, taken (and kept) under the meeting's
 * secret — the one the first host chose and every participant was welcomed
 * with, so a successor's lease continues the first host's rather than
 * fighting it.
 */
function ensureLease(call) {
  if (!call.roomCode) return null;
  if (call.lease) return call.lease;
  const secret = call.session.meetingSecret;
  if (!secret) return null;
  const lease = new RoomLease(call.roomCode, secret, () => hostFields(call.session));
  attachLease(call, lease);
  void lease.start();
  return lease;
}

/** Hear of the lease's every write while this call is the active one. */
function attachLease(call, lease) {
  call.lease = lease;
  call.disposers.push(lease.on('beat', (beat) => onBeat(call, lease, beat)));
  // Writes it made before we listened (prejoin's claim) still count.
  if (lease.last) call.linkHealth?.beat({ ok: lease.last === 'ok', held: lease.last === 'held' });
}

function onBeat(call, lease, { ok, held, stale, room, error }) {
  if (call !== activeCall || call.lease !== lease) return;
  if (stale) {
    void onMeetingMovedOn(call, lease, room);
    return;
  }
  call.linkHealth?.beat({ ok, held });
  if (ok) {
    lastNotified.delete('link-write-failed'); // the next failure is news again
    // Only worth a word if the host was told of the trouble.
    if (call.linkAlerted) {
      call.linkAlerted = false;
      toast('Your meeting link is working again.', { icon: 'info' });
    }
    return;
  }
  if (held) {
    void onLinkHeld(call, room);
    return;
  }
  onPublishError(call, error);
}

/**
 * The directory says another meeting holds this link: someone started it in
 * the same breath as us, and their write stood. Newcomers land there. Alone,
 * we go there too — join it on the same media, and let our own meeting go.
 * With people already in ours there is nothing to move: say so, and keep
 * heartbeating; if their meeting ends first, the next beat takes the link.
 */
async function onLinkHeld(call, room) {
  if (call !== activeCall) return;
  if (call.session.peerCount === 0) {
    if (room?.status === 'live') {
      if (await moveToRival(call, room)) return;
    } else if (room?.status === 'starting') {
      // Their server is not up yet — look again in a moment.
      setTimeout(() => {
        if (call === activeCall && call.session.peerCount === 0) void call.lease?.refresh();
      }, HELD_STARTING_RECHECK_MS);
      return;
    }
  }
  notifyOnce('link-held', LINK_TROUBLE_TOAST_EVERY_MS, () => {
    call.linkAlerted = true;
    toast(
      'Someone else started a meeting on this link at the same time. New participants will join theirs; this meeting carries on for everyone in it.',
      { icon: 'info' }
    );
  });
}

const HELD_STARTING_RECHECK_MS = 3000;
const LINK_TROUBLE_TOAST_EVERY_MS = 5 * 60_000;
const lastNotified = new Map();
/** Say something at most once per `everyMs` — a flapping link must not flood the call with toasts. */
function notifyOnce(key, everyMs, show) {
  const last = lastNotified.get(key) ?? -Infinity;
  if (Date.now() - last < everyMs) return;
  lastNotified.set(key, Date.now());
  show();
}

/**
 * The host could not mint a guest grant. While the previous one still holds
 * there is nothing to say — guests keep their relays until it expires; once
 * none is in force, say so every few minutes, and say when it is back.
 */
function onGrantFailed(call, inForce) {
  if (call !== activeCall || !call.session.isHost || inForce) return;
  notifyOnce('grant-failed', LINK_TROUBLE_TOAST_EVERY_MS, () => {
    call.grantAlerted = true;
    toast('Guests without a Puter account may not be able to connect until Puter can be reached again.', {
      icon: 'info',
    });
  });
}

function onGrantRestored(call) {
  lastNotified.delete('grant-failed'); // the next failure is news again
  if (call !== activeCall || !call.grantAlerted) return;
  call.grantAlerted = false;
  toast('Puter can be reached again — guests without an account can connect.', { icon: 'info' });
}

/** A heartbeat did not land: the entry is ageing towards gone while the meeting hums along. */
function onPublishError(call, error) {
  console.warn('[app] could not write the meeting link', error);
  if (call !== activeCall) return;
  notifyOnce('link-write-failed', LINK_TROUBLE_TOAST_EVERY_MS, () => {
    call.linkAlerted = true;
    toast('The meeting link couldn’t be updated just now. New participants may not find this meeting until it can be.', {
      icon: 'info',
    });
  });
}

/** The meeting is over (we were the last one in it): free the link. */
/** Stop holding a room entry on an absent host's behalf. */
function stopWarming(call) {
  call.warmer?.stop();
  call.warmer = null;
}

function releaseRoom(call) {
  stopWarming(call);
  if (!call.roomCode) return Promise.resolve(false);
  if (call.lease) {
    const lease = call.lease;
    call.lease = null;
    return lease.end();
  }
  return endRoom(call.roomCode, call.session.meetingSecret, call.session.term);
}

/**
 * The directory turned our heartbeat away as coming from a term the meeting
 * has left behind: while we were out of reach the others elected a
 * successor, and it is writing for the room now. We are not this meeting's
 * host any more, whatever our session still thinks, and must never write
 * for the room again — nor release it, which would end the successor's
 * meeting. With nobody left on a link of ours, go to where the meeting is;
 * with someone still here, we are a piece of it that split off, and say so.
 */
async function onMeetingMovedOn(call, lease, room) {
  if (call !== activeCall || call.lease !== lease) return;
  lease.stop();
  call.lease = null;
  call.linkHealth?.role({ host: false });
  console.warn('[app] the meeting moved on to a later host while we were out of reach');
  if (call.session.connectedPeerIds().length > 0) {
    notifyOnce('meeting-moved-on', LINK_TROUBLE_TOAST_EVERY_MS, () =>
      toast('The meeting continued under a new host while you were disconnected. New participants will join them.', {
        icon: 'info',
      })
    );
    return;
  }
  if (room?.status !== 'live' || !room.invite) return;
  await moveToMeeting(call, room, {
    alone: () => call.session.connectedPeerIds().length === 0,
    message: 'The meeting continued under a new host while you were disconnected — you’ve rejoined it.',
  });
}

/**
 * We started this room's meeting, but someone else started it in the same
 * breath and the directory took theirs — theirs is the one newcomers will
 * find, so, being alone, we go there too: join it on the same media, then
 * let our own meeting go. The call carries on in place; only the session
 * underneath changes. Resolves whether we moved.
 */
async function moveToRival(call, room) {
  return moveToMeeting(call, room, {
    alone: () => call.session.peerCount === 0,
    message: 'Someone else started this meeting at the same time — you’ve joined them.',
  });
}

/**
 * Carry the call over to the meeting at `room.invite`: join it on the same
 * media, then let our own session go. The call carries on in place; only
 * the session underneath changes. `alone()` is asked again once the join is
 * in, since a meeting someone joined meanwhile is not ours to walk out of.
 * Resolves whether we moved.
 */
async function moveToMeeting(call, room, { alone, message }) {
  if (call !== activeCall) return false;
  const session = new RoomSession({ media: call.media, name: call.session.name, grant: room.grant ?? null });
  try {
    await session.join(room.invite);
  } catch (error) {
    leaveQuietly(session);
    console.warn('[app] could not join the meeting at', room.invite, error);
    return false;
  }
  if (call !== activeCall || !alone()) {
    // The call ended meanwhile — or someone joined us, and a meeting with
    // people in it is the meeting: it stays.
    leaveQuietly(session);
    return false;
  }
  for (const dispose of call.disposers ?? []) dispose();
  call.lease?.stop(); // the entry is theirs, not ours — nothing to release
  call.lease = null;
  leaveQuietly(call.session);
  toast(message, { icon: 'info' });
  ctx.startCall({ media: call.media, session, roomCode: call.roomCode, lease: null });
  return true;
}

function leaveQuietly(session) {
  try {
    session.leave();
  } catch {
    /* noop */
  }
}

function onSessionEnded() {
  // Session ended underneath us (e.g. connection loss) while in a call.
  if (activeCall) ctx.endCall();
}

function show(mount) {
  unmount?.();
  unmount = mount(root) ?? null;
}

/** Update the hash without triggering our own hashchange handling. */
let suppressHash = false;
function setHashSilently(hash) {
  const target = hash ? `#${hash}` : '';
  const current = location.hash === '#' ? '' : location.hash;
  if (current === (target || '')) return;
  suppressHash = true;
  if (target) location.hash = target;
  else history.replaceState(null, '', location.pathname + location.search);
  setTimeout(() => {
    suppressHash = false;
  }, 0);
}

/**
 * Canonical form of a meeting code: room codes get normalized ("ABC DEFG
 * HIJ" → "abc-defg-hij") so history entries, the active call, and typed
 * input all compare equal; legacy invite codes pass through untouched.
 */
function canonicalCode(code) {
  return normalizeRoomCode(code) ?? code;
}

function route() {
  if (suppressHash) return;
  const r = parseHash(location.hash);
  if (r.view === 'meeting' && r.code) {
    const code = canonicalCode(r.code);
    if (activeCall && (activeCall.meetingCode ?? activeCall.session.code) === code) return; // already in it
    if (activeCall) ctx.endCall();
    ctx.openPrejoin({ mode: 'join', code });
  } else {
    if (activeCall) {
      // Back button out of a meeting = leave.
      ctx.endCall();
      return;
    }
    ctx.goHome();
  }
}

/** Post-call screen. */
function mountLeft(rootEl, { code, wasHost, meetingEnded, reason }, appCtx) {
  clear(rootEl);
  let seconds = 60;
  const countdown = el('span', {}, `Returning to home screen in ${seconds}s`);
  const timer = setInterval(() => {
    seconds -= 1;
    countdown.textContent = `Returning to home screen in ${seconds}s`;
    if (seconds <= 0) appCtx.goHome();
  }, 1000);

  const title = meetingEnded ? 'The meeting has ended' : 'You left the meeting';
  // Leaving removes the button that was focused, which drops focus to
  // <body> — so the keyboard restarts from the top of the document and a
  // screen reader is told nothing at all about where it landed. Give the
  // heading focus instead: it names the new screen, and the controls
  // follow it.
  const heading = el('h1', { style: { fontWeight: '400', margin: '0' }, tabindex: '-1' }, title);
  // A persistent room outlives the session: rejoining works, and anyone
  // holding the link can start it again when nothing is running. A legacy
  // code is one host's dead peer server, so there is nothing to go back to.
  const roomful = isRoomCode(code);

  rootEl.append(
    el(
      'div',
      { class: 'home' },
      el('header', { class: 'home-header' }, brandLockup()),
      el(
        'main',
        { class: 'home-main', style: { flexDirection: 'column', gap: '20px', textAlign: 'center' } },
        heading,
        meetingEnded
          ? el(
              'p',
              { style: { color: 'var(--text-secondary)', margin: '0' } },
              // The session's own reason (e.g. a takeover that could not
              // serve) beats the generic story, which would be wrong there.
              (reason ?? 'Everyone has left, so the meeting is over.') +
                (roomful ? ' The link still works, so anyone holding it can start the meeting again.' : '')
            )
          : null,
        el('p', { style: { color: 'var(--text-secondary)', margin: '0' } }, countdown),
        el(
          'div',
          { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' } },
          roomful
            ? el(
                'button',
                { class: 'btn btn-outline', onclick: () => appCtx.openPrejoin({ mode: 'join', code }) },
                icon('videoCall'),
                wasHost ? 'Restart meeting' : 'Rejoin'
              )
            : wasHost || meetingEnded
              ? el(
                  'button',
                  {
                    class: 'btn btn-outline',
                    onclick: async (e) => {
                      // Their choice is made: the countdown must not pull
                      // the screen away under a start in progress.
                      clearInterval(timer);
                      const btn = e.currentTarget;
                      btn.disabled = true;
                      await appCtx.startInstantMeeting();
                      btn.disabled = false;
                    },
                  },
                  icon('videoCall'),
                  'Start a new meeting'
                )
              : code
                ? el(
                    'button',
                    { class: 'btn btn-outline', onclick: () => appCtx.openPrejoin({ mode: 'join', code }) },
                    icon('videoCall'),
                    'Rejoin'
                  )
                : null,
          el('button', { class: 'btn btn-primary', onclick: () => appCtx.goHome() }, 'Return to home screen')
        )
      )
    )
  );

  heading.focus();

  return () => clearInterval(timer);
}

// Leave gracefully when the tab closes. A lone host frees the link with a
// beacon, which the browser sends after the page is gone; with people still
// in, the successor's lease takes over — and if nothing of ours lands, the
// entry simply ages out. `pagehide` as well as `beforeunload`: iOS Safari
// does not fire the latter, and a page going into the back/forward cache
// skips it elsewhere too — a phone host swiping the tab away would
// otherwise say no goodbye, and the others would wait out the reconnect
// deadline on a ghost. Both handlers may run; everything here is idempotent.
const leaveOnUnload = () => {
  const call = activeCall;
  if (!call) return;
  try {
    if (call.lease && call.session.isHost && call.session.peerCount === 0 && !call.session.mayContinueElsewhere) {
      call.lease.endOnUnload();
    }
    else call.lease?.stop();
    call.session.leave();
  } catch {
    /* noop */
  }
};
window.addEventListener('beforeunload', leaveOnUnload);
window.addEventListener('pagehide', leaveOnUnload);

window.addEventListener('hashchange', route);

// Boot: start the cloud pref pull (best-effort; views that prefill from a
// preference await it through prefsReady), then route.
if (hasPuter()) void syncPrefsFromCloud();
route();
