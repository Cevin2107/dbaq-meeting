import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { trapFocus } from './focus.js';
import { getPref, setPref, getLocalPref, setLocalPref } from '../lib/prefs.js';
import {
  BLUR_SLIGHT,
  BLUR_STRONG,
  CUSTOM_BACKGROUND_ID,
  PRESET_BACKGROUNDS,
  presetSrc,
  normalizeBackground,
  resolveBackground,
  storableBackground,
  sameBackground,
} from '../lib/backgrounds.js';

/**
 * Background effects (blur / virtual backgrounds) — chooser dialog shared
 * by the green room and the in-call More menu.
 */

const CUSTOM_IMAGE_KEY = 'bgImage'; // local-only: data URLs are too big for puter.kv
const MAX_CUSTOM_EDGE = 1920;

const BASE = import.meta.env.BASE_URL;

/** The persisted background choice, validated and ready to apply. */
export function savedBackground() {
  const customSrc = getLocalPref(CUSTOM_IMAGE_KEY);
  const spec = normalizeBackground(getPref('background'), { hasCustom: customSrc !== undefined });
  return resolveBackground(spec, { customSrc, base: BASE });
}

/** Kick off the model/WASM download without blocking anything. */
export function preloadBackgroundEngine() {
  import('../net/background-effect.js').then((m) => m.preloadBackgroundEngine()).catch(() => {});
}

/**
 * Open the background chooser over the current view. Applies changes
 * immediately through media.setBackground and persists the choice.
 * @param {{media: import('../net/media.js').LocalMedia}} deps
 */
export function openBackgroundDialog({ media }) {
  if (document.querySelector('.dialog-backdrop')) return;
  preloadBackgroundEngine();

  const video = el('video', { autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  video.srcObject = media.stream;
  const previewNote = el('div', { class: 'bg-preview-note' }, 'Camera is off. Effects apply when it’s back on');
  const preview = el('div', { class: 'bg-preview' }, video, previewNote);

  const grid = el('div', { class: 'bg-grid', role: 'group', 'aria-label': 'Background options' });

  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*',
    style: { display: 'none' },
    onchange: () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) addCustomImage(file);
    },
  });

  const backdrop = el(
    'div',
    {
      class: 'dialog-backdrop',
      onclick: (e) => {
        if (e.target === backdrop) backdrop.remove();
      },
    },
    el(
      'div',
      { class: 'dialog effects-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Change background', tabindex: '-1' },
      el(
        'div',
        { class: 'dialog-header' },
        el('h2', {}, 'Change background'),
        el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => backdrop.remove() }, icon('close'))
      ),
      el('div', { class: 'dialog-body' }, preview, grid, fileInput)
    )
  );

  // Cleanup must run however the dialog is dismissed — our close button,
  // a backdrop click, or the meeting view's own Escape handling, which
  // removes any .dialog-backdrop node directly.
  const disposers = [
    media.on('background', renderTiles),
    media.on('change', renderPreview),
    () => window.removeEventListener('keydown', onKeydown),
  ];
  const observer = new MutationObserver(() => {
    if (backdrop.isConnected) return;
    observer.disconnect();
    for (const dispose of disposers) dispose();
    video.srcObject = null;
  });
  window.addEventListener('keydown', onKeydown);

  renderTiles();
  renderPreview();
  document.body.append(backdrop);
  observer.observe(document.body, { childList: true });
  const dialog = backdrop.querySelector('.dialog');
  // Before focus moves onto the dialog — the trap restores focus to the
  // element focused now, and cleans itself up when the dialog closes.
  if (dialog) trapFocus(dialog);
  dialog?.focus();

  function onKeydown(e) {
    if (e.key === 'Escape') backdrop.remove();
  }

  function renderPreview() {
    const on = media.camOn;
    video.style.visibility = on ? 'visible' : 'hidden';
    previewNote.style.display = on ? 'none' : '';
    if (on) video.play?.().catch(() => {});
  }

  function renderTiles() {
    // Every rebuild throws away the button the keyboard was on, stranding
    // focus on <body> inside a focus-trapped dialog — and choosing a
    // background triggers a rebuild. Note where focus was, and put it back.
    const focused = grid.contains(document.activeElement)
      ? document.activeElement.getAttribute('aria-label')
      : null;
    clear(grid);
    grid.append(
      tile({
        spec: { type: 'none' },
        label: 'No effect',
        content: [icon('block')],
      }),
      tile({
        spec: { type: 'blur', blur: BLUR_SLIGHT },
        label: 'Slight blur',
        content: [icon('blurSlight')],
      }),
      tile({
        spec: { type: 'blur', blur: BLUR_STRONG },
        label: 'Blur',
        content: [icon('blur')],
      })
    );
    for (const preset of PRESET_BACKGROUNDS) {
      grid.append(
        tile({
          spec: resolveBackground({ type: 'image', id: preset.id }, { base: BASE }),
          label: preset.label,
          image: presetSrc(preset.id, BASE),
        })
      );
    }
    const customSrc = getLocalPref(CUSTOM_IMAGE_KEY);
    if (customSrc !== undefined) {
      grid.append(
        tile({
          spec: { type: 'image', id: CUSTOM_BACKGROUND_ID, src: customSrc },
          label: 'Your image',
          image: customSrc,
        })
      );
    }
    grid.append(
      el(
        'button',
        {
          class: 'bg-tile bg-tile-upload',
          title: 'Upload an image',
          'aria-label': customSrc !== undefined ? 'Replace image' : 'Add image',
          onclick: () => fileInput.click(),
        },
        icon('upload'),
        el('span', { class: 'bg-tile-label' }, customSrc !== undefined ? 'Replace image' : 'Add image')
      )
    );
    if (!focused) return;
    // The upload tile relabels itself once there is a custom image, so fall
    // back to whatever is selected now rather than losing focus anyway.
    const back = grid.querySelector(`[aria-label="${CSS.escape(focused)}"]`) ?? grid.querySelector('[aria-pressed="true"]');
    back?.focus();
  }

  function tile({ spec, label, content = [], image }) {
    const selected = sameBackground(media.background, spec);
    return el(
      'button',
      {
        class: 'bg-tile',
        title: label,
        'aria-label': label,
        'aria-pressed': selected ? 'true' : 'false',
        style: image ? { backgroundImage: `url("${image}")` } : undefined,
        onclick: () => choose(spec),
      },
      ...content,
      image ? null : el('span', { class: 'bg-tile-label' }, label)
    );
  }

  async function choose(spec) {
    const ok = await media.setBackground(spec);
    // Failures surface as a toast through the views' media 'error'
    // listeners; only persist what actually worked.
    //
    // Persist what is applied rather than what this call asked for. A
    // second choice made while the first is still loading its image
    // settles the effect on its own spec, but leaves two of these awaits
    // to resolve in whichever order the loads finish — so the earlier
    // choice could be the one written down, and come back next session in
    // place of the one on screen.
    if (ok) setPref('background', storableBackground(media.background));
  }

  async function addCustomImage(file) {
    try {
      const src = await toDataURL(file);
      try {
        setLocalPref(CUSTOM_IMAGE_KEY, src);
      } catch {
        /* storage full — still usable this session */
      }
      await choose({ type: 'image', id: CUSTOM_BACKGROUND_ID, src });
      renderTiles();
    } catch {
      toast('Couldn’t read that image. Try a different file.', { icon: 'info' });
    }
  }
}

/** Downscale an image file and encode it for localStorage. */
async function toDataURL(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_CUSTOM_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}
