// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  selectPipTiles,
  primaryPipTile,
  pipSupported,
  documentPipSupported,
  hostedPipSupported,
} from '../src/lib/pip.js';
import { PictureInPicture, PipUnavailableError, HOSTED_ATTACH_TIMEOUT_MS } from '../src/ui/pip.js';
import { Emitter } from '../src/lib/emitter.js';
import { Roster } from '../src/lib/roster.js';
import { mountMeeting } from '../src/ui/meeting.js';

/*
 * Picture-in-picture floats a second view of the call. The call itself
 * stays in the tab, so the window is a mirror: it borrows the streams
 * (muted, or every voice would arrive twice) and shows the few tiles that
 * fit in something the size of a postcard.
 */

/** Streams are stable objects in the app — the same one on every refresh. */
const streams = new Map();
function streamFor(id) {
  if (!streams.has(id)) streams.set(id, { id: `${id}-stream` });
  return streams.get(id);
}

/** A tile as ui/meeting.js builds them, with just the fields the picker reads. */
function tile(id, extra = {}) {
  return {
    id,
    title: id,
    stream: streamFor(id),
    showVideo: true,
    speaking: false,
    self: false,
    screen: false,
    ...extra,
  };
}

describe('picking what a floating window carries', () => {
  it('takes everyone when the whole call fits', () => {
    const tiles = [tile('a'), tile('b'), tile('c')];
    expect(selectPipTiles(tiles).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('caps a big call and keeps the stage order', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => tile(id));
    expect(selectPipTiles(tiles).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops your own tile before anyone else’s', () => {
    const tiles = [tile('me', { self: true }), tile('a'), tile('b'), tile('c'), tile('d')];
    expect(selectPipTiles(tiles).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('makes room for whoever is talking', () => {
    const tiles = [tile('a'), tile('b'), tile('c'), tile('d'), tile('e', { speaking: true })];
    expect(selectPipTiles(tiles).map((t) => t.id)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('never drops a presentation', () => {
    const tiles = [
      tile('a'),
      tile('b'),
      tile('c'),
      tile('d'),
      tile('e'),
      tile('f:screen', { screen: true }),
    ];
    expect(selectPipTiles(tiles).map((t) => t.id)).toContain('f:screen');
  });

  it('keeps the pinned tile and leaves a slot free for its filmstrip', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e'].map((id) => tile(id));
    const chosen = selectPipTiles(tiles, { pinnedId: 'e' });
    expect(chosen.map((t) => t.id)).toEqual(['a', 'b', 'e']);
  });

  it('leaves the tiles that are already up where they are', () => {
    const tiles = ['a', 'b', 'c', 'd', 'e'].map((id) => tile(id));
    // 'e' got in by speaking; now nobody is. It keeps its slot rather than
    // handing it back and shuffling every face in the window.
    const chosen = selectPipTiles(tiles, { previous: ['a', 'b', 'c', 'e'] });
    expect(chosen.map((t) => t.id)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('floats the most important stream that actually has a picture', () => {
    const tiles = [
      tile('me', { self: true }),
      tile('a', { showVideo: false }),
      tile('b'),
      tile('c:screen', { screen: true }),
    ];
    expect(primaryPipTile(tiles).id).toBe('c:screen');
    expect(primaryPipTile(tiles, { pinnedId: 'b' }).id).toBe('b');
    expect(primaryPipTile([tile('a', { showVideo: false })])).toBe(null);
  });
});

/** The Document PiP window Chromium hands back, as much of it as we use. */
class FakePipWindow extends EventTarget {
  closed = false;
  constructor() {
    super();
    this.document = document.implementation.createHTMLDocument('');
  }
  requestAnimationFrame(fn) {
    fn();
    return 1;
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event('pagehide'));
  }
}

class FakeMedia extends Emitter {
  micOn = true;
  camOn = true;
  setMicOn = vi.fn((on) => {
    this.micOn = on;
    this.emit('change', {});
  });
  setCamOn = vi.fn((on) => {
    this.camOn = on;
    this.emit('change', {});
  });
}

let media;
let pip;
let opened;

const pipTiles = () => [...opened.document.querySelectorAll('.pip-grid .tile')];
const pipButton = (label) => opened.document.querySelector(`.pip-bar [aria-label="${label}"]`);

/** The reader switching tabs, as the page hears about it. */
function tabBecomes(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}
/** Chromium's media session, holding whatever action handlers a page registers. */
function withMediaSession(setActionHandler) {
  Object.defineProperty(navigator, 'mediaSession', { value: { setActionHandler }, configurable: true });
}

beforeEach(() => {
  opened = null;
  window.documentPictureInPicture = {
    requestWindow: vi.fn(async () => {
      opened = new FakePipWindow();
      return opened;
    }),
  };
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  media = new FakeMedia();
  pip = new PictureInPicture({ media, onLeave: vi.fn() });
});

afterEach(() => {
  pip.destroy();
  delete window.documentPictureInPicture;
  delete document.visibilityState; // back to jsdom's own (always visible)
  delete navigator.mediaSession;
});

describe('the floating meeting window', () => {
  it('is offered when the browser has an API for it', () => {
    expect(pip.supported).toBe(true);
    expect(pipSupported()).toBe(true);
    delete window.documentPictureInPicture;
    expect(pip.supported).toBe(false);
  });

  it('mirrors the stage into the window it opens', async () => {
    document.documentElement.lang = 'en';
    pip.update({ tiles: [tile('me', { self: true }), tile('a')], pinnedId: null });
    await pip.open();

    expect(pip.active).toBe(true);
    expect(pipTiles()).toHaveLength(2);
    expect(pipButton('Leave call')).toBeTruthy();
    // A document that opens empty has no language of its own to read the
    // participants' names in.
    expect(opened.document.documentElement.lang).toBe('en');
  });

  it('mutes the copies — the call is still being played in the tab', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    const video = opened.document.querySelector('.pip-grid video');
    expect(video.muted).toBe(true);
  });

  it('follows the call while it is open, and says who didn’t fit', async () => {
    pip.update({ tiles: [tile('a'), tile('b')] });
    await pip.open();
    expect(opened.document.querySelector('.pip-count').style.display).toBe('none');

    pip.update({ tiles: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => tile(id)) });
    expect(pipTiles()).toHaveLength(4);
    const count = opened.document.querySelector('.pip-count');
    expect(count.textContent).toBe('+2');
    // A bare "+2" says nothing on its own — hovering it, or reading it
    // through a screen reader, has to spell out the meeting's real size.
    expect(count.getAttribute('aria-label')).toBe('Showing 4 of 6');
    expect(count.title).toBe('Showing 4 of 6');

    pip.update({ tiles: [tile('a')] });
    expect(pipTiles()).toHaveLength(1);
  });

  it('drives the real microphone and camera from its own controls', async () => {
    pip.update({ tiles: [tile('me', { self: true })] });
    await pip.open();

    pipButton('Turn off microphone').click();
    expect(media.setMicOn).toHaveBeenCalledWith(false);
    // The button follows the device, however it was turned off.
    expect(pipButton('Turn on microphone')).toBeTruthy();

    media.setCamOn(false);
    expect(pipButton('Turn on camera')).toBeTruthy();
  });

  it('lets a window go that the browser hands over after the meeting view is gone', async () => {
    pip.update({ tiles: [tile('a')] });
    let handOver;
    window.documentPictureInPicture.requestWindow = vi.fn(
      () =>
        new Promise((resolve) => {
          handOver = () => {
            opened = new FakePipWindow();
            resolve(opened);
          };
        })
    );
    const changes = [];
    pip.on('change', (e) => changes.push(e.active));

    const opening = pip.open();
    // The call ends while the browser is still putting the window up.
    pip.destroy();
    handOver();
    await opening;

    // Nothing is left floating over a call that is over, and nobody was
    // told a window opened.
    expect(pip.active).toBe(false);
    expect(opened.closed).toBe(true);
    expect(changes).toEqual([]);
  });

  it('opens one window however many times it is asked at once', async () => {
    pip.update({ tiles: [tile('a')] });
    // The window arrives a turn later; asking again in the gap must not
    // leave a second one floating with nobody holding it.
    await Promise.all([pip.open(), pip.open(), pip.toggle()]);

    expect(window.documentPictureInPicture.requestWindow).toHaveBeenCalledTimes(1);
    expect(pip.active).toBe(true);
  });

  it('closes when the reader closes the window', async () => {
    const changes = [];
    pip.on('change', ({ active }) => changes.push(active));
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    opened.dispatchEvent(new Event('pagehide'));
    expect(pip.active).toBe(false);
    expect(changes).toEqual([true, false]);
    // A window that is gone must not be fed any more tiles.
    expect(() => pip.update({ tiles: [tile('a'), tile('b')] })).not.toThrow();
  });

  it('closes the window when the meeting view goes away', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();
    pip.destroy();

    expect(opened.closed).toBe(true);
    expect(pip.active).toBe(false);
  });

  it('takes the reader back to the tab to leave, so they see where they land', async () => {
    const onLeave = vi.fn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    pip = new PictureInPicture({ media, onLeave });
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    pipButton('Leave call').click();
    expect(onLeave).toHaveBeenCalled();
    // The post-call screen — its countdown home, its link to rejoin — is
    // in the tab, and unseen there it might as well not exist.
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });

  it('hands the reader back to the tab', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    pipButton('Back to the meeting tab').click();
    expect(focus).toHaveBeenCalled();
    expect(pip.active).toBe(false);
    focus.mockRestore();
  });

  it('closes when the reader comes back to the meeting tab', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();
    // Opening it over the tab is not coming back to the tab.
    expect(pip.active).toBe(true);

    tabBecomes('hidden');
    expect(pip.active).toBe(true);
    // Over the meeting itself the window is a postage stamp of the grid
    // underneath, covering tiles.
    tabBecomes('visible');
    expect(pip.active).toBe(false);
    expect(opened.closed).toBe(true);
  });

  it('lets a window go that arrives after the reader is already back', async () => {
    pip.update({ tiles: [tile('a')] });
    let handOver;
    window.documentPictureInPicture.requestWindow = vi.fn(
      () =>
        new Promise((resolve) => {
          handOver = () => {
            opened = new FakePipWindow();
            resolve(opened);
          };
        })
    );
    const changes = [];
    pip.on('change', (e) => changes.push(e.active));

    tabBecomes('hidden');
    const opening = pip.open();
    tabBecomes('visible');
    handOver();
    await opening;

    expect(pip.active).toBe(false);
    expect(opened.closed).toBe(true);
    expect(changes).toEqual([]);
  });

  it('opens on its own when the browser says the reader has switched tabs', async () => {
    pip.destroy();
    const setActionHandler = vi.fn();
    withMediaSession(setActionHandler);
    pip = new PictureInPicture({ media, onLeave: vi.fn() });
    pip.update({ tiles: [tile('a')] });

    // Chromium's automatic picture-in-picture: it fires this on a tab switch
    // and lets the handler open a window with no gesture behind it.
    expect(setActionHandler).toHaveBeenCalledWith('enterpictureinpicture', expect.any(Function));
    const [, onEnter] = setActionHandler.mock.calls[0];
    onEnter();
    await vi.waitFor(() => expect(pip.active).toBe(true));
    expect(pipTiles()).toHaveLength(1);

    // The ask dies with the meeting view, or a window would open on a
    // call that is over.
    pip.destroy();
    expect(setActionHandler).toHaveBeenLastCalledWith('enterpictureinpicture', null);
  });

  it('keeps quiet when the automatic window cannot open', async () => {
    pip.destroy();
    const setActionHandler = vi.fn();
    withMediaSession(setActionHandler);
    window.documentPictureInPicture.requestWindow = vi.fn().mockRejectedValue(new Error('no'));
    pip = new PictureInPicture({ media, onLeave: vi.fn() });
    const [, onEnter] = setActionHandler.mock.calls[0];

    // Nobody asked for it, so nobody is told it failed.
    await expect(onEnter()).resolves.toBeUndefined();
    expect(pip.active).toBe(false);
  });

  it('copes with a media session that has never heard of the action', () => {
    pip.destroy();
    withMediaSession(() => {
      throw new TypeError('unknown action');
    });
    expect(() => {
      pip = new PictureInPicture({ media, onLeave: vi.fn() });
    }).not.toThrow();
    expect(() => pip.destroy()).not.toThrow();
  });
});

describe('inside the Puter desktop (a hosted window)', () => {
  /*
   * On the desktop the app is a frame, and browsers refuse Document PiP
   * from a frame. The desktop opens the window instead, loads our pip.html
   * in it, and that page hands its window back to us through a hook on our
   * global — the same window, rendered the same way, closed by the desktop.
   */
  let desktop;
  let hostedOnClose;
  /** jsdom's own `top`, to put back — deleting it would leave the page top-less, not top-level. */
  let realTop;

  /**
   * The desktop's side of puter.ui.requestPictureInPicture(): open a
   * window, load pip.html, which looks us up by the token in its URL and
   * hands over its window a moment later.
   */
  function fakeDesktop({ arrives = true, reject = null } = {}) {
    return {
      requestPictureInPicture: vi.fn(async ({ url, onClose }) => {
        if (reject) throw reject;
        hostedOnClose = onClose;
        const token = new URL(url).searchParams.get('token');
        if (!arrives) return;
        queueMicrotask(() => {
          opened = new FakePipWindow();
          window.__pmPipAttach(token, opened);
        });
      }),
      exitPictureInPicture: vi.fn(async () => {
        hostedOnClose = null;
        const win = opened;
        opened = null;
        win?.close();
        return !!win;
      }),
      showWindow: vi.fn(),
    };
  }

  beforeEach(() => {
    pip.destroy();
    // A frame in the desktop's page, not a tab of our own.
    realTop = Object.getOwnPropertyDescriptor(window, 'top');
    Object.defineProperty(window, 'top', { value: {}, configurable: true });
    desktop = fakeDesktop();
    window.puter = { env: 'app', ui: desktop };
    pip = new PictureInPicture({ media, onLeave: vi.fn() });
  });

  afterEach(() => {
    if (realTop) Object.defineProperty(window, 'top', realTop);
    else delete window.top;
    delete window.puter;
    delete window.__pmPipAttach;
  });

  it('is offered, through the desktop rather than the browser’s own API', async () => {
    expect(pip.supported).toBe(true);
    // The browser's API is there — and would refuse, from a frame.
    expect(documentPipSupported()).toBe(false);
    expect(hostedPipSupported()).toBe(true);

    pip.update({ tiles: [tile('me', { self: true }), tile('a')] });
    await pip.open();

    expect(window.documentPictureInPicture.requestWindow).not.toHaveBeenCalled();
    expect(desktop.requestPictureInPicture).toHaveBeenCalledTimes(1);
    const [{ url, width, height }] = desktop.requestPictureInPicture.mock.calls[0];
    expect(new URL(url).pathname.endsWith('/pip.html')).toBe(true);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(pip.active).toBe(true);
    expect(pipTiles()).toHaveLength(2);
    // There is no tab to go back to, only our window.
    expect(pipButton('Back to the meeting')).toBeTruthy();
  });

  it('is not offered off the desktop, in someone else’s frame', () => {
    window.puter = { env: 'web', ui: desktop };
    expect(hostedPipSupported()).toBe(false);
    delete window.puter;
    expect(hostedPipSupported()).toBe(false);
  });

  it('has the desktop close it, and says so', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();
    const onChange = vi.fn();
    pip.on('change', onChange);

    pip.close();

    expect(desktop.exitPictureInPicture).toHaveBeenCalledTimes(1);
    expect(pip.active).toBe(false);
    expect(onChange).toHaveBeenCalledWith({ active: false });
  });

  it('hears about the reader closing the window', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    hostedOnClose();

    expect(pip.active).toBe(false);
    // Already gone; nothing to ask the desktop to close.
    expect(desktop.exitPictureInPicture).not.toHaveBeenCalled();
  });

  it('brings the meeting window forward on the way back', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    pipButton('Back to the meeting').click();

    expect(desktop.showWindow).toHaveBeenCalledTimes(1);
    expect(pip.active).toBe(false);
  });

  it('stays up when the tab is looked at — on the desktop it always is', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    tabBecomes('visible');

    expect(pip.active).toBe(true);
  });

  it('falls back to a single video when the desktop’s browser has no Document PiP', async () => {
    const refusal = new Error('no Document PiP here');
    refusal.name = 'NotSupportedError';
    desktop = fakeDesktop({ reject: refusal });
    window.puter = { env: 'app', ui: desktop };
    const request = vi.fn().mockResolvedValue({});
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    window.HTMLVideoElement.prototype.requestPictureInPicture = request;
    try {
      pip.update({ tiles: [tile('a')] });
      await pip.open();
      expect(request).toHaveBeenCalledTimes(1);
      expect(pip.active).toBe(true);
    } finally {
      delete window.HTMLVideoElement.prototype.requestPictureInPicture;
      delete document.pictureInPictureEnabled;
    }
  });

  it('passes the browser’s other refusals on', async () => {
    const refusal = new Error('no gesture');
    refusal.name = 'NotAllowedError';
    desktop = fakeDesktop({ reject: refusal });
    window.puter = { env: 'app', ui: desktop };
    pip.update({ tiles: [tile('a')] });
    await expect(pip.open()).rejects.toBe(refusal);
    expect(pip.active).toBe(false);
  });

  it('gives up on a window whose page never reports in, and takes it down', async () => {
    vi.useFakeTimers();
    try {
      desktop = fakeDesktop({ arrives: false });
      window.puter = { env: 'app', ui: desktop };
      pip.update({ tiles: [tile('a')] });
      const opening = pip.open();
      const outcome = expect(opening).rejects.toThrow(/did not load/);
      await vi.advanceTimersByTimeAsync(HOSTED_ATTACH_TIMEOUT_MS + 1);
      await outcome;
      expect(desktop.exitPictureInPicture).toHaveBeenCalledTimes(1);
      expect(pip.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a window go that arrives after the meeting view is gone', async () => {
    let arrive;
    desktop.requestPictureInPicture = vi.fn(async ({ url }) => {
      const token = new URL(url).searchParams.get('token');
      arrive = () => {
        opened = new FakePipWindow();
        window.__pmPipAttach(token, opened);
      };
    });
    pip.update({ tiles: [tile('a')] });
    const opening = pip.open();
    await Promise.resolve();
    await Promise.resolve();
    pip.destroy();

    arrive();
    await opening;

    expect(desktop.exitPictureInPicture).toHaveBeenCalled();
    expect(pip.active).toBe(false);
  });

  it('ignores a page that is not the one it asked for', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();
    expect(window.__pmPipAttach('some-other-token', new FakePipWindow())).toBe(false);
  });
});

describe('the single-video fallback', () => {
  let host;
  let request;

  beforeEach(() => {
    delete window.documentPictureInPicture; // no Document PiP here
    request = vi.fn().mockResolvedValue({});
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    window.HTMLVideoElement.prototype.requestPictureInPicture = request;
    host = document.createElement('div');
    document.body.append(host);
    pip = new PictureInPicture({ media, host, onLeave: vi.fn() });
  });

  afterEach(() => {
    pip.destroy();
    host.remove();
    delete window.HTMLVideoElement.prototype.requestPictureInPicture;
    delete document.pictureInPictureEnabled;
  });

  it('floats the stream that matters most', async () => {
    pip.update({ tiles: [tile('me', { self: true }), tile('a')] });
    await pip.open();

    expect(request).toHaveBeenCalled();
    const video = host.querySelector('video.pip-source');
    expect(video.srcObject.id).toBe('a-stream');
    expect(video.muted).toBe(true);
  });

  it('refuses when there is no picture to float, and says what would help', async () => {
    pip.update({ tiles: [tile('a', { showVideo: false })] });
    // The reason is the reader's to act on, so it has to survive the throw.
    await expect(pip.open()).rejects.toThrow(PipUnavailableError);
    expect(pip.active).toBe(false);
    expect(host.querySelector('video.pip-source')).toBe(null);
  });

  it('says nothing about a window that never opened', async () => {
    request.mockRejectedValue(new Error('the browser said no'));
    const changes = [];
    pip.on('change', ({ active }) => changes.push(active));
    pip.update({ tiles: [tile('a')] });

    await expect(pip.open()).rejects.toThrow();
    // Cleaning up an open that failed is not a close: nobody was ever told
    // it was up.
    expect(changes).toEqual([]);
    expect(pip.active).toBe(false);
    expect(host.querySelector('video.pip-source')).toBe(null);
  });

  it('stays on its stream when someone else speaks, and follows a pin', async () => {
    pip.update({ tiles: [tile('a'), tile('b')] });
    await pip.open();
    const video = host.querySelector('video.pip-source');

    pip.update({ tiles: [tile('a'), tile('b', { speaking: true })] });
    expect(video.srcObject.id).toBe('a-stream');

    pip.update({ tiles: [tile('a'), tile('b')], pinnedId: 'b' });
    expect(video.srcObject.id).toBe('b-stream');
  });

  it('gives up when the stream it was floating is gone', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    pip.update({ tiles: [tile('a', { showVideo: false })] });
    expect(pip.active).toBe(false);
    expect(host.querySelector('video.pip-source')).toBe(null);
  });

  it('stays up when the reader comes back — nothing could bring it back', async () => {
    pip.update({ tiles: [tile('a')] });
    await pip.open();

    tabBecomes('hidden');
    tabBecomes('visible');
    expect(pip.active).toBe(true);
  });

  it('is never opened for the reader — only the document window comes back on its own', () => {
    pip.destroy();
    const setActionHandler = vi.fn();
    withMediaSession(setActionHandler);
    pip = new PictureInPicture({ media, host, onLeave: vi.fn() });
    expect(setActionHandler).not.toHaveBeenCalled();
  });
});

