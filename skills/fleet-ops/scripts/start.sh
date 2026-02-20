#!/bin/bash
cd /Users/user/.openclaw/workspace/fleet
pm2 start ecosystem.config.cjs
pm2 save
echo "Fleet server started"
