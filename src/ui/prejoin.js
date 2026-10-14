import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { openBackgroundDialog, savedBackground, preloadBackgroundEngine } from './effects.js';
import { LocalMedia } from '../net/media.js';
import { RoomSession, isInvalidInviteError, isSignallerUnreachableError } from '../net/session.js';
import { getPref, setPref, setLocalPref, prefsReady } from '../lib/prefs.js';
import { displayCode } from '../lib/codes.js';
import {
  normalizeRoomCode,
  readRoom,
  claimRoom,
  endRoom,
  RoomLease,
  hostFields,
  LEASE_TTL_MS,
  ROOM_SETUP_TIMEOUT_MS,
} from '../lib/rooms.js';
import { withDeadline } from '../lib/timers.js';
import { startInstant } from './instant.js';
import { sanitizeName } from '../lib/protocol.js';
import { hasPuter } from '../lib/env.js';
import { ensureSession, isAnonymous } from '../lib/account.js';

const ROOM_POLL_MS = 4500;
const ROOM_POLL_JITTER_MS = 1500;
/**
 * While a meeting is running but out of reach — the host is heartbeating an
 * entry whose invite we could not use — the host is re-serving a dead
 * invite within ~15 s and writing the new one at once: it is about to
 * land, and a 6 s poll gap is all waiting. So poll every couple of seconds
 * for a while (one cheap read a poll), then fall back to the usual
 * cadence: whatever is wrong by then is not fixed by reading faster.
 */
export const UNREACHABLE_POLL_MS = 2000;
export const UNREACHABLE_POLL_JITTER_MS = 500;
export const UNREACHABLE_FAST_POLL_FOR_MS = 2 * 60_000;
const ROOM_MISSING_HINT_AFTER = 4; // polls the directory never answered before we say so
/**
 * A dial of a live invite that failed QUICKLY, without the signaller saying
 * the invite is gone — a dropped channel, our own socket to the signaller
 * closing on us — may be a passing hiccup, so the same invite gets one more
 * try after a short wait before it is written off and the directory is
 * read again. Two failures are not a hiccup. Neither is a full handshake
 * timeout (the dial went through and nobody answered — a host that is gone,
 * or a path that cannot be built), nor an "Invalid invite code": the
 * signaller has said no one can reach it, and the host is already
 * replacing it. Those are written off at once, as they always were.
 */
export const INVITE_RETRY_DELAY_MS = 5000;
export const INVITE_QUICK_FAILURE_MS = 8000;
export const INVITE_FAILURES_BEFORE_DEAD = 2;
/**
 * How long an invite written off stays written off: as long as the
 * directory itself keeps an entry nobody is heartbeating (LEASE_TTL_MS). A
 * host that is still there notices a dead invite of its own within a couple
 * of self-probes (src/net/session.js) and writes the new one; a host that is
 * gone takes its entry with it in the same time. Past that, an entry still
 * naming the old invite is worth a fresh look — a lobby must never hold a
 * grudge against a healthy meeting over one failed dial.
 */
export const INVITE_DEAD_FOR_MS = LEASE_TTL_MS;
/** A start that failed on the automatic path is not tried again for this long. */
export const AUTO_START_RETRY_MS = 30_000;
/**
 * A dial that never reached the signaller at all — our own socket to it
 * would not open, or Puter could not be asked where it is — says nothing
 * about the invite, so it is neither a dial failure nor a reason to write
 * it off: the same invite is dialed again, with backoff, until the
 * way there is back (see isSignallerUnreachableError). A capped backoff:
 * the network here may be down for a while, and every attempt is a socket.
 */
export const SIGNALLER_RETRY_MS = [5000, 10_000, 20_000];
/** How long a running meeting may stay out of reach before the guest is told to get help. */
export const UNREACHABLE_HELP_AFTER_MS = 45_000;

/**
 * Pre-join screen: preview devices, pick a name, then start/join.
 * @param {HTMLElement} root
 * @param {{mode: 'create'|'join', code?: string}} params
 * @param {object} ctx
 * @returns {() => void} cleanup
 */
