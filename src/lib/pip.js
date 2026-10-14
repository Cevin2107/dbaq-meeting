/**
 * Picture-in-picture: what the browser can float, and what belongs in it.
 *
 * Three ways can host a picture-in-picture view:
 *  - **Document PiP** (Chromium) hands back a real `Window` we can render a
 *    miniature meeting into — several tiles plus working controls. Only a
 *    top-level page may open one.
 *  - **Hosted Document PiP**, inside the Puter desktop, where the app is an
 *    iframe: the desktop opens the window for us and loads our `pip.html`
 *    in it, which hands its window back — the same miniature meeting.
 *  - **Element PiP** (older, wider support) can only float a single
 *    `<video>`, so the fallback picks one stream and shows that.
 * The UI layer takes the richest one it has; all need to decide *what* to
 * show, which is what the selectors here are for.
 */

/** How many tiles a floating window carries at once. It is a postage stamp. */
export const MAX_PIP_TILES = 4;

/** Whether this page is the top of its window, rather than a frame in someone else's. */
export function isTopLevelPage() {
  if (typeof window === 'undefined') return false;
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

/**
 * Document PiP we can open ourselves. Browsers only allow it from a
 * top-level page: in a frame the API is still there, and refuses.
 */
export function documentPipSupported() {
  return isTopLevelPage() && typeof window.documentPictureInPicture?.requestWindow === 'function';
}

/**
 * Document PiP the Puter desktop opens for us — we are a frame there, so
 * we can't. Off the desktop puter.js reports another environment, and in
 * a frame on some other site nobody can open one for us.
 */
export function hostedPipSupported() {
  if (typeof window === 'undefined' || isTopLevelPage()) return false;
  const puter = window.puter;
  return puter?.env === 'app' && typeof puter.ui?.requestPictureInPicture === 'function';
}

export function videoPipSupported() {
  if (typeof document === 'undefined' || document.pictureInPictureEnabled === false) return false;
  return typeof HTMLVideoElement !== 'undefined' && typeof HTMLVideoElement.prototype?.requestPictureInPicture === 'function';
}

export function pipSupported() {
  return documentPipSupported() || hostedPipSupported() || videoPipSupported();
}

/**
 * Pick the tiles a floating window should carry, most important first out
 * of the grid but returned in the caller's own order — a mini window that
 * reshuffles itself every time someone speaks is harder to read than one
 * whose faces stay put.
 *
 * @param {Array<import('../ui/tiles.js').TileData>} tiles  in display order
 * @param {{pinnedId?: string|null, previous?: string[], max?: number}} [opts]
 *   `previous` is what the window is showing right now: it breaks ties, so
 *   a tile that is already up keeps its slot over an equally good newcomer.
 * @returns {Array<import('../ui/tiles.js').TileData>}
 */
export function selectPipTiles(tiles, { pinnedId = null, previous = [], max } = {}) {
  const list = [...tiles];
  const pinned = list.some((t) => t.id === pinnedId) ? pinnedId : null;
  // A pinned tile takes the stage and pushes the rest into a filmstrip, so
  // one slot less keeps the strip readable.
  const limit = Math.max(1, max ?? (pinned ? MAX_PIP_TILES - 1 : MAX_PIP_TILES));
  if (list.length <= limit) return list;

  const order = new Map(list.map((tile, i) => [tile.id, i]));
  const keep = new Set(
    list
      .slice()
      .sort(
        (a, b) =>
          rank(a, pinned) - rank(b, pinned) ||
          seenAt(a, previous) - seenAt(b, previous) ||
          order.get(a.id) - order.get(b.id)
      )
      .slice(0, limit)
      .map((tile) => tile.id)
  );
  return list.filter((tile) => keep.has(tile.id));
}

/**
 * The one stream to float when all the browser gives us is a single video
 * element. Only tiles with a picture qualify — an element PiP has no way
 * to draw the avatar a camera-off participant would show.
 *
 * @param {Array<import('../ui/tiles.js').TileData>} tiles
 * @returns {import('../ui/tiles.js').TileData|null}
 */
export function primaryPipTile(tiles, { pinnedId = null } = {}) {
  const showable = tiles.filter((tile) => tile.showVideo && tile.stream);
  // Array#sort is stable, so tiles of equal rank keep their display order.
  return showable.sort((a, b) => rank(a, pinnedId) - rank(b, pinnedId))[0] ?? null;
}

/**
 * How much a tile deserves one of the few slots. Whatever the user pinned
 * wins outright; then presentations, then whoever is talking. Your own
 * camera goes last — you are not who you opened the window to watch.
 */
function rank(tile, pinnedId) {
  if (pinnedId && tile.id === pinnedId) return 0;
  if (tile.screen) return 1;
  if (tile.speaking && !tile.self) return 2;
  if (!tile.self) return 3;
  return 4;
}

/** Where a tile sits in the window right now (unshown tiles sort last). */
function seenAt(tile, previous) {
  const at = previous.indexOf(tile.id);
  return at === -1 ? previous.length : at;
}
