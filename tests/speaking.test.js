import { describe, it, expect } from 'vitest';
import { SpeakingDetector } from '../src/lib/speaking.js';

const OPTS = { onThreshold: 0.02, offThreshold: 0.01, holdMs: 900 };

describe('SpeakingDetector', () => {
  it('starts silent', () => {
    const d = new SpeakingDetector(OPTS);
    expect(d.speaking).toBe(false);
    expect(d.update(0.001, 0)).toBe(false);
  });

  it('activates when the level crosses the on-threshold', () => {
    const d = new SpeakingDetector(OPTS);
    expect(d.update(0.05, 0)).toBe(true);
  });

  it('holds through brief silence (hysteresis)', () => {
    const d = new SpeakingDetector(OPTS);
    d.update(0.05, 0);
    expect(d.update(0.001, 100)).toBe(true); // silent, but within hold window
    expect(d.update(0.001, 500)).toBe(true);
    expect(d.update(0.05, 800)).toBe(true); // speech resumes
    expect(d.update(0.001, 900)).toBe(true); // hold timer restarts
  });

  it('deactivates after sustained silence', () => {
    const d = new SpeakingDetector(OPTS);
    d.update(0.05, 0);
    d.update(0.001, 100);
    expect(d.update(0.001, 1001)).toBe(false); // 901ms below threshold
  });

  it('keeps state in the dead zone between thresholds', () => {
    const d = new SpeakingDetector(OPTS);
    d.update(0.05, 0);
    // 0.015 is between off (0.01) and on (0.02): stays speaking indefinitely
    expect(d.update(0.015, 5000)).toBe(true);
    expect(d.update(0.015, 50_000)).toBe(true);

    const quiet = new SpeakingDetector(OPTS);
    expect(quiet.update(0.015, 0)).toBe(false); // and stays silent if it was silent
  });

  it('dead-zone samples reset the off timer', () => {
    const d = new SpeakingDetector(OPTS);
    d.update(0.05, 0);
    d.update(0.001, 100); // below off — timer starts
    d.update(0.015, 500); // dead zone — timer resets
    expect(d.update(0.001, 1300)).toBe(true); // only 800ms since new below-start
    expect(d.update(0.001, 2300)).toBe(false);
  });

  it('reset returns to silent', () => {
    const d = new SpeakingDetector(OPTS);
    d.update(0.5, 0);
    d.reset();
    expect(d.speaking).toBe(false);
  });
});
