#!/usr/bin/env bash
# Re-generate the agenda-navigator kit from this repo.
#
#   tools/sync-kit.sh              # show what would change
#   tools/sync-kit.sh --write      # actually copy
#
# The kit is this tree minus docs/data/, so almost every file is shared and a
# fix that lands in only one of them is a slow-motion divergence. There is no
# submodule or subtree here on purpose: either is a build step, and the whole
# shape of this project is that there isn't one.
#
# FIVE FILES ARE MEANT TO DIFFER and are never copied:
#
#   README.md                    the kit's is about porting, not about RGS-IBG
#   CLAUDE.md                    the kit's opens by saying these notes are
#                                written from the reference implementation
#   test/data.test.mjs           the kit's skips when docs/data/ is empty
#   test/monitor.mjs             the kit's requires a URL instead of defaulting
#   .github/workflows/check.yml  the kit has no deployment to monitor
#
# If you change one of those here, port the change by hand — that is the point
# at which they are supposed to be read rather than overwritten.
set -euo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
KIT=${KIT:-$HOME/agenda-navigator}
WRITE=${1:-}

[ -d "$KIT/.git" ] || { echo "no kit repo at $KIT (set KIT=... to override)"; exit 1; }

DIVERGENT="README.md CLAUDE.md test/data.test.mjs test/monitor.mjs .github/workflows/check.yml"
# ...and this script itself, which maintains the kit from here and has no job
# inside it. Without this line it copies itself over and the kit acquires a tool
# that would overwrite the kit from a repo it doesn't have.
NOT_IN_KIT="tools/sync-kit.sh"

cd "$SRC"
skip=$(printf '%s\n%s\n' "$(echo "$DIVERGENT" | tr ' ' '\n')" "$NOT_IN_KIT")
shared=$(git ls-files | grep -v '^docs/data/' | grep -vxF "$skip" || true)

changed=0
while read -r f; do
  [ -n "$f" ] || continue
  if ! cmp -s "$SRC/$f" "$KIT/$f" 2>/dev/null; then
    echo "  differs: $f"
    changed=$((changed + 1))
    if [ "$WRITE" = "--write" ]; then
      mkdir -p "$KIT/$(dirname "$f")"
      cp "$SRC/$f" "$KIT/$f"
    fi
  fi
done <<< "$shared"

if [ "$changed" -eq 0 ]; then
  echo "kit is in sync ($(echo "$shared" | grep -c . ) shared files)"
else
  echo
  echo "$changed shared file(s) differ."
  [ "$WRITE" = "--write" ] && echo "copied. now: cd $KIT && node test/parse.test.mjs && git diff" \
                           || echo "re-run with --write to copy them."
fi

echo
echo "the five deliberately-divergent files are not touched:"
for f in $DIVERGENT; do
  cmp -s "$SRC/$f" "$KIT/$f" 2>/dev/null && echo "  IDENTICAL (suspicious): $f" || echo "  differs as expected: $f"
done