export function mountPrejoin(root, params, ctx) {
  clear(root);

  const media = new LocalMedia();
  // A short code is a persistent room; anything else is a raw peer invite
  // code from a legacy one-time link.
  const roomCode = params.mode === 'join' ? normalizeRoomCode(params.code) : null;
  let handedOff = false;
  let joining = false;
  let alive = true; // false once the view unmounts (e.g. Back mid-join)
  let waitCancelled = false;
  let startRequested = false; // "Start this meeting" clicked while waiting
  let wakeWait = null; // resolves the current waiting-room sleep early
  let retryRequested = false; // "Try again" clicked: the next dial is the guest's own doing
  let forgetDialHistory = null; // set by joinRoom: wipes what it holds against invites

  const video = el('video', { autoplay: true, playsinline: true, muted: true });
  video.muted = true; // attribute alone isn't always honored

  const videoNote = el('div', { class: 'video-off-note' }, 'Camera is starting…');
  const nameTag = el('div', { class: 'prejoin-name-tag' });

  const micBtn = roundCtl('mic', 'microphone', async () => {
    await media.setMicOn(!media.micOn);
    setPref('joinMuted', !media.micOn);
  });
  const camBtn = roundCtl('cam', 'camera', async () => {
    await media.setCamOn(!media.camOn);
    setPref('joinCamOff', !media.camOn);
  });
  // Until the devices answer (a permission prompt can take a while) the
  // buttons show the state that was asked for, and do nothing: media starts
  // with both off, so a click here would have read as "turn on" against a
  // button that said "on", and the init landing afterwards overwrote
  // whatever the click had done.
  micBtn.set(!getPref('joinMuted', false));
  camBtn.set(!getPref('joinCamOff', false));
  micBtn.node.disabled = true;
  camBtn.node.disabled = true;
  const fxBtn = el(
    'button',
    {
      class: 'round-ctl',
      title: 'Change background',
      'aria-label': 'Change background',
      onclick: () => openBackgroundDialog({ media }),
    },
    icon('sparkle')
  );

  const micSelect = el('select', { 'aria-label': 'Microphone', onchange: () => onDevicePick('mic') });
  const camSelect = el('select', { 'aria-label': 'Camera', onchange: () => onDevicePick('cam') });

  const nameInput = el('input', {
    type: 'text',
    placeholder: 'Your name',
    maxlength: '60',
    'aria-label': 'Your name',
    value: ctx.getUserName() ?? '',
    onkeydown: (e) => {
      if (e.key === 'Enter') onJoin();
    },
    oninput: renderNameTag,
  });

  /** Preview the name the way the meeting will label this tile. */
  function renderNameTag() {
    const name = nameInput.value.trim();
    nameTag.textContent = name;
    nameTag.style.display = name ? '' : 'none';
  }
  renderNameTag();

  const errorLine = el('p', { class: 'prejoin-error', role: 'alert' });
  const joinBtn = el('button', { class: 'btn btn-primary', onclick: onJoin }, joinLabel());
  const startRoomBtn = el(
    'button',
    { class: 'btn btn-outline', style: { display: 'none' }, onclick: onStartRoom },
    'Start this meeting'
  );
  const cancelWaitBtn = el(
    'button',
    { class: 'btn btn-text', style: { display: 'none' }, onclick: onCancelWait },
    'Stop waiting'
  );
  // While a running meeting is out of reach the lobby decides on its own
  // when to dial the same invite again; when its guess is wrong (a dial that
  // failed for a reason on this side) the guest would otherwise have nothing
  // to do but reload, and lose their name and device choices with it.
  const retryBtn = el(
    'button',
    {
      class: 'btn btn-text',
      style: { display: 'none' },
      'aria-label': 'Try connecting to the meeting again',
      onclick: onRetry,
    },
    'Try again'
  );
  const sideTitle = el('h1', {}, sideTitleText());
  // A live region: entering/leaving the waiting room otherwise changes the
  // screen silently for screen-reader users.
  const sideSub = el('p', { class: 'prejoin-sub', role: 'status' }, sideSubText());

  const view = el(
    'div',
    { class: 'prejoin' },
    el(
      'main',
      { class: 'prejoin-main' },
      el(
        'section',
        { class: 'prejoin-preview' },
        el(
          'div',
          { class: 'prejoin-video' },
          video,
          videoNote,
          nameTag,
          el('div', { class: 'prejoin-video-controls' }, micBtn.node, camBtn.node, fxBtn)
        ),
        el(
          'div',
          { class: 'prejoin-devices' },
          el('label', { class: 'select-field' }, icon('mic'), micSelect),
          el('label', { class: 'select-field' }, icon('cam'), camSelect)
        )
      ),
      el(
        'aside',
        { class: 'prejoin-side' },
        sideTitle,
        sideSub,
        el('div', { class: 'text-field' }, nameInput),
        errorLine,
        joinBtn,
        startRoomBtn,
        el('div', { class: 'prejoin-wait-actions' }, retryBtn, cancelWaitBtn),
        el(
          'button',
          { class: 'btn btn-text prejoin-back', onclick: () => ctx.goHome() },
          icon('back'),
          'Back to home'
        )
      )
    )
  );

  root.append(view);
  nameInput.focus();

  // Warm up TURN relays while the user is still on this screen.
  if (hasPuter()) {
    try {
      window.puter.peer?.ensureTurnRelays?.().catch?.(() => {});
    } catch {
      /* noop */
    }
  }

  if (!nameInput.value) void prefillName();

  /**
   * Fill an empty name field with the name used last time. It is stored
   * locally, so the common case is already in the input above; on a device
   * that has never joined from here it may still be on its way down from
   * puter.kv, which is what the wait is for. The Puter account username is
   * only a fallback, and typing beats both.
   */
  async function prefillName() {
    await prefsReady();
    if (!alive || nameInput.value) return;
    let name = getPref('name');
    if (!name && hasPuter()) {
      try {
        if (window.puter.auth?.isSignedIn?.()) {
          // Skip a username Puter generated when it made the account for a
          // guest: nobody chose it, so nobody wants to be introduced by it.
          const account = await window.puter.auth.getUser();
          if (!account?.is_temp) name = account?.username;
        }
      } catch {
        /* signed out, or the account lookup failed */
      }
    }
    if (!alive || !name || nameInput.value) return;
    nameInput.value = name;
    renderNameTag();
  }

  init();

  // Browsers throttle a hidden tab's timers — to once a minute after a few
  // minutes in Chrome — so a guest who tabbed away sits on a stale poll,
  // and comes back to a lobby that has not looked in a while. Look the
  // moment they do: end the current sleep, and the loop polls at once.
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') wakeWait?.();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Disposed on unmount: `media` outlives this view (it is handed off to
  // the meeting), and stale listeners would keep toasting errors a second
  // time — and keep re-attaching the camera to the detached preview.
  const mediaDisposers = [
    media.on('change', renderControls),
    media.on('video-track', attachPreview),
    media.on('background', renderControls),
    media.on('error', ({ message }) => {
      toast(message, { icon: 'info' });
      renderControls();
    }),
  ];

  async function init() {
    // Restore the saved background effect before the camera starts so
    // it applies to the very first track (and the engine warms early).
    const bg = savedBackground();
    if (bg.type !== 'none') {
      preloadBackgroundEngine();
      media.setBackground(bg);
    }
    // Noise suppression is on unless the user turned it off; requested
    // before the mic starts so it wraps the very first track.
    if (getPref('noiseSuppression', true)) media.setNoiseSuppression(true);
    await media.init({
      micId: getPref('micId'),
      camId: getPref('camId'),
      micOn: !getPref('joinMuted', false),
      camOn: !getPref('joinCamOff', false),
    });
    if (!alive) return; // Back was pressed while the permission prompt was up
    micBtn.node.disabled = false;
    camBtn.node.disabled = false;
    attachPreview();
    renderControls();
    await refreshDevices();
    // Not once the view is gone: the cleanup below has already run its
    // removeEventListener, and a listener added after it would outlive the
    // page, polling devices for a preview nobody sees.
    if (alive) navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
  }

  function attachPreview() {
    if (media.videoTrack) {
      video.srcObject = media.stream;
      video.play?.().catch(() => {});
    } else {
      video.srcObject = null;
    }
    renderControls();
  }

  function renderControls() {
    micBtn.set(media.micOn);
    camBtn.set(media.camOn);
    fxBtn.classList.toggle('active', media.background.type !== 'none');
    video.style.display = media.camOn ? '' : 'none';
    videoNote.textContent = media.camOn ? '' : 'Camera is off';
    videoNote.style.display = media.camOn ? 'none' : '';
  }

  async function refreshDevices() {
    try {
      const { mics, cams } = await media.listDevices();
      fillSelect(micSelect, mics, media.micId, 'Microphone');
      fillSelect(camSelect, cams, media.camId, 'Camera');
    } catch {
      /* enumeration unavailable */
    }
  }

  async function onDevicePick(kind) {
    if (kind === 'mic') {
      await media.setMicDevice(micSelect.value);
      setPref('micId', micSelect.value);
    } else {
      await media.setCamDevice(camSelect.value);
      setPref('camId', camSelect.value);
      attachPreview();
    }
  }

  async function onJoin() {
    if (joining) return;
    if (!nameInput.value.trim()) {
      errorLine.textContent = 'Please enter your name.';
      nameInput.focus();
      return;
    }
    const name = sanitizeName(nameInput.value);
    // Remember it now: a join that fails below (Puter.js missing, sign-in
    // dismissed, nothing running yet) shouldn't cost the user their name
    // on the next attempt. The cloud copy needs sign-in, so it waits.
    setLocalPref('name', name);
    ctx.setUserName(name);
    errorLine.textContent = '';
    joining = true;
    waitCancelled = false;
    startRequested = false; // a click from an earlier, cancelled wait must not carry over
    joinBtn.disabled = true;
    // The name is captured now; leaving the field editable through a long
    // waiting-room stay would invite edits that silently never apply.
    nameInput.disabled = true;
    joinBtn.textContent = params.mode === 'create' ? 'Starting…' : 'Joining…';

    try {
      if (!hasPuter()) {
        throw new Error('Puter.js failed to load. Check your connection and reload.');
      }
      // Starting a meeting takes a Puter account: the host serves the room,
      // publishes its link and pays for its relays. Joining a room takes
      // none — the guest goes in anonymously, on the grant the host published
      // next to the invite. Only a one-time link from an older deploy still
      // needs a session, having no room to carry a grant; Puter makes that
      // guest an account on the spot (see src/lib/account.js).
      if (!roomCode && params.mode !== 'create') {
        await ensureSession({ autoCreate: true });
      }

      // Local always; to puter.kv as well where there is a session.
      setPref('name', name);

      const call =
        params.mode === 'create'
          ? await startInstant({ media, name })
          : roomCode
            ? await joinRoom(roomCode, name)
            : await joinLegacy(params.code, name);

      if (!call) {
        // Cancelled out of the waiting room (or the view went away).
        restoreJoinUI();
        return;
      }
      if (!alive) {
        // The user navigated away while we were connecting. A meeting we
        // were hosting alone is over before anyone saw it: free its link.
        void call.lease?.end();
        call.session.leave();
        media.stopAll();
        return;
      }
      handedOff = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
      ctx.startCall({
        media,
        session: call.session,
        roomCode: call.roomCode ?? null,
        lease: call.lease ?? null,
      });
    } catch (err) {
      console.error('[prejoin] failed to start/join', err);
      errorLine.textContent = friendlyError(err);
      restoreJoinUI();
    }
  }

  /** One-time links from older deploys: the code is the live invite code. */
  async function joinLegacy(code, name) {
    const session = new RoomSession({ media, name });
    await session.join(code);
    return { session, roomCode: null, lease: null };
  }

  /**
   * Persistent room: ask the directory what is running, then join the
   * meeting that is, or start one — anyone with a Puter account does, the
   * first to arrive hosting. A visitor with no account, or a room the
   * directory cannot be asked about, sits in the waiting room polling until
   * a meeting appears. Resolves null when the wait is cancelled or the view
   * unmounts.
   */
  async function joinRoom(code, name) {
    let sawRoom = false; // the directory has answered at least once
    let autoStartBlockedUntil = 0; // a start of ours failed — wait a while, don't retry on every poll
    // Invites that turned out to be dead. Chasing one costs a 20 s handshake
    // timeout, so an entry still advertising it is passed over — for as long
    // as it takes the host to notice and replace it (INVITE_DEAD_FOR_MS), not
    // for good: one transient failure must not hide a healthy meeting from
    // this lobby forever.
    const deadInvites = new Map(); // invite -> when it was written off
    const isDead = (invite) => {
      const at = deadInvites.get(invite);
      if (at === undefined) return false;
      if (Date.now() - at > INVITE_DEAD_FOR_MS) {
        deadInvites.delete(invite);
        return false;
      }
      return true;
    };
    // Failed dials per invite that were not the signaller saying "gone" —
    // one more try before the invite is written off (INVITE_FAILURES_BEFORE_DEAD).
    const dialFailures = new Map(); // invite -> count
    // Since when a meeting that IS running has been out of our reach: an
    // entry the host is keeping fresh whose invite we could not use. Shown
    // for what it is, and after a while with a way out.
    let unreachableSince = null;
    // Why: 'invite' — the invite itself failed us (the host is replacing
    // it, or it is dead); 'signaller' — we never got as far as the signaller,
    // which is our side, or Puter's, and no verdict on the invite; 'network'
    // — the dial went through, but no path could be built from here.
    let unreachableReason = null;
    // Consecutive dials that never reached the signaller — sets the backoff.
    let reachFailures = 0;
    // A meeting to dial without another read: the one that claimed the room
    // as we were about to.
    let next = null;
    // "Try again": every invite gets a clean slate, and the next poll dials
    // whatever the room advertises.
    forgetDialHistory = () => {
      deadInvites.clear();
      dialFailures.clear();
      reachFailures = 0;
    };

    for (let attempt = 0; ; attempt++) {
      if (!alive || waitCancelled) return null;
      const room = next ?? (await readRoom(code));
      next = null;
      if (!alive || waitCancelled) return null;

      if (room.status !== 'unknown') sawRoom = true;
      // A live entry whose invite we ruled out: the host is right there,
      // heartbeating — the meeting is running and out of reach. Anything
      // else, and we are simply waiting for a meeting to start. Except a
      // room we cannot read at all while we cannot reach the signaller
      // either: that is one outage, ours, and the meeting we saw running a
      // moment ago is still running — say so, rather than "waiting for the
      // host" until the network is back.
      const blindfolded = room.status === 'unknown' && unreachableReason === 'signaller';
      const outOfReach = room.status === 'live' && isDead(room.invite);
      const starting = room.status === 'starting';
      if (outOfReach) unreachableSince ??= Date.now();
      else if (room.status !== 'live' && !blindfolded) {
        unreachableSince = null;
        unreachableReason = null;
        reachFailures = 0;
      }

      if (room.status === 'live' && !outOfReach) {
        // The host's guest grant, for a guest with no session to reach the
        // relays on. A room an older build is hosting carries none; the join
        // then works only where a direct connection does.
        const session = new RoomSession({ media, name, grant: room.grant ?? null });
        // No grant with the invite and no session of our own: nothing to
        // reach the relays on, so the join works only where a direct
        // connection does. Said up front, so a network that blocks it does
        // not come as a mystery twenty seconds later.
        if (!room.grant && isAnonymous()) {
          const note = 'This meeting was started on an older version — joining may not work from every network.';
          if (sideSub.textContent !== note) sideSub.textContent = note;
        }
        const dialedAt = Date.now();
        retryBtn.disabled = true; // a dial is under way — nothing to hurry
        try {
          await session.join(room.invite);
          // "Stop waiting" (or Back) clicked while the join was in flight —
          // honor it rather than dragging the user into the meeting.
          if (!alive || waitCancelled) {
            leaveQuietly(session);
            return null;
          }
          return { session, roomCode: code, lease: null };
        } catch (error) {
          leaveQuietly(session);
          // A version mismatch won't fix itself by waiting — surface it.
          if (/version-mismatch/i.test(error?.message ?? '')) throw error;
          if (!alive || waitCancelled) return null;
          unreachableSince ??= Date.now();
          if (isSignallerUnreachableError(error)) {
            // We never got as far as the signaller: our own network, or a
            // signaller outage that hits the host the same. Neither is a
            // verdict on the invite — it stays off the failure counts and
            // out of the skip set, and is dialed again once the way there
            // may be back. With backoff: this can last a while.
            reachFailures += 1;
            unreachableReason = 'signaller';
            const delay = SIGNALLER_RETRY_MS[Math.min(reachFailures, SIGNALLER_RETRY_MS.length) - 1];
            console.warn('[prejoin] could not reach the signaller — trying the invite again in', delay, 'ms', error);
            showWaiting(sawRoom, attempt, { unreachableSince, unreachableReason });
            await waitABit(delay);
            continue;
          }
          reachFailures = 0;
          // The signaller took the dial and the host answered, yet no path
          // could be built: this network — no relay reachable, a symmetric
          // NAT, a corporate firewall. Waiting will not change that, and
          // the host cannot help; say so, and let the guest try again once
          // they have done something about it.
          const noMediaPath = error?.kind === 'no-media-path';
          unreachableReason = noMediaPath ? 'network' : 'invite';
          const failures = (dialFailures.get(room.invite) ?? 0) + 1;
          dialFailures.set(room.invite, failures);
          const quick = Date.now() - dialedAt < INVITE_QUICK_FAILURE_MS;
          if (isInvalidInviteError(error) || noMediaPath || !quick || failures >= INVITE_FAILURES_BEFORE_DEAD) {
            // The signaller no longer serves this invite (a host whose
            // socket died — it is replacing the invite as we speak), the
            // dial ran its course unanswered, no path to it can be built
            // from here, or it keeps failing. Rule it out for a while and
            // keep reading the directory: the invite the host writes next
            // shows up on the next polls.
            deadInvites.set(room.invite, Date.now());
            console.warn('[prejoin] published invite is unreachable — looking elsewhere', error);
            continue;
          }
          // One quick failure is not a verdict: a dropped channel, a socket
          // that closed on us. The same invite gets another try in a moment.
          console.warn('[prejoin] could not reach the published invite — trying again shortly', error);
          showWaiting(sawRoom, attempt, { unreachableSince, unreachableReason });
          await waitABit(INVITE_RETRY_DELAY_MS);
          continue;
        }
      }

      // Nothing is running — or the meeting that is cannot be reached from
      // here, or is still being set up. Whoever holds the link and has a
      // Puter account starts the meeting as a matter of course when nothing
      // runs: the first to arrive is the host, the way it works on a call
      // with friends, rather than being told to wait for a host who may be
      // them. Only a visitor with no account has to ask: hosting takes an
      // account (the host serves the room and pays for its relays), and the
      // sign-in is a popup that browsers allow only from a click, so it
      // lives on the Start button rather than here. Nothing is started over
      // a directory we could not read — a claim needs it — nor over a
      // meeting that is running and merely out of our reach: the directory
      // would refuse the claim anyway, and the host is right there. An
      // explicit Start click may still try; the directory settles it.
      const autoStart =
        !startRequested && !isAnonymous() && room.status === 'idle' && Date.now() >= autoStartBlockedUntil;
      if (startRequested || autoStart) {
        startRequested = false;
        const outcome = await startRoomMeeting(code, name);
        if (!alive || waitCancelled) {
          if (outcome.call) {
            void outcome.call.lease?.end();
            leaveQuietly(outcome.call.session);
          }
          return null;
        }
        if (outcome.call) return outcome.call;
        resetStartRoomBtn();
        if (outcome.taken) {
          // Someone started it first — the directory told us whose meeting
          // it is. Dial that, right away.
          next = outcome.taken;
          continue;
        }
        // The start failed (startRoomMeeting said so). Not again at once on
        // the automatic path — trying every poll would toast the same
        // apology every few seconds; the button stays for a deliberate retry.
        if (autoStart) autoStartBlockedUntil = Date.now() + AUTO_START_RETRY_MS;
        // Disabling the clicked button dropped keyboard focus to <body>.
        if (document.activeElement === document.body) startRoomBtn.focus();
      }

      showWaiting(sawRoom, attempt, { unreachableSince, unreachableReason, starting });
      // A Start click can land while a poll is in flight (no sleep to wake) —
      // don't make it sit through a full poll sleep before it's acted on.
      if (startRequested) continue;
      // Look often while the meeting is being set up, or is running and out
      // of reach: the invite we need is about to appear.
      const hurry =
        starting || (unreachableSince !== null && Date.now() - unreachableSince < UNREACHABLE_FAST_POLL_FOR_MS);
      await waitABit(
        hurry
          ? UNREACHABLE_POLL_MS + Math.random() * UNREACHABLE_POLL_JITTER_MS
          : ROOM_POLL_MS + Math.random() * ROOM_POLL_JITTER_MS
      );
    }
  }

  /**
   * Host this room's meeting. The room is claimed in the directory FIRST —
   * with no invite yet, which the directory shows as "starting" — so two
   * people clicking Start in the same breath never both serve: the second
   * claim is refused, with the first one's entry. Then we serve, and the
   * lease writes the invite. Resolves {call} once hosting, {taken: room}
   * when the room turned out to be someone's meeting already (dial that
   * one), or {} when the start failed — said out loud here.
   */
  async function startRoomMeeting(code, name) {
    const secret = crypto.randomUUID();
    let claim;
    try {
      claim = await withDeadline(claimRoom(code, { secret, host: name }), ROOM_SETUP_TIMEOUT_MS);
    } catch (error) {
      console.warn('[prejoin] could not claim the meeting link', error);
      toast('Could not reach the meeting service to start this meeting. It will be tried again in a moment.', {
        icon: 'info',
      });
      return {};
    }
    if (!alive || waitCancelled) {
      if (claim.ok) void endRoom(code, secret);
      return {};
    }
    if (!claim.ok) return { taken: claim.room };

    const session = new RoomSession({ media, name, secret });
    try {
      await session.host();
    } catch (error) {
      void endRoom(code, secret); // the claim was never a meeting — free the link
      throw error;
    }
    if (!alive || waitCancelled) {
      leaveQuietly(session);
      void endRoom(code, secret);
      return {};
    }
    const lease = new RoomLease(code, secret, () => hostFields(session));
    const first = await withDeadline(lease.start(), ROOM_SETUP_TIMEOUT_MS).catch((error) => ({ ok: false, error }));
    // "Stop waiting" (or Back) clicked while the claim was in flight —
    // honor it here too, or the user gets pulled into the meeting anyway.
    if (!alive || waitCancelled) {
      leaveQuietly(session);
      void lease.end();
      return {};
    }
    if (first.held) {
      // Our claim lapsed before the server was up (a very slow serve) and
      // someone else took the room meanwhile: theirs is the meeting.
      leaveQuietly(session);
      lease.stop();
      return { taken: first.room };
    }
    if (!first.ok) {
      // The claim landed, the invite did not (yet): the lease keeps trying,
      // and the shell says how the link is doing.
      console.warn('[prejoin] could not write the invite to the meeting link', first.error);
      toast('The meeting link couldn’t be updated just now. Guests may not find this meeting until it can be.', {
        icon: 'info',
      });
    }
    return { call: { session, roomCode: code, lease } };
  }

  function leaveQuietly(session) {
    try {
      session.leave();
    } catch {
      /* noop */
    }
  }

  function showWaiting(sawRoom, attempt, { unreachableSince = null, unreachableReason = null, starting = false } = {}) {
    // A meeting that is running but out of reach is not "waiting for the
    // host" — the host is there. Say so, and once it has gone on for a
    // while, say what to do about it: the person inside can re-share the
    // link, and knows to when told. When it is Puter's connection service
    // we cannot reach, say that instead of blaming the host's link. And a
    // meeting someone is starting this very moment is neither: connecting.
    const running = unreachableSince !== null;
    const title = starting ? 'The meeting is starting' : running ? 'The meeting is running' : 'Waiting for the host';
    const sub = starting
      ? 'Someone is starting the meeting right now. Connecting you — this usually takes a few seconds.'
      : running
        ? unreachableReason === 'network'
          ? 'Your network is blocking the connection. Try another network or a phone hotspot, or ask the host to check that guests can use relays.'
          : Date.now() - unreachableSince >= UNREACHABLE_HELP_AFTER_MS
            ? 'Still trying to get you in. Ask the host to check their connection, or to share the link again.'
            : unreachableReason === 'signaller'
              ? 'Can’t reach Puter’s connection service — retrying…'
              : 'The host is here, but their link is being refreshed. Connecting you — this usually takes a few seconds.'
        : !sawRoom && attempt >= ROOM_MISSING_HINT_AFTER
          ? 'We can’t reach the meeting service right now. Check your connection — you’ll join automatically once it’s back.'
          : isAnonymous()
            ? 'The meeting hasn’t started yet. You’ll join automatically when it starts — or sign in with Puter to start it yourself.'
            : 'The meeting hasn’t started yet. You’ll join automatically when it starts, or you can start it now.';
    if (sideTitle.textContent !== title) sideTitle.textContent = title;
    // Rewriting the live region with identical text would re-announce it to
    // screen readers on every poll — only touch it when it actually changes.
    if (sideSub.textContent !== sub) sideSub.textContent = sub;
    const label = starting || running ? 'Connecting…' : 'Waiting for the host…';
    if (joinBtn.textContent !== label) joinBtn.textContent = label;
    // Anyone holding the link may start the meeting when none is running.
    // Offering that only to the room's creator is what used to leave
    // everyone else staring at a link that could never come back to life.
    startRoomBtn.style.display = '';
    // "Try again" only while there is something to retry: a running meeting
    // the lobby has given up dialing for now. With nothing running it would
    // only re-read a room that is being read anyway.
    retryBtn.style.display = running ? '' : 'none';
    retryBtn.disabled = false;
    if (retryRequested) {
      retryRequested = false;
      // Disabling the clicked button dropped keyboard focus to <body>.
      if (running && document.activeElement === document.body) retryBtn.focus();
    }
    if (cancelWaitBtn.style.display === 'none') {
      cancelWaitBtn.style.display = '';
      // Disabling the clicked Join button dropped keyboard focus to <body>;
      // hand it to the most useful control that still does something.
      if (document.activeElement === document.body) startRoomBtn.focus();
    }
  }

  /**
   * The guest asks for another go at a meeting that is running but out of
   * reach: forget what was held against every invite, and have the loop
   * look and dial right away instead of sitting out its sleep.
   */
  function onRetry() {
    if (retryBtn.disabled || !joining) return;
    retryBtn.disabled = true;
    retryRequested = true;
    forgetDialHistory?.();
    wakeWait?.();
  }

  async function onStartRoom() {
    if (startRequested || startRoomBtn.disabled) return;
    startRoomBtn.disabled = true;
    startRoomBtn.textContent = 'Starting…';
    errorLine.textContent = '';
    // Starting a meeting takes a Puter account, here as on the home page:
    // the host serves the room, publishes its link and pays for its relays.
    // A guest waiting here may well have none — joining never asked. The
    // sign-in is a popup, which browsers allow only during the click, so it
    // is asked for now rather than from the waiting loop; declined, the
    // button is theirs to try again.
    if (isAnonymous()) {
      try {
        await ensureSession({ autoCreate: true });
      } catch (err) {
        if (!alive || waitCancelled) return;
        console.warn('[prejoin] could not sign in to start the meeting', err);
        errorLine.textContent = friendlyError(err);
        resetStartRoomBtn();
        return;
      }
      if (!alive || waitCancelled) return;
    }
    startRequested = true;
    wakeWait?.(); // let the waiting loop act on the click right away
  }

  function resetStartRoomBtn() {
    startRoomBtn.disabled = false;
    startRoomBtn.textContent = 'Start this meeting';
  }

  function onCancelWait() {
    waitCancelled = true;
    wakeWait?.();
  }

  function waitABit(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      wakeWait = done;
      function done() {
        clearTimeout(timer);
        wakeWait = null;
        resolve();
      }
    });
  }

  function restoreJoinUI() {
    joining = false;
    joinBtn.disabled = false;
    nameInput.disabled = false;
    // Hiding a focused waiting-room button (or an earlier disable) strands
    // focus on <body> — put it back on Join so keyboard users keep their place.
    const focusLost =
      document.activeElement === cancelWaitBtn ||
      document.activeElement === startRoomBtn ||
      document.activeElement === retryBtn ||
      document.activeElement === document.body;
    cancelWaitBtn.style.display = 'none';
    retryBtn.style.display = 'none';
    retryBtn.disabled = false;
    retryRequested = false;
    startRoomBtn.style.display = 'none';
    resetStartRoomBtn();
    refreshSideText();
    if (focusLost && joinBtn.isConnected) joinBtn.focus();
  }

  function joinLabel() {
    return params.mode === 'create' ? 'Start meeting' : 'Join now';
  }

  function sideTitleText() {
    return params.mode === 'create' ? 'Ready to start?' : 'Ready to join?';
  }

  function sideSubText() {
    if (params.mode === 'create') return 'You’ll get a reusable link that works every time this meeting runs.';
    return `Joining meeting ${displayCode(roomCode ?? params.code ?? '')}`;
  }

  function refreshSideText() {
    joinBtn.textContent = joinLabel();
    sideTitle.textContent = sideTitleText();
    sideSub.textContent = sideSubText();
  }

  return () => {
    alive = false;
    wakeWait?.();
    for (const dispose of mediaDisposers) dispose();
    video.srcObject = null; // release the preview's hold on the camera stream
    document.removeEventListener('visibilitychange', onVisibilityChange);
    navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
    document.querySelector('.dialog-backdrop')?.remove();
    if (!handedOff) media.stopAll();
  };
}

