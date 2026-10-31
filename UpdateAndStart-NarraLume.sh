#!/usr/bin/env sh
set -eu
# Kept for shortcuts made before the rename; remove in a later release.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
echo "UpdateAndStart-NarraLume.sh was renamed to UpdateAndStart-Lapis.sh." >&2
exec sh "$ROOT/UpdateAndStart-Lapis.sh"
