#!/usr/bin/env sh
set -eu
# Kept for shortcuts made before the rename; remove in a later release.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
echo "Start-NarraLume.sh was renamed to Start-Lapis.sh." >&2
exec sh "$ROOT/Start-Lapis.sh"
