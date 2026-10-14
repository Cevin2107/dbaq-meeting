import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { initials, colorFor } from '../lib/names.js';
import { computeGridLayout, computeSpotlightLayout } from '../lib/layout.js';

/**
 * @typedef {Object} TileData
 * @property {string} id
 * @property {string} title        name label
 * @property {string} colorSeed    avatar color seed
 * @property {MediaStream|null} stream
 * @property {boolean} showVideo
 * @property {boolean} mirrored
 * @property {boolean} muted       mute the <video> element (self / local screen)
 * @property {boolean} micOn
 * @property {boolean} hand
 * @property {boolean} [reconnecting]  the link carrying this video is being rebuilt
 * @property {boolean} speaking
 * @property {'cover'|'contain'} fit
 * @property {boolean} [self]     the reader's own tile
 * @property {boolean} [screen]   a shared screen rather than a camera
 */

/**
 * TileGrid — owns the video tiles: reconciles DOM against tile data and
 * positions tiles with the layout math (grid or spotlight when pinned).
 */
export class TileGrid {
  /** @type {Map<string, {node: HTMLElement, video: HTMLVideoElement, avatar: HTMLElement, sharingPlaceholder: HTMLElement, nameSpan: HTMLElement, nameMic: HTMLElement, badges: HTMLElement, pinBtn: HTMLElement, data: TileData}>} */
  #tiles = new Map();
  #order = [];
  #container;
  #onPin;
  #sinkId = null;
  pinnedId = null;

  constructor(container, { onPin } = {}) {
    this.#container = container;
    this.#onPin = onPin;
  }

