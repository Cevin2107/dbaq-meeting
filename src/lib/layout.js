/**
 * Video grid layout math (pure functions).
 *
 * Positions are absolute rects inside a container, so the DOM layer can
 * animate tiles between positions with CSS transitions.
 */

/**
 * Compute the best uniform grid for `count` tiles in a `width` x `height`
 * container: the column count that maximizes tile area while preserving
 * the preferred aspect ratio. Rows are centered; a partial last row is
 * centered horizontally.
 *
 * @returns {{ cols: number, rows: number, tileW: number, tileH: number,
 *             rects: Array<{x:number,y:number,w:number,h:number}> }}
 */
export function computeGridLayout(count, width, height, { gap = 12, aspect = 16 / 9, maxTileW = Infinity } = {}) {
  if (count <= 0 || width <= 0 || height <= 0) {
    return { cols: 0, rows: 0, tileW: 0, tileH: 0, rects: [] };
  }

  // A container narrower (or shorter) than the gaps alone leaves every
  // arrangement with a zero-sized cell. Drop the gaps rather than the
  // layout: with a positive width and height, a gapless grid always fits.
  const best =
    bestGrid(count, width, height, gap, aspect, maxTileW) ??
    bestGrid(count, width, height, 0, aspect, maxTileW);

  const { cols, rows, tileW, tileH } = best;
  gap = best.gap;
  const gridH = rows * tileH + (rows - 1) * gap;
  const offsetY = Math.max(0, (height - gridH) / 2);

  const rects = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const rowW = inRow * tileW + (inRow - 1) * gap;
    const offsetX = Math.max(0, (width - rowW) / 2);
    const col = i - row * cols;
    rects.push({
      x: round2(offsetX + col * (tileW + gap)),
      y: round2(offsetY + row * (tileH + gap)),
      w: round2(tileW),
      h: round2(tileH),
    });
  }

  return { cols, rows, tileW: round2(tileW), tileH: round2(tileH), rects };
}

/**
 * Spotlight layout: one featured tile plus a filmstrip of the rest.
 * The strip goes to the right in landscape containers and below in
 * portrait ones. `stripCount` may be 0 (featured tile fills everything).
 *
 * @returns {{ featured: {x,y,w,h}, strip: Array<{x,y,w,h}>, orientation: 'row'|'column' }}
 */
export function computeSpotlightLayout(stripCount, width, height, { gap = 12, stripSize = 180, aspect = 16 / 9 } = {}) {
  const landscape = width >= height;

  if (stripCount <= 0) {
    return { featured: { x: 0, y: 0, w: round2(width), h: round2(height) }, strip: [], orientation: landscape ? 'row' : 'column' };
  }

  if (landscape) {
    const stripW = Math.min(stripSize, width * 0.25);
    const featured = { x: 0, y: 0, w: round2(Math.max(0, width - stripW - gap)), h: round2(height) };
    const tileH = clampSize(Math.min(stripW / aspect, (height - gap * (stripCount - 1)) / stripCount));
    const totalH = stripCount * tileH + (stripCount - 1) * gap;
    const startY = Math.max(0, (height - totalH) / 2);
    const strip = [];
    for (let i = 0; i < stripCount; i++) {
      strip.push({
        x: round2(width - stripW),
        y: round2(startY + i * (tileH + gap)),
        w: round2(stripW),
        h: round2(tileH),
      });
    }
    return { featured, strip, orientation: 'row' };
  }

  const stripH = Math.min(stripSize * 0.75, height * 0.25);
  const featured = { x: 0, y: 0, w: round2(width), h: round2(Math.max(0, height - stripH - gap)) };
  const tileW = clampSize(Math.min(stripH * aspect, (width - gap * (stripCount - 1)) / stripCount));
  const totalW = stripCount * tileW + (stripCount - 1) * gap;
  const startX = Math.max(0, (width - totalW) / 2);
  const strip = [];
  for (let i = 0; i < stripCount; i++) {
    strip.push({
      x: round2(startX + i * (tileW + gap)),
      y: round2(height - stripH),
      w: round2(tileW),
      h: round2(stripH),
    });
  }
  return { featured, strip, orientation: 'column' };
}

/**
 * The column count that maximizes tile area for a given gap, or null when
 * the gaps leave no room for a single positive-sized cell.
 */
function bestGrid(count, width, height, gap, aspect, maxTileW) {
  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;

    // Fit an `aspect` box inside the cell.
    let tileW = Math.min(cellW, cellH * aspect, maxTileW);
    let tileH = tileW / aspect;
    if (tileH > cellH) {
      tileH = cellH;
      tileW = tileH * aspect;
    }
    const area = tileW * tileH;
    if (!best || area > best.area) {
      best = { cols, rows, tileW, tileH, area, gap };
    }
  }
  return best;
}

/** Rects are written straight into CSS px, where a negative size is ignored. */
function clampSize(n) {
  return n > 0 ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
