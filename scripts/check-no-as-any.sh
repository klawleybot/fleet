#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

matches=$(find packages -path '*/node_modules' -prune -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print \
  | xargs grep -nE '\bas any\b' \
  | grep -vE '^(packages/server/tests/|packages/server/scripts/|packages/intelligence/scripts/)' || true)

if [[ -n "$matches" ]]; then
  echo "Production as any usage detected:"
  echo "$matches"
  exit 1
fi

echo "OK: no production as any usages found"
