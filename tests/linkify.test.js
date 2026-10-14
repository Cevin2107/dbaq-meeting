import { describe, it, expect } from 'vitest';
import { linkify } from '../src/lib/linkify.js';

/** Compact view of a result: text runs as strings, links as [text, href]. */
const shape = (text) => linkify(text).map((p) => (p.type === 'link' ? [p.text, p.href] : p.text));
const links = (text) => linkify(text).filter((p) => p.type === 'link');
const hrefs = (text) => links(text).map((p) => p.href);

describe('linkify', () => {
  it('leaves plain text alone', () => {
    expect(shape('no links here')).toEqual(['no links here']);
    expect(shape('')).toEqual([]);
  });

  it('is lossless: concatenating segments rebuilds the input', () => {
    for (const text of [
      'see https://example.com now',
      'a.com, b.org and www.c.net!',
      'mail nj@puter.com',
      'weird ) ( . text',
      'multi\nline https://example.com/x\nend',
    ]) {
      expect(linkify(text).map((p) => p.text).join('')).toBe(text);
    }
  });

  it('links http(s) URLs', () => {
    expect(shape('see https://example.com for details')).toEqual([
      'see ',
      ['https://example.com', 'https://example.com/'],
      ' for details',
    ]);
    expect(hrefs('http://example.com/a/b?q=1#z')).toEqual(['http://example.com/a/b?q=1#z']);
  });

  it('links www hosts and bare hosts with a known TLD', () => {
    expect(hrefs('visit www.example.com')).toEqual(['https://www.example.com/']);
    expect(hrefs('meetings.puter.com/abc-def-ghi')).toEqual(['https://meetings.puter.com/abc-def-ghi']);
    expect(hrefs('sub.example.co.uk')).toEqual(['https://sub.example.co.uk/']);
    expect(hrefs('example.com:8080/path?q=1')).toEqual(['https://example.com:8080/path?q=1']);
  });

  it('finds several links in one message', () => {
    expect(hrefs('multi https://a.com then b.org end')).toEqual(['https://a.com/', 'https://b.org/']);
  });

  it('keeps the typed text as the link label', () => {
    expect(links('HTTPS://EXAMPLE.COM/Path')[0]).toEqual({
      type: 'link',
      text: 'HTTPS://EXAMPLE.COM/Path',
      href: 'https://example.com/Path',
    });
  });

  it('drops sentence punctuation from the end of a URL', () => {
    expect(shape('go to example.com.')).toEqual(['go to ', ['example.com', 'https://example.com/'], '.']);
    expect(shape('www.example.com!')).toEqual([['www.example.com', 'https://www.example.com/'], '!']);
    expect(shape('read https://a.com/x, then stop')).toEqual([
      'read ',
      ['https://a.com/x', 'https://a.com/x'],
      ', then stop',
    ]);
    expect(shape('"https://a.com"')).toEqual(['"', ['https://a.com', 'https://a.com/'], '"']);
  });

  it('balances brackets so wrapped and wiki-style URLs both work', () => {
    expect(shape('(https://example.com/x)')).toEqual(['(', ['https://example.com/x', 'https://example.com/x'], ')']);
    expect(hrefs('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  it('does not link filenames or version numbers', () => {
    expect(links('run main.js, notes.sh, tags.py and script.rs')).toEqual([]);
    expect(links('bumped to 1.2.3 today')).toEqual([]);
    expect(links('see foo.com.zzz')).toEqual([]);
  });

  it('does not link the host half of an email address', () => {
    expect(links('mail nj@puter.com please')).toEqual([]);
  });

  it('never produces a non-http scheme', () => {
    for (const text of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(document.domain)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(links(text)).toEqual([]);
    }
    for (const p of linkify('mixed javascript:alert(1) and https://ok.com')) {
      if (p.type === 'link') expect(p.href).toMatch(/^https?:\/\//);
    }
  });

  it('links only the http part of an exotic scheme', () => {
    // Not a blob: href, just the plain https URL the text spells out.
    expect(hrefs('blob:https://example.com/uuid')).toEqual(['https://example.com/uuid']);
  });

  it('refuses URLs that hide their real host', () => {
    // Credentials: reads as puter.com, resolves to evil.test.
    expect(links('https://puter.com@evil.test/login')).toEqual([]);
    expect(links('https://user:pw@evil.test/')).toEqual([]);
    // Bidi overrides can make link text render as a different host.
    expect(links('https://example.com/‮gnp.exe')).toEqual([]);
  });

  it('resolves lookalike hosts to punycode in the href', () => {
    const [link] = links('https://аpple.com/login'); // Cyrillic "а"
    expect(link.href).toBe('https://xn--pple-43d.com/login');
    expect(link.text).toBe('https://аpple.com/login');
  });

  it('drops malformed candidates instead of linking them', () => {
    expect(links('example.com:99999999/x')).toEqual([]);
    expect(links('http://')).toEqual([]);
  });

  it('caps the number of links per message', () => {
    expect(links('a.com '.repeat(200))).toHaveLength(100);
    expect(linkify('a.com '.repeat(200)).map((p) => p.text).join('')).toBe('a.com '.repeat(200));
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    for (const text of ['a.'.repeat(2000), 'a-'.repeat(1000) + '.com', 'a'.repeat(4000)]) {
      expect(links(text)).toEqual([]);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('tolerates non-string input', () => {
    expect(linkify(null)).toEqual([]);
    expect(linkify(undefined)).toEqual([]);
    expect(shape(42)).toEqual(['42']);
  });
});
