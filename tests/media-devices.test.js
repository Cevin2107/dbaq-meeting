// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalMedia } from '../src/net/media.js';

/*
 * Devices are acquired asynchronously — a permission prompt, a Bluetooth
 * headset that takes a second to open — and the user keeps clicking
 * meanwhile. Whatever they did last is what has to hold once the device
 * answers; and a device that goes away mid-call has to be noticed.
 */

class FakeTrack extends EventTarget {
  constructor(kind, label) {
    super();
    this.kind = kind;
    this.label = label;
    this.readyState = 'live';
    this.enabled = true;
    this.id = `${kind}-${label}-${Math.random().toString(36).slice(2, 6)}`;
  }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return { deviceId: this.label };
  }
  /** The device went away (unplugged, taken by the OS). */
  unplug() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
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
let pending; // getUserMedia calls waiting to be answered: { constraints, resolve, reject }
let handed; // every track ever handed out

function answer(index = 0, { fail = null } = {}) {
  const call = pending.splice(index, 1)[0];
  if (fail) {
    call.reject(fail);
    return null;
  }
  const { audio, video } = call.constraints;
  const tracks = [];
  if (audio) tracks.push(new FakeTrack('audio', audio.deviceId?.exact ?? 'default-mic'));
  if (video) tracks.push(new FakeTrack('video', video.deviceId?.exact ?? 'default-cam'));
  handed.push(...tracks);
  call.resolve(new FakeStream(tracks));
  return tracks;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const live = () => handed.filter((t) => t.readyState === 'live');

beforeEach(() => {
  pending = [];
  handed = [];
  globalThis.MediaStream = FakeStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(
        (constraints) =>
          new Promise((resolve, reject) => {
            pending.push({ constraints, resolve, reject });
          })
      ),
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
  media = new LocalMedia();
});

describe('a toggle that lands while the device is still opening', () => {
  it('mute after a pending unmute leaves the microphone muted', async () => {
    const init = media.init({ micOn: true, camOn: false });
    answer(0, { fail: new Error('NotAllowedError') }); // nothing granted yet
    await flush();
    answer(0, { fail: new Error('NotAllowedError') }); // the quiet audio retry
    await init;
    expect(media.micOn).toBe(false);

    // Unmute: the microphone has to be acquired, which takes a while…
    const unmute = media.setMicOn(true);
    await flush();
    expect(pending).toHaveLength(1);
    // …and the user changes their mind before it answers.
    const mute = media.setMicOn(false);
    await mute;
    expect(media.micOn).toBe(false);

    answer(0);
    await unmute;
    await flush();
    // What the user did last holds: muted, and nothing is hot.
    expect(media.micOn).toBe(false);
    for (const track of live().filter((t) => t.kind === 'audio')) expect(track.enabled).toBe(false);
  });

  it('camera off after a pending camera on leaves the camera off — and its light', async () => {
    const init = media.init({ micOn: true, camOn: false });
    answer(0);
    await init;
    expect(media.camOn).toBe(false);

    const on = media.setCamOn(true);
    await flush();
    expect(pending).toHaveLength(1);
    const off = media.setCamOn(false);
    await off;
    expect(media.camOn).toBe(false);

    answer(0);
    await on;
    await flush();
    expect(media.camOn).toBe(false);
    expect(media.videoTrack).toBeNull();
    expect(live().filter((t) => t.kind === 'video')).toEqual([]);
  });
});

describe('switching devices', () => {
  it('publishes the device picked last, however the requests come back', async () => {
    const init = media.init({ micOn: true, camOn: false });
    answer(0);
    await init;

    const pickA = media.setMicDevice('mic-a'); // slow to open (a headset)
    await flush();
    const pickB = media.setMicDevice('mic-b'); // fast
    await flush();
    expect(pending).toHaveLength(2);
    answer(1); // B answers first
    await pickB;
    expect(media.audioTrack.label).toBe('mic-b');
    answer(0); // A limps in
    await pickA;
    await flush();

    // The last pick is what is published; the straggler is stopped.
    expect(media.micId).toBe('mic-b');
    expect(media.audioTrack.label).toBe('mic-b');
    expect(live().filter((t) => t.kind === 'audio').map((t) => t.label)).toEqual(['mic-b']);
    expect(media.audioTrack.enabled).toBe(true);
  });

  it('the same, for the camera', async () => {
    const init = media.init({ micOn: false, camOn: true });
    answer(0);
    await init;

    const pickA = media.setCamDevice('cam-a');
    await flush();
    const pickB = media.setCamDevice('cam-b');
    await flush();
    answer(1);
    await pickB;
    answer(0);
    await pickA;
    await flush();

    expect(media.camId).toBe('cam-b');
    expect(media.camOn).toBe(true);
    expect(media.videoTrack.label).toBe('cam-b');
    expect(live().filter((t) => t.kind === 'video').map((t) => t.label)).toEqual(['cam-b']);
  });
});

describe('a device that goes away mid-call', () => {
  it('falls back to another camera, or turns the camera off when there is none', async () => {
    const init = media.init({ micOn: true, camOn: true });
    const [, cam] = answer(0);
    await init;
    const changes = [];
    media.on('change', (e) => changes.push({ ...e }));
    const errors = [];
    media.on('error', (e) => errors.push(e.kind));

    cam.unplug();
    await flush();
    // Another camera answers the fallback request.
    expect(pending).toHaveLength(1);
    answer(0);
    await flush();
    expect(media.camOn).toBe(true);
    expect(media.videoTrack).not.toBe(cam);
    expect(media.videoTrack.readyState).toBe('live');

    // No camera left at all: off, and said so.
    media.videoTrack.unplug();
    await flush();
    const notFound = new Error('Requested device not found');
    notFound.name = 'NotFoundError';
    answer(0, { fail: notFound });
    await flush();
    expect(media.camOn).toBe(false);
    expect(media.videoTrack).toBeNull();
    expect(changes.at(-1)).toMatchObject({ camOn: false });
    expect(errors).toEqual(['video']);
  });

  it('reports a microphone that goes away rather than showing it live', async () => {
    const init = media.init({ micOn: true, camOn: false });
    const [mic] = answer(0);
    await init;
    expect(media.micOn).toBe(true);
    const errors = [];
    media.on('error', (e) => errors.push(e.kind));

    mic.unplug();
    await flush();
    expect(pending).toHaveLength(1);
    const notFound = new Error('Requested device not found');
    notFound.name = 'NotFoundError';
    answer(0, { fail: notFound });
    await flush();
    expect(media.micOn).toBe(false);
    expect(media.audioTrack).toBeNull();
    expect(errors).toEqual(['audio']);
  });

  it('keeps the mute state across a microphone that is swapped in', async () => {
    const init = media.init({ micOn: false, camOn: false });
    const [mic] = answer(0);
    await init;
    expect(media.micOn).toBe(false);
    expect(mic.enabled).toBe(false);

    mic.unplug();
    await flush();
    const [next] = answer(0);
    await flush();
    expect(media.micOn).toBe(false);
    expect(next.enabled).toBe(false); // still muted, on the new device
  });
});
