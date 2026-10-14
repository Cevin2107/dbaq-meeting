import { el } from './dom.js';

/** The app icon itself. The 128px source keeps it sharp in the 32px slot on retina screens. */
export function brandMark() {
  return el('img', {
    src: '/icons/icon-128.png',
    alt: '',
    width: 32,
    height: 32,
    decoding: 'async',
  });
}

/** Icon and wordmark — the header lock-up shared by the home and post-call screens. */
export function brandLockup() {
  return el(
    'div',
    { class: 'home-brand' },
    brandMark(),
    el('span', { class: 'home-wordmark' }, el('b', {}, 'ĐBAQ'), ' Meeting')
  );
}
