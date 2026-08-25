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
# Scaled to ~0.69 of the plate and centred: at full size the terminals ran past
# the rounded corners and got clipped. Stroke is a little under proportional so
# the counters stay open once it steps down to 16px.
mark="M 341,157 C 341,100 263,100 271,171 L 242,341 C 249,412 171,412 171,355"

magick -size 512x512 xc:none \
  -fill '#2f7d95' -draw 'roundrectangle 8,8,503,503,112,112' \
  -fill none -stroke white -strokewidth 50 \
  -draw "stroke-linecap round stroke-linejoin round path '$mark'" \
  "$out/icon-512.png"

for size in 16 32 48 128; do
  magick "$out/icon-512.png" -filter Lanczos -resize "${size}x${size}" "$out/icon-$size.png"
done
rm "$out/icon-512.png"

echo "wrote $out/icon-{16,32,48,128}.png"
