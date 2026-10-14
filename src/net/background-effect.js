/**
 * BackgroundEffect — camera background blur / replacement.
 *
 *  1. The raw camera track plays into a hidden <video>.
 *  2. Each frame is downscaled to 256×144 and run through a person
 *     segmentation model (MediaPipe selfie segmenter, WASM — the modern
 *     packaging of the same TFLite model Jitsi uses). The confidence
 *     mask is stabilized with an uncertainty-weighted blend against the
 *     previous frame and shaped with a smoothstep before use.
 *  3. The mask and the frame are composited in WebGL2 (see
 *     background-compositor.js): the low-res mask is upsampled with a
 *     joint bilateral filter so the alpha edge lands on real image
 *     edges, the background is a separable Gaussian of background
 *     pixels only (or an image), and a light wrap bleeds background
 *     light onto the subject's rim.
 *     Without WebGL2 there is a 2D-canvas fallback that feathers the
 *     mask with a blur — Jitsi's original three-pass composite.
 *  4. The canvas' captureStream() track replaces the camera track.
 *
 * The frame loop is driven by a Web Worker timer instead of
 * requestAnimationFrame so video keeps flowing to peers while the tab is
 * in the background (rAF is throttled there; worker timers are not).
 *
 * The model + WASM runtime load lazily on first use and are cached for
 * the rest of the page's life.
 */

// Vite resolves these to hashed asset URLs; the SIMD build is universal
// in browsers new enough to run this app (es2022 + WebRTC).
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { GLCompositor } from './background-compositor.js';

const MODEL_URL = `${import.meta.env.BASE_URL}models/selfie_segmenter_landscape.tflite`;

// The landscape selfie segmenter's native input shape. Segmenting a
// pre-downscaled frame keeps the mask small (36k px) and cheap to copy.
const SEG_WIDTH = 256;
const SEG_HEIGHT = 144;

const TARGET_FPS = 30;

// Temporal mask smoothing (the approach of MediaPipe's segmentation-
// smoothing calculator): where the fresh mask is uncertain (values near
// 0.5 — the edge band) lean on last frame's mask; where it is confident,
// take it as-is. This pins the outline against per-frame sensor noise
// without ghosting the interior when the person actually moves.
// The share of the previous frame kept at maximum uncertainty:
const TEMPORAL_SMOOTHING = 0.8;

// Confidence shaping: transparent below LO, opaque above HI, smoothstep
// between. Under WebGL the band is centred, because the bilateral
// upsample decides where the edge really is. The 2D fallback has no such
// help, so its band is biased upward — the soft edge then erodes into
// the person rather than haloing the old background around them.
const EDGE_GL = { lo: 0.3, hi: 0.7 };
const EDGE_2D = { lo: 0.35, hi: 0.8 };

// How far the bilateral gather reaches, in mask texels. A blurred
// background forgives a loose edge; an image background needs a tight one.
const EDGE_SPREAD_BLUR = 1.25;
const EDGE_SPREAD_IMAGE = 1;

// Light-wrap strength. An image background is a different scene, so it
// needs more help blending than a blur of the real one does.
const LIGHT_WRAP_BLUR = 0.25;
const LIGHT_WRAP_IMAGE = 0.4;

// Mask edge feathering for the 2D fallback, like Jitsi.
const FEATHER_BLUR_PX = 8;
const FEATHER_IMAGE_PX = 4;

// CanvasRenderingContext2D.filter is missing in older Safari; there is a
// downscale-based fallback for the background blur, and mask upscaling
// alone feathers the edges acceptably.
const supportsCanvasFilter = () => {
  try {
    return typeof document.createElement('canvas').getContext('2d').filter === 'string';
  } catch {
    return false;
  }
};

/** @type {Promise<import('@mediapipe/tasks-vision').ImageSegmenter>|null} */
let segmenterPromise = null;

function loadSegmenter() {
  segmenterPromise ??= (async () => {
    const { ImageSegmenter } = await import('@mediapipe/tasks-vision');
    const fileset = { wasmLoaderPath, wasmBinaryPath };
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    try {
      return await ImageSegmenter.createFromOptions(fileset, options('GPU'));
    } catch {
      return await ImageSegmenter.createFromOptions(fileset, options('CPU'));
    }
  })();
  segmenterPromise.catch(() => {
    segmenterPromise = null; // allow a retry (e.g. transient network failure)
  });
  return segmenterPromise;
}

