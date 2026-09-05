#!/usr/bin/env sh
# Stop the dashboard and hand the screen back to the Kindle UI.
# Mirrors dash.sh's start_ui(): nothing was killed, so nothing is restarted.
pkill -f "/mnt/us/dashboard/dash.sh"
sleep 1

killall -CONT awesome 2>/dev/null
[ -f /etc/upstart/statusbar.conf ] && /sbin/start statusbar >/dev/null 2>&1
lipc-set-prop com.lab126.pillow disableEnablePillow enable 2>/dev/null
lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home 2>/dev/null
lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null
echo "Dashboard stopped, Kindle UI restored."
