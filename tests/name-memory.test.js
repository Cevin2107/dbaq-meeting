// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/*
 * The green room remembers the name from the last join and prefills it.
 * The order matters: a name the user entered (local, or synced down from
 * puter.kv on a device that has never joined here) outranks the Puter
 * account username, which is only a fallback.
 */

/** Enough of MediaStream for LocalMedia to construct in jsdom. */
class FakeMediaStream {
  #tracks = [];
  getTracks() {
    return this.#tracks;
  }
  getAudioTracks() {
    return [];
  }
  getVideoTracks() {
    return [];
  }
  addTrack() {}
  removeTrack() {}
}

function fakePuter({ username = 'ada-42', signedIn = true, kv = {} } = {}) {
  return {
    auth: {
      isSignedIn: () => signedIn,
      getUser: async () => ({ username }),
    },
    kv: {
      get: async (key) => (key in kv ? kv[key] : null),
      set: async () => true,
      del: async () => true,
    },
  };
}

let mountPrejoin;
let prefs;
let dispose = null;
let root;

const ctx = {
  getUserName: () => prefs.getPref('name') ?? null,
  setUserName: vi.fn(),
  goHome: vi.fn(),
  startCall: vi.fn(),
};

const nameField = () => root.querySelector('.prejoin-side input[type="text"]');

beforeEach(async () => {
  localStorage.clear();
  delete window.puter;
  globalThis.MediaStream = FakeMediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: () => Promise.reject(new Error('no devices in jsdom')),
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
  });

  // prefs.js memoizes the cloud pull, so each case needs a fresh module graph.
  vi.resetModules();
  prefs = await import('../src/lib/prefs.js');
  ({ mountPrejoin } = await import('../src/ui/prejoin.js'));

  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  root.remove();
});

function mount(params = { mode: 'create' }) {
  dispose = mountPrejoin(root, params, ctx);
}

describe('green room name memory', () => {
  it('prefills the name entered last time', () => {
    prefs.setLocalPref('name', 'Ada Lovelace');
    mount();
    expect(nameField().value).toBe('Ada Lovelace');
    expect(root.querySelector('.prejoin-name-tag').textContent).toBe('Ada Lovelace');
  });

  it('starts empty when nothing is remembered', () => {
    mount();
    expect(nameField().value).toBe('');
  });

  it('prefers a cloud-remembered name over the account username', async () => {
    window.puter = fakePuter({ kv: { 'meet:pref:name': JSON.stringify('Ada Lovelace') } });
    prefs.syncPrefsFromCloud(); // main.js kicks this off before routing
    mount();

    await vi.waitFor(() => expect(nameField().value).toBe('Ada Lovelace'));
  });

  it('falls back to the account username when nothing is remembered', async () => {
    window.puter = fakePuter();
    prefs.syncPrefsFromCloud();
    mount();

    await vi.waitFor(() => expect(nameField().value).toBe('ada-42'));
  });

  it('never overwrites a name the user is already typing', async () => {
    window.puter = fakePuter();
    prefs.syncPrefsFromCloud();
    mount();
    nameField().value = 'Grace';

    await new Promise((r) => setTimeout(r, 10));
    expect(nameField().value).toBe('Grace');
  });

  it('remembers the typed name even when the join fails', async () => {
    mount(); // no window.puter: the join cannot get off the ground
    nameField().value = '  Ada   Lovelace ';
    root.querySelector('.btn-primary').click();

    await vi.waitFor(() => expect(root.querySelector('.prejoin-error').textContent).not.toBe(''));
    // Sanitized the same way the meeting labels the tile, and stored locally
    // so the next attempt starts from it.
    expect(prefs.getPref('name')).toBe('Ada Lovelace');
  });

  it('does not remember an empty name', async () => {
    mount();
    root.querySelector('.btn-primary').click();

    expect(root.querySelector('.prejoin-error').textContent).toBe('Please enter your name.');
    expect(prefs.getPref('name')).toBeUndefined();
  });
});
