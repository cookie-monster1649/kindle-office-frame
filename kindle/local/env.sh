#!/usr/bin/env sh

# --- Endpoint -----------------------------------------------------------
# Must be a hostname, not an IP: xh uses rustls, which refuses HTTPS to
# bare IP addresses.
export FRAME_URL=${FRAME_URL:-"https://kindleframe.monester.au/frame.png"}

# The server's READ token. This device must never hold the write token: it
# sits unattended, could be lost, and has no business changing anything.
# The server returns 403 to this token on every write endpoint.
export FRAME_TOKEN=${FRAME_TOKEN:-"set-me-to-the-read-token"}

# --- Schedule -----------------------------------------------------------
# Cron expression, not an interval. Every 15 minutes, all day.
# Unchanged content returns 304 and never touches the screen, so a short
# poll interval is cheap.
export REFRESH_SCHEDULE=${REFRESH_SCHEDULE:-"*/15 * * * *"}

# Only feeds next-wakeup's cron maths. The device clock is UTC and it ships no
# tzdata, so nothing here affects what is printed - the server renders the
# date and decides the weekend, in its own timezone.
export TIMEZONE=${TIMEZONE:-"Australia/Melbourne"}

# --- Display ------------------------------------------------------------
# A full (flashing) refresh is triggered every Nth *actual redraw*.
# Polls that return 304 do not count, so on mostly-static content this
# flashes rarely. Lower = crisper text, more flashing.
export FULL_DISPLAY_REFRESH_RATE=${FULL_DISPLAY_REFRESH_RATE:-4}

# --- Fetch ---------------------------------------------------------------
# The radio is down during suspend and needs a few seconds after a wake, so
# the fetch retries rather than being gated behind a reachability probe. A
# ping-based pre-check is the wrong tool: it misreports any host that filters
# ICMP, which would block a request that would otherwise have succeeded.
export FETCH_ATTEMPTS=${FETCH_ATTEMPTS:-3}
export FETCH_TIMEOUT=${FETCH_TIMEOUT:-10}

# How long the menu waits for a tap before restoring the current view.
export MENU_TIMEOUT=${MENU_TIMEOUT:-30}

# --- Cloudflare Access (optional) ---------------------------------------
#
# Set these when the endpoint sits behind Cloudflare Access. They are a
# *service token*: a non-interactive credential, because a headless Kindle
# cannot complete an SSO login.
#
# Scope the Access policy for this token to /frame.png alone. Then losing the
# device leaks a credential that can fetch frames and nothing else - it cannot
# reach the control page or any write endpoint, even before the read/write
# token split is considered.
#
# export CF_ACCESS_CLIENT_ID="....access"
# export CF_ACCESS_CLIENT_SECRET="...."
