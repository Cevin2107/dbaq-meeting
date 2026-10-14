import { el } from './dom.js';
import { icon } from './icons.js';
import { trapFocus } from './focus.js';
import { toast } from './toast.js';
import { getPref, prefsReady, setPref } from '../lib/prefs.js';
import { sanitizeName } from '../lib/protocol.js';

/** The same nickname editor before and during a call. */
export function nicknameField({ ctx, session }) {
  const input = el('input', {
    type: 'text', 'aria-label': 'Nickname', placeholder: 'Your name',
    maxlength: '60', autocomplete: 'nickname',
    value: session?.name ?? getPref('name') ?? ctx.getUserName?.() ?? '',
  });
  const save = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save nickname');
  const update = () => {
    save.disabled = !input.value.trim();
  };
  let edited = false;
  input.addEventListener('input', () => { edited = true; update(); });
  update();
  const form = el(
    'form',
    {
      class: 'nickname-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        const name = sanitizeName(input.value);
        session?.setName(name);
        setPref('name', name);
        ctx.setUserName?.(name);
        input.value = name;
        edited = true;
        toast('Nickname saved', { icon: 'check' });
      },
    },
    el('label', {}, el('span', { class: 'field-label' }, 'Nickname'), el('div', { class: 'text-field' }, input)),
    el('p', { class: 'nickname-hint' }, 'Shown to everyone in your meeting and remembered for future meetings.'),
    save
  );
  void prefsReady().then(() => {
    if (session || edited || !form.isConnected) return;
    input.value = getPref('name') ?? ctx.getUserName?.() ?? '';
    update();
  });
  return form;
}

/** Home settings do not acquire devices just to edit a nickname. */
export function openHomeSettings(root, ctx, opener) {
  const close = () => backdrop.remove();
  const dialog = el(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings', tabindex: '-1' },
    el('div', { class: 'dialog-header' }, el('h2', {}, 'Settings'),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))),
    el('div', { class: 'dialog-body' }, nicknameField({ ctx }))
  );
  let pressedBackdrop = false;
  const backdrop = el('div', {
    class: 'dialog-backdrop',
    onpointerdown: (e) => { pressedBackdrop = e.target === backdrop; },
    onclick: (e) => { if (pressedBackdrop && e.target === backdrop) close(); },
    onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } },
  }, dialog);
  root.append(backdrop);
  trapFocus(dialog, { restoreTo: opener });
  dialog.querySelector('input').focus();
  return close;
}
