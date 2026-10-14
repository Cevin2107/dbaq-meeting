import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { TileGrid } from './tiles.js';
import { Emitter } from '../lib/emitter.js';
import {
  selectPipTiles,
  primaryPipTile,
  documentPipSupported,
  hostedPipSupported,
  videoPipSupported,
} from '../lib/pip.js';

/** Roughly a 16:9 stage plus the control bar underneath it. */
const WINDOW_SIZE = { width: 440, height: 300 };

/**
 * How long a hosted window gets to come back to us. The desktop opens it
 * and loads our pip.html at once; a page that hasn't reported in by then
 * isn't going to (blocked, or not ours).
 */
export const HOSTED_ATTACH_TIMEOUT_MS = 10_000;

/**
 * Hosted windows on their way: pip.html looks us up by the token in its
 * URL and hands over its window. Keyed by token so two asks (a reopen
 * before the first page loaded) can't cross.
 * @type {Map<string, (win: Window) => void>}
 */
const hostedArrivals = new Map();

/**
 * The hook pip.html calls, from inside the floating window, to hand over
 * its `window`. It is on the global because that page reaches us as one of
 * the desktop's frames (`parent.opener.frames[i]`) — a plain same-origin
 * property read, which is all a page in another window can do.
 */
function installHostedAttachHook() {
  if (typeof window.__pmPipAttach === 'function') return;
  window.__pmPipAttach = (token, win) => {
    const arrive = hostedArrivals.get(token);
    if (!arrive) return false;
    hostedArrivals.delete(token);
    arrive(win);
    return true;
  };
}

/**
 * A refusal we wrote ourselves, rather than one the browser threw. Its
 * message says what the reader could do about it, so the UI shows it
 * instead of a generic "not available" — most often on a phone, where
 * Document PiP doesn't exist and the single-video fallback has nothing to
 * float until somebody turns a camera on.
 */
export class PipUnavailableError extends Error {
  name = 'PipUnavailableError';
}

/**
 * PictureInPicture — the meeting in a window that floats over everything
 * else, for when the reader has to go and look at something in another
 * tab but still wants to see who is talking.
 *
 * The call itself never moves: the tab keeps its grid, its audio and its
 * connections, and the floating window is a second view of the same
 * streams (muted, so nobody is heard twice). Closing it — from the menu,
 * from the window's own close button, or by leaving the meeting — leaves
 * the call exactly where it was.
 *
 * Where Document PiP exists the window is a real document: a few tiles
 * laid out by the same {@link TileGrid} as the stage, plus mic, camera,
 * back-to-tab and leave. Inside the Puter desktop the app is a frame, which
 * browsers won't open a Document PiP window from — so the desktop opens it
 * for us and loads our `pip.html`, which finds this frame and hands over
 * its window; from there on it is the very same document. Everywhere else
 * it degrades to the older single-`<video>` PiP, which floats the most
 * important stream on its own.
 *
 * The document window comes and goes with the tab. Over the meeting tab
 * itself it would only be a postage stamp of the grid underneath, covering
 * tiles, so it closes as soon as the tab is back in view; and where the
 * browser offers it (Chromium's automatic picture-in-picture, which asks
 * through the media session when the reader switches tabs) it opens again
 * on its own the next time they leave. The single-video fallback is left
 * alone: nothing could bring it back, so closing it would only cost the
 * reader a trip through the menu.
 *
 * Emits 'change' ({active}) whenever the window opens or closes, however
 * it was closed.
 */
export class PictureInPicture extends Emitter {
  #media;
  #host;
  #onLeave;

  /** @type {Array<import('./tiles.js').TileData>} */
  #tiles = [];
  #pinnedId = null;
  /** Tile ids the window is showing, in order (ties go to whoever is up). */
  #shown = [];

  /** @type {Window|null} document PiP window */
  #win = null;
  /** The desktop opened #win for us (hosted), so the desktop closes it too. */
  #hosted = false;
  /** @type {TileGrid|null} */
  #grid = null;
  /** @type {HTMLVideoElement|null} the single-stream fallback's source */
  #video = null;
  /** Which tile the fallback is floating (streams get replaced; ids don't). */
  #videoTileId = null;

