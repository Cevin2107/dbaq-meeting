import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startOfDay, startOfWeek, weekDays, onDay, windowFor, nextDayStart, addDays } from '../src/lib/agenda.js';

/*
 * Chile moves its clocks forward at midnight: on the first Sunday of
 * September 00:00 does not exist, and the day starts at 01:00. Every
 * "day start" the panel compares has to come out of the same function for
 * such a day, or the week strip finds no day equal to today, and none to
 * the selected one.
 */

let savedTZ;
beforeAll(() => {
  savedTZ = process.env.TZ;
  process.env.TZ = 'America/Santiago';
});
afterAll(() => {
  if (savedTZ === undefined) delete process.env.TZ;
  else process.env.TZ = savedTZ;
});

const local = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();

describe('day math across a midnight clock change', () => {
  it('the environment moves the clock at midnight on 6 Sep 2026', () => {
    // Sanity check on the zone data this suite relies on.
    const gapDay = new Date(2026, 8, 6, 0, 0, 0, 0);
    expect(gapDay.getHours()).toBe(1);
    expect(new Date(2026, 8, 7, 0, 0, 0, 0).getHours()).toBe(0);
  });

  it('every day of the week compares equal to startOfDay of that day', () => {
    const ws = startOfWeek(local(2026, 8, 9), 0); // the week of Sun 6 Sep
    expect(ws).toBe(startOfDay(local(2026, 8, 6)));
    const days = weekDays(ws);
    expect(days).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      expect(days[i]).toBe(startOfDay(local(2026, 8, 6 + i)));
    }
    // Monday the 7th starts at a real midnight — not an hour after it.
    expect(new Date(days[1]).getHours()).toBe(0);
  });

  it('a week starting on a normal day still lines up when it reaches the gap day', () => {
    const ws = startOfWeek(local(2026, 8, 3), 1); // Monday-first: Mon 31 Aug … Sun 6 Sep
    expect(weekDays(ws)[6]).toBe(startOfDay(local(2026, 8, 6)));
  });

  it('a day’s meetings are the ones between its start and the next day’s start', () => {
    const gapDayStart = startOfDay(local(2026, 8, 6));
    expect(nextDayStart(gapDayStart)).toBe(startOfDay(local(2026, 8, 7)));
    // Raw addDays from 01:00 would have said 01:00 the next day.
    expect(addDays(gapDayStart, 1)).not.toBe(nextDayStart(gapDayStart));
    const early = { id: 'a', start: new Date(2026, 8, 7, 0, 30).getTime(), end: new Date(2026, 8, 7, 1, 0).getTime(), allDay: false };
    expect(onDay([early], gapDayStart)).toEqual([]);
    expect(onDay([early], nextDayStart(gapDayStart))).toEqual([early]);
  });

  it('read windows end on a day start', () => {
    const todayWeek = startOfWeek(local(2026, 7, 12), 0); // Sun 9 Aug
    const w = windowFor(todayWeek, todayWeek);
    expect(w.to).toBe(startOfDay(local(2026, 8, 6)));
    expect(windowFor(startOfWeek(local(2026, 8, 6), 0), todayWeek).to).toBe(startOfDay(local(2026, 8, 13)));
  });
});
