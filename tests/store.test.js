import { describe, it, expect, vi } from 'vitest';
import { Store } from '../src/lib/store.js';
import { Emitter } from '../src/lib/emitter.js';

describe('Emitter', () => {
  it('subscribes, emits, and unsubscribes', () => {
    const em = new Emitter();
    const fn = vi.fn();
    const off = em.on('x', fn);
    em.emit('x', 1);
    off();
    em.emit('x', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('once fires a single time', () => {
    const em = new Emitter();
    const fn = vi.fn();
    em.once('x', fn);
    em.emit('x');
    em.emit('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('isolates listener errors', () => {
    const em = new Emitter();
    const good = vi.fn();
    em.on('x', () => {
      throw new Error('boom');
    });
    em.on('x', good);
    expect(() => em.emit('x')).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});

describe('Store', () => {
  it('gets initial values and snapshots', () => {
    const store = new Store({ a: 1 });
    expect(store.get('a')).toBe(1);
    expect(store.snapshot()).toEqual({ a: 1 });
  });

  it('emits per-key events only on change', () => {
    const store = new Store({ a: 1 });
    const fn = vi.fn();
    store.on('a', fn);
    store.set({ a: 1 }); // no change
    expect(fn).not.toHaveBeenCalled();
    store.set({ a: 2 });
    expect(fn).toHaveBeenCalledWith(2);
  });

  it('emits a wildcard event with changed keys', () => {
    const store = new Store({ a: 1, b: 2 });
    const fn = vi.fn();
    store.on('*', fn);
    store.set({ a: 9, b: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].keys).toEqual(['a']);
  });

  it('update applies a function of the previous value', () => {
    const store = new Store({ n: 1 });
    store.update('n', (n) => n + 1);
    expect(store.get('n')).toBe(2);
  });

  it('watch invokes immediately and on change', () => {
    const store = new Store({ a: 'x' });
    const fn = vi.fn();
    store.watch('a', fn);
    expect(fn).toHaveBeenCalledWith('x');
    store.set({ a: 'y' });
    expect(fn).toHaveBeenLastCalledWith('y');
  });
});
