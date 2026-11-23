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

REFRESH_SCHEDULE=${REFRESH_SCHEDULE:-"0 7-18 * * MON-FRI;*/15 7-8 * * MON-FRI;0 7 * * SAT,SUN"}
FULL_DISPLAY_REFRESH_RATE=${FULL_DISPLAY_REFRESH_RATE:-4}
MENU_TIMEOUT=${MENU_TIMEOUT:-30}

# A failed refresh is retried on a short delay rather than costing a whole
# scheduled interval. Multiplied by the attempt number, so the gaps widen:
# 2, 4, 6 minutes, then back to the ordinary schedule.
FETCH_RETRY_DELAY=${FETCH_RETRY_DELAY:-120}
FETCH_RETRY_MAX=${FETCH_RETRY_MAX:-3}

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
# Present while Frame should be on the screen. boot.sh restarts Frame after a
# reboot only if this exists; a deliberate Exit removes it.
AUTOSTART_FILE="$STATE_DIR/autostart"

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

  # Only button presses logged after this point belong to this sleep.
  SUSPEND_KTS=$(klog_last_ts)

  echo "mem" >/sys/power/state

  # Resumes here. Disarm anything that did not fire so it cannot block the
  # next arming.
  [ "$RTC_KIND" = "generic" ] && echo 0 >"$RTC" 2>/dev/null
}

# The touch panel is not a wake source on this device but the PMIC onkey is,
# so the only way in is: hold power to wake early, then tap. There is no
# kernel wake-reason to read, so infer it from the clock - an RTC wakeup lands
# on its target, a button press arrives before it.
woke_early() {
  [ "$WAKE_TARGET" -gt 0 ] || return 1
  [ "$(date +%s)" -lt $((WAKE_TARGET - 5)) ]
}

# An early wake is not proof of a press. dmesg has caught the PMIC onkey
# logging a "button online event" with nobody at the desk, 531s before the
# alarm, and every one of those used to throw the menu up over the frame. So
# the menu needs the power button *held*.
#
# How long it was held cannot be read from the key's live state. The first
# version asked the kernel whether KEY_POWER was down (EVIOCGKEY, via `evtest
# --query`), and it never was, however long the button was held: the press
# that wakes the device is registered during resume, and on this 3.0 kernel
# the input core then resets the device and marks every key released. The
# eventual release changes nothing, so the key reads "up" throughout.
#
# The onkey driver's own log lines are what is left: "button online event"
# on press and "button offline event" on release, straight from its
# interrupt. Not both, though. The press that wakes the device is spent as the
# wake source and never logged; only its release is. A press made while
# already awake logs both.
#
# So the hold runs from whichever comes first after this sleep began - a
# logged press, or the kernel finishing the wakeup the press caused - to the
# first release.
#
#   short press     released during resume or just after; a second press
#                   within SECOND_PRESS_WAIT opens the menu, else ignored
#   long hold       measured on release, so the menu appears as you let go
#   phantom         a wake with no release logged; times out, ignored
#
# Timed from the wakeup, the measurement misses the second or so the kernel
# spent resuming while the button was already down. RESUME_SLACK is that
# allowance: LONG_PRESS_MIN = LONG_PRESS_SECS - RESUME_SLACK is the measured
# threshold.
EVTEST="${EVTEST:-/mnt/us/usbnet/bin/evtest}"
LONG_PRESS_SECS=${LONG_PRESS_SECS:-2}
RESUME_SLACK=${RESUME_SLACK:-1}
LONG_PRESS_MIN=$(awk -v a="$LONG_PRESS_SECS" -v b="$RESUME_SLACK" 'BEGIN { print a - b }')
# A hold longer than this with no release logged is not a hold.
RELEASE_WAIT=${RELEASE_WAIT:-5}
# After a short press, how long to stay awake for a second one.
SECOND_PRESS_WAIT=${SECOND_PRESS_WAIT:-4}
POWER_DEV="${POWER_DEV:-}"
SUSPEND_KTS=""

# Timestamp of the newest kernel log line, on dmesg's own clock.
klog_last_ts() {
  dmesg 2>/dev/null | tail -n 1 | sed -n 's/^\[ *\([0-9][0-9.]*\)\].*/\1/p'
}

