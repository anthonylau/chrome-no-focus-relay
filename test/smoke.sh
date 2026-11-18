#!/bin/sh
# Protocol smoke test: a throwaway headless Chromium behind the relay, driven
# by agent-browser. Checks that the relay rewrites createTarget, swallows
# bringToFront/activateTarget and turns on focus emulation. It cannot check
# macOS focus; use test/mac-focus-watch.sh on the Mac for that.
set -eu

DIR=$(cd "$(dirname "$0")/.." && pwd)
CHROME=${CHROME:-$(command -v chromium || command -v google-chrome || true)}
CHROME_PORT=${CHROME_PORT:-9333}
RELAY_PORT=${RELAY_PORT:-9334}
SESSION=relay-smoke-$$
WORK=$(mktemp -d)

[ -n "$CHROME" ] || { echo "no chromium found, set CHROME"; exit 2; }

CHROME_PID=
RELAY_PID=

cleanup() {
  agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
  for pid in $RELAY_PID $CHROME_PID; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  # Chrome's helper processes outlive the main one and keep writing to the
  # profile; stop them and let them exit before removing it.
  pkill -f -- "$WORK/" 2>/dev/null || true
  for _ in $(seq 1 25); do
    pgrep -f -- "$WORK/" >/dev/null || break
    sleep 0.2
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# wait_for NAME PORT LOG: wait for a CDP endpoint, or fail and show its log.
wait_for() {
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$2/json/version" >/dev/null && return 0
    sleep 0.2
  done
  echo "$1 did not start on port $2"
  echo "--- $3"; cat "$3"
  exit 1
}

"$CHROME" --headless=new --no-sandbox --disable-gpu --no-first-run \
  --user-data-dir="$WORK/profile" --remote-debugging-port="$CHROME_PORT" \
  about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!

wait_for Chrome "$CHROME_PORT" "$WORK/chrome.log"

node "$DIR/relay.mjs" --listen "127.0.0.1:$RELAY_PORT" \
  --upstream "127.0.0.1:$CHROME_PORT" --verbose >"$WORK/relay.log" 2>&1 &
RELAY_PID=$!
wait_for relay "$RELAY_PORT" "$WORK/relay.log"

ab() { agent-browser --session "$SESSION" "$@"; }
PAGE='data:text/html,<title>relay</title><button id="b" onclick="window.n=(window.n||0)+1">b</button>'

fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

ab --cdp "http://127.0.0.1:$RELAY_PORT" --pin-tab tab new "$PAGE" >/dev/null
ab tab new "$PAGE" >/dev/null
ab tab list > "$WORK/tabs.txt"
first=$(grep -o '\[t[0-9]*\]' "$WORK/tabs.txt" | tail -2 | head -1 | tr -d '[]')
ab tab "$first" >/dev/null
ab click '#b' >/dev/null
clicks=$(ab eval 'window.n || 0')
ab screenshot "$WORK/shot.png" >/dev/null

check "click reached the page" '[ "$clicks" = "1" ]'
check "screenshot written" '[ -s "$WORK/shot.png" ]'
check "createTarget rewritten" 'grep -q "createTarget background" "$WORK/relay.log"'
check "Page.bringToFront swallowed" 'grep -q "swallowed Page.bringToFront" "$WORK/relay.log"'
check "focus emulation enabled" 'grep -q "focus emulation on" "$WORK/relay.log"'
check "no relay command errors" '! grep -q "relay command failed" "$WORK/relay.log"'

if [ "$fail" -ne 0 ]; then
  echo "--- relay.log"; cat "$WORK/relay.log"
fi
exit "$fail"
