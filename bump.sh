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
# EVERY page, discovered rather than listed. The hardcoded list had fallen three
# pages behind (forecast.html, gpam.html, meta.html were never bumped), so those
# pages kept serving a stale core.js to any browser that had one cached — and
# since the nav and live pill are now rendered BY core.js, a stale copy means a
# page with no nav at all. A glob cannot drift when a page is added.
shopt -s nullglob
FILES=(*.html)
if [ ${#FILES[@]} -eq 0 ]; then echo "No HTML files found next to bump.sh" >&2; exit 1; fi

# `sed -i` takes a mandatory suffix argument on BSD/macOS and an optional one on
# GNU/Linux, so `sed -i ''` works on a Mac and makes Linux read '' as the script.
# Write to a temp file and move it back — identical on both.
for f in "${FILES[@]}"; do
  tmp="$(mktemp "${f}.XXXXXX")"
  sed -E "s/\?v=[0-9]+/?v=$N/g" "$f" > "$tmp"
  mv "$tmp" "$f"
done

echo "Bumped cache versions to ?v=$N across: ${FILES[*]}"
echo "Hard-reload the browser (Cmd-Shift-R) to pick up the change."
