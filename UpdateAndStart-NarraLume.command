#!/bin/sh
set -eu
# Kept for shortcuts made before the rename; remove in a later release.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
echo "UpdateAndStart-NarraLume.command was renamed to UpdateAndStart-Lapis.command." >&2
exec sh "$ROOT/UpdateAndStart-Lapis.command"
