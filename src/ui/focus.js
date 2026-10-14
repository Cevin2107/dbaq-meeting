/** Keyboard containment for modal dialogs — aria-modal promises it. */

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab inside `dialog` until it leaves the DOM, then hand focus back
 * to `restoreTo` (or whatever was focused when the trap was set). Cleanup
 * is automatic: every dismissal path removes the dialog node, which the
 * observer notices — so callers with several close paths (close button,
 * backdrop click, Escape, view teardown) need no bookkeeping.
 * @param {HTMLElement} dialog
 * @param {{restoreTo?: HTMLElement}} [opts]
 */
export function trapFocus(dialog, { restoreTo } = {}) {
  const previous = restoreTo ?? document.activeElement;

  const onKeydown = (e) => {
    if (e.key !== 'Tab' || !dialog.isConnected) return;
    // getClientRects() weeds out display:none controls (e.g. a hidden
    // file input) — focus() on those silently fails and breaks the wrap.
    const focusables = [...dialog.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.disabled && el.getClientRects().length > 0
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement;
    // Wrap at the edges, and pull focus in when it is outside the dialog
    // (or still on the container itself, which takes focus on open).
    const inside = dialog.contains(current) && current !== dialog;
    if (e.shiftKey && (!inside || current === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || current === last)) {
      e.preventDefault();
      first.focus();
    }
  };

  const observer = new MutationObserver(() => {
    if (dialog.isConnected) return;
    observer.disconnect();
    window.removeEventListener('keydown', onKeydown);
    // Skip the restore when the opener went away too (view unmounted).
    if (previous?.isConnected) previous.focus?.();
  });

  window.addEventListener('keydown', onKeydown);
  observer.observe(document.body, { childList: true, subtree: true });
}