  #micBtn = null;
  #camBtn = null;
  #countEl = null;
  #disposers = [];

  /** Asking for a window, which the browser answers a turn or two later. */
  #opening = false;
  /**
   * Bumped by every close. An open still waiting on the browser when the
   * meeting ends compares against it and lets the window go, instead of
   * finishing a window wired to a call that is over.
   */
  #epoch = 0;
  /** Whether listeners have been told a window is up, so a close is news. */
  #announced = false;

  #onVisibility;
  /** Unregisters the browser's ask to open on a tab switch. */
  #stopAutoOpen;

  /**
   * @param {{media: import('../net/media.js').LocalMedia,
   *          host?: HTMLElement, onLeave?: () => void}} opts
   *   `host` is where the fallback's hidden <video> lives; it has to stay
   *   in a rendered document for the browser to float it.
   */
  constructor({ media, host, onLeave } = {}) {
    super();
    this.#media = media;
    this.#host = host ?? null;
    this.#onLeave = onLeave;

    // visibilitychange only fires on a change, so this never runs for the
    // tab the window was opened over — only for one the reader comes back
    // to. Closing also cancels an open still waiting on the browser, for a
    // reader who left and returned before the window came up.
    this.#onVisibility = () => {
      if (document.visibilityState === 'visible' && documentPipSupported()) this.close();
    };
    document.addEventListener('visibilitychange', this.#onVisibility);
    // Nobody asked for this one, so a refusal is nothing to tell them about.
    this.#stopAutoOpen = onAutoOpen(() => this.open().catch(() => {}));
  }

  get supported() {
    return documentPipSupported() || hostedPipSupported() || videoPipSupported();
  }

  get active() {
    return !!this.#win || !!this.#video;
  }

  /** Feed the window the same tiles the stage is drawing. */
  update({ tiles, pinnedId = null }) {
    this.#tiles = tiles ?? [];
    this.#pinnedId = pinnedId;
    if (this.active) this.#render();
  }

  /** Mirror a reaction onto the floating window's copy of the tile. */
  reactionBubble(tileId, emoji) {
    this.#grid?.reactionBubble(tileId, emoji);
  }

  async toggle() {
    if (this.active) this.close();
    else await this.open();
  }

