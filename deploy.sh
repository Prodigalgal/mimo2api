#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required" >&2
  exit 1
fi

npm ci
npm run check
npm run build

echo "Build complete. Start with: npm start"