/** Start fetching the model/runtime before the user needs it. */
export function preloadBackgroundEngine() {
  loadSegmenter().catch(() => {});
}

// Timestamps handed to segmentForVideo must be strictly increasing for
// the lifetime of the (shared) segmenter, across effect instances.
let lastVideoTimestamp = 0;

const timerWorkerUrl = URL.createObjectURL(
  new Blob(
    [
      `let timer = null;
       onmessage = ({ data }) => {
         if (data.delay !== undefined) timer = setTimeout(() => postMessage(0), data.delay);
         else { clearTimeout(timer); timer = null; }
       };`,
    ],
    { type: 'application/javascript' }
  )
);

export class BackgroundEffect {
  /** @type {MediaStreamTrack} the processed track to publish */
  track;

  #segmenter;
  #spec;
  /** @type {HTMLImageElement|null} */
  #image = null;

  #inputVideo = document.createElement('video');
  /** @type {import('./background-compositor.js').GLCompositor|null} */
  #gl;
  #canvas;
  #segInput = document.createElement('canvas');
  #segInputCtx;
  /** @type {Uint8Array|null} shaped person alpha at mask resolution */
  #alpha = null;
  #maskWidth = 0;
  #maskHeight = 0;
  /** @type {Float32Array|null} last frame's smoothed mask */
  #prevMask = null;

  // 2D fallback only.
  #ctx = null;
  #maskCanvas = null;
  #maskCtx = null;
  #maskData = null;
  #hasFilter = false;
  /** @type {HTMLCanvasElement|null} scratch canvas for the no-filter blur fallback */
  #blurScratch = null;

  #worker = null;
  #stopped = false;
  #specSeq = 0;
  /** Force the next tick to composite even if the frame didn't advance. */
  #needsRender = true;
  #lastFrameTime = -1;

  /**
   * Load the engine and start processing a camera track.
   * @param {MediaStreamTrack} rawTrack - Live camera video track (not consumed;
   *   the caller keeps ownership and must keep it running).
   * @param {{type: 'blur'|'image', blur?: number, src?: string}} spec
   * @returns {Promise<BackgroundEffect>}
   */
  static async start(rawTrack, spec) {
    const segmenter = await loadSegmenter();
    const effect = new BackgroundEffect(segmenter);
    try {
      await effect.setSpec(spec);
      effect.#begin(rawTrack);
    } catch (err) {
      effect.stop();
      throw err;
    }
    return effect;
  }

  constructor(segmenter) {
    this.#segmenter = segmenter;
    this.#gl = GLCompositor.create();
    this.#canvas = this.#gl?.canvas ?? document.createElement('canvas');

    this.#segInput.width = SEG_WIDTH;
    this.#segInput.height = SEG_HEIGHT;
    this.#segInputCtx = this.#segInput.getContext('2d', { willReadFrequently: true });
    // A cleaner 5x downscale gives the model a sharper view of the edge —
    // and this same canvas is the guide the bilateral upsample reads.
    this.#segInputCtx.imageSmoothingQuality = 'high';

    if (!this.#gl) {
      this.#ctx = this.#canvas.getContext('2d');
      this.#hasFilter = supportsCanvasFilter();
      this.#maskCanvas = document.createElement('canvas');
      this.#maskCanvas.width = SEG_WIDTH;
      this.#maskCanvas.height = SEG_HEIGHT;
      this.#maskCtx = this.#maskCanvas.getContext('2d');
    }
  }

