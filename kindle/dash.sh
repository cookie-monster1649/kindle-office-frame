#!/usr/bin/env sh
# Frame - e-ink desk display for a Kindle Paperwhite 3 on FW 5.16.2.1.1.
#
# Derived from pascalw/kindle-dash, but the PW3 on 5.16.x differs from that
# project's Kindle 4 target in three ways that each caused a silent failure:
#
#   * The RTC wake node is /sys/class/rtc/rtc0/wakealarm and takes an absolute
#     epoch, not mxc_rtc's relative seconds. Upstream would suspend with no
#     alarm armed and never wake.
#   * The UI is upstart, not init.d, and /sbin is not on PATH, so upstream's
#     framework-stopping calls silently did nothing and the Kindle kept
#     drawing its status bar over the frame.
#   * Anything that kills cvm (stop framework / stop lab126_gui) cannot be
#     undone without a reboot, so the UI is paused rather than stopped.

DEBUG=${DEBUG:-false}
[ "$DEBUG" = true ] && set -x

DIR="$(cd "$(dirname "$0")" && pwd)"
DASH_PNG="$DIR/dash.png"
SCREENS="$DIR/screens"
FETCH_CMD="$DIR/local/fetch-dashboard.sh"

REFRESH_SCHEDULE=${REFRESH_SCHEDULE:-"*/15 * * * *"}
FULL_DISPLAY_REFRESH_RATE=${FULL_DISPLAY_REFRESH_RATE:-4}
MENU_TIMEOUT=${MENU_TIMEOUT:-30}

RTC_LEGACY=/sys/devices/platform/mxc_rtc.0/wakeup_enable
RTC_GENERIC=/sys/class/rtc/rtc0/wakealarm
RTC=""
RTC_KIND=""

num_refresh=0

# ---------------------------------------------------------------- state ----
#
#   MODE    server | in | out          what sits on screen between wakeups
#   ORIENT  portrait | landscape       which pre-rendered assets to use
#
# Persisted, so a suspend, a restart or a crash all resume the same view
# instead of dropping back to the menu.

STATE_DIR="$DIR/local/state"
MODE_FILE="$STATE_DIR/mode"
ORIENT_FILE="$STATE_DIR/orientation"

MODE="server"
ORIENT="portrait"

load_state() {
  mkdir -p "$STATE_DIR"
  [ -f "$MODE_FILE" ]   && MODE=$(cat "$MODE_FILE" 2>/dev/null)
  [ -f "$ORIENT_FILE" ] && ORIENT=$(cat "$ORIENT_FILE" 2>/dev/null)
  case "$MODE"   in server|in|out) ;;      *) MODE="server" ;;   esac
  case "$ORIENT" in portrait|landscape) ;; *) ORIENT="portrait" ;; esac
}

save_state() {
  mkdir -p "$STATE_DIR"
  printf '%s' "$MODE"   >"$MODE_FILE"
  printf '%s' "$ORIENT" >"$ORIENT_FILE"
}

# Assets are pre-rendered per orientation and their hit regions are already
# in device coordinates, so nothing below has to reason about rotation.
screen_png()     { echo "$SCREENS/$1-$ORIENT.png"; }
screen_regions() { echo "$SCREENS/$1-$ORIENT.regions"; }

# ------------------------------------------------------------------ rtc ----

detect_rtc() {
  if [ -w "$RTC_LEGACY" ]; then
    RTC="$RTC_LEGACY"; RTC_KIND="legacy"
  elif [ -w "$RTC_GENERIC" ]; then
    RTC="$RTC_GENERIC"; RTC_KIND="generic"
  else
    echo "No writable RTC wakeup node found."
    echo "Looked for: $RTC_LEGACY"
    echo "            $RTC_GENERIC"
    echo "Without one the device would suspend and never wake. Refusing to start."
    exit 1
  fi
  echo "Using $RTC_KIND RTC node: $RTC"
}

WAKE_TARGET=0

