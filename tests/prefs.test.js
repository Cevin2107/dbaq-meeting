// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * Preferences live in localStorage and sync through puter.kv. The rule is
 * that the cloud only fills in blanks: a choice made on this device is
 * never replaced by one made on another.
 */

/** A puter double whose kv holds the given already-encoded entries. */
function fakePuter(kv = {}, { signedIn = true } = {}) {
  const writes = [];
  return {
    writes,
    auth: { isSignedIn: () => signedIn },
    kv: {
      get: async (key) => (key in kv ? kv[key] : null),
      set: async (key, value) => {
        writes.push([key, value]);
        return true;
      },
      del: async (key) => {
        writes.push([key, null]);
        return true;
      },
    },
  };
}

let prefs;

beforeEach(async () => {
  localStorage.clear();
  delete window.puter;
  vi.resetModules(); // the cloud pull is memoized per module instance
  prefs = await import('../src/lib/prefs.js');
});

describe('preferences', () => {
  it('round-trips a value through localStorage', () => {
    prefs.setLocalPref('micId', 'abc');
    expect(prefs.getPref('micId')).toBe('abc');
    expect(prefs.hasLocalPref('micId')).toBe(true);
  });

  it('reports an absent key as unset', () => {
    expect(prefs.hasLocalPref('micId')).toBe(false);
    expect(prefs.getPref('micId', 'fallback')).toBe('fallback');
  });

  it('clearing a value removes the entry entirely', () => {
    prefs.setLocalPref('micId', 'abc');
    prefs.setLocalPref('micId', null);
    expect(prefs.hasLocalPref('micId')).toBe(false);
  });

  it('fills in only the preferences this device has never set', async () => {
    prefs.setLocalPref('micId', 'mine');
    window.puter = fakePuter({
      'meet:pref:micId': JSON.stringify('theirs'),
      'meet:pref:camId': JSON.stringify('theirs'),
    });
    await prefs.syncPrefsFromCloud();
    expect(prefs.getPref('micId')).toBe('mine'); // untouched
    expect(prefs.getPref('camId')).toBe('theirs'); // filled in
  });

  it('keeps the theme this device chose when another device chose differently', async () => {
    prefs.setThemePref('dark');
    window.puter = fakePuter({ 'meet:pref:theme': JSON.stringify('light') });
    await prefs.syncPrefsFromCloud();
    expect(prefs.getThemePref()).toBe('dark');
  });

  it('keeps a theme stored by an older build, whose format it cannot parse', async () => {
    localStorage.setItem('pm.theme', 'dark'); // the bare form we used to write
    window.puter = fakePuter({ 'meet:pref:theme': JSON.stringify('light') });
    await prefs.syncPrefsFromCloud();
    expect(prefs.getThemePref()).toBe('dark');
  });

  it('pulls the cloud theme onto a device that has never chosen one', async () => {
    window.puter = fakePuter({ 'meet:pref:theme': JSON.stringify('dark') });
    await prefs.syncPrefsFromCloud();
    expect(prefs.getThemePref()).toBe('dark');
  });

  it('pulls once however many callers ask', async () => {
    window.puter = fakePuter({ 'meet:pref:camId': JSON.stringify('theirs') });
    let gets = 0;
    const inner = window.puter.kv.get;
    window.puter.kv.get = (key) => {
      gets++;
      return inner(key);
    };
    await Promise.all([prefs.syncPrefsFromCloud(), prefs.syncPrefsFromCloud()]);
    await prefs.syncPrefsFromCloud();
    expect(gets).toBe(prefs.PREF_KEYS.length);
  });

  it('does not touch kv while signed out', async () => {
    const puter = fakePuter({ 'meet:pref:camId': JSON.stringify('theirs') }, { signedIn: false });
    window.puter = puter;
    await prefs.syncPrefsFromCloud();
    prefs.setPref('camId', 'mine');
    expect(puter.writes).toEqual([]);
    expect(prefs.getPref('camId')).toBe('mine'); // still stored locally
  });

  it('prefsReady resolves even when no pull was started', async () => {
    await expect(prefs.prefsReady()).resolves.toBeUndefined();
  });
});
