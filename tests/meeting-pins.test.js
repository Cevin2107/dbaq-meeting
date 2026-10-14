// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountMeeting } from '../src/ui/meeting.js';
import { Emitter } from '../src/lib/emitter.js';
import { Roster } from '../src/lib/roster.js';

/*
 * Who is on the stage. A presentation should take it the moment it starts,
 * even if the viewer had pinned someone earlier — the report that prompted
 * this was "when a screen is shared it should be maximized automatically;
 * currently users need to pin it". A pin the viewer makes *during* the
 * presentation is a deliberate override and wins.
 */

const fakeStream = (id) => ({ id, getAudioTracks: () => [], getVideoTracks: () => [] });

class FakeMedia extends Emitter {
  micOn = true;
  camOn = true;
  screenStream = null;
  background = { type: 'none' };
  noiseSuppression = false;
  stream = fakeStream('self-stream');
  get presenting() {
    return !!this.screenStream;
  }
  setMicOn = vi.fn();
  setCamOn = vi.fn();
  listDevices = async () => ({ mics: [], cams: [], speakers: [] });
  startScreenShare() {
    this.screenStream = fakeStream('self-screen');
    this.emit('screen', { on: true, stream: this.screenStream });
  }
  stopScreenShare() {
    const stream = this.screenStream;
    this.screenStream = null;
    this.emit('screen', { on: false, stream });
  }
}

class FakeSession extends Emitter {
  selfId = 'self';
  code = 'abc-defg-hij';
  isHost = false;
  hand = false;
  startedAt = Date.now();
  roster = new Roster();
  streams = new Map(); // `${peerId}:${kind}` -> stream
  constructor() {
    super();
    this.roster.add({ id: this.selfId, name: 'Ada', isSelf: true, mic: true, cam: true });
  }
  getStream = (peerId, kind = 'camera') => this.streams.get(`${peerId}:${kind}`) ?? null;
  sendChat = vi.fn();
  sendReaction = vi.fn();
  setHand = vi.fn();

  join(id, name) {
    this.roster.add({ id, name, mic: true, cam: true });
    const stream = fakeStream(`${id}-cam`);
    this.streams.set(`${id}:camera`, stream);
    this.emit('stream', { peerId: id, kind: 'camera', stream });
  }

  /** The wire order: STREAM_META + STATE over the data channel, then the track. */
  startPresenting(id) {
    this.roster.update(id, { presenting: true });
    const stream = fakeStream(`${id}-screen`);
    this.streams.set(`${id}:screen`, stream);
    this.emit('stream', { peerId: id, kind: 'screen', stream });
  }

  stopPresenting(id) {
    const stream = this.streams.get(`${id}:screen`);
    this.streams.delete(`${id}:screen`);
    this.roster.update(id, { presenting: false });
    this.emit('stream-removed', { peerId: id, kind: 'screen', stream });
  }
}

let media;
let session;
let root;
let unmount;

const tile = (id) => root.querySelector(`.tile[data-tile-id="${id}"]`);
const pinButton = (id) => tile(id).querySelector('.tile-action');
const pinned = () =>
  [...root.querySelectorAll('.tile .tile-action[aria-pressed="true"]')].map((b) => b.closest('.tile').dataset.tileId);

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);

  media = new FakeMedia();
  session = new FakeSession();
  root = document.createElement('div');
  document.body.append(root);
  unmount = mountMeeting(root, { media, session, roomCode: 'abc-defg-hij' }, { endCall: vi.fn() });
  session.join('bob', 'Bob');
});

afterEach(() => {
  unmount?.();
  root.remove();
});

describe('a presentation taking the stage', () => {
  it('pins a remote share when nothing is pinned', () => {
    expect(pinned()).toEqual([]);
    session.startPresenting('bob');
    expect(pinned()).toEqual(['bob:screen']);
  });

  it('pins our own share', () => {
    media.startScreenShare();
    expect(pinned()).toEqual(['self:screen']);
  });

  it('replaces our capture preview with a message while keeping the capture live', () => {
    media.startScreenShare();
    const stream = media.screenStream;
    const preview = tile('self:screen');
    expect(preview.querySelector('video').srcObject).toBeNull();
    expect(preview.querySelector('video').style.visibility).toBe('hidden');
    expect(preview.querySelector('.tile-sharing-placeholder').style.display).toBe('');
    expect(preview.textContent).toContain('You’re sharing your screen');
    expect(media.presenting).toBe(true);
    expect(media.screenStream).toBe(stream);

    // Reconciliation and pin changes must never reattach the capture.
    pinButton('bob').click();
    expect(preview.querySelector('video').srcObject).toBeNull();
    media.stopScreenShare();
    expect(tile('self:screen')).toBeNull();
  });

  it('still plays a remote presentation while our own preview is hidden', () => {
    media.startScreenShare();
    session.startPresenting('bob');
    const preview = tile('bob:screen');
    expect(preview.querySelector('video').srcObject).toBe(session.getStream('bob', 'screen'));
    expect(preview.querySelector('video').style.visibility).toBe('visible');
    expect(preview.querySelector('.tile-sharing-placeholder').style.display).toBe('none');
    expect(tile('self:screen').querySelector('video').srcObject).toBeNull();
  });

  it('takes the stage from a tile the viewer pinned before the share began', () => {
    pinButton('bob').click();
    expect(pinned()).toEqual(['bob']);

    session.startPresenting('bob');
    expect(pinned()).toEqual(['bob:screen']);
  });

  it('holds the auto-pin until the tile arrives, if the stream lands before the presenting flag', () => {
    const stream = fakeStream('bob-screen');
    session.streams.set('bob:screen', stream);
    session.emit('stream', { peerId: 'bob', kind: 'screen', stream });
    expect(tile('bob:screen')).toBeNull();
    expect(pinned()).toEqual([]);

    session.roster.update('bob', { presenting: true });
    expect(pinned()).toEqual(['bob:screen']);
  });

  it('lets the newest presentation win', () => {
    session.startPresenting('bob');
    media.startScreenShare();
    expect(pinned()).toEqual(['self:screen']);
  });
});

describe('the viewer overriding a presentation', () => {
  it('keeps a pin made during the share on the stage', () => {
    session.startPresenting('bob');
    pinButton('bob').click();
    expect(pinned()).toEqual(['bob']);
  });

  it('can unpin the presentation itself, and pin it back', () => {
    session.startPresenting('bob');
    pinButton('bob:screen').click();
    expect(pinned()).toEqual([]);

    pinButton('bob:screen').click();
    expect(pinned()).toEqual(['bob:screen']);
  });

  it('returns to the presentation when the override is unpinned', () => {
    session.startPresenting('bob');
    pinButton('bob').click();
    pinButton('bob').click();
    expect(pinned()).toEqual(['bob:screen']);
  });
});

describe('a presentation ending', () => {
  it('goes back to the grid, not to the pin that predated the share', () => {
    pinButton('bob').click();
    session.startPresenting('bob');
    session.stopPresenting('bob');
    expect(tile('bob:screen')).toBeNull();
    expect(pinned()).toEqual([]);
  });

  it('keeps a pin the viewer made during the share', () => {
    session.startPresenting('bob');
    pinButton('bob').click();
    session.stopPresenting('bob');
    expect(pinned()).toEqual(['bob']);
  });

  it('goes back to the grid when our own share stops', () => {
    media.startScreenShare();
    media.stopScreenShare();
    expect(pinned()).toEqual([]);
  });
});
