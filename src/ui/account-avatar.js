import { el } from './dom.js';
import { initials, colorFor } from '../lib/names.js';

// Keep only the most recently used account, and refresh after five minutes.
const CACHE_KEY = 'pm.profile-picture.v1';
const MAX_AGE = 5 * 60 * 1000;

export function accountAvatar() {
  return el('div', {
    class: 'avatar is-loading',
    'aria-busy': 'true',
    'aria-label': 'Loading profile picture',
    role: 'img',
  });
}

export async function loadAccountAvatar(avatar, user, auth) {
  const name = user?.username ?? 'You';
  const account = user?.uuid ?? user?.id ?? user?.username;
  avatar.title = `Signed in as ${name}`;
  let cache;
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (account && stored?.account === account &&
        Number.isFinite(stored.savedAt) && Date.now() - stored.savedAt < 24 * 60 * 60 * 1000 &&
        (stored.picture === null || validPicture(stored.picture))) cache = stored;
  } catch { /* Storage is optional. */ }

  const remember = (picture) => {
    if (!account) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ account, picture, savedAt: Date.now() }));
    } catch { /* Storage may be unavailable or full. */ }
  };
  const ready = () => {
    avatar.classList.remove('is-loading');
    avatar.removeAttribute('aria-busy');
    avatar.setAttribute('aria-label', `Signed in as ${name}`);
  };
  const fallback = () => {
    avatar.textContent = initials(name);
    avatar.style.background = colorFor(name);
    ready();
  };
  const show = async (picture) => {
    const image = new Image();
    image.alt = '';
    await withTimeout(new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = picture;
    }));
    image.onload = image.onerror = null;
    avatar.replaceChildren(image);
    avatar.style.background = '';
    ready();
  };

  let hasPicture = false;
  if (cache?.picture) {
    try {
      await show(cache.picture);
      hasPicture = true;
    } catch { cache = null; }
  }
  if (cache && Date.now() - cache.savedAt >= 0 && Date.now() - cache.savedAt < MAX_AGE) {
    if (!hasPicture) fallback();
    return;
  }

  try {
    const picture = await withTimeout(Promise.resolve().then(() => auth.getProfilePicture?.()));
    if (validPicture(picture)) {
      if (!hasPicture || picture !== cache.picture) await show(picture);
      remember(picture);
    } else if (!hasPicture) {
      fallback();
      if (picture === null) remember(null);
    }
    // Puter also returns null on request failure; retain a cached picture
    // in that case rather than flashing initials during an outage.
  } catch {
    if (!hasPicture) fallback();
  }
}

function validPicture(picture) {
  return typeof picture === 'string' && picture.startsWith('data:image/');
}

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Picture timed out')), 8000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
