/**
 * Minimal event emitter used across networking and UI layers.
 */
export class Emitter {
  #listeners = new Map();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @param {string} event
   * @param {(payload: any) => void} fn
   */
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /** Subscribe to a single occurrence of an event. */
  once(event, fn) {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const fns = this.#listeners.get(event);
    if (!fns) return;
    for (const fn of [...fns]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[emitter] listener for "${event}" threw`, err);
      }
    }
  }

  removeAllListeners() {
    this.#listeners.clear();
  }
}
