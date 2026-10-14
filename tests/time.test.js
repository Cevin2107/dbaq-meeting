import { describe, it, expect } from 'vitest';
import { formatClock, formatDuration, formatChatTime, formatDay } from '../src/lib/time.js';

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(5000)).toBe('00:05');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(20 * 60_000 + 9000)).toBe('20:09');
  });

  it('adds hours past 60 minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_600_000 + 65_000)).toBe('1:01:05');
    expect(formatDuration(10 * 3_600_000)).toBe('10:00:00');
  });

  it('clamps negative values', () => {
    expect(formatDuration(-5000)).toBe('00:00');
  });
});

describe('formatClock / formatDay', () => {
  it('formats a 12-hour clock in en-US', () => {
    const d = new Date(2026, 6, 14, 15, 45);
    expect(formatClock(d, 'en-US')).toMatch(/3:45\sPM/);
  });

  it('formats a short day', () => {
    const d = new Date(2026, 6, 14);
    expect(formatDay(d, 'en-US')).toBe('Tue, Jul 14');
  });
});

describe('formatChatTime', () => {
  it('shows only the time for same-day timestamps', () => {
    const now = new Date(2026, 6, 14, 18, 0).getTime();
    const ts = new Date(2026, 6, 14, 9, 30).getTime();
    expect(formatChatTime(ts, now, 'en-US')).toMatch(/9:30\sAM/);
    expect(formatChatTime(ts, now, 'en-US')).not.toContain('Jul');
  });

  it('includes the day for older timestamps', () => {
    const now = new Date(2026, 6, 14, 18, 0).getTime();
    const ts = new Date(2026, 6, 13, 9, 30).getTime();
    expect(formatChatTime(ts, now, 'en-US')).toContain('Jul 13');
  });
});
