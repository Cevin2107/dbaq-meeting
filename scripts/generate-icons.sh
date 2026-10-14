#!/usr/bin/env bash
#
# Regenerate every favicon / app-icon rendition in public/ from the source
# artwork at ./icon.png. Requires ImageMagick 7 (`brew install imagemagick`).
#
#   npm run icons
#
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=icon.png
OUT=public
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

command -v magick >/dev/null || { echo "ImageMagick 7 (magick) not found" >&2; exit 1; }
[ -f "$SRC" ] || { echo "missing source artwork: $SRC" >&2; exit 1; }

# Background gradient sampled from the source artwork's own corners, used to
# fill in behind the mark where a transparent corner would look wrong.
GRAD_FROM='#2FA0FC'
GRAD_TO='#0A50E4'

# Tuned PNG output: 8-bit, no metadata, max zlib effort.
PNGOPT=(-depth 8 -strip -define png:compression-level=9 -define png:compression-filter=5)

# Downscale in linear light so the gradient and the white mark stay clean.
scale() { # scale <size> <out>
  magick "$SRC" -colorspace RGB -filter Lanczos -resize "${1}x${1}" -colorspace sRGB "${PNGOPT[@]}" "$2"
}

echo "==> favicons"
scale 16 "$OUT/favicon-16.png"
scale 32 "$OUT/favicon-32.png"
scale 48 "$TMP/favicon-48.png"
magick "$OUT/favicon-16.png" "$OUT/favicon-32.png" "$TMP/favicon-48.png" -strip "$OUT/favicon.ico"

echo "==> app icons"
scale 128 "$OUT/icons/icon-128.png"   # also the brand mark in the app header
scale 192 "$OUT/icons/icon-192.png"
scale 512 "$OUT/icons/icon-512.png"

echo "==> apple-touch-icon"
# iOS applies its own rounded mask, so ship this one opaque: the artwork's
# transparent corners are filled with the sampled gradient.
magick -size 1138x1138 xc: \
  -sparse-color barycentric "0,0 $GRAD_FROM 1137,1137 $GRAD_TO" \
  "$SRC" -compose over -composite \
  -colorspace RGB -filter Lanczos -resize 180x180 -colorspace sRGB \
  -alpha off "${PNGOPT[@]}" "$OUT/apple-touch-icon.png"

echo "==> maskable icons"
# Android crops maskable icons to an arbitrary shape, so the background has to
# bleed to the edges and the mark has to sit inside the safe zone (a centred
# circle 80% of the icon's width). Isolate the white mark by luminance — its
# dimmest pixel is 87.5% grey, the brightest background highlight is 79.6% —
# then lay it back over a full-bleed gradient at 72% width.
magick "$SRC" -background black -alpha remove -alpha off -colorspace gray -threshold 83% "$TMP/mark-alpha.png"
magick "$SRC" -background white -alpha remove -alpha off \
  "$TMP/mark-alpha.png" -alpha off -compose CopyOpacity -composite \
  -trim +repage "$TMP/mark.png"

for size in 192 512; do
  magick -size "${size}x${size}" xc: \
    -sparse-color barycentric "0,0 $GRAD_FROM $((size - 1)),$((size - 1)) $GRAD_TO" \
    \( "$TMP/mark.png" -colorspace RGB -filter Lanczos -resize "$((size * 72 / 100))x" -colorspace sRGB \) \
    -gravity center -compose over -composite \
    -alpha off "${PNGOPT[@]}" "$OUT/icons/icon-maskable-${size}.png"
done

echo
magick identify -format '%f  %wx%h  depth=%z  %[size]B\n' \
  "$OUT/favicon.ico[2]" "$OUT"/favicon-*.png "$OUT/apple-touch-icon.png" "$OUT"/icons/*.png
