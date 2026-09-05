#!/usr/bin/env sh
# Fetch the current frame into "$1", using a conditional request.
#
# Exit codes:
#   0  - new image written to "$1", caller should redraw
#   20 - content unchanged, caller should skip the redraw
#   1  - anything else went wrong, caller should leave the screen alone
#
# Strategy: a conditional HEAD carries the stored ETag. Unchanged content
# comes back 304 and costs a few hundred bytes with no image transfer and
# no screen refresh, which is the common case. Only when the ETag differs
# do we spend a GET on the actual PNG.

DIR="$(dirname "$0")"
OUT="$1"

XH="$DIR/../xh"
STATE_DIR="$DIR/state"
ETAG_FILE="$STATE_DIR/etag"
HDR_FILE="$STATE_DIR/headers.tmp"
TMP_BODY="$STATE_DIR/frame.tmp"

[ -z "$OUT" ] && echo "No output path given" && exit 1
[ -z "$FRAME_URL" ] && echo "FRAME_URL is not set" && exit 1

# Tell the server what to render. MODE is the device's menu choice, which the
# server may honour (in/out) or override (server). ORIENT decides whether it
# composes 1072x1448 or 1448x1072.
#
# Appended here rather than baked into FRAME_URL so the configured endpoint
# stays a plain URL, and so a hand-set FRAME_URL with its own query string
# still works.
QUERY="mode=${MODE:-server}&orient=${ORIENT:-portrait}"
case "$FRAME_URL" in
  *\?*) URL="${FRAME_URL}&${QUERY}" ;;
  *)    URL="${FRAME_URL}?${QUERY}" ;;
esac

mkdir -p "$STATE_DIR"

auth_header=""
[ -n "$FRAME_TOKEN" ] && auth_header="Authorization:Bearer $FRAME_TOKEN"

# Cloudflare Access service token, when the endpoint sits behind Access.
#
# Two independent layers, and they are checked by different things: these
# headers get the request *through Cloudflare*, the bearer token above gets it
# past the application. Losing the device leaks both, which is why the Access
# policy for the service token should be scoped to /frame.png only - it then
# cannot reach the control page or the write endpoints.
cf_id_header=""
cf_secret_header=""
if [ -n "$CF_ACCESS_CLIENT_ID" ] && [ -n "$CF_ACCESS_CLIENT_SECRET" ]; then
  cf_id_header="CF-Access-Client-Id:$CF_ACCESS_CLIENT_ID"
  cf_secret_header="CF-Access-Client-Secret:$CF_ACCESS_CLIENT_SECRET"
fi

etag=""
[ -f "$ETAG_FILE" ] && etag=$(cat "$ETAG_FILE" 2>/dev/null)

# --- 1. Conditional HEAD ------------------------------------------------
# xh's grammar is: xh [OPTIONS] <[METHOD] URL> [REQUEST_ITEM]...
# Headers are REQUEST_ITEMs and must follow the method and URL, not precede
# them, or xh parses the first header as the URL.
#
# Retried with a short timeout rather than gated behind a separate reachability
# probe. The radio is down during suspend and needs a few seconds afterwards,
# but a ping-based pre-check is the wrong tool: a host with ICMP filtered -
# macOS stealth mode, say - never answers, so the check fails while HTTP would
# have worked perfectly. Letting the real request retry tests the one thing
# that actually matters.
attempt=1
status=""
while [ "$attempt" -le "${FETCH_ATTEMPTS:-3}" ]; do
  set -- --ignore-stdin --print=h --output "$HDR_FILE" \
         --timeout "${FETCH_TIMEOUT:-10}" HEAD "$URL"
  [ -n "$auth_header" ]      && set -- "$@" "$auth_header"
  [ -n "$cf_id_header" ]     && set -- "$@" "$cf_id_header"
  [ -n "$cf_secret_header" ] && set -- "$@" "$cf_secret_header"
  [ -n "$etag" ] && set -- "$@" "If-None-Match:$etag"

  # xh 0.16.1 has --check-status on by default and no way to disable it, so a
  # 304 exits 3 and a 4xx exits 4. That makes the exit code useless for telling
  # "no response" from "a response we asked for". Ignore it and judge by
  # whether a status line came back instead.
  xh_err=$("$XH" "$@" 2>&1 >/dev/null)
  status=$(head -n 1 "$HDR_FILE" 2>/dev/null | awk '{print $2}')

  [ -n "$status" ] && break

  echo "No response (attempt $attempt), waiting for the network..."
  attempt=$((attempt + 1))
  sleep 3
done

if [ -z "$status" ]; then
  echo "HEAD failed after $((attempt - 1)) attempts: ${xh_err:-no error output}"
  rm -f "$HDR_FILE"
  exit 1
fi

if [ "$status" = "304" ]; then
  echo "Frame unchanged (304)"
  rm -f "$HDR_FILE"
  exit 20
fi

if [ "$status" != "200" ]; then
  echo "Unexpected status from HEAD: ${status:-<none>}"
  rm -f "$HDR_FILE"
  exit 1
fi

# Header names are case-insensitive. Keep the value verbatim apart from the
# trailing CR: the quotes are part of the ETag and If-None-Match is ignored
# without them, and a weak validator keeps its W/ prefix too.
new_etag=$(awk 'tolower($1) == "etag:" { print $2 }' "$HDR_FILE" | tr -d '\r' | head -n 1)
rm -f "$HDR_FILE"

# --- 2. Body only when it actually changed ------------------------------
set -- --ignore-stdin --print=b --output "$TMP_BODY" --timeout 60 GET "$URL"
[ -n "$auth_header" ]      && set -- "$@" "$auth_header"
[ -n "$cf_id_header" ]     && set -- "$@" "$cf_id_header"
[ -n "$cf_secret_header" ] && set -- "$@" "$cf_secret_header"

# Same reasoning as the HEAD: ignore the exit code and validate the payload,
# which the PNG magic-byte check below does properly anyway.
xh_err=$("$XH" "$@" 2>&1 >/dev/null)

# Refuse to draw an empty file, and sanity-check the PNG magic bytes so a
# proxy error page never reaches eips.
if [ ! -s "$TMP_BODY" ]; then
  echo "Empty body: ${xh_err:-no error output}"
  rm -f "$TMP_BODY"
  exit 1
fi

if [ "$(dd if="$TMP_BODY" bs=1 skip=1 count=3 2>/dev/null)" != "PNG" ]; then
  echo "Response is not a PNG"
  rm -f "$TMP_BODY"
  exit 1
fi

mv "$TMP_BODY" "$OUT"

# Only persist the ETag once the image is safely in place, so a failure
# mid-way retries cleanly next cycle instead of silently skipping.
[ -n "$new_etag" ] && printf '%s' "$new_etag" >"$ETAG_FILE"

echo "New frame fetched"
exit 0