  /**
   * Switch blur strength / background image on the fly. For images the
   * previous background keeps rendering until the new one has loaded;
   * rapid re-selections resolve to the *last* choice, not the last load.
   */
  async setSpec(spec) {
    const seq = ++this.#specSeq;
    const image = spec.type === 'image' ? await loadImage(spec.src) : null;
    if (seq !== this.#specSeq || this.#stopped) return;
    this.#image = image;
    this.#spec = spec;
    this.#gl?.setBackgroundImage(image);
    this.#needsRender = true; // show the new look without waiting for a fresh frame
  }

  /** Stop processing. Does not stop the raw camera track. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#worker?.postMessage({});
    this.#worker?.terminate();
    this.#worker = null;
    this.track?.stop();
    this.#inputVideo.srcObject = null;
    this.#image = null;
    this.#gl?.dispose();
    this.#gl = null;
  }

  // ---- internals ----

  #begin(rawTrack) {
    const settings = rawTrack.getSettings?.() ?? {};
    this.#setSize(settings.width || 1280, settings.height || 720);

    this.#inputVideo.autoplay = true;
    this.#inputVideo.muted = true;
    this.#inputVideo.playsInline = true;
    this.#inputVideo.srcObject = new MediaStream([rawTrack]);
    this.#inputVideo.play?.().catch(() => {});

    const fps = Math.min(TARGET_FPS, settings.frameRate || TARGET_FPS);
    const stream = this.#canvas.captureStream(TARGET_FPS);
    this.track = stream.getVideoTracks()[0];
    try {
      this.track.contentHint = 'motion';
    } catch {
      /* unsupported */
    }

    // Paint the first frame before anyone sees the track so consumers
    // never render an empty canvas.
    this.#renderFrame();

