#!/bin/sh
# Name: Block OTA
# Author: built for the PW3 desk display
# Description: Renames the OTA update binaries, reporting each step. Unlike
#              renameotabin's rename.sh this checks its work and does not
#              reboot, so failures are visible instead of silent.

OTA1=/usr/bin/otaupd
OTA2=/usr/bin/otav3

# sh_integration redirects stdout/stderr to the screen via fbink, so plain
# echo is enough here.
say() { echo "$@"; }

say "--- Block OTA ---"

# Nothing to do if it already worked.
if [ -f "${OTA1}.bck" ] && [ -f "${OTA2}.bck" ]; then
  say "Already blocked: both .bck files present."
  say "Nothing to do."
  exit 0
fi

say "Remounting rootfs read-write..."
if ! mntroot rw; then
  say "FAILED: mntroot rw returned non-zero."
  say "Cannot continue."
  exit 1
fi

# The jailbreak sets the immutable bit on files it wants to protect, and a
# chattr'd file cannot be renamed even as root. Clear it defensively; the
# binaries are not normally immutable, so a failure here is not fatal.
for f in "$OTA1" "$OTA2"; do
  [ -f "$f" ] && chattr -i "$f" 2>/dev/null
done

rc=0
for f in "$OTA1" "$OTA2"; do
  if [ ! -f "$f" ]; then
    if [ -f "${f}.bck" ]; then
      say "OK: $(basename "$f") already renamed."
    else
      say "WARN: $(basename "$f") not found, and no .bck either."
      rc=1
    fi
    continue
  fi

  if mv "$f" "${f}.bck" 2>/dev/null; then
    say "OK: renamed $(basename "$f")"
  else
    say "FAILED: could not rename $(basename "$f")"
    ls -la "$f" 2>/dev/null | while read -r line; do say "  $line"; done
    lsattr "$f" 2>/dev/null | while read -r line; do say "  attrs: $line"; done
    rc=1
  fi
done

sync
say "Remounting rootfs read-only..."
mntroot ro

say ""
if [ -f "${OTA1}.bck" ] && [ -f "${OTA2}.bck" ] \
   && [ ! -f "$OTA1" ] && [ ! -f "$OTA2" ]; then
  say "RESULT: OTA blocking is ENABLED."
  say "Reboot, then confirm with Check OTA status."
  exit 0
fi

say "RESULT: OTA blocking is NOT fully enabled."
say "Do not connect to Wi-Fi yet."
exit "$rc"
