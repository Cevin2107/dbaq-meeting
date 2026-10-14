import { describe, it, expect } from 'vitest';
import { buildMeetingURL, parseHash, extractCode, displayCode } from '../src/lib/codes.js';

describe('buildMeetingURL', () => {
  it('builds a hash-routed URL from a base', () => {
    expect(buildMeetingURL('abc123', 'https://meet.example.com/')).toBe('https://meet.example.com/#/m/abc123');
  });

  it('URL-encodes special characters in codes', () => {
    expect(buildMeetingURL('a b/c', 'https://x.test/')).toBe('https://x.test/#/m/a%20b%2Fc');
  });
});

describe('parseHash', () => {
  it('routes empty and bare hashes home', () => {
    expect(parseHash('')).toEqual({ view: 'home' });
    expect(parseHash('#')).toEqual({ view: 'home' });
    expect(parseHash('#/')).toEqual({ view: 'home' });
  });

  it('parses meeting routes and decodes the code', () => {
    expect(parseHash('#/m/abc123')).toEqual({ view: 'meeting', code: 'abc123' });
    expect(parseHash('#/m/a%20b%2Fc')).toEqual({ view: 'meeting', code: 'a b/c' });
  });

  it('falls back home for unknown routes', () => {
    expect(parseHash('#/nope')).toEqual({ view: 'home' });
  });
});

describe('extractCode', () => {
  it('accepts a raw code', () => {
    expect(extractCode('  abc123  ')).toBe('abc123');
  });

  it('extracts the code from a full meeting link', () => {
    expect(extractCode('https://meet.example.com/#/m/xyz789')).toBe('xyz789');
  });

  it('extracts from a link with an encoded code', () => {
    expect(extractCode('https://x.test/#/m/a%20b')).toBe('a b');
  });

  it('rejects URLs that are not meeting links', () => {
    expect(extractCode('https://example.com/other')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(extractCode('')).toBeNull();
    expect(extractCode('   ')).toBeNull();
    expect(extractCode(null)).toBeNull();
    expect(extractCode(undefined)).toBeNull();
  });

  it('round-trips through buildMeetingURL', () => {
    const url = buildMeetingURL('code-42!', 'https://m.test/');
    expect(extractCode(url)).toBe('code-42!');
  });
});

describe('displayCode', () => {
  it('returns short codes unchanged', () => {
    expect(displayCode('abc-defg-hij')).toBe('abc-defg-hij');
  });

  it('middle-truncates long codes', () => {
    const long = 'x'.repeat(60);
    const out = displayCode(long, 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out).toContain('…');
  });

  it('handles non-strings safely', () => {
    expect(displayCode(undefined)).toBe('');
  });
});
