// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openBackgroundDialog, savedBackground } from '../src/ui/effects.js';
import { getPref, setLocalPref } from '../src/lib/prefs.js';
import { Emitter } from '../src/lib/emitter.js';

/*
 * Choosing a background applies it and remembers it. Applying is async —
 * an image has to load — so two quick choices are in flight at once, and
 * what gets remembered has to be what ended up applied.
 */

class FakeMedia extends Emitter {
  camOn = true;
  stream = { id: 's', getAudioTracks: () => [], getVideoTracks: () => [] };
  #background = { type: 'none' };
  /** Resolvers for each in-flight setBackground, in call order. */
  pending = [];

  get background() {
    return this.#background;
  }

  setBackground = vi.fn((spec) => {
    return new Promise((resolve) => {
      this.pending.push(() => {
        // The engine settles on whichever spec was requested last, exactly
        // as BackgroundEffect.setSpec does with its own sequence guard.
        this.#background = this.latest;
        resolve(true);
      });
      this.latest = spec;
    });
  });
}

let media;

const tileFor = (label) => document.querySelector(`.bg-tile[aria-label="${label}"]`);

beforeEach(() => {
  localStorage.clear();
  globalThis.MutationObserver ??= class {
    observe() {}
    disconnect() {}
  };
  // jsdom's play() is a "not implemented" stub returning undefined.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  media = new FakeMedia();
  openBackgroundDialog({ media });
});

afterEach(() => {
  document.querySelector('.dialog-backdrop')?.remove();
});

describe('background chooser', () => {
  it('remembers a single choice', async () => {
    tileFor('Forest').click();
    media.pending.forEach((fn) => fn());
    await vi.waitFor(() => expect(getPref('background')).toEqual({ type: 'image', id: 'forest' }));
  });

  it('remembers the background that actually ended up applied', async () => {
    tileFor('Blur').click();
    tileFor('Forest').click(); // a quick second thought

    // The first request settles last — a cached image resolving out of order.
    const [first, second] = media.pending;
    second();
    first();

    await vi.waitFor(() => expect(getPref('background')).not.toBeUndefined());
    // Whatever is on screen is what the next session must start from.
    expect(media.background).toMatchObject({ type: 'image', id: 'forest' });
    expect(getPref('background')).toEqual({ type: 'image', id: 'forest' });
  });

  it('stores nothing when applying fails', async () => {
    media.setBackground = vi.fn(async () => false);
    tileFor('Lake').click();
    await vi.waitFor(() => expect(media.setBackground).toHaveBeenCalled());
    expect(getPref('background')).toBeUndefined();
  });

  it('round-trips through savedBackground', async () => {
    tileFor('Lake').click();
    media.pending.forEach((fn) => fn());
    await vi.waitFor(() => expect(getPref('background')).not.toBeUndefined());
    expect(savedBackground()).toMatchObject({ type: 'image', id: 'lake' });
  });

  it('drops a remembered custom image that this device no longer holds', () => {
    setLocalPref('background', { type: 'image', id: 'custom' });
    expect(savedBackground()).toEqual({ type: 'none' });
  });
});
