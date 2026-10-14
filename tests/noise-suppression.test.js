import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalMedia } from '../src/net/media.js';

// media.js lazy-imports the pipeline; intercept it so tests control when
// and whether it starts, without touching WASM or the Web Audio API.
const mocked = vi.hoisted(() => ({ start: null }));
vi.mock('../src/net/noise-suppression.js', () => ({
  NoiseSuppression: { start: (raw) => mocked.start(raw) },
}));

class FakeTrack {
  constructor(kind, label = '') {
    this.kind = kind;
    this.label = label;
    this.enabled = true;
    this.readyState = 'live';
  }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return {};
  }
  addEventListener() {}
  removeEventListener() {}
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(track) {
    this.tracks.push(track);
  }
  removeTrack(track) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

/** Let the fire-and-forget apply pipeline (dynamic import + start) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LocalMedia noise suppression', () => {
  let effects; // every pipeline the mock started, in order
  let gumTracks; // every raw mic track handed out by fake getUserMedia

  beforeEach(() => {
    effects = [];
    gumTracks = [];
    mocked.start = async (raw) => {
      const effect = { raw, track: new FakeTrack('audio', 'processed'), stop: vi.fn() };
      effects.push(effect);
      return effect;
    };
    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => {
          const track = new FakeTrack('audio', `mic-${gumTracks.length}`);
          gumTracks.push(track);
          return new FakeMediaStream([track]);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function freshMedia({ micOn = true } = {}) {
    const media = new LocalMedia();
    await media.setNoiseSuppression(true);
    await media.init({ micOn, camOn: false });
    await flush();
    return media;
  }

  it('publishes the processed track and keeps the raw one feeding the pipeline', async () => {
    const media = await freshMedia();
    expect(effects).toHaveLength(1);
    expect(effects[0].raw).toBe(gumTracks[0]);
    expect(media.audioTrack).toBe(effects[0].track);
    expect(media.stream.getAudioTracks()).toEqual([effects[0].track]);
    expect(gumTracks[0].enabled).toBe(true);
    expect(media.micOn).toBe(true);
  });

  it('carries a pre-swap mute (joining muted) onto the processed track', async () => {
    const media = await freshMedia({ micOn: false });
    expect(media.audioTrack).toBe(effects[0].track);
    expect(media.audioTrack.enabled).toBe(false);
    // The raw track must flow regardless, or unmuting stays silent.
    expect(gumTracks[0].enabled).toBe(true);
  });

  it('mutes and unmutes via the published track only', async () => {
    const media = await freshMedia();
    await media.setMicOn(false);
    expect(effects[0].track.enabled).toBe(false);
    expect(gumTracks[0].enabled).toBe(true);
    await media.setMicOn(true);
    expect(effects[0].track.enabled).toBe(true);
    expect(media.micOn).toBe(true);
  });

  it('turning it off restores the raw track with the mute state intact', async () => {
    const media = await freshMedia();
    await media.setMicOn(false);
    const swaps = [];
    media.on('audio-track', ({ track }) => swaps.push(track));

    await media.setNoiseSuppression(false);
    expect(effects[0].stop).toHaveBeenCalled();
    expect(media.audioTrack).toBe(gumTracks[0]);
    expect(media.audioTrack.enabled).toBe(false); // still muted
    expect(swaps).toEqual([gumTracks[0]]);
    expect(media.noiseSuppression).toBe(false);
  });

  it('re-applies to the fresh track on mic device switch', async () => {
    const media = await freshMedia();
    await media.setMicDevice('other-mic');
    await flush();

    expect(effects).toHaveLength(2);
    expect(effects[0].stop).toHaveBeenCalled();
    expect(gumTracks[0].readyState).toBe('ended');
    expect(effects[1].raw).toBe(gumTracks[1]);
    expect(media.audioTrack).toBe(effects[1].track);
  });

  it('reverts to the raw track and reports when the pipeline cannot start', async () => {
    mocked.start = async () => {
      throw new Error('no AudioWorklet');
    };
    const media = new LocalMedia();
    const errors = [];
    media.on('error', (e) => errors.push(e));
    await media.setNoiseSuppression(true);
    await media.init({ micOn: true, camOn: false });
    await flush();

    expect(media.noiseSuppression).toBe(false);
    expect(media.audioTrack).toBe(gumTracks[0]);
    expect(errors.some((e) => e.kind === 'noise-suppression')).toBe(true);
  });

  it('a toggle-off during startup wins over the late pipeline', async () => {
    let release;
    mocked.start = async (raw) => {
      await new Promise((resolve) => (release = resolve));
      const effect = { raw, track: new FakeTrack('audio', 'processed'), stop: vi.fn() };
      effects.push(effect);
      return effect;
    };
    const media = new LocalMedia();
    await media.setNoiseSuppression(true);
    await media.init({ micOn: true, camOn: false });
    await flush(); // start() is now pending
    await media.setNoiseSuppression(false);
    release();
    await flush();

    expect(effects).toHaveLength(1);
    expect(effects[0].stop).toHaveBeenCalled(); // the late pipeline was discarded
    expect(media.audioTrack).toBe(gumTracks[0]);
  });

  it('stopAll stops the pipeline and the raw track', async () => {
    const media = await freshMedia();
    media.stopAll();
    expect(effects[0].stop).toHaveBeenCalled();
    expect(gumTracks[0].readyState).toBe('ended');
    expect(media.stream.getTracks()).toEqual([]);
  });
});
