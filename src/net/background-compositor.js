/**
 * GLCompositor — WebGL2 compositing for the camera background effect.
 *
 * The segmentation model gives us a 256×144 confidence mask for a
 * 1280×720 frame. Stretching that 5× and feathering it with a fixed
 * blur (the obvious 2D-canvas approach) is what makes a composite look
 * cheap: the edge sits wherever the low-res mask put it, so the subject
 * either wears a halo of old background or gets shaved into.
 *
 * This is the technique Google Meet uses instead:
 *
 *  1. **Joint bilateral upsample.** Each output pixel gathers the 3×3
 *     neighbourhood of mask texels around it, weighting each one by
 *     spatial falloff *and* by how closely the low-res frame at that
 *     texel matches the full-res pixel being shaded. Where colour
 *     agrees the mask value carries; where it disagrees it is rejected.
 *     The alpha edge lands on the real image edge, not the mask grid.
 *
 *  2. **Light wrapping.** A wide, purely spatial blur of the same mask
 *     says how deep inside the subject we are. Just inside the outline
 *     we screen a little of the background over the subject, so they
 *     pick up the scene's light instead of reading as a sticker on top
 *     of it. This is what sells an image background.
 *
 *  3. **A background-only Gaussian blur.** The frame is premultiplied by
 *     1 − person alpha at full resolution, mip-filtered down (so fine
 *     detail doesn't shimmer), Gaussian-blurred separably at working
 *     resolution, and the composite divides the blurred weight back out.
 *     Because the premultiply happens before any downscale, every
 *     averaging step carries the weight consistently: the blur averages
 *     background pixels only, and the subject's colours never smear
 *     into the backdrop around them. `CanvasRenderingContext2D.filter`'s
 *     blur is a triple-box approximation and bands visibly at large
 *     radii, and smears the subject besides.
 *
 * Everything runs in two or four draw calls on textures the GPU already
 * has, so it costs less than the per-pixel JS mask loop it replaces.
 */

// Blur: pick a downscale that lands the working sigma near this value,
// so the tap count stays fixed and small no matter the requested radius.
const BLUR_WORK_SIGMA = 3;
export const MAX_BLUR_DOWNSCALE = 8;
export const MAX_BLUR_RADIUS = 12; // must match uWeight[] in BLUR_FRAG

// Joint bilateral range term: how far the guide colour may sit from the
// pixel being shaded (euclidean RGB distance) before a mask tap is
// rejected. Tighter = edges snap harder, but a subject that matches
// their real background loses its outline. Colour rather than luma so a
// red shirt still cuts against equally-bright green leaves; 0.2 ≈ the
// old luma sigma of 0.12 × √3, i.e. unchanged for achromatic edges.
const JBU_RANGE_SIGMA = 0.2;

// Mask-texel radius of the wide blur that drives light wrapping. 2.5
// texels ≈ 12 output px at 720p — a rim, not a glow.
const WRAP_SPREAD = 2.5;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Serves two passes of the blur pipeline. With uMask = the person mask,
// uSrc = the frame and uLod = 0 it premultiplies by 1 - person alpha at
// full resolution (alpha carries the weight from then on). With uMask =
// the all-zero dummy it is a plain mip-filtered downscale that passes
// the premultiplied weight through untouched.
const BLIT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform float uLod;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 s = textureLod(uSrc, vUv, uLod);
  float keep = 1.0 - textureLod(uMask, vUv, 0.0).r;
  fragColor = vec4(s.rgb * keep, s.a * keep);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform vec2 uStep;      // one texel along the axis being blurred
uniform int uRadius;
uniform float uWeight[${MAX_BLUR_RADIUS + 1}];
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 acc = textureLod(uSrc, vUv, 0.0) * uWeight[0];
  for (int i = 1; i <= uRadius; i++) {
    vec2 o = uStep * float(i);
    acc += (textureLod(uSrc, vUv + o, 0.0) + textureLod(uSrc, vUv - o, 0.0)) * uWeight[i];
  }
  fragColor = acc;
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uFrame;   // full-res camera frame
uniform sampler2D uMask;    // low-res person alpha
uniform sampler2D uGuide;   // the same frame at mask resolution
uniform sampler2D uBlur;    // blurred background, premultiplied (blur mode)
uniform sampler2D uImage;   // background image (image mode)