function roundCtl(kind, noun, onclick) {
  const node = el('button', { class: 'round-ctl', onclick });
  const set = (on) => {
    clear(node).append(icon(on ? kind : `${kind}Off`));
    node.classList.toggle('off', !on);
    node.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = `Turn ${on ? 'off' : 'on'} ${noun}`;
    node.title = label;
    node.setAttribute('aria-label', label);
  };
  set(true);
  return { node, set };
}

function fillSelect(select, devices, currentId, fallbackLabel) {
  clear(select);
  if (!devices.length) {
    select.append(el('option', { value: '' }, `No ${fallbackLabel.toLowerCase()} found`));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  devices.forEach((d, i) => {
    select.append(el('option', { value: d.deviceId }, d.label || `${fallbackLabel} ${i + 1}`));
  });
  if (currentId && devices.some((d) => d.deviceId === currentId)) select.value = currentId;
}

/**
 * What to tell the user about a start or join that failed. Shared with the
 * home screen's direct start (src/main.js).
 */
export function friendlyError(err) {
  // Puter's sign-in rejects with a plain `{error, msg}` object rather than an
  // Error, so reaching only for `.message` used to print "[object Object]" at
  // the one moment the user most needs to be told what happened. The codes
  // are checked before the text below, or "window was closed" would be read
  // as the *meeting* closing.
  const code = err?.error ?? '';
  const msg = err?.message ?? err?.msg ?? String(err);
  if (code === 'popup_blocked')
    return 'Your browser blocked the Puter window. Allow pop-ups for this site, then try again.';
  if (code === 'auth_window_closed' || /cancel|dismiss|denied/i.test(msg))
    return 'The Puter window closed before we could get you in. Try again.';
  if (/version-mismatch/i.test(msg))
    return 'You and the host are on different versions of ĐBAQ Meeting. Both of you should hard-refresh the page (⌘/Ctrl+Shift+R) and try again with a new meeting link.';
  if (isSignallerUnreachableError(err))
    return 'Can’t reach Puter’s connection service. Check your connection and try again.';
  if (err?.kind === 'no-media-path')
    return 'Your network is blocking the connection. Try another network or a phone hotspot, or ask the host to check that guests can use relays.';
  if (/handshake-timeout/i.test(msg))
    return 'Connected, but the meeting never answered. Make sure the host still has the meeting open. If this keeps happening, both of you should hard-refresh the page (⌘/Ctrl+Shift+R) to get the latest version.';
  if (/timed out/i.test(msg)) return 'Could not reach the meeting. Check the code and try again.';
  if (/closed/i.test(msg)) return 'The meeting is unavailable. The host may have left.';
  return msg;
}
