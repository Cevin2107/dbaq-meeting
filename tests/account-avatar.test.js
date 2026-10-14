// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { accountAvatar, loadAccountAvatar } from '../src/ui/account-avatar.js';

const picture = 'data:image/png;base64,cGljdHVyZQ==';
const user = { uuid: 'ada', username: 'Ada Lovelace' };
let images;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  localStorage.clear();
  images = [];
  vi.stubGlobal('Image', function () {
    const image = document.createElement('img');
    images.push(image);
    return image;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows only shimmer until lookup and image loading both finish, then reuses the cache', async () => {
  let resolve;
  const auth = { getProfilePicture: vi.fn(() => new Promise(r => { resolve = r; })) };
  const avatar = accountAvatar();
  const pending = loadAccountAvatar(avatar, user, auth);
  await flush();
  expect(avatar.textContent).toBe('');
  expect(avatar.getAttribute('aria-busy')).toBe('true');
  resolve(picture);
  await flush();
  expect(avatar.textContent).toBe('');
  expect(avatar.querySelector('img')).toBeNull();
  images[0].dispatchEvent(new Event('load'));
  await pending;
  expect(avatar.querySelector('img').src).toBe(picture);
  expect(avatar.hasAttribute('aria-busy')).toBe(false);

  const next = accountAvatar();
  const cached = loadAccountAvatar(next, user, auth);
  images[1].dispatchEvent(new Event('load'));
  await cached;
  expect(next.querySelector('img').src).toBe(picture);
  expect(auth.getProfilePicture).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'rejected', 'broken', 'timeout'])('settles to initials for a %s picture', async (failure) => {
  vi.useFakeTimers();
  const auth = { getProfilePicture: vi.fn(() => {
    if (failure === 'rejected') return Promise.reject(new Error('offline'));
    if (failure === 'timeout') return new Promise(() => {});
    return Promise.resolve(failure === 'missing' ? null : picture);
  }) };
  const avatar = accountAvatar();
  const pending = loadAccountAvatar(avatar, user, auth);
  await flush();
  if (failure === 'broken') images[0].dispatchEvent(new Event('error'));
  if (failure === 'timeout') await vi.advanceTimersByTimeAsync(8000);
  await pending;
  expect(avatar.textContent).toBe('AL');
  expect(avatar.classList.contains('is-loading')).toBe(false);
});

it('isolates accounts and keeps a stale picture visible during refresh failure', async () => {
  localStorage.setItem('pm.profile-picture.v1', JSON.stringify({
    account: user.uuid, picture, savedAt: Date.now() - 6 * 60 * 1000,
  }));
  let resolve;
  const auth = { getProfilePicture: vi.fn(() => new Promise(r => { resolve = r; })) };
  const avatar = accountAvatar();
  const pending = loadAccountAvatar(avatar, user, auth);
  images[0].dispatchEvent(new Event('load'));
  await flush();
  expect(avatar.querySelector('img').src).toBe(picture);
  resolve(null);
  await pending;
  expect(avatar.querySelector('img').src).toBe(picture);

  const other = accountAvatar();
  const otherPending = loadAccountAvatar(other, { uuid: 'bob', username: 'Bob' }, auth);
  await flush();
  expect(other.querySelector('img')).toBeNull();
  expect(other.textContent).toBe('');
  resolve(null);
  await otherPending;
  expect(other.textContent).toBe('B');
});

it('still loads pictures when storage is unavailable', async () => {
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  try {
    const avatar = accountAvatar();
    const pending = loadAccountAvatar(avatar, user, { getProfilePicture: async () => picture });
    await flush();
    images[0].dispatchEvent(new Event('load'));
    await pending;
    expect(avatar.querySelector('img').src).toBe(picture);
  } finally { spy.mockRestore(); }
});
