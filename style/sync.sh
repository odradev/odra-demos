#!/usr/bin/env bash
# Copies the Odra web style from the odra-style-guide repository into this directory.
# Usage: style/sync.sh [path to odra-style-guide]   (default: ../odra-style-guide, next to this repository)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
guide="${1:-$here/../../odra-style-guide}"

if [ ! -f "$guide/odra.css" ]; then
  echo "No odra.css in $guide. Pass the path of the odra-style-guide repository." >&2
  exit 1
fi

# Each file is written beside its target and moved into place, so a dev server watching this
# directory never reads a half-written file.
install() {
  cp "$1" "$2.tmp" && mv "$2.tmp" "$2"
}

install "$guide/odra.css" "$here/odra.css"
install "$guide/assets/odra-logo-white.png" "$here/public/assets/odra-logo-white.png"
install "$guide/assets/favicon.png" "$here/public/assets/favicon.png"
echo "Copied odra.css, the logo and the favicon from $guide"
