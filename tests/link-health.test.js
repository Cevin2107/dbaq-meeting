import { describe, it, expect, vi } from 'vitest';
import { LinkHealth } from '../src/lib/link-health.js';

/*
 * The one line the meeting info panel shows a host about the link: fed by
 * the room lease's every write (src/lib/rooms.js) and by the moments the
 * invite changes, and worded only when the words change.
 */

function watched() {
  const health = new LinkHealth();
  const changes = [];
  health.on('change', (snapshot) => changes.push(snapshot));
  return { health, changes };
}

describe('the link’s health', () => {
  it('is nothing for a guest, refreshing for a host nothing has been written for, and working once a write lands', () => {
    const { health } = watched();
    expect(health.state).toBeNull();
    expect(health.snapshot()).toBeNull();
    health.role({ host: true });
    expect(health.state).toBe('refreshing');
    health.beat({ ok: true });
    expect(health.state).toBe('working');
    expect(health.snapshot()).toMatchObject({ label: 'Working' });
  });

  it('is refreshing from the moment the invite changes until the next write lands', () => {
    const { health } = watched();
    health.role({ host: true });
    health.beat({ ok: true });
    health.codeChanged();
    expect(health.state).toBe('refreshing');
    expect(health.snapshot().label).toBe('Refreshing…');
    health.beat({ ok: true });
    expect(health.state).toBe('working');
  });

  it('is failing while writes fail, and working again once one lands', () => {
    const { health } = watched();
    health.role({ host: true });
    health.beat({ ok: true });
    health.beat({ ok: false });
    expect(health.state).toBe('failing');
    expect(health.snapshot()).toMatchObject({ label: 'Can’t be updated' });
    expect(health.snapshot().detail).toMatch(/ask them to reopen the link/);
    health.beat({ ok: false });
    expect(health.state).toBe('failing');
    health.beat({ ok: true });
    expect(health.state).toBe('working');
  });

  it('says when another meeting holds the link, until a write of ours stands', () => {
    const { health } = watched();
    health.role({ host: true });
    health.beat({ ok: false, held: true });
    expect(health.state).toBe('held');
    expect(health.snapshot()).toMatchObject({ label: 'In use by another meeting' });
    expect(health.snapshot().detail).toMatch(/carries on for everyone in it/);
    health.beat({ ok: true });
    expect(health.state).toBe('working');
  });

  it('follows the host role as it moves', () => {
    const { health, changes } = watched();
    health.role({ host: true });
    health.beat({ ok: false });
    expect(health.state).toBe('failing');
    health.role({ host: false });
    expect(health.state).toBeNull();
    expect(changes.at(-1)).toBeNull();
    // Back as host: a clean slate — nothing of ours has been written yet.
    health.role({ host: true });
    expect(health.state).toBe('refreshing');
  });

  it('announces a change only when the words change', () => {
    const { health, changes } = watched();
    health.role({ host: true });
    expect(changes).toHaveLength(1);
    health.beat({ ok: true });
    health.beat({ ok: true });
    health.beat({ ok: true });
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ state: 'working' });
    health.role({ host: false });
    health.role({ host: false });
    expect(changes).toHaveLength(3);
    expect(changes[2]).toBeNull();
    const spy = vi.fn();
    health.on('change', spy);
    health.beat({ ok: true }); // a guest: still nothing to say
    expect(spy).not.toHaveBeenCalled();
  });
});
