import { describe, it, expect } from 'vitest';
import { initials, colorFor } from '../src/lib/names.js';

describe('initials', () => {
  it('takes first and last initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Grace Brewster Murray Hopper')).toBe('GH');
  });

  it('handles single names', () => {
    expect(initials('puter')).toBe('P');
  });

  it('handles empty input', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
    expect(initials(null)).toBe('?');
  });

  it('handles unicode names', () => {
    expect(initials('José García')).toBe('JG');
  });
});

describe('colorFor', () => {
  it('is deterministic', () => {
    expect(colorFor('Ada')).toBe(colorFor('Ada'));
  });

  it('returns a hex color', () => {
    expect(colorFor('anyone')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(colorFor('')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('spreads distinct seeds across the palette', () => {
    const colors = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(colorFor));
    expect(colors.size).toBeGreaterThan(2);
  });
});
