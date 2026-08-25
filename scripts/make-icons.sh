#!/bin/sh
# Draw the toolbar icon.
#
# A font glyph does not survive 16px: Computer Modern's integral is a hairline,
# and once the hooks disappear it reads as a slash. So the mark is drawn as a
# stroked path with deliberately heavy terminals, rendered large and stepped
# down. Stroke weight was picked by looking at the 16px result, not the 128px.
#
# The mark sits on a filled rounded plate. A bare glyph has to survive whatever
# toolbar colour it lands on and loses either way; a plate fixes the contrast
# against the glyph instead of against the browser.
set -eu

cd "$(dirname "$0")/.."
out=extension/images
mark="M 379,113 C 379,31 266,31 277,133 L 236,379 C 246,481 133,481 133,399"

magick -size 512x512 xc:none \
  -fill '#2f7d95' -draw 'roundrectangle 8,8,503,503,112,112' \
  -fill none -stroke white -strokewidth 84 \
  -draw "stroke-linecap round stroke-linejoin round path '$mark'" \
  "$out/icon-512.png"

for size in 16 32 48 128; do
  magick "$out/icon-512.png" -filter Lanczos -resize "${size}x${size}" "$out/icon-$size.png"
done
rm "$out/icon-512.png"

echo "wrote $out/icon-{16,32,48,128}.png"
