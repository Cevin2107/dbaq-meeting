import { el } from './dom.js';
import { icon } from './icons.js';

const DEFAULT_DURATION = 4000;
const MAX_VISIBLE = 4;

/**
 * Show a transient toast. Returns a function that dismisses it early.
 *
 * Toasts are normally pass-through — they land over the control bar's
 * popovers, and a picker you can see but can't press is worse than one
 * that's covered. Pass `onClick` to make this one toast a button instead:
 * it takes pointer events, is keyboard-reachable, and dismisses itself
 * once pressed.
 * @param {string} message
 * @param {{icon?: string, duration?: number, onClick?: () => void}} [opts]
 */
export function toast(message, opts = {}) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};

  while (host.children.length >= MAX_VISIBLE) host.firstChild.remove();

  const clickable = typeof opts.onClick === 'function';
  const node = el(
    clickable ? 'button' : 'div',
    { class: clickable ? 'toast clickable' : 'toast', type: clickable ? 'button' : null },
    opts.icon ? icon(opts.icon) : null,
    // Its own box, so a long unbroken run (a pasted link in a chat preview)
    // can be told to wrap instead of running out of the toast.
    el('span', { class: 'toast-text' }, message)
  );
  host.append(node);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 250);
  };
  if (clickable) {
    node.addEventListener('click', () => {
      if (removed) return; // already leaving — don't fire twice
      remove();
      opts.onClick();
    });
  }
  setTimeout(remove, opts.duration ?? DEFAULT_DURATION);
  return remove;
}
