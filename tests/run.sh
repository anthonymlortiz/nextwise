#!/usr/bin/env bash
#
# Browser test runner.
#
# There is no test framework in this project; these suites drive a real headless
# Chrome over the DevTools Protocol so IndexedDB, Dexie transactions and React
# rendering are all exercised for real rather than mocked.
#
# Usage:
#   ./tests/run.sh            # engine, both providers, and the UI, against the dev server
#   ./tests/run.sh prod       # smoke test the production build instead
#
# SUITES_OVERRIDE="tests/dual.mjs" ./tests/run.sh   # narrow the run while iterating
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=9224
PROFILE="${TMPDIR:-/tmp}/fbchrome"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
MODE="${1:-dev}"

[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME"; exit 1; }

cleanup() {
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

if [ "$MODE" = "prod" ]; then
  npm run build
  TARGET=http://localhost:4178/
  START=(env HTTPS=0 npx vite preview --port 4178 --strictPort)
  SUITES=(tests/prod.mjs)
else
  # Port 5174, not the dev server's 5173, so `npm test` works while you have
  # `npm run dev` running. Plain HTTP: a self-signed cert adds noise, no coverage.
  TARGET=http://localhost:5174/
  START=(env HTTPS=0 npx vite --port 5174 --strictPort)
  # migration runs first: it rebuilds the database from scratch to replay the
  # v2 -> v4 upgrade, so it must not land in the middle of another suite.
  SUITES=(${SUITES_OVERRIDE:-tests/migration.mjs tests/engine.mjs tests/google.mjs tests/dual.mjs tests/syncui.mjs tests/projects.mjs tests/chat.mjs tests/dates.mjs tests/links.mjs tests/theme.mjs tests/fields.mjs tests/session.mjs tests/backup.mjs})
fi

# Reuse an already-running server; --strictPort keeps the suites' hardcoded
# URLs honest instead of letting Vite silently pick a different port.
if ! curl -sf -o /dev/null "$TARGET"; then
  "${START[@]}" >/dev/null 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "$TARGET" && break
    sleep 0.5
  done
fi

rm -rf "$PROFILE" && mkdir -p "$PROFILE"
"$CHROME" --headless=new --disable-gpu --no-sandbox --no-first-run --disable-extensions \
  --user-data-dir="$PROFILE" --remote-debugging-port=$PORT about:blank \
  >"$PROFILE/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://localhost:$PORT/json/version" && break
  sleep 0.5
done

export TEST_URL="$TARGET"

STATUS=0
for suite in "${SUITES[@]}"; do
  echo "### $suite"
  node "$suite" || STATUS=1
done
exit $STATUS
