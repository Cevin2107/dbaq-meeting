/**
 * Give jsdom tests a working `localStorage`.
 *
 * Node 22+ ships its own `localStorage` global. Vitest's jsdom environment
 * copies the jsdom window onto the Node global but skips any key that is
 * already there, so `window.localStorage` resolves to Node's object instead
 * of jsdom's Storage — and without `--localstorage-file` that object has none
 * of the Storage methods. Every `localStorage` call in the app then throws
 * (silently, since prefs.js guards them), and the theme suite fails outright.
 *
 * Install a real in-memory Storage whenever what's there isn't usable. On a
 * Node old enough to leave the global alone, jsdom's own Storage survives and
 * this is a no-op.
 */

function memoryStorage() {
  const entries = new Map();
  const storage = {
    getItem: (key) => (entries.has(String(key)) ? entries.get(String(key)) : null),
    setItem: (key, value) => void entries.set(String(key), String(value)),
    removeItem: (key) => void entries.delete(String(key)),
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
  };
  Object.defineProperty(storage, 'length', { get: () => entries.size });
  return storage;
}

for (const name of ['localStorage', 'sessionStorage']) {
  if (typeof globalThis[name]?.getItem === 'function' && typeof globalThis[name]?.clear === 'function') continue;
  Object.defineProperty(globalThis, name, {
    value: memoryStorage(),
    writable: true,
    configurable: true,
  });
}
