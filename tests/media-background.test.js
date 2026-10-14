// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * The background pipeline runs on the raw camera track and publishes a
 * processed one in its place. Turning the effect off — by choice, or
 * because a new look failed to start — has to put the raw track back and
 * stop the pipeline; the state and the published track must agree.
 */

const effects = [];
vi.mock('../src/net/background-effect.js', () => ({
  BackgroundEffect: {
    start: async (raw, spec) => {
      const effect = {
        spec,
        stopped: false,
        track: { kind: 'video', readyState: 'live', id: 'processed', stop() { this.readyState = 'ended'; } },
        setSpec: vi.fn(async (next) => {
          if (next.type === 'image' && next.src === 'bad') throw new Error('background image failed to load');
          effect.spec = next;
        }),
        stop() {
          effect.stopped = true;
        },
      };
      effects.push(effect);
      return effect;
    },
  },
  preloadBackgroundEngine: () => {},
}));

import { LocalMedia } from '../src/net/media.js';

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.readyState = 'live';
    this.enabled = true;
    this.id = `${kind}-${Math.random().toString(36).slice(2)}`;
  }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return {};
  }
  addEventListener() {}
}

class FakeStream {
  constructor(tracks = []) {
    this.id = `stream-${Math.random().toString(36).slice(2)}`;
    this._tracks = tracks;
  }
  getTracks() {
    return this._tracks;
  }
  getVideoTracks() {
    return this._tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this._tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(t) {
    this._tracks.push(t);
  }
  removeTrack(t) {
    this._tracks = this._tracks.filter((x) => x !== t);
  }
}

let media;

beforeEach(async () => {
  effects.length = 0;
  globalThis.MediaStream = FakeStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async ({ audio, video }) =>
        new FakeStream([...(audio ? [new FakeTrack('audio')] : []), ...(video ? [new FakeTrack('video')] : [])]),
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
  media = new LocalMedia();
  await media.init({ micOn: true, camOn: true });
});

describe('background effects', () => {
  it('publishes the processed track while an effect runs, and the raw one again when it is turned off', async () => {
    const raw = media.videoTrack;
    const published = [];
    media.on('video-track', ({ track }) => published.push(track?.id));

    expect(await media.setBackground({ type: 'blur', blur: 8 })).toBe(true);
    expect(effects).toHaveLength(1);
    expect(media.videoTrack.id).toBe('processed');
    expect(raw.readyState).toBe('live'); // still feeding the pipeline

    expect(await media.setBackground({ type: 'none' })).toBe(true);
    expect(effects[0].stopped).toBe(true);
    expect(media.videoTrack).toBe(raw);
    expect(published).toEqual(['processed', raw.id]);
  });

  it('changes the look in place while the pipeline is up, without republishing', async () => {
    await media.setBackground({ type: 'blur', blur: 8 });
    const published = [];
    media.on('video-track', ({ track }) => published.push(track?.id));

    expect(await media.setBackground({ type: 'image', id: 'lake', src: '/backgrounds/lake.webp' })).toBe(true);
    expect(effects).toHaveLength(1);
    expect(effects[0].setSpec).toHaveBeenLastCalledWith({ type: 'image', id: 'lake', src: '/backgrounds/lake.webp' });
    expect(published).toEqual([]);
    expect(media.background).toEqual({ type: 'image', id: 'lake', src: '/backgrounds/lake.webp' });
  });

  it('really turns the effect off when a new look fails to start over a running one', async () => {
    const raw = media.videoTrack;
    await media.setBackground({ type: 'blur', blur: 8 });
    const errors = [];
    media.on('error', (e) => errors.push(e));
    const states = [];
    media.on('background', ({ background }) => states.push(background));

    // A custom image that can't be loaded, chosen over a working blur.
    expect(await media.setBackground({ type: 'image', id: 'custom', src: 'bad' })).toBe(false);

    // State says no effect — and the camera agrees: the pipeline is down and
    // the raw track is what peers get, not a blur nobody asked to keep.
    expect(media.background).toEqual({ type: 'none' });
    expect(effects[0].stopped).toBe(true);
    expect(media.videoTrack).toBe(raw);
    expect(states).toEqual([{ type: 'none' }]);
    // And the message blames the image, not the browser.
    expect(errors).toHaveLength(1);
    expect(errors[0].kind).toBe('background');
    expect(errors[0].message).toMatch(/image/i);
  });
});