rtc_sleep() {
  duration=$1

  if [ "$DEBUG" = true ]; then
    WAKE_TARGET=0
    sleep "$duration"
    return
  fi

  WAKE_TARGET=$(($(date +%s) + duration))

  if [ "$RTC_KIND" = "legacy" ]; then
    [ "$(cat "$RTC")" -eq 0 ] && echo -n "$duration" >"$RTC"
  else
    # wakealarm refuses a new alarm while one is pending, so clear it first.
    echo 0 >"$RTC" 2>/dev/null
    echo "$WAKE_TARGET" >"$RTC"
  fi

  echo "mem" >/sys/power/state

  # Resumes here. Disarm anything that did not fire so it cannot block the
  # next arming.
  [ "$RTC_KIND" = "generic" ] && echo 0 >"$RTC" 2>/dev/null
}

# The touch panel is not a wake source on this device but the PMIC onkey is,
# so the only way in is: press power to wake early, then tap. There is no
# kernel wake-reason to read, so infer it from the clock - an RTC wakeup lands
# on its target, a button press arrives before it.
woke_early() {
  [ "$WAKE_TARGET" -gt 0 ] || return 1
  [ "$(date +%s)" -lt $((WAKE_TARGET - 5)) ]
}

# ------------------------------------------------------------------- ui ----
#
# Never stop the framework or lab126_gui: both kill cvm, the Java process that
# draws the Kindle UI, and on this firmware nothing restarts cvm short of a
# reboot - start/restart both report success while the panel stays frozen.
# Follow KOReader's default instead (STOP_FRAMEWORK=no): leave the UI running
# and just stop it drawing.
#
# Three things draw over us and each needs separate handling:
#   pillow     the chrome layer, disabled over lipc
#   awesome    the window manager, SIGSTOPped
#   statusbar  a separate upstart job here, which is why the clock still
#              appeared over the frame with pillow already disabled
UI_SERVICES="statusbar"

stop_ui() {
  lipc-set-prop com.lab126.pillow disableEnablePillow disable 2>/dev/null
  for job in $UI_SERVICES; do
    [ -f "/etc/upstart/${job}.conf" ] && /sbin/stop "$job" >/dev/null 2>&1
  done
  killall -STOP awesome 2>/dev/null
  usleep 250000 2>/dev/null || sleep 1
}

start_ui() {
  echo "Handing the screen back to the Kindle UI"
  killall -CONT awesome 2>/dev/null
  for job in $UI_SERVICES; do
    [ -f "/etc/upstart/${job}.conf" ] && /sbin/start "$job" >/dev/null 2>&1
  done
  lipc-set-prop com.lab126.pillow disableEnablePillow enable 2>/dev/null
  lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
  # Without this the UI is alive but idle, and e-ink keeps holding our frame.
  lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home 2>/dev/null
}

# -------------------------------------------------------------- painting ---

paint() {
  img="$1"
  [ -f "$img" ] || { echo "missing screen: $img"; return 1; }

  if [ "$num_refresh" -ge "$FULL_DISPLAY_REFRESH_RATE" ]; then
    num_refresh=0
    /usr/sbin/eips -f -g "$img" >/dev/null 2>&1
  else
    /usr/sbin/eips -g "$img" >/dev/null 2>&1
  fi
  num_refresh=$((num_refresh + 1))
}

# Force the next paint to be a full flashing refresh, to clear ghosting when
# the whole screen changes rather than just its contents.
force_full_refresh() { num_refresh=$FULL_DISPLAY_REFRESH_RATE; }

# Print a few lines of text to the panel.
#
# Tapping a menu button and seeing nothing change is indistinguishable from a
# crash, and a fetch over a sleeping radio can take several seconds. So say
# what is happening, and say when it failed - silence is the one thing that
# leaves you with no idea whether to press it again.
#
# eips takes character cells rather than pixels, hence the small integers.
notify() {
  /usr/sbin/eips -c >/dev/null 2>&1
  row=6
  for line in "$@"; do
    /usr/sbin/eips 4 "$row" "$line" >/dev/null 2>&1
    row=$((row + 2))
  done
}

# -------------------------------------------------------------- content ----

