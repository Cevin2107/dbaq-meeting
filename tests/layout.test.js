import { describe, it, expect } from 'vitest';
import { computeGridLayout, computeSpotlightLayout } from '../src/lib/layout.js';

function assertWithinBounds(rects, width, height) {
  for (const r of rects) {
    expect(r.x).toBeGreaterThanOrEqual(-0.01);
    expect(r.y).toBeGreaterThanOrEqual(-0.01);
    expect(r.x + r.w).toBeLessThanOrEqual(width + 0.01);
    expect(r.y + r.h).toBeLessThanOrEqual(height + 0.01);
  }
}

function overlaps(a, b) {
  return a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
}

describe('computeGridLayout', () => {
  it('returns an empty layout for zero tiles', () => {
    expect(computeGridLayout(0, 1280, 720).rects).toEqual([]);
  });

  it('gives a single tile the full 16:9 fit', () => {
    const { rects } = computeGridLayout(1, 1600, 900, { gap: 0 });
    expect(rects).toHaveLength(1);
    expect(rects[0].w).toBeCloseTo(1600, 0);
    expect(rects[0].h).toBeCloseTo(900, 0);
  });

  it('produces one rect per tile for many sizes', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 9, 12, 20]) {
      const { rects } = computeGridLayout(n, 1280, 720);
      expect(rects).toHaveLength(n);
      assertWithinBounds(rects, 1280, 720);
    }
  });

  it('never overlaps tiles', () => {
    for (const n of [2, 3, 5, 8, 13]) {
      const { rects } = computeGridLayout(n, 1024, 768);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(overlaps(rects[i], rects[j])).toBe(false);
        }
      }
    }
  });

  it('keeps the preferred aspect ratio', () => {
    const { rects } = computeGridLayout(4, 1280, 720, { aspect: 16 / 9 });
    for (const r of rects) {
      expect(r.w / r.h).toBeCloseTo(16 / 9, 1);
    }
  });

  it('uses two columns for two tiles in landscape', () => {
    const { cols, rows } = computeGridLayout(2, 1600, 700);
    expect(cols).toBe(2);
    expect(rows).toBe(1);
  });

  it('stacks two tiles vertically in portrait', () => {
    const { cols, rows } = computeGridLayout(2, 400, 900);
    expect(cols).toBe(1);
    expect(rows).toBe(2);
  });

  it('centers a partial last row', () => {
    const { rects, cols } = computeGridLayout(3, 1200, 800);
    if (cols === 2) {
      const lastRect = rects[2];
      const center = lastRect.x + lastRect.w / 2;
      expect(center).toBeCloseTo(600, 0);
    }
  });

  it('drops the gaps rather than the layout in a container smaller than them', () => {
    // No arrangement fits three tiles and two 12px gaps into 10x10.
    const { rects } = computeGridLayout(3, 10, 10, { gap: 12 });
    expect(rects).toHaveLength(3);
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
    assertWithinBounds(rects, 10, 10);
  });

  it('never emits a negative tile size', () => {
    for (const [count, w, h] of [[40, 429, 6], [8, 20, 4], [2, 1, 1], [16, 100, 100]]) {
      const { rects } = computeGridLayout(count, w, h, { gap: 12 });
      expect(rects).toHaveLength(count);
      for (const r of rects) {
        expect(r.w).toBeGreaterThanOrEqual(0);
        expect(r.h).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('computeSpotlightLayout', () => {
  it('gives the featured tile everything when the strip is empty', () => {
    const { featured, strip } = computeSpotlightLayout(0, 1280, 720);
    expect(strip).toEqual([]);
    expect(featured).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });

  it('places the strip on the right in landscape', () => {
    const { featured, strip, orientation } = computeSpotlightLayout(3, 1280, 720);
    expect(orientation).toBe('row');
    expect(strip).toHaveLength(3);
    for (const r of strip) {
      expect(r.x).toBeGreaterThan(featured.w);
    }
    assertWithinBounds([featured, ...strip], 1280, 720);
  });

  it('places the strip below in portrait', () => {
    const { featured, strip, orientation } = computeSpotlightLayout(2, 400, 800);
    expect(orientation).toBe('column');
    for (const r of strip) {
      expect(r.y).toBeGreaterThan(featured.h);
    }
    assertWithinBounds([featured, ...strip], 400, 800);
  });

  it('keeps large strips inside the container', () => {
    const { strip } = computeSpotlightLayout(12, 1280, 720);
    assertWithinBounds(strip, 1280, 720);
  });

  it('never emits a negative size, however cramped', () => {
    for (const [count, w, h] of [[80, 1280, 720], [60, 400, 800], [3, 12, 8]]) {
      const { featured, strip } = computeSpotlightLayout(count, w, h);
      for (const r of [featured, ...strip]) {
        expect(r.w).toBeGreaterThanOrEqual(0);
        expect(r.h).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
