import { describe, it, expect } from 'vitest';
import {
  BLUR_SLIGHT,
  BLUR_STRONG,
  CUSTOM_BACKGROUND_ID,
  PRESET_BACKGROUNDS,
  presetSrc,
  normalizeBackground,
  resolveBackground,
  storableBackground,
  sameBackground,
  describeBackground,
} from '../src/lib/backgrounds.js';

describe('normalizeBackground', () => {
  it('collapses garbage to none', () => {
    for (const raw of [undefined, null, 42, 'blur', {}, { type: 'sparkles' }, []]) {
      expect(normalizeBackground(raw)).toEqual({ type: 'none' });
    }
  });

  it('keeps valid blur specs and clamps the radius', () => {
    expect(normalizeBackground({ type: 'blur', blur: BLUR_STRONG })).toEqual({ type: 'blur', blur: BLUR_STRONG });
    expect(normalizeBackground({ type: 'blur', blur: 0 })).toEqual({ type: 'blur', blur: 1 });
    expect(normalizeBackground({ type: 'blur', blur: 9999 })).toEqual({ type: 'blur', blur: 100 });
    expect(normalizeBackground({ type: 'blur', blur: 12.6 })).toEqual({ type: 'blur', blur: 13 });
  });

  it('defaults a malformed blur radius to strong blur', () => {
    expect(normalizeBackground({ type: 'blur', blur: 'lots' })).toEqual({ type: 'blur', blur: BLUR_STRONG });
    expect(normalizeBackground({ type: 'blur' })).toEqual({ type: 'blur', blur: BLUR_STRONG });
  });

  it('accepts known preset images and rejects unknown ids', () => {
    expect(normalizeBackground({ type: 'image', id: 'forest' })).toEqual({ type: 'image', id: 'forest' });
    expect(normalizeBackground({ type: 'image', id: 'not-a-preset' })).toEqual({ type: 'none' });
    expect(normalizeBackground({ type: 'image' })).toEqual({ type: 'none' });
  });

  it('keeps the custom image only when its data exists on this device', () => {
    const raw = { type: 'image', id: CUSTOM_BACKGROUND_ID };
    expect(normalizeBackground(raw, { hasCustom: true })).toEqual(raw);
    expect(normalizeBackground(raw, { hasCustom: false })).toEqual({ type: 'none' });
  });

  it('drops stray fields (e.g. a persisted src)', () => {
    expect(normalizeBackground({ type: 'image', id: 'lake', src: 'data:...' })).toEqual({ type: 'image', id: 'lake' });
  });
});

describe('resolveBackground', () => {
  it('passes through none and blur untouched', () => {
    expect(resolveBackground({ type: 'none' })).toEqual({ type: 'none' });
    expect(resolveBackground({ type: 'blur', blur: 8 })).toEqual({ type: 'blur', blur: 8 });
    expect(resolveBackground(undefined)).toEqual({ type: 'none' });
  });

  it('resolves preset sources from the id and base path', () => {
    const spec = resolveBackground({ type: 'image', id: 'forest' }, { base: '/app/' });
    expect(spec).toEqual({ type: 'image', id: 'forest', src: '/app/backgrounds/forest.webp' });
  });

  it('resolves the custom image from customSrc, or falls back to none', () => {
    const raw = { type: 'image', id: CUSTOM_BACKGROUND_ID };
    expect(resolveBackground(raw, { customSrc: 'data:image/jpeg;base64,x' }).src).toBe('data:image/jpeg;base64,x');
    expect(resolveBackground(raw, {})).toEqual({ type: 'none' });
  });
});

describe('storableBackground', () => {
  it('stores none as undefined (pref removed)', () => {
    expect(storableBackground({ type: 'none' })).toBeUndefined();
    expect(storableBackground(undefined)).toBeUndefined();
  });

  it('never persists image data', () => {
    const stored = storableBackground({ type: 'image', id: CUSTOM_BACKGROUND_ID, src: 'data:huge' });
    expect(stored).toEqual({ type: 'image', id: CUSTOM_BACKGROUND_ID });
  });

  it('round-trips through normalize', () => {
    const specs = [
      { type: 'blur', blur: BLUR_SLIGHT },
      { type: 'blur', blur: BLUR_STRONG },
      { type: 'image', id: 'underwater' },
    ];
    for (const spec of specs) {
      expect(normalizeBackground(storableBackground(spec), { hasCustom: true })).toEqual(spec);
    }
  });
});

describe('sameBackground', () => {
  it('matches by type and identity, ignoring resolved sources', () => {
    expect(sameBackground({ type: 'none' }, undefined)).toBe(true);
    expect(sameBackground({ type: 'blur', blur: 8 }, { type: 'blur', blur: 8 })).toBe(true);
    expect(sameBackground({ type: 'blur', blur: 8 }, { type: 'blur', blur: 25 })).toBe(false);
    expect(sameBackground({ type: 'image', id: 'lake', src: 'a' }, { type: 'image', id: 'lake' })).toBe(true);
    expect(sameBackground({ type: 'image', id: 'lake' }, { type: 'image', id: 'forest' })).toBe(false);
    expect(sameBackground({ type: 'blur', blur: 8 }, { type: 'image', id: 'lake' })).toBe(false);
  });
});

describe('presets', () => {
  it('have unique ids and labels', () => {
    const ids = PRESET_BACKGROUNDS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRESET_BACKGROUNDS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.id).not.toBe(CUSTOM_BACKGROUND_ID); // reserved
    }
  });

  it('resolve to per-id asset paths', () => {
    expect(presetSrc('forest')).toBe('/backgrounds/forest.webp');
  });
});

describe('describeBackground', () => {
  it('labels the common specs', () => {
    expect(describeBackground(undefined)).toBe('No background effect');
    expect(describeBackground({ type: 'blur', blur: BLUR_SLIGHT })).toBe('Slight blur');
    expect(describeBackground({ type: 'blur', blur: BLUR_STRONG })).toBe('Background blur');
    expect(describeBackground({ type: 'image', id: 'living-room' })).toBe('Living room');
    expect(describeBackground({ type: 'image', id: CUSTOM_BACKGROUND_ID })).toBe('Your background');
  });
});
