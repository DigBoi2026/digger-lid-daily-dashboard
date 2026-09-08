#!/bin/bash
# bump.sh — cache-bust every ?v= query string across the dashboard HTML in one step.
# The browser caches core.js / app.js / data.js aggressively; bumping the version
# forces a fresh fetch after you edit a JS or data file.
#
#   ./bump.sh          → bump to the current unix timestamp (always unique)
#   ./bump.sh 12       → bump to a specific integer version
#
set -euo pipefail
cd "$(dirname "$0")"

N="${1:-$(date +%s)}"
FILES=(index.html performance.html products.html region.html daily.html)

for f in "${FILES[@]}"; do
  sed -i '' -E "s/\?v=[0-9]+/?v=$N/g" "$f"
done

echo "Bumped cache versions to ?v=$N across: ${FILES[*]}"
echo "Hard-reload the browser (Cmd-Shift-R) to pick up the change."