refresh_from_server() {
  announce=${1:-no}

  [ "$announce" = yes ] && notify "Fetching from server..." "$FRAME_URL"

  # No separate reachability probe: the fetch itself retries with a short
  # timeout. A ping-based pre-check misreports any host that filters ICMP,
  # which includes a Mac with stealth mode on - it would block a fetch that
  # would otherwise have succeeded.

  # The device's own settings, passed as query parameters so the server can
  # render to match. These select a rendering; they do not change any server
  # state, and the device's token is read-only so it could not anyway.
  #
  # MODE is always `server` here: `in` and `out` are drawn from local assets
  # without a fetch, so the only time we ask the server for a frame is when
  # the server is the one deciding what to show.
  err=$(MODE=server ORIENT="$ORIENT" "$FETCH_CMD" "$DASH_PNG" 2>&1)
  status=$?
  echo "$err"

  case "$status" in
    20)
      echo "Content unchanged, leaving screen as-is"
      # On an explicit menu choice the screen is still showing the menu, so
      # "unchanged" would leave the wrong thing up. Repaint the cached frame.
      [ "$announce" = yes ] && [ -f "$DASH_PNG" ] && paint "$DASH_PNG"
      return 0
      ;;
    0)
      paint "$DASH_PNG"
      return 0
      ;;
    *)
      echo "Fetch failed ($status)"
      [ "$announce" = yes ] && notify "Could not fetch the frame." \
        "$(echo "$err" | head -n 1)" \
        "" \
        "Press power for the menu."
      return 1
      ;;
  esac
}

render_current() {
  announce=${1:-no}
  case "$MODE" in
    in|out) paint "$(screen_png "$MODE")" ;;
    server) refresh_from_server "$announce" ;;
  esac
}

# ----------------------------------------------------------------- menu ----

show_menu() {
  echo "Showing menu ($ORIENT)"
  force_full_refresh

  choice=$(MODAL_PNG="$(screen_png menu)" \
           MODAL_REGIONS="$(screen_regions menu)" \
           MODAL_TIMEOUT="$MENU_TIMEOUT" \
           "$DIR/modal.sh" 2>/dev/null)
  echo "Menu returned: ${choice:-<nothing>}"

  case "$choice" in
    server|in|out)
      MODE="$choice"
      save_state
      force_full_refresh
      # A menu tap is a deliberate action, so it gets feedback. The scheduled
      # refreshes stay silent - nobody is watching, and a flash every cycle
      # would defeat the point of the 304 path.
      render_current yes
      ;;
    rotate)
      if [ "$ORIENT" = "portrait" ]; then ORIENT="landscape"; else ORIENT="portrait"; fi
      echo "Rotated to $ORIENT"
      save_state
      # Redraw the menu in the new orientation so the change is immediately
      # visible and reversible without hunting for the power button again.
      show_menu
      ;;
    exit)
      echo "Exiting"
      start_ui
      exit 0
      ;;
    *)
      # Timed out, or the menu could not run. Restore the current view rather
      # than leaving the menu on screen.
      force_full_refresh
      render_current
      ;;
  esac
}

# ----------------------------------------------------------------- main ----

log_battery() {
  echo "$(date) Battery: $(gasgauge-info -c 2>/dev/null)"
}

init() {
  if [ -z "$TIMEZONE" ] || [ -z "$REFRESH_SCHEDULE" ]; then
    echo "Missing configuration. Timezone: ${TIMEZONE:-unset}, schedule: ${REFRESH_SCHEDULE:-unset}."
    exit 1
  fi

  detect_rtc
  load_state
  echo "Starting Frame (mode=$MODE orientation=$ORIENT schedule=$REFRESH_SCHEDULE)"

  stop_ui
  echo powersave >/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
}

main_loop() {
  while true; do
    log_battery

    next_wakeup_secs=$("$DIR/next-wakeup" --schedule="$REFRESH_SCHEDULE" --timezone="$TIMEZONE")
    render_current

    # A moment before suspending, so the loop can be interrupted over SSH.
    sleep 10

    echo "Suspending, next wakeup in ${next_wakeup_secs}s"
    rtc_sleep "$next_wakeup_secs"

    if woke_early; then
      echo "Woke before the alarm: power button"
      show_menu
    fi
  done
}

init
# Show the menu on launch so the first thing you get is a choice, and so
# there is always a visible way out without needing the power button.
show_menu
main_loop