# Power button activity after kernel time $1, as "<wake> <press> <release>":
# when the kernel finished waking, the first logged press, the first logged
# release. "-" for each not yet seen; nothing if none of them has happened.
press_since() {
  dmesg 2>/dev/null | awk -v since="${1:-0}" '
    {
      s = $0
      if (s !~ /^\[ *[0-9]/) next
      sub(/^\[ */, "", s)
      ts = substr(s, 1, index(s, "]") - 1) + 0
      if (ts <= since + 0) next
    }
    /pmic:onkey::.*button online event/  { if (on == "") on = ts; next }
    /pmic:onkey::.*button offline event/ { if (off == "") off = ts; next }
    /PM: Finishing wakeup/               { if (wake == "") wake = ts }
    END {
      if (wake != "" || on != "" || off != "")
        print (wake == "" ? "-" : wake), (on == "" ? "-" : on), (off == "" ? "-" : off)
    }'
}

# 0 if the wake was someone asking for the menu: the waking press held for
# LONG_PRESS_MIN before release, or a second press within SECOND_PRESS_WAIT.
long_press_from_log() {
  ticks=0
  short=""
  while :; do
    set -- $(press_since "$SUSPEND_KTS")
    wake=${1:--} on=${2:--} off=${3:--}
    if [ "$on" != "-" ]; then
      # A press that wakes the device is logged late, ~1.8s after the wakeup
      # (seen: wake 9055.59, online 9057.43, no release logged), and only when
      # it is still held. A press made while awake is logged at once. Either
      # way, a logged press after waking is someone at the button.
      echo "Power press logged after waking: menu"
      return 0
    fi
    if [ "$off" != "-" ] && [ -z "$short" ]; then
      from=$wake
      [ "$from" = "-" ] && from=$SUSPEND_KTS
      held=$(awk -v a="$from" -v b="$off" 'BEGIN { printf "%.2f", b - a }')
      if awk -v h="$held" -v m="$LONG_PRESS_MIN" 'BEGIN { exit !(h >= m) }'; then
        echo "Power released ${held}s after waking (needs ${LONG_PRESS_MIN}s): long press"
        return 0
      fi
      echo "Power released ${held}s after waking: short; waiting ${SECOND_PRESS_WAIT}s for a second press"
      short=$ticks
    fi
    if [ -n "$short" ] && [ $((ticks - short)) -ge $((SECOND_PRESS_WAIT * 4)) ]; then
      echo "No second press"
      return 1
    fi
    if [ "$wake" = "-" ] && [ "$off" = "-" ] && [ "$ticks" -ge 4 ]; then
      echo "Nothing logged since suspending"
      return 1
    fi
    if [ "$ticks" -ge $((RELEASE_WAIT * 4)) ]; then
      echo "No power button release within ${RELEASE_WAIT}s; not a press"
      return 1
    fi
    usleep 250000 2>/dev/null || sleep 1
    ticks=$((ticks + 1))
  done
}

# The input device that reports KEY_POWER, from /proc/bus/input/devices. A
# block whose key bitmap includes code 116 (KEY_POWER) - bit 20 of the fourth
# 32-bit word from the right. Matching by name is a fallback.
find_power_dev() {
  [ -n "$POWER_DEV" ] && { echo "$POWER_DEV"; return; }
  awk '
    /^N: Name=/   { name = tolower($0) }
    /^H: Handlers=/ { ev = ""; for (i = 1; i <= NF; i++) if ($i ~ /^event[0-9]+$/) ev = $i }
    /^B: KEY=/ {
      n = split(substr($0, 8), w, " ")
      word = (n >= 4) ? w[n - 3] : ""
      if (word != "" && ev != "") {
        v = 0
        for (i = 1; i <= length(word); i++)
          v = v * 16 + index("0123456789abcdef", substr(word, i, 1)) - 1
        if (int(v / 1048576) % 2 == 1) { print "/dev/input/" ev; found = 1; exit }
      }
    }
    /^$/ { if (!byname && ev != "" && name ~ /onkey|pwrkey|power/) byname = "/dev/input/" ev }
    END { if (!found && byname) print byname }
  ' /proc/bus/input/devices 2>/dev/null
}

# 0 the key is held, 1 it is not, 2 cannot tell.
power_key_down() {
  "$EVTEST" --query "$1" EV_KEY KEY_POWER >/dev/null 2>&1
  case "$?" in
    10) return 0 ;;
    0)  return 1 ;;
    *)  return 2 ;;
  esac
}