  async open() {
    // requestWindow() resolves a turn or two after it is asked, and until it
    // does there is nothing to see `active` by. Without this, a second ask
    // in that gap opens a second window and orphans the first.
    if (this.active || this.#opening) return;
    this.#opening = true;
    const epoch = this.#epoch;
    try {
      if (documentPipSupported()) await this.#openWindow(epoch);
      else if (hostedPipSupported()) await this.#openHosted(epoch);
      else if (videoPipSupported()) await this.#openVideo();
      else throw new PipUnavailableError('This browser has no picture-in-picture.');
    } finally {
      this.#opening = false;
    }
    // Closed while it was opening (the call ended, or the fallback lost its
    // last picture): whatever came up has been let go, and there is nothing
    // to announce.
    if (epoch !== this.#epoch || !this.active) return;
    this.#announced = true;
    this.emit('change', { active: true });
  }

  close() {
    this.#epoch++;
    this.#end({ dismiss: true });
  }

  /** Hand the reader back to the meeting, the way Meet's mini window does. */
  returnToTab() {
    this.#focusMeeting();
    this.close();
  }

  /**
   * Bring the meeting back in front of the reader. In a tab of its own that
   * is the tab; on the desktop it is our window, which only the desktop can
   * raise — a frame focusing itself moves nothing there.
   */
  #focusMeeting() {
    if (this.#hosted) window.puter?.ui?.showWindow?.();
    focusOpener();
  }

  destroy() {
    this.close();
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.#stopAutoOpen();
    this.removeAllListeners();
  }

  // ---- document picture-in-picture ----

  async #openWindow(epoch) {
    const win = await window.documentPictureInPicture.requestWindow({
      width: WINDOW_SIZE.width,
      height: WINDOW_SIZE.height,
    });
    if (epoch !== this.#epoch) {
      // The meeting view is gone; a window wired to it would float on with
      // nothing behind it, and its Leave button would end a call twice.
      try {
        win.close();
      } catch {
        /* already gone */
      }
      return;
    }
    this.#mountWindow(win);
  }

  // ---- hosted document picture-in-picture (Puter desktop) ----

  async #openHosted(epoch) {
    const puter = window.puter;
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    installHostedAttachHook();
    const arrival = new Promise((resolve) => hostedArrivals.set(token, resolve));

    try {
      try {
        await puter.ui.requestPictureInPicture({
          // Next to the app's page, wherever that is served from.
          url: new URL(`pip.html?token=${encodeURIComponent(token)}`, window.location.href).href,
          width: WINDOW_SIZE.width,
          height: WINDOW_SIZE.height,
          // The user closing the window from its own frame: the page in
          // it unloads too, so pagehide below hears the same — this is the
          // backstop for a close the page didn't live to report.
          onClose: () => this.#end({ dismiss: false }),
        });
      } catch (err) {
        // The desktop's browser has no Document PiP at all: the lesser
        // window is still better than none.
        if (err?.name === 'NotSupportedError' && videoPipSupported()) {
          hostedArrivals.delete(token);
          return this.#openVideo();
        }
        throw err;
      }

      let timer;
      const win = await Promise.race([
        arrival,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The picture-in-picture page did not load.')),
            HOSTED_ATTACH_TIMEOUT_MS
          );
        }),
      ])
        .finally(() => clearTimeout(timer))
        .catch((err) => {
          // A window is up with nothing in it — take it down before failing.
          puter.ui.exitPictureInPicture?.()?.catch?.(() => {});
          throw err;
        });

      if (epoch !== this.#epoch) {
        // The meeting view is gone; see #openWindow.
        puter.ui.exitPictureInPicture?.()?.catch?.(() => {});
        return;
      }
      this.#hosted = true;
      this.#mountWindow(win);
    } finally {
      hostedArrivals.delete(token);
    }
  }

  /**
   * Fill a window with the miniature meeting. `win` is either a Document
   * PiP window of our own or the window of our pip.html inside one the
   * desktop opened; the two behave alike from here — a document to render
   * into, resize and pagehide events, and requestAnimationFrame.
   */
  #mountWindow(win) {
    this.#win = win;

    const doc = win.document;
    doc.title = 'Meeting';
    // The window opens on a document with no language of its own, which
    // leaves a screen reader guessing how to pronounce the names in it.
    if (document.documentElement.lang) doc.documentElement.lang = document.documentElement.lang;
    adoptStyles(doc);

    const gridEl = el('div', { class: 'pip-grid' });
    // "+2" stands in for a sentence, so the chip carries the sentence too
    // rather than reading out as a bare number.
    this.#countEl = el('span', { class: 'pip-count', role: 'img', style: { display: 'none' } });
    this.#micBtn = this.#ctlButton('Turn off microphone', () => this.#media.setMicOn(!this.#media.micOn));
    this.#camBtn = this.#ctlButton('Turn off camera', () => this.#media.setCamOn(!this.#media.camOn));

    doc.body.className = 'pip-window';
    doc.body.append(
      el('div', { class: 'pip-stage' }, gridEl, this.#countEl),
      el(
        'div',
        { class: 'pip-bar' },
        this.#micBtn,
        this.#camBtn,
        el(
          'button',
          {
            class: 'round-ctl',
            title: this.#hosted ? 'Back to the meeting' : 'Back to the meeting tab',
            'aria-label': this.#hosted ? 'Back to the meeting' : 'Back to the meeting tab',
            onclick: () => this.returnToTab(),
          },
          icon('back')
        ),
        el(
          'button',
          {
            class: 'leave-btn',
            title: 'Leave call',
            'aria-label': 'Leave call',
            onclick: () => {
              // The only control here whose result is somewhere else: the
              // tab swaps the call for the post-call screen — a countdown
              // home, and the link to rejoin. Take the reader to it, or
              // the call just vanishes with nothing said about it.
              this.#focusMeeting();
              this.#onLeave?.();
            },
          },
          icon('callEnd')
        )
      )
    );

    // The tiles are the page's own, so the window needs the page's CSS to
    // follow the theme it is switched to while open.
    const stopTheme = mirrorTheme(doc);
    const onResize = () => this.#grid?.layout();
    const onPageHide = () => this.#end({ dismiss: false });
    win.addEventListener('resize', onResize);
    win.addEventListener('pagehide', onPageHide);
    this.#disposers.push(
      () => {
        stopTheme();
        win.removeEventListener('resize', onResize);
        win.removeEventListener('pagehide', onPageHide);
      },
      this.#media.on('change', () => this.#renderControls())
    );

    this.#grid = new TileGrid(gridEl);
    this.#renderControls();
    this.#render();
    // The window is still being sized when requestWindow() resolves, so
    // the first layout can land on a zero-width container.
    win.requestAnimationFrame?.(() => this.#grid?.layout());
  }

  #ctlButton(label, onclick) {
    return el('button', { class: 'round-ctl', title: label, 'aria-label': label, onclick });
  }

  #renderControls() {
    if (!this.#micBtn) return;
    setCtl(this.#micBtn, 'mic', this.#media.micOn, 'microphone');
    setCtl(this.#camBtn, 'cam', this.#media.camOn, 'camera');
  }

  // ---- single-video fallback ----

  async #openVideo() {
    const primary = primaryPipTile(this.#tiles, { pinnedId: this.#pinnedId });
    if (!primary) {
      throw new PipUnavailableError('Turn on a camera or present to float the meeting.');
    }

    const video = el('video', { class: 'pip-source', autoplay: true, playsinline: true, muted: true });
    video.muted = true; // the attribute alone doesn't mute a srcObject
    video.srcObject = primary.stream;
    this.#videoTileId = primary.id;
    (this.#host ?? document.body).append(video);
    this.#video = video;

    const onLeaveEvent = () => this.#end({ dismiss: false });
    video.addEventListener('leavepictureinpicture', onLeaveEvent);
    this.#disposers.push(() => video.removeEventListener('leavepictureinpicture', onLeaveEvent));

    try {
      await video.play?.();
    } catch {
      /* a muted stream should always play; requestPictureInPicture reports the real problem */
    }
    try {
      await video.requestPictureInPicture();
    } catch (err) {
      this.#end({ dismiss: false });
      throw err;
    }
  }

  // ---- rendering ----

  #render() {
    if (this.#grid) {
      const chosen = selectPipTiles(this.#tiles, { pinnedId: this.#pinnedId, previous: this.#shown });
      this.#shown = chosen.map((tile) => tile.id);
      // Every one of these streams is already playing, with its audio, in
      // the tab that owns the call — a second element would double it.
      this.#grid.update(chosen.map((tile) => ({ ...tile, muted: true })));
      this.#grid.setPinned(this.#pinnedId);
      setCount(this.#countEl, chosen.length, this.#tiles.length);
      return;
    }
    if (this.#video) this.#renderVideo();
  }

  /**
   * A lone floating video should stay on whatever it is showing: swapping
   * streams under the reader every time somebody speaks would be a strobe
   * light. Follow a pin (a presentation, usually), and otherwise only move
   * when what it is showing is gone.
   */
  #renderVideo() {
    const current = this.#tiles.find(
      (tile) => tile.id === this.#videoTileId && tile.showVideo && tile.stream
    );
    const pinned = this.#pinnedId
      ? this.#tiles.find((tile) => tile.id === this.#pinnedId && tile.showVideo && tile.stream)
      : null;
    const next = pinned ?? current ?? primaryPipTile(this.#tiles, { pinnedId: this.#pinnedId });
    if (!next) {
      // Nothing left with a picture in it — an empty floating window is
      // worse than none.
      this.close();
      return;
    }

    this.#videoTileId = next.id;
    // A camera that was turned off and on again comes back as a new stream
    // under the same tile, so follow the object as well as the id.
    if (next.stream !== this.#video.srcObject) {
      this.#video.srcObject = next.stream;
      this.#video.play?.()?.catch?.(() => {});
    }
  }

  // ---- teardown ----

  /** @param {{dismiss: boolean}} opts dismiss: we are closing it, not the browser */
  #end({ dismiss }) {
    if (!this.active) return;
    const win = this.#win;
    const hosted = this.#hosted;
    const video = this.#video;

    for (const dispose of this.#disposers) dispose();
    this.#disposers = [];
    this.#grid?.destroy();
    this.#grid = null;
    this.#win = null;
    this.#hosted = false;
    this.#video = null;
    this.#videoTileId = null;
    this.#micBtn = this.#camBtn = this.#countEl = null;
    this.#shown = [];

    if (dismiss) {
      // A hosted window is the desktop's to close: from in here `win` is a
      // frame, and a frame can't close itself.
      if (hosted) window.puter?.ui?.exitPictureInPicture?.()?.catch?.(() => {});
      else win?.close();
      if (video && document.pictureInPictureElement === video) {
        document.exitPictureInPicture?.().catch(() => {});
      }
    }
    if (video) {
      video.srcObject = null;
      video.remove();
    }
    // An open that failed half-way was never announced, so its cleanup is
    // not a close anybody is waiting to hear about.
    if (this.#announced) {
      this.#announced = false;
      this.emit('change', { active: false });
    }
  }
}

/**
 * Ask to be told when the reader switches away from the tab, so the window
 * can open without them. Chromium (desktop, 120+) fires the media session's
 * 'enterpictureinpicture' action for a page that is capturing a camera or
 * microphone, and lets the handler call requestWindow() with no gesture
 * behind it; the reader can turn this off per site in the browser's own
 * settings, in which case the handler simply never runs. Anywhere else the
 * action name is unknown and the registration throws.
 *
 * @param {() => void} open
 * @returns {() => void} unregister
 */
function onAutoOpen(open) {
  const session = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
  if (!documentPipSupported() || typeof session?.setActionHandler !== 'function') return () => {};
  try {
    session.setActionHandler('enterpictureinpicture', open);
  } catch {
    return () => {};
  }
  return () => {
    try {
      session.setActionHandler('enterpictureinpicture', null);
    } catch {
      /* it took the registration; it can take the removal */
    }
  };
}

/**
 * Bring the tab that owns the call to the front. The browser is allowed to
 * refuse, in which case it would rather the reader switched over itself.
 */
function focusOpener() {
  try {
    window.focus();
  } catch {
    /* nothing to do about it from here */
  }
}

/**
 * The chip that keeps the window honest about the size of the meeting.
 * Hidden while everything fits.
 */
function setCount(node, shown, total) {
  const hidden = total - shown;
  node.style.display = hidden > 0 ? '' : 'none';
  node.textContent = hidden > 0 ? `+${hidden}` : '';
  const label = `Showing ${shown} of ${total}`;
  node.title = label;
  node.setAttribute('aria-label', label);
}

function setCtl(btn, kind, on, label) {
  clear(btn).append(icon(on ? kind : `${kind}Off`));
  btn.classList.toggle('off', !on);
  btn.title = `Turn ${on ? 'off' : 'on'} ${label}`;
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/**
 * A picture-in-picture window opens with an empty document — no styles, no
 * fonts. Copy the page's own CSS into it so the tiles it borrows look the
 * way they do on the stage.
 */
function adoptStyles(doc) {
  for (const sheet of document.styleSheets) {
    try {
      const css = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      doc.head.append(el('style', { media: sheet.media?.mediaText || null }, css));
    } catch {
      // A cross-origin sheet won't hand over its rules — link it instead.
      if (sheet.href) doc.head.append(el('link', { rel: 'stylesheet', href: sheet.href }));
    }
  }
}

/** Keep the window on the theme the page is on, including a change made while it is open. */
function mirrorTheme(doc) {
  const apply = () => {
    const theme = document.documentElement.dataset.theme;
    if (theme) doc.documentElement.dataset.theme = theme;
    else delete doc.documentElement.dataset.theme;
  };
  apply();
  if (typeof MutationObserver !== 'function') return () => {};
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
