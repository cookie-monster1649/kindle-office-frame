#!/bin/sh
# Paint a screen, wait for a tap, and report which region was hit.
#
# Prints the region name from the .regions file - for the menu that is one of
# server | in | out | rotate | exit - or `timeout` if nothing was tapped in
# time. Exits 0 in both cases; exits 1 only if the screen could not be shown.
#
# Touch reports ABS_MT_POSITION_X 0..1071 and Y 0..1447, matching the
# framebuffer exactly, and the generator has already converted regions into
# device coordinates, so raw event values are compared directly with no
# scaling and no knowledge of orientation.

DIR="$(dirname "$0")"
# Always passed in by dash.sh, which picks the pair matching the current
# orientation. No default: a missing screen should be an obvious error, not
# a silent fallback to whatever happens to be lying around.
MODAL="${MODAL_PNG:?MODAL_PNG not set}"
REGIONS="${MODAL_REGIONS:?MODAL_REGIONS not set}"
TOUCH_DEV="${TOUCH_DEV:-/dev/input/event1}"
EVTEST="${EVTEST:-/mnt/us/usbnet/bin/evtest}"
TIMEOUT="${MODAL_TIMEOUT:-30}"

EV_LOG="/tmp/modal_ev.$$"

cleanup() {
  # Kill by recorded PID, never by name: `pkill -f evtest` also matches the
  # shell running this script and takes it down with it.
  [ -n "$EV_PID" ] && kill "$EV_PID" 2>/dev/null
  rm -f "$EV_LOG"
}
trap cleanup EXIT INT TERM

[ -f "$MODAL" ]   || { echo "missing $MODAL" >&2; exit 1; }
[ -f "$REGIONS" ] || { echo "missing $REGIONS" >&2; exit 1; }
[ -x "$EVTEST" ]  || { echo "missing $EVTEST" >&2; exit 1; }
[ -r "$TOUCH_DEV" ] || { echo "cannot read $TOUCH_DEV" >&2; exit 1; }

/usr/sbin/eips -f -g "$MODAL" >/dev/null 2>&1

"$EVTEST" "$TOUCH_DEV" >"$EV_LOG" 2>&1 &
EV_PID=$!

# Pull the coordinates recorded at the moment of release. Using release
# rather than press means a stray drag off a button does not count as a hit.
read_tap() {
  awk '
    /ABS_MT_POSITION_X/ { x = $NF }
    /ABS_MT_POSITION_Y/ { y = $NF }
    /BTN_TOUCH/ && /value 1/ { down = 1 }
    /BTN_TOUCH/ && /value 0/ { if (down && x != "" && y != "") { print x, y; exit } }
  ' "$EV_LOG" 2>/dev/null
}

hit_test() {
  tx=$1
  ty=$2
  # Skip comments and blank lines; first match wins.
  while read -r name x1 y1 x2 y2 _rest; do
    case "$name" in ''|\#*) continue ;; esac
    if [ "$tx" -ge "$x1" ] && [ "$tx" -le "$x2" ] \
    && [ "$ty" -ge "$y1" ] && [ "$ty" -le "$y2" ]; then
      echo "$name"
      return 0
    fi
  done < "$REGIONS"
  return 1
}

elapsed=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
  tap=$(read_tap)
  if [ -n "$tap" ]; then
    tx=${tap% *}
    ty=${tap#* }
    if hit=$(hit_test "$tx" "$ty"); then
      echo "$hit"
      exit 0
    fi
    # Tap landed outside every button. Clear the log so the same stale event
    # is not re-read on the next pass, and keep waiting.
    : > "$EV_LOG"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "timeout"
exit 0