# Fallback for a kernel that does not log onkey events: the live key state,
# held for LONG_PRESS_SECS from now. See above for why this misses a press
# that woke the device on this firmware.
long_press_from_state() {
  dev=$(find_power_dev)
  if [ ! -x "$EVTEST" ] || [ -z "$dev" ] || [ ! -r "$dev" ]; then
    echo "Cannot read the power button (dev=${dev:-none}); treating the wake as a press"
    return 0
  fi

  ticks=$((LONG_PRESS_SECS * 4))
  i=0
  while [ "$i" -lt "$ticks" ]; do
    power_key_down "$dev"
    case "$?" in
      1) return 1 ;;
      2) echo "evtest --query unsupported on $dev; treating the wake as a press"
         return 0 ;;
    esac
    usleep 250000 2>/dev/null || sleep 1
    i=$((i + 1))
  done
  return 0
}

# Whether earlier onkey lines are still in the log says nothing: the ring
# buffer is small and a run of suspend/resume cycles flushes them. All the log
# method needs is a timestamp to measure from.
long_press() {
  if [ -n "$SUSPEND_KTS" ]; then
    long_press_from_log
  else
    echo "No kernel log timestamps; reading the key state instead"
    long_press_from_state
  fi
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

# 1 whenever the panel shows something other than the current view: the
# Kindle UI at launch, the menu, a "Fetching..." or error message. A 304 means
# the *frame* is unchanged, not that the frame is on screen, so an unchanged
# poll repaints the cached frame while this is set and only leaves the screen
# alone when it is clear.
#
# This replaces reasoning about which path we arrived by. That reasoning is how
# the menu, and later the error message after a failed tap, each outlived
# every following poll: some path painted over the frame and the next 304
# assumed the frame was still there.
SCREEN_DIRTY=1

paint() {
  img="$1"
  [ -f "$img" ] || { echo "missing screen: $img"; return 1; }
  SCREEN_DIRTY=0

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
  SCREEN_DIRTY=1
  /usr/sbin/eips -c >/dev/null 2>&1
  row=6
  for line in "$@"; do
    /usr/sbin/eips 4 "$row" "$line" >/dev/null 2>&1
    row=$((row + 2))
  done
}

# -------------------------------------------------------------- content ----

# ------------------------------------------------------------- network ----
#
# The radio is off through suspend and takes 5-15 seconds to associate again
# after a wake. Every fetch therefore starts against a network that does not
# work yet, and the failure is immediate rather than slow: with no route, the
# request errors out in milliseconds instead of using its timeout. Three
# attempts three seconds apart is under ten seconds of trying, so the device
# would give up and suspend just as the radio came up.
#
# This waits for the local network to actually be usable before asking for
# anything. It is not the ICMP pre-check that was rejected before, and for the
# same reason: that probed the *server*, which a host with ICMP filtered would
# fail while HTTP worked. These are local facts about this device's own radio,
# and none of them can be wrong about a remote host.
NETWORK_WAIT=${NETWORK_WAIT:-45}

# 0 ready, 1 not ready, 2 cannot tell.
network_ready() {
  # wifid is the device's own view of association, and the cheapest to ask.
  state=$(lipc-get-prop com.lab126.wifid cmState 2>/dev/null)
  case "$state" in
    CONNECTED|READY) return 0 ;;
    '')              ;;        # wifid not answering - fall through
    *)               return 1 ;;  # SCANNING, PENDING, NA, disconnected
  esac

  # Busybox ifconfig prints "inet addr:10.0.4.52"; some builds print "inet
  # 10.0.4.52". An address on the wireless interface means DHCP has completed.
  if ifconfig wlan0 >/dev/null 2>&1; then
    ifconfig wlan0 2>/dev/null | grep -qE 'inet (addr:)?[0-9]+\.' && return 0
    return 1
  fi

  return 2
}

# The host part of FRAME_URL: strip scheme, then userinfo, then path, then
# port. Only used to ask the resolver a question.
frame_host() {
  echo "$FRAME_URL" \
    | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|[/?].*$||' \
          -e 's|^.*@||' -e 's|:[0-9]*$||'
}

