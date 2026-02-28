#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-status}"
case "$cmd" in
  start) npm run daemon:start ;;
  stop) npm run daemon:stop ;;
  status) npm run daemon:status ;;
  run) npm run daemon:run ;;
  *)
    echo "usage: scripts/daemon.sh {start|stop|status|run}"
    exit 1
    ;;
esac
