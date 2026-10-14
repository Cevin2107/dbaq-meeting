/** Display-name helpers: initials and stable avatar colors. */

const AVATAR_COLORS = [
  '#0010d7', // brand blue
  '#d93025', // red
  '#188038', // green
  '#e37400', // orange
  '#9334e6', // purple
  '#007b83', // teal
  '#b31412', // dark red
  '#3949ab', // indigo
  '#c5221f', // crimson
  '#00796b', // dark teal
  '#7b1fa2', // violet
  '#5f6368', // gray
];

/** Up to two initials: "Ada Lovelace" -> "AL", "puter" -> "P". */
export function initials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = [...parts[0]][0] ?? '?';
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? '' : '';
  return (first + last).toUpperCase();
}

/** Deterministic color from a string (djb2 hash into palette). */
export function colorFor(seed) {
  const str = String(seed ?? '');
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
