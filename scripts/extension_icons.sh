#!/usr/bin/env bash
# Export the browser extension's toolbar and store icons from the square logo.
# Source: assets/logo-square.svg. Output: browser-extension/public/icons/icon-{16,32,48,128}.png.
# Needs rsvg-convert (librsvg: `brew install librsvg`, `apt install librsvg2-bin`).
set -euo pipefail
cd "$(dirname "$0")/.."

src="assets/logo-square.svg"
dest="browser-extension/public/icons"

for size in 16 32 48 128; do
  rsvg-convert -w "$size" -h "$size" "$src" -o "$dest/icon-$size.png"
done
