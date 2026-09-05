#!/bin/sh
# Shared drawing helpers for the Frame screens.
#
# Every screen is composed in "logical" space for its orientation and then
# written into the device framebuffer, which is always 1072x1448 portrait no
# matter how the Kindle is held:
#
#   portrait   logical 1072x1448 -> used as-is
#   landscape  logical 1448x1072 -> rotated 90 CW into 1072x1448
#
# Touch always reports in device space too, so hit regions have to travel
# through the same rotation. A 90 CW rotation of a WxH image maps
# logical (lx, ly) to device (H-1-ly, lx), so for landscape:
#
#   dx = 1071 - ly
#   dy = lx
#
# Doing that here means the on-device code never has to know about
# orientation at all: it just loads <screen>-<orient>.png alongside
# <screen>-<orient>.regions and compares raw touch values directly.

DEV_W=1072
DEV_H=1448

# ImageMagick 6 and 7 differ in entry point, and which you get depends on the
# distro: IM7 has `magick`, IM6 (Debian bookworm) has only `convert`.
if command -v magick >/dev/null 2>&1; then
  IM="magick"
elif command -v convert >/dev/null 2>&1; then
  IM="convert"
else
  echo "ImageMagick not found: needs magick (v7) or convert (v6)" >&2
  exit 1
fi

FONT="${FONT:-/System/Library/Fonts/Supplemental/Charter.ttc}"

# logical canvas for an orientation
logical_w() { [ "$1" = "landscape" ] && echo 1448 || echo 1072; }
logical_h() { [ "$1" = "landscape" ] && echo 1072 || echo 1448; }

# Build the 16 fixed grey levels the panel actually uses. ImageMagick's
# -colors picks an adaptive palette instead, which is not what the hardware
# wants, so we remap onto this explicitly.
ensure_palette() {
  pal="$1"
  [ -f "$pal" ] && return 0
  set --
  i=0
  while [ $i -lt 16 ]; do
    v=$(( i * 255 / 15 ))
    set -- "$@" -size 1x1 "xc:rgb($v,$v,$v)"
    i=$(( i + 1 ))
  done
  "$IM" "$@" +append -depth 8 "$pal"
}

# finalise <logical.png> <orientation> <out.png> <palette>
#
# Rotates if needed, then flattens to 16-level greyscale as true greyscale
# samples. eips rejects palette-indexed PNGs outright ("8bit only"), so
# png:color-type=0 is not optional.
finalise() {
  src="$1"; orient="$2"; out="$3"; pal="$4"
  rot=""
  [ "$orient" = "landscape" ] && rot="-rotate 90"
  # shellcheck disable=SC2086
  "$IM" "$src" $rot \
    -colorspace Gray -dither FloydSteinberg -remap "$pal" \
    -type Grayscale -depth 8 -define png:color-type=0 \
    "$out"
}

# emit_region <regions-file> <name> <lx1> <ly1> <lx2> <ly2> <orientation>
#
# Converts a logical rectangle to device space and appends it.
emit_region() {
  f="$1"; name="$2"; lx1="$3"; ly1="$4"; lx2="$5"; ly2="$6"; orient="$7"

  if [ "$orient" = "landscape" ]; then
    # dx = 1071 - ly, dy = lx. Corners swap, so normalise after mapping.
    a_x=$(( DEV_W - 1 - ly2 )); a_y=$lx1
    b_x=$(( DEV_W - 1 - ly1 )); b_y=$lx2
    dx1=$a_x; dx2=$b_x; dy1=$a_y; dy2=$b_y
  else
    dx1=$lx1; dy1=$ly1; dx2=$lx2; dy2=$ly2
  fi

  [ "$dx1" -gt "$dx2" ] && { t=$dx1; dx1=$dx2; dx2=$t; }
  [ "$dy1" -gt "$dy2" ] && { t=$dy1; dy1=$dy2; dy2=$t; }

  echo "$name $dx1 $dy1 $dx2 $dy2" >> "$f"
}