uniform vec2 uMaskTexel;    // 1 / mask size, pre-scaled by the edge spread
uniform vec2 uImageScale;   // cover-fit transform for uImage
uniform vec2 uImageOffset;
uniform float uRangeFalloff; // 1 / (2 * sigma^2) for the range term
uniform float uWrap;         // light-wrap strength, 0 disables
uniform int uUseImage;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec3 fg = textureLod(uFrame, vUv, 0.0).rgb;

  // 3x3 over the mask grid: joint bilateral for the alpha we composite
  // with, plain spatial for the wide alpha that drives light wrapping.
  float sum = 0.0;
  float weightSum = 0.0;
  float wide = 0.0;
  float wideSum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 d = vec2(float(x), float(y));
      float spatial = exp(-0.5 * dot(d, d)); // gaussian, sigma = 1 texel
      vec2 tap = vUv + d * uMaskTexel;

      vec3 dc = textureLod(uGuide, tap, 0.0).rgb - fg;
      float w = spatial * exp(-dot(dc, dc) * uRangeFalloff);
      sum += textureLod(uMask, tap, 0.0).r * w;
      weightSum += w;

      wide += textureLod(uMask, vUv + d * uMaskTexel * ${WRAP_SPREAD.toFixed(1)}, 0.0).r * spatial;
      wideSum += spatial;
    }
  }
  float alpha = clamp(sum / max(weightSum, 1e-4), 0.0, 1.0);
  float wideAlpha = wide / wideSum;

  // The blur is premultiplied by 1 - person alpha; dividing that weight
  // back out reconstructs a background-only blur, with the background
  // extended a little way in under the subject's edge. Deep inside the
  // subject the weight hits 0 and bg falls to black — alpha is 1 there,
  // so it is never seen (and the wrap term has died off with wideAlpha).
  vec4 blurred = textureLod(uBlur, vUv, 0.0);
  vec3 bg = uUseImage == 1
    ? textureLod(uImage, vUv * uImageScale + uImageOffset, 0.0).rgb
    : clamp(blurred.rgb / max(blurred.a, 0.004), 0.0, 1.0);

  // Light wrapping. Peaks just inside the outline (solid alpha, but the
  // wide blur hasn't saturated yet) and dies off deeper in. Screened
  // rather than added so a bright background can't blow out skin.
  float wrap = uWrap * alpha * (1.0 - wideAlpha);
  fg = 1.0 - (1.0 - fg) * (1.0 - bg * wrap);

  fragColor = vec4(mix(bg, fg, alpha), 1.0);
}`;

/**
 * Gaussian weights + the downscale that keeps the tap count bounded.
 * Exported for tests: radius must never exceed MAX_BLUR_RADIUS, or the
 * shader would read past the end of uWeight[].
 */
export function blurPlan(sigma) {
  const downscale = Math.min(MAX_BLUR_DOWNSCALE, Math.max(1, Math.round(sigma / BLUR_WORK_SIGMA)));
  const s = Math.max(0.5, sigma / downscale);
  const radius = Math.min(MAX_BLUR_RADIUS, Math.max(1, Math.ceil(3 * s)));
  const weights = new Float32Array(MAX_BLUR_RADIUS + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) {
    const g = Math.exp(-(i * i) / (2 * s * s));
    weights[i] = g;
    total += i === 0 ? g : 2 * g;
  }
  for (let i = 0; i <= radius; i++) weights[i] /= total;
  return { downscale, radius, weights, lod: Math.log2(downscale) };
}

export class GLCompositor {
  /** @returns {GLCompositor|null} null when WebGL2 isn't usable. */
  static create() {
    try {
      const compositor = new GLCompositor();
      return compositor.#gl ? compositor : null;
    } catch {
      return null;
    }
  }

  canvas = document.createElement('canvas');

  #gl;
  #programs = null;
  #vao = null;
  #buffer = null;
  #tex = null;
  #fbo = null;
  /** @type {{width: number, height: number}|null} current blur target size */
  #blurSize = null;
  /** @type {{width: number, height: number}|null} current premultiply target size */
  #preSize = null;
  #maskSize = null;
  /** @type {HTMLImageElement|null} kept so the image survives context loss */
  #image = null;
  #imageDirty = false;
  #blurCache = { sigma: -1, plan: null };
  #halfFloat = false;
  #lost = false;

  constructor() {
    this.#gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!this.#gl) return;

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // opt in to a restore
      this.#lost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.#build();
      this.#lost = false;
    });
    this.#build();
  }

  /** Size the output. Cheap to call every frame. */
  resize(width, height) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** @param {HTMLImageElement|null} image */
  setBackgroundImage(image) {
    this.#image = image;
    this.#imageDirty = true;
  }

  /**
   * Composite one frame onto `canvas`.
   * @param {object} args
   * @param {HTMLVideoElement} args.video - full-res source frame
   * @param {Uint8Array} args.mask - person alpha, row 0 = bottom of frame
   * @param {number} args.maskWidth
   * @param {number} args.maskHeight
   * @param {HTMLCanvasElement} args.guide - the frame at mask resolution
   * @param {{type: string, blur?: number}} args.spec
   * @param {number} args.spread - edge spread multiplier
   * @param {number} args.wrap - light-wrap strength
   */
  render({ video, mask, maskWidth, maskHeight, guide, spec, spread, wrap }) {
    const gl = this.#gl;
    if (!gl || this.#lost || gl.isContextLost() || !this.#programs) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const useImage = spec.type === 'image' && this.#image;
    const needsBlur = !useImage;

    this.#uploadFrame(video);
    this.#uploadMask(mask, maskWidth, maskHeight);
    this.#uploadGuide(guide);
    if (this.#imageDirty) this.#uploadImage();

    gl.bindVertexArray(this.#vao);

    if (needsBlur) this.#renderBlur(width, height, spec.blur);

    // ---- composite to the visible canvas ----
    const { composite } = this.#programs;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(composite.program);
    this.#bind(gl.TEXTURE0, this.#tex.frame, composite.u.uFrame, 0);
    this.#bind(gl.TEXTURE1, this.#tex.mask, composite.u.uMask, 1);
    this.#bind(gl.TEXTURE2, this.#tex.guide, composite.u.uGuide, 2);
    this.#bind(gl.TEXTURE3, needsBlur ? this.#tex.blurA : this.#tex.dummy, composite.u.uBlur, 3);
    this.#bind(gl.TEXTURE4, useImage ? this.#tex.image : this.#tex.dummy, composite.u.uImage, 4);
    gl.uniform2f(composite.u.uMaskTexel, spread / maskWidth, spread / maskHeight);
    gl.uniform1f(composite.u.uRangeFalloff, 1 / (2 * JBU_RANGE_SIGMA * JBU_RANGE_SIGMA));
    gl.uniform1f(composite.u.uWrap, wrap);
    gl.uniform1i(composite.u.uUseImage, useImage ? 1 : 0);
    this.#setImageFit(composite.u, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.#gl;
    if (!gl) return;
    this.#image = null;
    for (const tex of Object.values(this.#tex ?? {})) gl.deleteTexture(tex);
    for (const fbo of Object.values(this.#fbo ?? {})) gl.deleteFramebuffer(fbo);
    for (const p of Object.values(this.#programs ?? {})) gl.deleteProgram(p.program);
    gl.deleteVertexArray(this.#vao);
    gl.deleteBuffer(this.#buffer);
    this.#tex = this.#fbo = this.#programs = null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // ---- setup ----

  /** Create every GL object. Re-run verbatim after a context restore. */
  #build() {
    const gl = this.#gl;
    // Half-float working textures keep the premultiplied blur's
    // normalization from banding near the subject's edge; RGBA8 is the
    // universal fallback. (Extensions must be re-queried after a
    // context restore, which is why this lives here.)
    this.#halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.#programs = {
      blit: program(gl, VERT, BLIT_FRAG, ['uSrc', 'uMask', 'uLod']),
      blur: program(gl, VERT, BLUR_FRAG, ['uSrc', 'uStep', 'uRadius', 'uWeight[0]']),
      composite: program(gl, VERT, COMPOSITE_FRAG, [
        'uFrame', 'uMask', 'uGuide', 'uBlur', 'uImage',
        'uMaskTexel', 'uImageScale', 'uImageOffset', 'uRangeFalloff', 'uWrap', 'uUseImage',
      ]),
    };

    this.#buffer = gl.createBuffer();
    this.#vao = gl.createVertexArray();
    gl.bindVertexArray(this.#vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); // aPos is bound to location 0 by program()
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.#tex = {
      frame: texture(gl),
      mask: texture(gl),
      guide: texture(gl),
      image: texture(gl),
      pre: texture(gl),
      blurA: texture(gl),
      blurB: texture(gl),
      dummy: texture(gl),
    };
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    // The premultiplied frame is the one texture sampled at real mip
    // levels (the blur's box-filtered downscale).
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.pre);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);

    this.#fbo = { pre: gl.createFramebuffer(), a: gl.createFramebuffer(), b: gl.createFramebuffer() };
    this.#blurSize = null;
    this.#preSize = null;
    this.#maskSize = null;
    this.#imageDirty = this.#image !== null;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  // ---- uploads ----

  #uploadFrame(video) {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.frame);
    // Everything is uploaded flipped, so texture t=0 is the bottom of
    // the image and one uv convention covers textures and FBOs alike.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  #uploadMask(mask, width, height) {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.mask);
    if (this.#maskSize?.width !== width || this.#maskSize?.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, mask);
      this.#maskSize = { width, height };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, mask);
    }
  }

  #uploadGuide(guide) {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.guide);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, guide);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  #uploadImage() {
    const gl = this.#gl;
    this.#imageDirty = false;
    if (!this.#image) return;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.image);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.#image);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Backgrounds are often larger than the frame; mips keep the
    // downscale from aliasing into shimmer as the subject moves.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  // ---- passes ----

  /**
   * Premultiply the frame by 1 − person alpha at full resolution, mip
   * that down, blur it separably, and leave the result in blurA (with
   * the surviving weight in alpha for the composite to divide out).
   */
  #renderBlur(width, height, sigma) {
    const gl = this.#gl;
    if (this.#blurCache.sigma !== sigma) {
      this.#blurCache = { sigma, plan: blurPlan(sigma) };
    }
    const { downscale, radius, weights, lod } = this.#blurCache.plan;
    const w = Math.max(8, Math.round(width / downscale));
    const h = Math.max(8, Math.round(height / downscale));
    if (this.#preSize?.width !== width || this.#preSize?.height !== height) {
      gl.bindTexture(gl.TEXTURE_2D, this.#tex.pre);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo.pre);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#tex.pre, 0);
      this.#preSize = { width, height };
    }
    if (this.#blurSize?.width !== w || this.#blurSize?.height !== h) {
      this.#allocBlurTargets(w, h);
      // Guard against drivers that expose the extension but refuse to
      // render to half-float: fall back to RGBA8 rather than freeze.
      if (this.#halfFloat && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.#halfFloat = false;
        this.#allocBlurTargets(w, h);
      }
      this.#blurSize = { width: w, height: h };
    }

    const { blit, blur } = this.#programs;

    // Premultiply before any downscale so the subject is excluded from
    // the mip chain too, not just from the Gaussian.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo.pre);
    gl.viewport(0, 0, width, height);
    gl.useProgram(blit.program);
    this.#bind(gl.TEXTURE3, this.#tex.frame, blit.u.uSrc, 3);
    this.#bind(gl.TEXTURE1, this.#tex.mask, blit.u.uMask, 1);
    gl.uniform1f(blit.u.uLod, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.pre);
    gl.generateMipmap(gl.TEXTURE_2D);

    // Mip-filtered downscale to working resolution (dummy mask = no-op).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo.a);
    gl.viewport(0, 0, w, h);
    this.#bind(gl.TEXTURE3, this.#tex.pre, blit.u.uSrc, 3);
    this.#bind(gl.TEXTURE1, this.#tex.dummy, blit.u.uMask, 1);
    gl.uniform1f(blit.u.uLod, lod);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(blur.program);
    gl.uniform1i(blur.u.uRadius, radius);
    gl.uniform1fv(blur.u['uWeight[0]'], weights);
    for (const [src, dst, step] of [
      [this.#tex.blurA, this.#fbo.b, [1 / w, 0]],
      [this.#tex.blurB, this.#fbo.a, [0, 1 / h]],
    ]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst);
      this.#bind(gl.TEXTURE3, src, blur.u.uSrc, 3);
      gl.uniform2f(blur.u.uStep, step[0], step[1]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  #allocBlurTargets(w, h) {
    const gl = this.#gl;
    for (const [tex, fbo] of [[this.#tex.blurA, this.#fbo.a], [this.#tex.blurB, this.#fbo.b]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.#halfFloat) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    }
  }

  /** Cover-fit uv transform for the background image. */
  #setImageFit(u, width, height) {
    const gl = this.#gl;
    const iw = this.#image?.naturalWidth || this.#image?.width || 0;
    const ih = this.#image?.naturalHeight || this.#image?.height || 0;
    let sx = 1;
    let sy = 1;
    if (iw && ih) {
      const frame = width / height;
      const image = iw / ih;
      if (image > frame) sx = frame / image;
      else sy = image / frame;
    }
    gl.uniform2f(u.uImageScale, sx, sy);
    gl.uniform2f(u.uImageOffset, (1 - sx) / 2, (1 - sy) / 2);
  }

  #bind(unit, tex, location, index) {
    const gl = this.#gl;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(location, index);
  }
}

function texture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function program(gl, vertSource, fragSource, uniformNames) {
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, vertSource));
  gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, fragSource));
  gl.bindAttribLocation(prog, 0, 'aPos'); // so one VAO serves every program
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  const u = {};
  for (const name of uniformNames) u[name] = gl.getUniformLocation(prog, name);
  return { program: prog, u };
}

function shader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}
