import { describe, it, expect } from 'vitest';
import { cameraSendProfile, SCREEN_SEND_PROFILE } from '../src/net/rtc.js';

describe('cameraSendProfile', () => {
  it('gives a solo/1:1 call full quality', () => {
    const p = cameraSendProfile(1);
    expect(p.maxBitrate).toBeGreaterThanOrEqual(1_000_000);
    expect(p.maxFramerate).toBe(30);
    expect(p.scaleResolutionDownBy).toBe(1);
  });

  it('always prefers framerate over resolution for cameras', () => {
    for (const n of [0, 1, 2, 4, 8, 16]) {
      expect(cameraSendProfile(n).degradationPreference).toBe('maintain-framerate');
    }
  });

  it('never increases cost as the call grows', () => {
    let prev = cameraSendProfile(1);
    for (let n = 2; n <= 20; n++) {
      const p = cameraSendProfile(n);
      expect(p.maxBitrate).toBeLessThanOrEqual(prev.maxBitrate);
      expect(p.maxFramerate).toBeLessThanOrEqual(prev.maxFramerate);
      expect(p.scaleResolutionDownBy).toBeGreaterThanOrEqual(prev.scaleResolutionDownBy);
      prev = p;
    }
  });

  it('keeps total mesh upload bounded in large calls', () => {
    for (const n of [4, 8, 12, 20]) {
      const p = cameraSendProfile(n);
      // n outgoing copies must stay under ~5 Mbps total.
      expect(p.maxBitrate * n).toBeLessThanOrEqual(5_000_000);
    }
  });

  it('bounds every tier sensibly', () => {
    for (const n of [1, 3, 5, 10, 50]) {
      const p = cameraSendProfile(n);
      expect(p.maxBitrate).toBeGreaterThanOrEqual(100_000);
      expect(p.maxFramerate).toBeGreaterThanOrEqual(12);
      expect(p.scaleResolutionDownBy).toBeGreaterThanOrEqual(1);
      expect(p.scaleResolutionDownBy).toBeLessThanOrEqual(4);
    }
  });
});

describe('SCREEN_SEND_PROFILE', () => {
  it('prefers resolution (sharp text) and modest framerate', () => {
    expect(SCREEN_SEND_PROFILE.degradationPreference).toBe('maintain-resolution');
    expect(SCREEN_SEND_PROFILE.maxFramerate).toBeLessThanOrEqual(15);
    expect(SCREEN_SEND_PROFILE.scaleResolutionDownBy).toBe(1);
    expect(SCREEN_SEND_PROFILE.maxBitrate).toBeGreaterThan(1_000_000);
  });
});
