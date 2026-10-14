import { Emitter } from './emitter.js';

/**
 * A tiny reactive key-value store. Views subscribe to specific keys
 * (or '*') and re-render when values change.
 */
export class Store extends Emitter {
  #state;

  constructor(initial = {}) {
    super();
    this.#state = { ...initial };
  }

  get(key) {
    return this.#state[key];
  }

  /** Snapshot of the full state (shallow copy). */
  snapshot() {
    return { ...this.#state };
  }

  /**
   * Set one or more keys. Only keys whose value actually changed
   * (by Object.is) fire change events.
   * @param {Record<string, any>} patch
   */
  set(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (Object.is(this.#state[key], value)) continue;
      this.#state[key] = value;
      changed.push(key);
    }
    for (const key of changed) this.emit(key, this.#state[key]);
    if (changed.length) this.emit('*', { keys: changed, state: this.snapshot() });
    return changed;
  }

  /**
   * Update a key with a function of its previous value.
   */
  update(key, fn) {
    this.set({ [key]: fn(this.get(key)) });
  }

  /**
   * Subscribe to a key and invoke immediately with the current value.
   */
  watch(key, fn) {
    fn(this.get(key));
    return this.on(key, fn);
  }
}
