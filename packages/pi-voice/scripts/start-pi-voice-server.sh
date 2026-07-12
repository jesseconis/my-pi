#!/usr/bin/env bash
set -euo pipefail

HOST="${PI_VOICE_HOST:-127.0.0.1}"
PORT="${PI_VOICE_PORT:-8181}"
DTYPE="${PI_VOICE_MODEL:-q8}"
HOME_DIR="${HOME:?}"
VOICE_DIR="${PI_VOICE_DIR:-$HOME_DIR/.pi/voice}"
VOICE_ENV="$VOICE_DIR/local-repo.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$VOICE_ENV" ]; then
  # shellcheck disable=SC1090
  . "$VOICE_ENV"
fi

PI_VOICE_PACKAGE_DIR="${PI_VOICE_PACKAGE_DIR:-$SOURCE_PACKAGE_DIR}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ -z "${JITI_CLI:-}" ]; then
  for candidate in \
    "$PI_VOICE_PACKAGE_DIR/node_modules/jiti/lib/jiti-cli.mjs" \
    "$PI_VOICE_PACKAGE_DIR/../../node_modules/jiti/lib/jiti-cli.mjs" \
    "$HOME_DIR/.pi/agent/npm/node_modules/jiti/lib/jiti-cli.mjs"; do
    if [ -f "$candidate" ]; then
      JITI_CLI="$candidate"
      break
    fi
  done
fi

if [ -z "${JITI_CLI:-}" ] || [ ! -f "$JITI_CLI" ]; then
  echo "Could not find jiti. Run pnpm install in the monorepo or set JITI_CLI." >&2
  exit 1
fi

SERVER="$PI_VOICE_PACKAGE_DIR/extensions/server.ts"
PID_FILE="$VOICE_DIR/voice.pid"

if [ ! -f "$SERVER" ]; then
  echo "Missing pi-voice server at $SERVER" >&2
  exit 1
fi

mkdir -p "$VOICE_DIR"
cd "$PI_VOICE_PACKAGE_DIR"

export PYTORCH_ENABLE_MPS_FALLBACK=1
export JITI_CLI PI_VOICE_PACKAGE_DIR

echo "[$(date)] Starting pi-voice Kokoro server on http://$HOST:$PORT (model=$DTYPE)"
echo "[$(date)] Using pi-voice package: $PI_VOICE_PACKAGE_DIR"

"$NODE_BIN" "$JITI_CLI" "$SERVER" --host "$HOST" --port "$PORT" &
server_pid=$!
echo "$server_pid" >"$PID_FILE"

cleanup() {
  echo "[$(date)] Stopping pi-voice server pid=$server_pid"
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 150); do
  if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "[$(date)] pi-voice server exited before becoming healthy"
    wait "$server_pid"
  fi
  sleep 0.2
done

if ! curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then
  echo "[$(date)] pi-voice server did not become healthy"
  exit 1
fi

echo "[$(date)] Ensuring Kokoro model is downloaded and active: $DTYPE"
curl -fsS -X POST "http://$HOST:$PORT/models/download" \
  -H 'Content-Type: application/json' \
  -d "{\"dtype\":\"$DTYPE\",\"activate\":true}"
echo
curl -fsS "http://$HOST:$PORT/health"
echo

wait "$server_pid"
