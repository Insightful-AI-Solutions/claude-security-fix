#!/usr/bin/env bash
# Prints the hash of tools/ that the shared workflow pins in KIT_TOOLS_SHA256.
#   test/tools-hash.sh          print the hash
#   test/tools-hash.sh --check  fail if the workflow's value is out of date
#   test/tools-hash.sh --write  update the workflow's value
set -euo pipefail
cd "$(dirname "$0")/.."
wf=.github/workflows/claude-security-fix.yml
hash="$(cd tools && LC_ALL=C sha256sum -- * | sha256sum | cut -d' ' -f1)"
case "${1:-}" in
  --check) grep -q "KIT_TOOLS_SHA256: $hash\$" "$wf" || { echo "KIT_TOOLS_SHA256 in $wf is out of date. Run test/tools-hash.sh --write"; exit 1; } ;;
  --write) sed -i -E "s/^(  KIT_TOOLS_SHA256: ).*/\\1$hash/" "$wf" ;;
  *) echo "$hash" ;;
esac
