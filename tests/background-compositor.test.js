import { describe, it, expect } from 'vitest';
import { blurPlan, MAX_BLUR_RADIUS, MAX_BLUR_DOWNSCALE } from '../src/net/background-compositor.js';

// normalizeBackground clamps a stored blur radius to this range; every
// value in it must yield a plan the shader can execute safely.
const LEGAL_SIGMAS = Array.from({ length: 100 }, (_, i) => i + 1);

describe('blurPlan', () => {
  it('never plans more taps than the shader weight array holds', () => {
    for (const sigma of LEGAL_SIGMAS) {
      const { radius, downscale, weights } = blurPlan(sigma);
      expect(radius).toBeGreaterThanOrEqual(1);
      expect(radius).toBeLessThanOrEqual(MAX_BLUR_RADIUS);
      expect(downscale).toBeGreaterThanOrEqual(1);
      expect(downscale).toBeLessThanOrEqual(MAX_BLUR_DOWNSCALE);
      expect(weights.length).toBe(MAX_BLUR_RADIUS + 1);
    }
  });

  it('produces normalized, monotonically decreasing gaussian weights', () => {
    for (const sigma of [1, 8, 25, 100]) {
      const { radius, weights } = blurPlan(sigma);
      let total = weights[0];
      for (let i = 1; i <= radius; i++) {
        total += 2 * weights[i]; // each tap is applied on both sides
        expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
        expect(weights[i]).toBeGreaterThan(0);
      }
      expect(total).toBeCloseTo(1, 5);
      // The shader only reads up to uRadius, but the whole uniform array
      // is uploaded — everything past the radius must be zero.
      for (let i = radius + 1; i <= MAX_BLUR_RADIUS; i++) expect(weights[i]).toBe(0);
    }
  });

  it('keeps the mip level in lockstep with the downscale', () => {
    for (const sigma of LEGAL_SIGMAS) {
      const { downscale, lod } = blurPlan(sigma);
      expect(lod).toBeCloseTo(Math.log2(downscale), 10);
    }
  });

  it('holds the working sigma in a range the fixed tap budget covers', () => {
    for (const sigma of LEGAL_SIGMAS) {
      const { downscale, radius } = blurPlan(sigma);
      const workingSigma = Math.max(0.5, sigma / downscale);
      // 3 sigma of support (or the cap) — the gaussian tail beyond the
      // planned radius must be negligible, or big radii band visibly.
      expect(radius).toBeGreaterThanOrEqual(Math.min(MAX_BLUR_RADIUS, Math.ceil(3 * workingSigma)));
    }
  });
});
