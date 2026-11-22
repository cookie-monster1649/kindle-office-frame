#!/bin/sh
# Start Frame at boot, if it was running when the device went down.
#
# Called by /etc/upstart/frame.conf on framework_ready, detached. Lives on the
# userstore so it can be changed without remounting the root partition.
#
# Starts dash.sh only when all of these hold:
#   * DISABLE_AUTOSTART does not exist. It can be created over USB mass
#     storage as well as SSH, so there is always a way out.
#   * local/state/autostart exists. dash.sh writes it on start and removes it
#     on a deliberate Exit, so tapping Exit means the Kindle stays the Kindle
#     across reboots.
#   * dash.sh is not already running. framework_ready fires again whenever
#     the UI restarts without a reboot.

DIR=/mnt/us/dashboard
LOG="$DIR/logs/dash.log"
FLAG="$DIR/local/state/autostart"
DISABLE="$DIR/DISABLE_AUTOSTART"

# The home app has to be up first: dash.sh pauses the window manager and
# disables pillow, and doing that mid-boot leaves the UI half-drawn and
# drawing over the frame. Poll rather than wait for appStarted, which may
# already have fired by now.
HOME_WAIT=180
# Then a settle: the home screen does its first full paint, and Wi-Fi gets a
# head start. This is also a window to SSH in and touch DISABLE_AUTOSTART.
SETTLE=30

mkdir -p "$(dirname "$LOG")"
log() { echo "$(date) boot: $*" >>"$LOG"; }

[ -e "$DISABLE" ] && { log "DISABLE_AUTOSTART present; not starting"; exit 0; }
[ -e "$FLAG" ]    || exit 0
[ -x "$DIR/dash.sh" ] || { log "dash.sh missing; not starting"; exit 0; }

waited=0
while [ -z "$(lipc-get-prop com.lab126.appmgrd activeApp 2>/dev/null)" ]; do
  [ "$waited" -ge "$HOME_WAIT" ] && { log "home app not up after ${HOME_WAIT}s; starting anyway"; break; }
  sleep 5
  waited=$((waited + 5))
done

sleep "$SETTLE"

# Checked last, after the waits, so a DISABLE_AUTOSTART created during the
# settle window, or a manual start in the meantime, still wins.
[ -e "$DISABLE" ] && { log "DISABLE_AUTOSTART present; not starting"; exit 0; }
if pgrep -f "/mnt/us/dashboard/dash.sh" >/dev/null 2>&1; then
  log "dash.sh already running; nothing to do"
  exit 0
fi

# Same environment Frame.sh gives it.
# shellcheck disable=SC1090
[ -f "$DIR/local/env.sh" ] && . "$DIR/local/env.sh"

log "starting Frame"
FRAME_AUTOSTART=1 "$DIR/dash.sh" >>"$LOG" 2>&1 &
exit 0
