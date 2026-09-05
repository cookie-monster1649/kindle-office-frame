#!/bin/sh
# Generate every Frame screen in both orientations.
#
# Produces, into ./screens/ :
#   menu-portrait.png       menu-portrait.regions
#   menu-landscape.png      menu-landscape.regions
#   in-portrait.png         in-landscape.png
#   out-portrait.png        out-landscape.png
#
# The status cards get regions too, so a tap anywhere on them opens the menu
# without needing the power button.

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/lib.sh"

OUT_DIR="$DIR/screens"
PALETTE="$DIR/palette16.png"
mkdir -p "$OUT_DIR"
ensure_palette "$PALETTE"

NAME="${FRAME_NAME:-JJ}"

# ---------------------------------------------------------------- menu -----

draw_menu() {
  orient="$1"
  W=$(logical_w "$orient")
  H=$(logical_h "$orient")
  png="$OUT_DIR/menu-$orient.png"
  reg="$OUT_DIR/menu-$orient.regions"
  tmp="$OUT_DIR/.menu-$orient.tmp.png"

  : > "$reg"
  echo "# name x1 y1 x2 y2 (device coords, generated - do not hand edit)" >> "$reg"

  # Buttons are sized off the logical canvas so both orientations feel the
  # same rather than one being a squashed version of the other.
  bw=$(( W * 72 / 100 ))
  bx1=$(( (W - bw) / 2 ))
  bx2=$(( bx1 + bw ))

  if [ "$orient" = "landscape" ]; then
    bh=112; gap=22; top=300; title_y=180; ps=40
  else
    bh=132; gap=28; top=430; title_y=270; ps=44
  fi

  # All the rectangles go into one -draw string, and the labels are applied in
  # a second pass so the box fill colour cannot bleed into the text colour.
  boxes=""
  y=$top
  for item in "server:Show server" "in:In office" "out:Out of office" \
              "rotate:Rotate screen" "exit:Exit"; do
    key=${item%%:*}
    y2=$(( y + bh ))
    boxes="$boxes roundrectangle $bx1,$y $bx2,$y2 14,14"
    emit_region "$reg" "$key" "$bx1" "$y" "$bx2" "$y2" "$orient"
    y=$(( y2 + gap ))
  done

  "$IM" -size "${W}x${H}" xc:white \
    -fill gray92 -stroke black -strokewidth 3 \
    -draw "$boxes" \
    "$tmp"

  # Labels, centred on each button. Charter runs a little over half the point
  # size per character on average, which is close enough for a button label.
  set -- "Show server" "In office" "Out of office" "Rotate screen" "Exit"
  y=$top
  n=1
  cmd_label=""
  for label in "$@"; do
    y2=$(( y + bh ))
    tx=$(( (bx1 + bx2) / 2 - ${#label} * ps * 26 / 100 ))
    ty=$(( (y + y2) / 2 + ps / 3 ))
    cmd_label="$cmd_label -annotate +${tx}+${ty} \"${label}\""
    y=$(( y2 + gap ))
    n=$(( n + 1 ))
  done

  eval "$IM" "$tmp" -font "\"$FONT\"" -fill black -stroke none \
    -pointsize "$ps" -gravity NorthWest $cmd_label \
    -pointsize $(( ps * 3 / 2 )) -gravity North \
    -annotate +0+${title_y} "\"Frame\"" \
    "\"$tmp.2\""

  finalise "$tmp.2" "$orient" "$png" "$PALETTE"
  rm -f "$tmp" "$tmp.2"
  echo "  $png"
}

# --------------------------------------------------------- status card -----

draw_status() {
  orient="$1"; key="$2"; line1="$3"
  W=$(logical_w "$orient")
  H=$(logical_h "$orient")
  png="$OUT_DIR/$key-$orient.png"
  reg="$OUT_DIR/$key-$orient.regions"
  tmp="$OUT_DIR/.$key-$orient.tmp.png"

  : > "$reg"
  echo "# name x1 y1 x2 y2 (device coords, generated - do not hand edit)" >> "$reg"
  # The whole screen opens the menu, so the power button is a convenience
  # rather than the only way in.
  emit_region "$reg" "menu" 0 0 $(( W - 1 )) $(( H - 1 )) "$orient"

  # Vertically centred, since it is the only thing on the screen.
  if [ "$orient" = "landscape" ]; then
    ps1=150; y1=$(( H / 2 - 40 ))
  else
    ps1=130; y1=$(( H / 2 - 40 ))
  fi

  "$IM" -size "${W}x${H}" xc:white -font "$FONT" -fill black -stroke none \
    -gravity North \
    -pointsize "$ps1" -annotate +0+${y1} "$line1" \
    "$tmp"

  finalise "$tmp" "$orient" "$png" "$PALETTE"
  rm -f "$tmp"
  echo "  $png"
}

echo "Generating screens into $OUT_DIR"
for o in portrait landscape; do
  draw_menu "$o"
  draw_status "$o" in  "$NAME is in today"
  draw_status "$o" out "$NAME is out"
done

echo ""
echo "menu regions (portrait):";  cat "$OUT_DIR/menu-portrait.regions"
echo "menu regions (landscape):"; cat "$OUT_DIR/menu-landscape.regions"
