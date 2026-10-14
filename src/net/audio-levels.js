import { Emitter } from '../lib/emitter.js';
import { SpeakingDetector } from '../lib/speaking.js';

const SAMPLE_INTERVAL_MS = 200;

/**
 * AudioLevelMonitor — watches a set of MediaStreams and reports who is
 * speaking, using WebAudio analysers plus hysteresis.
 *
 * Events:
 *  - 'speaking' {id, speaking}
 */
export class AudioLevelMonitor extends Emitter {
  /** @type {AudioContext|null} */
  #ctx = null;
  /** @type {Map<string, {analyser: AnalyserNode, source: MediaStreamAudioSourceNode, data: Uint8Array, detector: SpeakingDetector, stream: MediaStream, track: MediaStreamTrack}>} */
  #entries = new Map();
  #timer = null;

  /** Track (or replace) a stream under the given id. */
  watch(id, stream) {
    const track = stream?.getAudioTracks()[0] ?? null;
    if (!track) return;
    // Watched already, on this very track: nothing to rebuild. A remote
    // stream is announced again for every track that lands in it, and the
    // rebuild dropped the detector — a one-sample flicker of the speaking
    // ring on someone mid-sentence. A source node follows the track it was
    // made with, so a *different* track (a new microphone) does need one.
    if (this.#entries.get(id)?.track === track) return;
    this.unwatch(id);
    try {
      const ctx = this.#ensureContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.#entries.set(id, {
        analyser,
        source,
        data: new Uint8Array(analyser.fftSize),
        detector: new SpeakingDetector(),
        stream,
        track,
      });
      this.#startLoop();
    } catch (err) {
      console.warn('[audio-levels] failed to watch stream', err);
    }
  }

  unwatch(id) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    try {
      entry.source.disconnect();
    } catch {
      /* noop */
    }
    this.#entries.delete(id);
    if (entry.detector.speaking) this.emit('speaking', { id, speaking: false });
    if (this.#entries.size === 0) this.#stopLoop();
  }

  close() {
    for (const id of [...this.#entries.keys()]) this.unwatch(id);
    this.#stopLoop();
    this.#ctx?.close().catch(() => {});
    this.#ctx = null;
  }

  /** Browsers suspend AudioContexts created without a user gesture. */
  resume() {
    this.#ctx?.resume().catch(() => {});
  }

  // ---- internals ----

  #ensureContext() {
    if (!this.#ctx) {
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      this.#ctx = new Ctx();
    }
    if (this.#ctx.state === 'suspended') this.#ctx.resume().catch(() => {});
    return this.#ctx;
  }

  #startLoop() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#sample(), SAMPLE_INTERVAL_MS);
  }

  #stopLoop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #sample() {
    const now = Date.now();
    for (const [id, entry] of this.#entries) {
      entry.analyser.getByteTimeDomainData(entry.data);
      let sum = 0;
      for (let i = 0; i < entry.data.length; i++) {
        const v = (entry.data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / entry.data.length);
      const was = entry.detector.speaking;
      const is = entry.detector.update(rms, now);
      if (was !== is) this.emit('speaking', { id, speaking: is });
    }
  }
}
