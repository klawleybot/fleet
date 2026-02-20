#!/bin/bash
LINES=${1:-50}
pm2 logs fleet-server --lines "$LINES" --nostream
