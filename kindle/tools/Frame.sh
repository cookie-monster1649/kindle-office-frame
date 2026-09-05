#!/bin/sh
# Name: Frame
# Author: desk display
# Description: Start the desk dashboard. Press power then tap Close to come back.
#
# Lives in documents/ so sh_integration surfaces it as a library item.
#
# The dashboard stops the UI framework, which kills the process group this
# script was launched from. Without detaching first, dash.sh would be torn
# down by the very thing it just did. setsid gives it its own session so it
# survives; nohup alone is not enough because the whole group gets signalled.

DASH_DIR=/mnt/us/dashboard
LOG="$DASH_DIR/logs/dash.log"

echo "Frame"
echo ""

if [ ! -x "$DASH_DIR/dash.sh" ]; then
  echo "ERROR: $DASH_DIR/dash.sh not found."
  echo "Nothing started."
  exit 1
fi

if ps 2>/dev/null | grep -q "[d]ash.sh"; then
  echo "Already running."
  exit 0
fi

mkdir -p "$(dirname "$LOG")"

# shellcheck disable=SC1090
[ -f "$DASH_DIR/local/env.sh" ] && . "$DASH_DIR/local/env.sh"

echo "Starting dashboard..."
echo "The Kindle interface will close shortly."
echo ""
echo "To come back: press power, then tap Close."
sleep 2

if command -v setsid >/dev/null 2>&1; then
  setsid "$DASH_DIR/dash.sh" >>"$LOG" 2>&1 &
else
  # No setsid: at least survive the hangup, and give dash.sh a moment to get
  # going before the framework goes down underneath it.
  nohup "$DASH_DIR/dash.sh" >>"$LOG" 2>&1 &
fi

exit 0