    // Sequential ticks: the next frame is scheduled only after this one
    // finishes, so slow devices degrade to a lower rate instead of
    // piling up work. The delay is trimmed by each frame's processing
    // time so the effective rate stays near the target.
    const interval = 1000 / fps;
    this.#worker = new Worker(timerWorkerUrl, { name: 'background-effect timer' });
    this.#worker.onmessage = () => {
      if (this.#stopped) return;
      const started = performance.now();
      try {
        this.#renderFrame();
      } catch (err) {
        // Skip the bad frame (e.g. a mid-resize hiccup) and keep going.
        console.warn('[background-effect] frame failed', err);
      }
      const elapsed = performance.now() - started;
      this.#worker?.postMessage({ delay: Math.max(1, interval - elapsed) });
    };
    this.#worker.postMessage({ delay: interval });
  }

  #setSize(width, height) {
    if (this.#gl) this.#gl.resize(width, height);
    else {
      if (this.#canvas.width !== width) this.#canvas.width = width;
      if (this.#canvas.height !== height) this.#canvas.height = height;
    }
  }

  #renderFrame() {
    const video = this.#inputVideo;
    if (video.readyState < 2 || !video.videoWidth) return;

    // Cameras drop below the tick rate in low light; when the element
    // hasn't presented a new frame there is nothing new to segment or
    // composite. Only trusted while visible — in a hidden tab every
    // tick renders rather than betting on currentTime advancing, so
    // video keeps flowing to peers no matter what the browser throttles.
    const frameTime = video.currentTime;
    if (
      !this.#needsRender &&
      frameTime === this.#lastFrameTime &&
      document.visibilityState === 'visible'
    ) {
      return;
    }

    const w = video.videoWidth;
    const h = video.videoHeight;
    // Track resolution can change mid-call (device switch, constraints).
    this.#setSize(w, h);

    if (!this.#segment(video)) return;
    this.#lastFrameTime = frameTime;
    this.#needsRender = false;

    if (this.#gl) {
      const isImage = this.#spec.type === 'image' && this.#image;
      this.#gl.render({
        video,
        mask: this.#alpha,
        maskWidth: this.#maskWidth,
        maskHeight: this.#maskHeight,
        guide: this.#segInput,
        spec: this.#spec,
        spread: isImage ? EDGE_SPREAD_IMAGE : EDGE_SPREAD_BLUR,
        wrap: isImage ? LIGHT_WRAP_IMAGE : LIGHT_WRAP_BLUR,
      });
    } else {
      this.#composite(video, w, h);
    }
  }

  /**
   * Run person segmentation and shape the confidence into `#alpha`
   * (and, on the 2D path, into `#maskCanvas`).
   * @returns {boolean} whether a mask is ready to composite with
   */
  #segment(video) {
    this.#segInputCtx.drawImage(video, 0, 0, SEG_WIDTH, SEG_HEIGHT);
    const timestamp = Math.max(performance.now(), lastVideoTimestamp + 1);
    lastVideoTimestamp = timestamp;

    const result = this.#segmenter.segmentForVideo(this.#segInput, timestamp);
    try {
      const masks = result.confidenceMasks;
      const mask = masks?.[masks.length - 1]; // last mask = person
      if (!mask) return false;
      const confidence = mask.getAsFloat32Array();
      const mw = mask.width;
      const mh = mask.height;
      if (this.#maskWidth !== mw || this.#maskHeight !== mh) {
        this.#maskWidth = mw;
        this.#maskHeight = mh;
        this.#alpha = new Uint8Array(mw * mh);
        this.#prevMask = null;
        if (!this.#gl) {
          this.#maskData = new ImageData(mw, mh);
          this.#maskCanvas.width = mw;
          this.#maskCanvas.height = mh;
        }
      }
      if (!this.#prevMask) this.#prevMask = Float32Array.from(confidence);

      const prev = this.#prevMask;
      const alpha = this.#alpha;
      // GL textures start at the bottom of the image, so rows go out in
      // reverse; the 2D fallback keeps them in mask order.
      const flip = this.#gl !== null;
      const { lo, hi } = flip ? EDGE_GL : EDGE_2D;
      const scale = 1 / (hi - lo);
      for (let y = 0; y < mh; y++) {
        const src = y * mw;
        const dst = (flip ? mh - 1 - y : y) * mw;
        for (let x = 0; x < mw; x++) {
          const p = confidence[src + x];
          // Temporal smoothing: keep of the previous frame in proportion
          // to how uncertain the fresh value is (1 at p=0.5, 0 at 0 or 1).
          const uncertainty = 1 - Math.min(1, 2 * Math.abs(p - 0.5));
          const keep = uncertainty * TEMPORAL_SMOOTHING;
          const v = p * (1 - keep) + prev[src + x] * keep;
          prev[src + x] = v;
          // Confidence shaping: smoothstep across the lo..hi band.
          let s = (v - lo) * scale;
          s = s < 0 ? 0 : s > 1 ? 1 : s;
          alpha[dst + x] = (s * s * (3 - 2 * s) * 255) | 0;
        }
      }

      if (!this.#gl) {
        const data = this.#maskData.data;
        for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i];
        this.#maskCtx.putImageData(this.#maskData, 0, 0);
      }
      return true;
    } finally {
      result.close();
    }
  }

  /** Jitsi's three-pass 2D composite: mask, person, then background. */
  #composite(video, w, h) {
    const ctx = this.#ctx;
    const isImage = this.#spec.type === 'image' && this.#image;

    // 1. Feathered person mask (replaces the previous frame wholesale).
    ctx.globalCompositeOperation = 'copy';
    if (this.#hasFilter) ctx.filter = `blur(${isImage ? FEATHER_IMAGE_PX : FEATHER_BLUR_PX}px)`;
    ctx.drawImage(this.#maskCanvas, 0, 0, this.#maskCanvas.width, this.#maskCanvas.height, 0, 0, w, h);

    // 2. The person, punched through the mask.
    ctx.globalCompositeOperation = 'source-in';
    if (this.#hasFilter) ctx.filter = 'none';
    ctx.drawImage(video, 0, 0, w, h);

    // 3. The background behind them.
    ctx.globalCompositeOperation = 'destination-over';
    if (isImage) {
      this.#drawCover(this.#image, w, h);
    } else if (this.#hasFilter) {
      ctx.filter = `blur(${this.#spec.blur}px)`;
      ctx.drawImage(video, 0, 0, w, h);
      ctx.filter = 'none';
    } else {
      this.#drawFallbackBlur(video, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Draw an image cover-fit (fill the frame, preserve aspect, center). */
  #drawCover(image, w, h) {
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    if (!iw || !ih) return;
    const scale = Math.max(w / iw, h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    this.#ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /**
   * Approximate a blur without ctx.filter (older Safari): bounce the
   * frame through a small canvas — bilinear resampling does the rest.
   */
  #drawFallbackBlur(video, w, h) {
    const down = Math.max(2, Math.round(this.#spec.blur / 4));
    const sw = Math.max(16, Math.round(w / down));
    const sh = Math.max(9, Math.round(h / down));
    this.#blurScratch ??= document.createElement('canvas');
    const scratch = this.#blurScratch;
    if (scratch.width !== sw || scratch.height !== sh) {
      scratch.width = sw;
      scratch.height = sh;
    }
    const sctx = scratch.getContext('2d');
    sctx.drawImage(video, 0, 0, sw, sh);
    this.#ctx.imageSmoothingEnabled = true;
    this.#ctx.drawImage(scratch, 0, 0, sw, sh, 0, 0, w, h);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('background image failed to load'));
    image.src = src;
  });
}
