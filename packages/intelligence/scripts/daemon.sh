#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-status}"
case "$cmd" in
  start) bun run daemon:start ;;
  stop) bun run daemon:stop ;;
  status) bun run daemon:status ;;
  run) bun run daemon:run ;;
  *)
    echo "usage: scripts/daemon.sh {start|stop|status|run}"
    exit 1
    ;;
esac
