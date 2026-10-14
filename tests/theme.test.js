// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setTheme, chosenTheme, effectiveTheme, toggleTheme, initTheme } from '../src/ui/theme.js';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  // jsdom has no matchMedia; stub a light-preferring system.
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
});

/** index.html's pre-paint boot script, verbatim in behaviour. */
function bootScriptTheme() {
  const t = (localStorage.getItem('pm.theme') || '').replace(/"/g, '');
  return t === 'light' || t === 'dark' ? t : null;
}

describe('theme', () => {
  it('defaults to following the system', () => {
    expect(chosenTheme()).toBeNull();
    expect(effectiveTheme()).toBe('light');
  });

  it('follows a dark system preference', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    expect(effectiveTheme()).toBe('dark');
  });

  it('setTheme stamps the html element and persists', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(chosenTheme()).toBe('dark');
    // What index.html's pre-paint boot script makes of the stored value:
    // it strips quotes, so the JSON form every other preference uses is
    // exactly as readable to it as a bare string.
    expect(bootScriptTheme()).toBe('dark');
  });

  it('setTheme(null) clears the stored choice for the boot script too', () => {
    setTheme('dark');
    setTheme(null);
    expect(localStorage.getItem('pm.theme')).toBeNull();
    expect(bootScriptTheme()).toBeNull();
  });

  it('initTheme applies a theme stored by an older build', () => {
    localStorage.setItem('pm.theme', 'dark'); // the bare form we used to write
    initTheme();
    expect(chosenTheme()).toBe('dark');
  });

  it('setTheme(null) reverts to system', () => {
    setTheme('dark');
    setTheme(null);
    expect(chosenTheme()).toBeNull();
    expect(effectiveTheme()).toBe('light');
  });

  it('toggleTheme flips the effective theme', () => {
    expect(effectiveTheme()).toBe('light');
    expect(toggleTheme()).toBe('dark');
    expect(effectiveTheme()).toBe('dark');
    expect(toggleTheme()).toBe('light');
    expect(effectiveTheme()).toBe('light');
  });

  it('initTheme applies the persisted choice', () => {
    setTheme('dark');
    delete document.documentElement.dataset.theme;
    initTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('initTheme ignores garbage values', () => {
    localStorage.setItem('pm.theme', 'banana');
    initTheme();
    expect(chosenTheme()).toBeNull();
  });
});
