// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mountHome } from '../src/ui/home.js';
import { getPref, setLocalPref } from '../src/lib/prefs.js';
import { makeState, encode, parse } from '../src/lib/protocol.js';

let root, unmount, ctx;
beforeEach(() => {
  localStorage.clear();
  delete window.puter;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  root = document.createElement('div');
  document.body.append(root);
  ctx = { getUserName: () => getPref('name'), setUserName: vi.fn() };
});
afterEach(() => { unmount?.(); root.remove(); document.querySelector('#toasts')?.remove(); });

it('lets a signed-out user change their saved nickname from home settings', () => {
  setLocalPref('name', 'Old name');
  unmount = mountHome(root, ctx);
  root.querySelector('[aria-label="Settings"]').click();
  const input = root.querySelector('[aria-label="Nickname"]');
  expect(input.value).toBe('Old name');
  input.value = '  Ada   Lovelace  ';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  root.querySelector('button[type="submit"]').click();
  expect(getPref('name')).toBe('Ada Lovelace');
  expect(ctx.setUserName).toHaveBeenCalledWith('Ada Lovelace');
  root.querySelector('[aria-label="Close"]').click();
  root.querySelector('[aria-label="Settings"]').click();
  expect(root.querySelector('[aria-label="Nickname"]').value).toBe('Ada Lovelace');
});

it('rejects a blank nickname and discards an unsaved edit on Escape', async () => {
  setLocalPref('name', 'Ada');
  unmount = mountHome(root, ctx);
  const opener = root.querySelector('[aria-label="Settings"]');
  opener.click();
  const input = root.querySelector('[aria-label="Nickname"]');
  input.value = '   ';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(root.querySelector('button[type="submit"]').disabled).toBe(true);
  input.value = 'Unsaved';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  expect(getPref('name')).toBe('Ada');
  await Promise.resolve();
  expect(document.activeElement).toBe(opener);
});

it('preserves legacy state messages and sanitizes optional nicknames through relaying', () => {
  expect(parse(encode(makeState({ mic: true })))).not.toHaveProperty('name');
  expect(parse(encode(makeState({ name: '  Ada   Lovelace ' }))).name).toBe('Ada Lovelace');
  expect(parse(encode({ ...makeState({}), name: 42 }))).not.toHaveProperty('name');
});