/*
 * And how the meeting itself offers it: an entry in the ⋮ menu that opens
 * the window on the call as it stands, and nothing at all in a browser
 * that can't float anything.
 */

class MeetingMedia extends FakeMedia {
  presenting = false;
  screenStream = null;
  background = { type: 'none' };
  noiseSuppression = false;
  stream = { id: 'self-stream', getAudioTracks: () => [], getVideoTracks: () => [] };
  listDevices = async () => ({ mics: [], cams: [], speakers: [] });
}

class MeetingSession extends Emitter {
  selfId = 'self';
  code = 'abc-defg-hij';
  isHost = false;
  hand = false;
  startedAt = Date.now();
  roster = new Roster();
  constructor() {
    super();
    this.roster.add({ id: this.selfId, name: 'Ada', isSelf: true, mic: true, cam: true });
    this.roster.add({ id: 'peer', name: 'Grace', mic: true, cam: true });
  }
  getStream = (id) => ({ id: `${id}-stream` });
  sendChat = vi.fn();
  sendReaction = vi.fn();
  setHand = vi.fn();
}

describe('the meeting’s picture-in-picture entry', () => {
  let root;
  let unmount;
  let toasts;
  let meetingMedia;
  let meetingSession;

  const openMoreMenu = () =>
    root.querySelector('.meeting-controls .bar-btn[aria-haspopup="menu"]').click();
  const menuItem = (label) =>
    [...root.querySelectorAll('.menu-above-bar .menu-item')].find((item) => item.textContent === label);

  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    root = document.createElement('div');
    toasts = document.createElement('div');
    toasts.id = 'toasts';
    document.body.append(root, toasts);
    meetingMedia = new MeetingMedia();
    meetingSession = new MeetingSession();
    unmount = mountMeeting(
      root,
      { media: meetingMedia, session: meetingSession, roomCode: 'abc-defg-hij' },
      { endCall: vi.fn() }
    );
  });

  afterEach(() => {
    unmount?.();
    root.remove();
    toasts.remove();
  });

  it('floats the call as the stage has it', async () => {
    openMoreMenu();
    menuItem('Picture-in-picture').click();
    await vi.waitFor(() => expect(opened).toBeTruthy());

    // Both participants, and none of them playing a second copy of the audio.
    const videos = [...opened.document.querySelectorAll('.pip-grid .tile video')];
    expect(videos).toHaveLength(2);
    expect(videos.every((video) => video.muted)).toBe(true);
  });

  it('offers to close the window it has already opened', async () => {
    openMoreMenu();
    menuItem('Picture-in-picture').click();
    await vi.waitFor(() => expect(opened).toBeTruthy());

    openMoreMenu();
    expect(menuItem('Exit picture-in-picture')).toBeTruthy();
    menuItem('Exit picture-in-picture').click();
    expect(opened.closed).toBe(true);
  });

  it('leaves the window behind when the meeting is left', async () => {
    openMoreMenu();
    menuItem('Picture-in-picture').click();
    await vi.waitFor(() => expect(opened).toBeTruthy());

    unmount();
    unmount = null;
    expect(opened.closed).toBe(true);
  });

  it('passes on the reason a floating window couldn’t open', async () => {
    // A phone: no Document PiP, and nothing with a picture in it yet.
    delete window.documentPictureInPicture;
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    window.HTMLVideoElement.prototype.requestPictureInPicture = vi.fn().mockResolvedValue({});
    meetingMedia.setCamOn(false);
    meetingSession.roster.update('peer', { cam: false });

    openMoreMenu();
    menuItem('Picture-in-picture').click();
    try {
      await vi.waitFor(() => expect(toasts.textContent).toContain('camera'));
    } finally {
      // Leaving these on would hand the next test a browser it didn't ask for.
      delete document.pictureInPictureEnabled;
      delete window.HTMLVideoElement.prototype.requestPictureInPicture;
    }
  });

  it('offers full screen only where the page can go full screen', () => {
    // jsdom, like iPhone Safari, has no Fullscreen API on the document.
    openMoreMenu();
    expect(menuItem('Full screen')).toBeUndefined();
    openMoreMenu();
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
    try {
      openMoreMenu();
      expect(menuItem('Full screen')).toBeTruthy();
    } finally {
      delete document.fullscreenEnabled;
    }
  });

  it('says nothing about it in a browser that can’t', () => {
    delete window.documentPictureInPicture;
    openMoreMenu();
    expect(menuItem('Picture-in-picture')).toBeUndefined();
    expect(menuItem('Settings')).toBeTruthy();
  });
});