  /** Reconcile the tile set. `list` order defines layout order. */
  update(list) {
    const seen = new Set();
    for (const data of list) {
      seen.add(data.id);
      let tile = this.#tiles.get(data.id);
      if (!tile) {
        tile = this.#createTile(data);
        this.#tiles.set(data.id, tile);
        this.#container.append(tile.node);
      }
      this.#applyData(tile, data);
    }
    for (const [id, tile] of [...this.#tiles]) {
      if (!seen.has(id)) {
        tile.video.srcObject = null;
        tile.node.remove();
        this.#tiles.delete(id);
      }
    }
    this.#order = list.map((d) => d.id);
    if (this.pinnedId && !this.#tiles.has(this.pinnedId)) this.pinnedId = null;
    this.layout();
  }

  setPinned(id) {
    this.pinnedId = id && this.#tiles.has(id) ? id : null;
    for (const [tileId, tile] of this.#tiles) {
      const pinned = tileId === this.pinnedId;
      tile.pinBtn.classList.toggle('active', pinned);
      tile.pinBtn.title = pinned ? 'Unpin' : 'Pin to screen';
      // The accessible name overrides the title — keep it in step.
      tile.pinBtn.setAttribute('aria-label', tile.pinBtn.title);
      tile.pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    }
    this.layout();
  }

  /** Position all tiles. Call on resize / membership change. */
  layout() {
    const w = this.#container.clientWidth;
    const h = this.#container.clientHeight;
    if (w <= 0 || h <= 0 || this.#order.length === 0) return;

    const gap = w < 600 ? 8 : 12;

    if (this.pinnedId && this.#order.length > 1) {
      const others = this.#order.filter((id) => id !== this.pinnedId);
      const { featured, strip } = computeSpotlightLayout(others.length, w, h, { gap });
      this.#place(this.pinnedId, featured);
      others.forEach((id, i) => this.#place(id, strip[i]));
      return;
    }

    if (this.pinnedId && this.#order.length === 1) {
      this.#place(this.pinnedId, { x: 0, y: 0, w, h });
      return;
    }

    const { rects } = computeGridLayout(this.#order.length, w, h, { gap });
    this.#order.forEach((id, i) => this.#place(id, rects[i]));
  }

  /** Route audio output (where supported). */
  async setSink(deviceId) {
    this.#sinkId = deviceId || null;
    for (const tile of this.#tiles.values()) {
      if (this.#sinkId && tile.video.setSinkId) {
        try {
          await tile.video.setSinkId(this.#sinkId);
        } catch {
          /* unsupported sink */
        }
      }
    }
  }

  /** Short-lived emoji bubble on a participant's tile. */
  reactionBubble(tileId, emoji) {
    const tile = this.#tiles.get(tileId);
    if (!tile) return;
    const bubble = el('div', { class: 'tile-reaction' }, emoji);
    tile.node.append(bubble);
    setTimeout(() => bubble.remove(), 2600);
  }

  destroy() {
    for (const tile of this.#tiles.values()) {
      tile.video.srcObject = null;
      tile.node.remove();
    }
    this.#tiles.clear();
    this.#order = [];
  }

  // ---- internals ----

  #place(id, rect) {
    const tile = this.#tiles.get(id);
    if (!tile || !rect) return;
    Object.assign(tile.node.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
    });
  }

  #createTile(data) {
    const video = el('video', { autoplay: true, playsinline: true });
    const avatar = el('div', { class: 'avatar' });
    const sharingPlaceholder = el(
      'div',
      { class: 'tile-sharing-placeholder', style: { display: 'none' } },
      icon('present'),
      el('strong', {}, 'You’re sharing your screen'),
      el('span', {}, 'Your preview is hidden to prevent mirroring.')
    );
    const nameMic = el('span', { class: 'tile-name-mic' });
    const nameSpan = el('span', {});
    const badges = el('div', { class: 'tile-badges' });
    const pinBtn = el(
      'button',
      {
        class: 'tile-action',
        title: 'Pin to screen',
        'aria-label': 'Pin to screen',
        onclick: () => this.#onPin?.(data.id),
      },
      icon('pin')
    );

    const node = el(
      'div',
      { class: 'tile', dataset: { tileId: data.id } },
      video,
      el('div', { class: 'tile-avatar-wrap' }, avatar),
      sharingPlaceholder,
      el('div', { class: 'tile-name' }, nameMic, nameSpan),
      badges,
      el('div', { class: 'tile-actions' }, pinBtn)
    );

    return { node, video, avatar, sharingPlaceholder, nameSpan, nameMic, badges, pinBtn, data: {} };
  }

  #applyData(tile, data) {
    const prev = tile.data;
    tile.data = data;

    if (prev.stream !== data.stream) {
      tile.video.srcObject = data.stream;
      if (data.stream) tile.video.play?.().catch(() => {});
      if (this.#sinkId && tile.video.setSinkId) tile.video.setSinkId(this.#sinkId).catch(() => {});
    }
    if (prev.muted !== data.muted) {
      tile.video.muted = !!data.muted;
    }
    if (prev.showVideo !== data.showVideo) {
      tile.video.style.visibility = data.showVideo ? 'visible' : 'hidden';
      // A re-enabled camera swaps a new track into the same stream; some
      // browsers pause the element until play() is called again.
      if (data.showVideo && data.stream) tile.video.play?.().catch(() => {});
    }
    const localPresentation = data.self && data.screen;
    tile.sharingPlaceholder.style.display = localPresentation ? '' : 'none';
    tile.avatar.parentElement.style.display = data.showVideo || localPresentation ? 'none' : '';
    if (prev.mirrored !== data.mirrored) {
      tile.node.classList.toggle('mirrored', !!data.mirrored);
    }
    if (prev.fit !== data.fit) {
      tile.node.classList.toggle('fit-contain', data.fit === 'contain');
    }
    if (prev.title !== data.title) {
      tile.nameSpan.textContent = data.title;
      tile.avatar.textContent = initials(data.colorSeed ?? data.title);
      tile.avatar.style.background = colorFor(data.colorSeed ?? data.title);
    }
    if (prev.speaking !== data.speaking) {
      tile.node.classList.toggle('speaking', !!data.speaking);
    }
    if (prev.micOn !== data.micOn) {
      clear(tile.nameMic);
      if (data.micOn === false) tile.nameMic.append(muteGlyph());
    }
    if (prev.hand !== data.hand || prev.reconnecting !== data.reconnecting) {
      clear(tile.badges);
      // The last frame stays up, dimmed, so the reader knows it is stale
      // rather than a still participant.
      tile.node.classList.toggle('reconnecting', !!data.reconnecting);
      if (data.reconnecting) {
        tile.badges.append(el('span', { class: 'tile-badge reconnecting', role: 'status' }, 'Reconnecting…'));
      }
      // The icon itself is aria-hidden, and a title on a span is not read
      // out — the badge has to name itself.
      if (data.hand) {
        tile.badges.append(
          el('span', { class: 'tile-badge hand', title: 'Hand raised', role: 'img', 'aria-label': 'Hand raised' }, icon('hand'))
        );
      }
    }
  }
}

function muteGlyph() {
  const node = icon('micOff');
  node.style.color = '#f28b82';
  // The name label reads "<name>" alone otherwise; the mute is part of it.
  return el('span', { role: 'img', 'aria-label': 'Muted', title: 'Muted', style: { display: 'inline-flex' } }, node);
}