# Association is not enough. The observed failure on this device is not a
# missing route, it is DNS:
#
#   dns error: failed to lookup address information: Try again
#
# The radio associates and DHCP completes, but the resolver is not usable for
# another moment, so a fetch fired the instant an address appears still fails.
# This asks the *local* resolver to resolve one name - it is not a reachability
# probe of the server, and a server that is down still answers here.
dns_ready() {
  host=$(frame_host)
  [ -n "$host" ] || return 0

  # A bare IP needs no resolver.
  case "$host" in
    *[!0-9.]*) ;;
    *) return 0 ;;
  esac

  # No resolver tool: not something to block on.
  command -v nslookup >/dev/null 2>&1 || return 0

  nslookup "$host" >/dev/null 2>&1
}

# Block until the network is actually usable, or the budget runs out. Never
# fails the caller: a fetch over a network that turns out not to work is no
# worse than today's behaviour, and the fetch has its own retries underneath.
wait_for_network() {
  budget=${1:-$NETWORK_WAIT}
  waited=0

  network_ready
  if [ "$?" = 2 ]; then
    # No way to inspect the radio on this firmware. Give it a flat settle
    # window anyway - an unconditional short wait is what makes this robust
    # on a device whose state we cannot read.
    echo "Cannot read network state; settling for 10s"
    sleep 10
    return 0
  fi

  while :; do
    if network_ready && dns_ready; then
      [ "$waited" -gt 0 ] && echo "Network up after ${waited}s"
      return 0
    fi
    [ "$waited" -ge "$budget" ] && break
    sleep 2
    waited=$((waited + 2))
  done

  echo "Network still not ready after ${budget}s; trying anyway"
  return 0
}

# announce is one of:
#   no       a scheduled poll. Silent.
#   yes      a menu choice. Say what is happening, and report a failure.
#   restore  the menu timed out. Silent, and on failure fall back to the last
#            good frame rather than leave the menu up.
# Whether an unchanged frame is repainted is decided by SCREEN_DIRTY, not by
# this.
refresh_from_server() {
  announce=${1:-no}

  [ "$announce" = yes ] && notify "Fetching from server..." "$FRAME_URL"

  # Wait for the radio before spending the fetch's retries on a network that
  # is not up yet. Without this the attempts are consumed in the first few
  # seconds after a wake, which is exactly when they cannot succeed.
  wait_for_network

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
      if [ "$SCREEN_DIRTY" = 0 ]; then
        echo "Content unchanged, leaving screen as-is"
      else
        echo "Content unchanged, repainting the cached frame"
        paint "$DASH_PNG" || return 1
      fi
      return 0
      ;;
    0)
      paint "$DASH_PNG"
      return 0
      ;;
    *)
      echo "Fetch failed ($status)"
      # The last line is the summary - "HEAD failed after 4 attempts: ..." -
      # where the first is only ever "no response, attempt 1", which says
      # nothing about why.
      [ "$announce" = yes ] && notify "Could not fetch the frame." \
        "$(echo "$err" | grep -v '^[[:space:]]*$' | tail -n 1)" \
        "" \
        "Hold power 2s for the menu."
      # Nobody is watching a timed-out menu, so an error message would sit
      # there unread. The last good frame is a better thing to leave up; the
      # retry path will replace it once the fetch works.
      [ "$announce" = restore ] && [ -f "$DASH_PNG" ] && paint "$DASH_PNG"
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

  # modal.sh paints the menu itself, outside paint().
  SCREEN_DIRTY=1
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
      rm -f "$AUTOSTART_FILE"
      start_ui
      exit 0
      ;;
    *)
      # Timed out, or the menu could not run. Restore the current view rather
      # than leaving the menu on screen - `restore`, not a plain refresh, so a
      # 304 still repaints.
      force_full_refresh
      render_current restore
      ;;
  esac
}

# ----------------------------------------------------------------- main ----

log_battery() {
  echo "$(date) Battery: $(gasgauge-info -c 2>/dev/null)"
}

