/**
 * Virtual background specs — pure logic (no DOM, no media).
 *
 * A spec describes what to do with the camera background:
 *   {type: 'none'}                        raw camera, no processing
 *   {type: 'blur', blur: <px>}            blur the real background
 *   {type: 'image', id, src?}             replace it with an image
 *
 * Persisted specs never carry a `src` — preset sources are resolved from
 * the id (so asset URLs can change between builds), and the custom
 * image's data URL lives in local storage only (too big for puter.kv).
 * `resolveBackground` turns a stored spec into a runnable one.
 */

// Background blur radii in output pixels (Jitsi uses the same values).
export const BLUR_STRONG = 25;
export const BLUR_SLIGHT = 8;

export const CUSTOM_BACKGROUND_ID = 'custom';

/**
 * Bundled backgrounds, served from public/backgrounds/<id>.webp — 1280×720
 * photographs and renders, cover-fitted onto the frame by the compositor.
 */
export const PRESET_BACKGROUNDS = Object.freeze(
  [
    { id: 'forest', label: 'Forest' },
    { id: 'lake', label: 'Lake' },
    { id: 'garden', label: 'Garden' },
    { id: 'underwater', label: 'Underwater' },
    { id: 'skyline', label: 'Skyline' },
    { id: 'office', label: 'Office' },
    { id: 'library', label: 'Library' },
    { id: 'cafe', label: 'Café' },
    { id: 'living-room', label: 'Living room' },
    { id: 'shapes', label: 'Shapes' },
  ].map(Object.freeze)
);

export function presetSrc(id, base = '/') {
  return `${base}backgrounds/${id}.webp`;
}

/**
 * Validate an untrusted/stored value into a well-formed spec.
 * Unknown shapes, unknown preset ids, and a custom image whose data is
 * missing on this device all collapse to {type:'none'}.
 */
export function normalizeBackground(raw, { hasCustom = false } = {}) {
  if (!raw || typeof raw !== 'object') return { type: 'none' };
  if (raw.type === 'blur') {
    const blur = Number(raw.blur);
    return { type: 'blur', blur: Number.isFinite(blur) ? Math.min(100, Math.max(1, Math.round(blur))) : BLUR_STRONG };
  }
  if (raw.type === 'image') {
    if (raw.id === CUSTOM_BACKGROUND_ID) return hasCustom ? { type: 'image', id: CUSTOM_BACKGROUND_ID } : { type: 'none' };
    if (PRESET_BACKGROUNDS.some((p) => p.id === raw.id)) return { type: 'image', id: raw.id };
    return { type: 'none' };
  }
  return { type: 'none' };
}

/**
 * Attach the image source to a normalized spec so it can be applied.
 * @param {object} spec - A normalized spec.
 * @param {{customSrc?: string, base?: string}} opts
 */
export function resolveBackground(spec, { customSrc, base = '/' } = {}) {
  if (spec?.type !== 'image') return spec ?? { type: 'none' };
  const src = spec.id === CUSTOM_BACKGROUND_ID ? customSrc : presetSrc(spec.id, base);
  if (!src) return { type: 'none' };
  return { ...spec, src };
}

/** The spec as it should be persisted (never carries image data). */
export function storableBackground(spec) {
  if (!spec || spec.type === 'none') return undefined;
  if (spec.type === 'blur') return { type: 'blur', blur: spec.blur };
  return { type: 'image', id: spec.id };
}

/** Do two specs select the same option (ignoring resolved sources)? */
export function sameBackground(a, b) {
  const ta = a?.type ?? 'none';
  const tb = b?.type ?? 'none';
  if (ta !== tb) return false;
  if (ta === 'blur') return a.blur === b.blur;
  if (ta === 'image') return a.id === b.id;
  return true;
}

/** Human label for toasts and buttons. */
export function describeBackground(spec) {
  if (!spec || spec.type === 'none') return 'No background effect';
  if (spec.type === 'blur') return spec.blur <= BLUR_SLIGHT ? 'Slight blur' : 'Background blur';
  if (spec.id === CUSTOM_BACKGROUND_ID) return 'Your background';
  return PRESET_BACKGROUNDS.find((p) => p.id === spec.id)?.label ?? 'Background image';
}
