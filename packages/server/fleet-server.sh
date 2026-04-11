#!/bin/bash
# Fleet server launcher — always-on service
# Usage: ./fleet-server.sh start|stop|status|logs
# Requires: doppler CLI with openclaw/prd config

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SERVER_DIR/.data/fleet-server.pid"
LOG_FILE="$SERVER_DIR/.data/fleet-server.log"
PORT="${FLEET_SERVER_PORT:-4020}"

mkdir -p "$SERVER_DIR/.data"

case "${1:-status}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Fleet server already running (PID $(cat "$PID_FILE"))"
      exit 0
    fi

    # Also check if port is already in use (catches stale PID file scenarios)
    if ss -tlnp 2>/dev/null | grep -q ":${PORT} " || lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Port $PORT already in use — server likely running with stale PID file"
      # Try to recover the PID
      PID=$(lsof -ti ":${PORT}" -sTCP:LISTEN 2>/dev/null | head -1)
      [ -n "$PID" ] && echo "$PID" > "$PID_FILE" && echo "Recovered PID: $PID"
      exit 0
    fi

    echo "Starting fleet server on port $PORT..."
    cd "$SERVER_DIR"
    nohup doppler run --project openclaw --config prd -- \
      env INTELLIGENCE_ENABLED=true INTELLIGENCE_INTERVAL_SEC=60 \
      ALERT_COIN_SWAPS_1H=120 \
      ALERT_MIN_MOMENTUM_1H=500 \
      ALERT_MIN_ACCELERATION_1H=2.5 \
      ALERT_ACCEL_SPIKE_MIN_SWAPS_1H=20 \
      ALERT_ACCEL_SPIKE_MIN_ACCELERATION_1H=5.0 \
      ALERT_PER_COIN_COOLDOWN_MIN=60 \
      ALERT_NOVELTY_WINDOW_HOURS=24 \
      ALERT_WHALE_SWAP_USD=10000 \
      npx tsx src/index.ts \
      >> "$LOG_FILE" 2>&1 &

    echo $! > "$PID_FILE"
    sleep 2

    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Fleet server started (PID $(cat "$PID_FILE"))"
    else
      echo "Fleet server failed to start. Check logs: $LOG_FILE"
      tail -20 "$LOG_FILE"
      exit 1
    fi
    ;;

  stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping fleet server (PID $PID)..."
        kill "$PID"
        sleep 2
        if kill -0 "$PID" 2>/dev/null; then
          echo "Force killing..."
          kill -9 "$PID"
        fi
        echo "Stopped."
      else
        echo "PID $PID not running."
      fi
      rm -f "$PID_FILE"
    else
      echo "No PID file found."
    fi
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      PID=$(cat "$PID_FILE")
      UPTIME=$(ps -o etime= -p "$PID" 2>/dev/null | xargs)
      echo "Fleet server running (PID $PID, uptime: $UPTIME)"
      # Health check via API
      HEALTH=$(curl -sf "http://localhost:$PORT/health" 2>/dev/null || echo '{"ok":false}')
      echo "Health: $HEALTH"
    else
      echo "Fleet server not running."
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
    fi
    ;;

  logs)
    LINES="${2:-50}"
    if [ -f "$LOG_FILE" ]; then
      tail -n "$LINES" "$LOG_FILE"
    else
      echo "No log file found."
    fi
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|logs [N]}"
    exit 1
    ;;
esac
