/**
 * NoiseSuppression — ML denoising for the microphone.
 *
 * The browser's built-in noiseSuppression constraint mostly handles
 * stationary noise (hiss, fan hum). This pipeline runs the mic through
 * GTCRN, a compact 2024 speech-enhancement network (~24k parameters)
 * compiled to WASM, which also cuts non-stationary noise: keyboards,
 * dishes, traffic.
 *
 *   raw mic track → MediaStreamAudioSourceNode → GTCRN worklet
 *     → MediaStreamAudioDestinationNode → track
 *
 * The processed track replaces the mic track in LocalMedia.stream; the
 * raw track stays private and keeps the device warm (the same shape as
 * BackgroundEffect around the camera). The gUM constraints (echo
 * cancellation, AGC, browser noise suppression) still apply at capture,
 * upstream of this pipeline.
 *
 * Why GTCRN and not RNNoise, which this used to run: RNNoise emits 22
 * Bark-band gains, so speech and noise inside the same band are always
 * attenuated together — a ceiling no tuning can move. GTCRN works per
 * frequency bin instead. Measured on an 8s take at 5 dB input SNR
 * (tools/audio-lab on the audio-lab branch): GTCRN +4.5 dB SNR over raw
 * against RNNoise's +2.8, with less level jitter during speech.
 *
 * There is deliberately no noise gate. The previous chain used one to mop
 * up RNNoise's residual floor; after GTCRN the floor lands inside the
 * gate's own hysteresis, so it never fires and only adds a worklet, a
 * little latency, and the risk of pumping.
 *
 * The context must run at 48 kHz: the engine has native 16 kHz and 48 kHz
 * paths (256- and 768-sample frames) and throws on anything else. The
 * source node resamples the device's native rate as needed.
 */

import { loadGtcrn, GtcrnWorkletNode } from '@sapphi-red/web-noise-suppressor';
// Vite resolves these to hashed asset URLs. The worklet module is
// self-contained (no imports), so the bare file loads in addModule.
import gtcrnWorkletPath from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import gtcrnWasmPath from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';

const SAMPLE_RATE = 48000;

const MAX_CHANNELS = 2;

/** @type {Promise<ArrayBuffer>|null} */
let wasmPromise = null;

function loadWasm() {
  wasmPromise ??= loadGtcrn({ url: gtcrnWasmPath });
  wasmPromise.catch(() => {
    wasmPromise = null; // allow a retry (e.g. transient network failure)
  });
  return wasmPromise;
}

export class NoiseSuppression {
  /** @type {MediaStreamTrack} the processed track to publish */
  track;

  /** @type {AudioContext|null} */
  #ctx = null;
  #source = null;
  #denoiser = null;
  #stopped = false;
  /** @type {(() => void)|null} */
  #disarmResume = null;

  /**
   * Load the engine and start denoising a mic track.
   * @param {MediaStreamTrack} rawTrack - Live mic audio track (not consumed;
   *   the caller keeps ownership and must keep it running).
   * @returns {Promise<NoiseSuppression>}
   */
  static async start(rawTrack) {
    const wasmBinary = await loadWasm();
    const ns = new NoiseSuppression();
    try {
      await ns.#begin(rawTrack, wasmBinary);
    } catch (err) {
      ns.stop();
      throw err;
    }
    return ns;
  }

  /** Stop processing. Does not stop the raw mic track. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#disarmResume?.();
    this.#disarmResume = null;
    this.track?.stop();
    this.#source?.disconnect();
    this.#denoiser?.disconnect();
    this.#denoiser?.destroy(); // frees the WASM heap
    this.#ctx?.close().catch(() => {});
  }

  // ---- internals ----

  async #begin(rawTrack, wasmBinary) {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.#ctx = ctx;
    await ctx.audioWorklet.addModule(gtcrnWorkletPath);
    this.#source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    this.#denoiser = new GtcrnWorkletNode(ctx, { wasmBinary, maxChannels: MAX_CHANNELS });
    const dest = ctx.createMediaStreamDestination();
    this.#source.connect(this.#denoiser);
    this.#denoiser.connect(dest);
    this.track = dest.stream.getAudioTracks()[0];
    this.#keepRunning();
  }

  /**
   * An AudioContext created without a user gesture starts 'suspended'
   * and outputs silence. Resume right away where allowed (Chrome
   * permits it while the page is capturing audio); otherwise the next
   * gesture — at latest the Join click — unlocks it.
   */
  #keepRunning() {
    const ctx = this.#ctx;
    const resume = () => {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    };
    const disarm = () => {
      window.removeEventListener('pointerdown', resume, true);
      window.removeEventListener('keydown', resume, true);
    };
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'running') disarm();
    });
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
    this.#disarmResume = disarm;
    resume();
  }
}