# Seconds until the next scheduled poll.
#
# REFRESH_SCHEDULE holds one or more cron expressions separated by ';'.
# next-wakeup takes a single expression, and one 5-field expression cannot
# describe a schedule whose minute field changes with the hour - "every 15
# minutes on weekday mornings, hourly the rest of the day, never overnight"
# needs the minutes to be */15 for some hours and 0 for others. Asking each
# expression when it would next fire and taking the earliest does describe it,
# and overlapping expressions are harmless because the earliest simply wins.
next_wakeup() {
  earliest=""
  old_ifs=$IFS

  IFS=';'
  for expr in $REFRESH_SCHEDULE; do
    IFS=$old_ifs
    [ -n "$expr" ] || continue

    secs=$("$DIR/next-wakeup" --schedule="$expr" --timezone="$TIMEZONE" 2>/dev/null)

    # A rejected expression exits non-zero and prints nothing usable. Skip it
    # instead of letting an empty string reach the arithmetic below, where it
    # would be a syntax error and take the loop down.
    case "$secs" in
      '' | *[!0-9]*)
        echo "Ignoring unusable schedule '$expr'" >&2
        IFS=';'
        continue
        ;;
    esac

    if [ -z "$earliest" ] || [ "$secs" -lt "$earliest" ]; then
      earliest=$secs
    fi
    IFS=';'
  done
  IFS=$old_ifs

  # Nothing parsed. An hour keeps a misconfigured device coming back on its
  # own rather than suspending with no alarm armed, which needs a hard reset.
  if [ -z "$earliest" ]; then
    echo "No usable schedule in '$REFRESH_SCHEDULE'; falling back to 3600s" >&2
    earliest=3600
  fi

  echo "$earliest"
}

init() {
  if [ -z "$TIMEZONE" ] || [ -z "$REFRESH_SCHEDULE" ]; then
    echo "Missing configuration. Timezone: ${TIMEZONE:-unset}, schedule: ${REFRESH_SCHEDULE:-unset}."
    exit 1
  fi

  detect_rtc
  load_state
  echo "Starting Frame (mode=$MODE orientation=$ORIENT schedule=$REFRESH_SCHEDULE)"

  : >"$AUTOSTART_FILE"

  stop_ui
  echo powersave >/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null
}

main_loop() {
  fetch_failures=0

  while true; do
    log_battery

    next_wakeup_secs=$(next_wakeup)
    render_current
    render_status=$?

    # A failed fetch used to cost a whole scheduled interval, because the loop
    # suspended until the next cron slot regardless. That was survivable when
    # the device polled every couple of minutes. It is not now: a failure at
    # 18:00 would leave a stale panel until 07:00 the next morning, and one on
    # Saturday would hold it until Sunday. Retry soon instead, then fall back
    # to the schedule so a genuinely offline server cannot keep the radio busy
    # all night.
    if [ "$render_status" -ne 0 ] && [ "$fetch_failures" -lt "$FETCH_RETRY_MAX" ]; then
      fetch_failures=$((fetch_failures + 1))
      sleep_secs=$((FETCH_RETRY_DELAY * fetch_failures))
      # Never postpone a scheduled poll that would have come sooner.
      [ "$sleep_secs" -gt "$next_wakeup_secs" ] && sleep_secs=$next_wakeup_secs
      echo "Refresh failed; retrying in ${sleep_secs}s (${fetch_failures}/${FETCH_RETRY_MAX})"
    else
      [ "$render_status" -eq 0 ] || echo "Refresh still failing; waiting for the next scheduled poll"
      fetch_failures=0
      sleep_secs=$next_wakeup_secs
    fi

    # A moment before suspending, so the loop can be interrupted over SSH.
    sleep 10

    echo "Suspending, next wakeup in ${sleep_secs}s"
    rtc_sleep "$sleep_secs"

    # Only a held power button opens the menu. Anything else that wakes the
    # device early - a spurious onkey event, a brush of the button - goes
    # straight back to sleep for what is left of the original alarm, with
    # nothing painted, so the frame stays exactly as it was.
    while woke_early; do
      margin=$((WAKE_TARGET - $(date +%s)))
      if long_press; then
        echo "$(date) Long press ${margin}s before the alarm: menu"
        show_menu
        break
      fi
      echo "$(date) Woke ${margin}s before the alarm without a long press; back to sleep"
      # Also stops a suspend that fails instantly from spinning this loop.
      sleep 2
      rtc_sleep "$margin"
    done
  done
}

init
# Show the menu on a manual launch, so the first thing you get is a choice and
# there is always a visible way out. Not after a reboot: boot.sh sets
# FRAME_AUTOSTART, and the device goes straight back to the view it was
# showing. SCREEN_DIRTY is still set, so even a 304 paints the cached frame
# over the Kindle UI.
if [ "${FRAME_AUTOSTART:-0}" = 1 ]; then
  echo "Autostarted after boot; resuming $MODE without the menu"
  force_full_refresh
else
  show_menu
fi
main_loop
