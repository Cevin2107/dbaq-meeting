import { describe, it, expect, vi } from 'vitest';
import { Roster } from '../src/lib/roster.js';

describe('Roster', () => {
  it('adds participants with defaults and emits add', () => {
    const roster = new Roster();
    const onAdd = vi.fn();
    roster.on('add', onAdd);
    const p = roster.add({ id: 'a', name: 'Ada' });
    expect(p).toMatchObject({ id: 'a', name: 'Ada', mic: false, cam: false, hand: false, speaking: false });
    expect(onAdd).toHaveBeenCalledOnce();
    expect(roster.size).toBe(1);
  });

  it('treats re-adding an existing id as an update', () => {
    const roster = new Roster();
    roster.add({ id: 'a', name: 'Ada' });
    roster.add({ id: 'a', name: 'Ada L.', mic: true });
    expect(roster.size).toBe(1);
    expect(roster.get('a')).toMatchObject({ name: 'Ada L.', mic: true });
  });

  it('emits update only when values change', () => {
    const roster = new Roster();
    roster.add({ id: 'a', name: 'Ada' });
    const onUpdate = vi.fn();
    roster.on('update', onUpdate);
    roster.update('a', { mic: false }); // unchanged
    expect(onUpdate).not.toHaveBeenCalled();
    roster.update('a', { mic: true });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('ignores undefined patch values', () => {
    const roster = new Roster();
    roster.add({ id: 'a', name: 'Ada', mic: true });
    roster.update('a', { mic: undefined, hand: true });
    expect(roster.get('a').mic).toBe(true);
    expect(roster.get('a').hand).toBe(true);
  });

  it('returns null when updating or removing unknown ids', () => {
    const roster = new Roster();
    expect(roster.update('nope', { mic: true })).toBeNull();
    expect(roster.remove('nope')).toBeNull();
  });

  it('removes participants and emits remove', () => {
    const roster = new Roster();
    roster.add({ id: 'a', name: 'Ada' });
    const onRemove = vi.fn();
    roster.on('remove', onRemove);
    const p = roster.remove('a');
    expect(p.id).toBe('a');
    expect(roster.size).toBe(0);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('sorts self first, then by join time', () => {
    const roster = new Roster();
    roster.add({ id: 'b', name: 'Bob', joinedAt: 100 });
    roster.add({ id: 'me', name: 'Me', isSelf: true, joinedAt: 200 });
    roster.add({ id: 'c', name: 'Cy', joinedAt: 150 });
    expect(roster.sorted().map((p) => p.id)).toEqual(['me', 'b', 'c']);
    expect(roster.others().map((p) => p.id)).toEqual(['b', 'c']);
    expect(roster.self().id).toBe('me');
  });

  it('lists raised hands', () => {
    const roster = new Roster();
    roster.add({ id: 'a', name: 'A', hand: true, joinedAt: 1 });
    roster.add({ id: 'b', name: 'B', joinedAt: 2 });
    roster.add({ id: 'c', name: 'C', hand: true, joinedAt: 3 });
    expect(roster.raisedHands().map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('clear removes everyone with events', () => {
    const roster = new Roster();
    roster.add({ id: 'a', name: 'A' });
    roster.add({ id: 'b', name: 'B' });
    const onRemove = vi.fn();
    roster.on('remove', onRemove);
    roster.clear();
    expect(roster.size).toBe(0);
    expect(onRemove).toHaveBeenCalledTimes(2);
  });
});
