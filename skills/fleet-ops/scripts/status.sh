#!/bin/bash
pm2 describe fleet-server 2>/dev/null || echo "Fleet server not running"
echo "---"
curl -s http://localhost:4020/health | python3 -m json.tool 2>/dev/null || echo "Health endpoint unreachable"
