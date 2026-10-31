#!/bin/sh
set -eu
# Kept for shortcuts made before the rename; remove in a later release.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
echo "Start-NarraLume.command was renamed to Start-Lapis.command." >&2
exec sh "$ROOT/Start-Lapis.command"
