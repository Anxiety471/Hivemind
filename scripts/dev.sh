#!/usr/bin/env bash
# Run the Hivemind API server and the web UI dev server together.
#   scripts/dev.sh                      # API http://127.0.0.1:7474, UI http://127.0.0.1:5173
#   scripts/dev.sh --config my.toml     # extra args are passed to `hivemind serve`
#   HIVEMIND_BIN=target/release/hivemind scripts/dev.sh   # skip `cargo run`
# Ctrl-C (or either process exiting) stops both.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -n "${HIVEMIND_BIN:-}" ]; then
  "$HIVEMIND_BIN" serve "$@" &
else
  cargo run --locked --quiet -- serve "$@" &
fi
pids+=($!)

(cd frontend && exec npm run dev) &
pids+=($!)

# Exit as soon as either process dies, propagating its status.
wait -n
