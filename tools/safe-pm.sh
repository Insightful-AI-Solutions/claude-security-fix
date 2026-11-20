#!/usr/bin/env bash
# The only way Claude can run the package manager in the fix job.
#
#   safe-pm audit [dir]   audit the lockfile (nothing is installed)
#   safe-pm lock  [dir]   update the lockfile from package.json, scripts off
#
# The workflow writes a small launcher that sets SAFE_PM_* and runs this file
# from a read-only folder outside the workspace, so Claude cannot change it.
#   SAFE_PM_PM          npm | pnpm | bun
#   SAFE_PM_DIRS        project folders allowed, space-separated, e.g. ". scripts/baseline"
#   SAFE_PM_WORKSPACE   the repository checkout
#   SAFE_PM_BASE        default-branch copies of each project's config files
#   SAFE_PM_TOOLS       this kit's tools folder
#
# It runs the package manager with an empty environment (no GitHub or Claude
# token), only from the npm registry, refuses if a package-manager config file
# differs from the default branch, refuses non-registry versions in
# package.json, and never shows package output, which can carry text a
# publisher wrote.
set -euo pipefail

verb="${1:-}"
dir="${2:-.}"
case "$verb" in audit|lock) ;; *) echo "usage: safe-pm audit [dir] | safe-pm lock [dir]" >&2; exit 2 ;; esac
[ "$#" -le 2 ] || { echo "safe-pm: too many arguments" >&2; exit 2; }
ok=0
for d in $SAFE_PM_DIRS; do [ "$d" = "$dir" ] && ok=1; done
[ "$ok" = 1 ] || { echo "safe-pm: '$dir' is not one of: $SAFE_PM_DIRS" >&2; exit 2; }

cd "$SAFE_PM_WORKSPACE/$dir"
base="$SAFE_PM_BASE/$dir"

# Config files that can run code or redirect the registry must match the default
# branch. A missing file and an empty one mean the same. Claude Code's sandbox
# can place an empty stand-in (such as /dev/null) over these names to stop them
# being created, so an empty non-file counts as missing. A link never matches.
content() { # prints a file's content, or nothing if it is missing or an empty stand-in
  if [ -L "$1" ]; then echo "LINK"; return; fi
  if [ -f "$1" ]; then cat -- "$1"; return; fi
  if [ -e "$1" ] && [ -s "$1" ]; then echo "NOT-A-FILE"; fi
}
for f in .npmrc .pnpmfile.cjs .pnpmfile.mjs pnpm-workspace.yaml bunfig.toml .yarnrc .yarnrc.yml npm-shrinkwrap.json; do
  if [ "$(content "$base/$f" | sha256sum)" != "$(content "$f" | sha256sum)" ]; then
    echo "safe-pm: $dir/$f differs from the default branch. Refusing." >&2; exit 1
  fi
done

node "$SAFE_PM_TOOLS/safe-pm-check.mjs" package.json || exit 1

# A cache folder the sandbox lets this write to, outside the workspace.
tmp="${SAFE_PM_CACHE:-${TMPDIR:-/tmp}/safe-pm}"
mkdir -p "$tmp/home" "$tmp/cache"
# Claude Code's sandbox reaches the network through a local proxy named in these
# variables. They hold no credentials, so they pass through.
passenv=()
for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy ALL_PROXY all_proxy SSL_CERT_FILE NODE_EXTRA_CA_CERTS; do
  if [ -n "${!v:-}" ]; then passenv+=("$v=${!v}"); fi
done
run() {
  env -i PATH="$PATH" HOME="$tmp/home" TMPDIR="$tmp" "${passenv[@]}" \
    XDG_CACHE_HOME="$tmp/cache" XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state" \
    npm_config_cache="$tmp/cache/npm" npm_config_store_dir="$tmp/store" \
    BUN_INSTALL_CACHE_DIR="$tmp/cache/bun" \
    npm_config_registry=https://registry.npmjs.org/ \
    npm_config_ignore_pnpmfile=true \
    npm_config_ignore_scripts=true \
    npm_config_update_notifier=false \
    "$@"
}

# The lockfile is built in a scratch copy, never in the workspace. Claude Code's
# sandbox does not let commands write the workspace's lockfile, and the workflow
# rebuilds the lockfile from package.json anyway. So both verbs rebuild the
# scratch copy from the current package.json; audit then audits that copy.
lockfile=""
case "$SAFE_PM_PM" in npm) lockfile=package-lock.json ;; pnpm) lockfile=pnpm-lock.yaml ;; bun) lockfile=bun.lock ;; esac
scratch="$tmp/work"
rm -rf "$scratch" && mkdir -p "$scratch"
cp package.json "$scratch/package.json"
if [ -f "$lockfile" ] && [ ! -L "$lockfile" ]; then cp "$lockfile" "$scratch/$lockfile"; fi
for f in .npmrc bunfig.toml pnpm-workspace.yaml; do
  if [ -f "$base/$f" ]; then cp "$base/$f" "$scratch/$f"; fi
done
cd "$scratch"
case "$SAFE_PM_PM" in
  npm)  cmd=(npm install --package-lock-only --ignore-scripts --no-audit --no-fund) ;;
  pnpm) cmd=(pnpm install --lockfile-only --ignore-scripts) ;;
  bun)  cmd=(bun install --lockfile-only --ignore-scripts) ;;
esac
rc=0; out="$(run "${cmd[@]}" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "safe-pm: the lockfile could not be built from package.json (exit $rc). Error codes:" >&2
  # Codes, and for file errors the path and system call: none of it is publisher text.
  printf '%s\n' "$out" | grep -oE 'ERR_PNPM_[A-Z_]+|npm (error|ERR!) (code|syscall) [A-Za-z0-9_]+|npm (error|ERR!) path /[A-Za-z0-9._/@+-]+|error: [A-Za-z]+(Error|NotFound|Mismatch)' | sort -u >&2 || true
  exit "$rc"
fi
case "$verb" in
  lock)
    echo "safe-pm: $dir/package.json resolves cleanly. The lockfile was built in a scratch copy, the same way the workflow will rebuild it. Run safe-pm audit${2:+ $dir} to check the result."
    ;;
  audit)
    echo "safe-pm: audit of the lockfile built from the current $dir/package.json:" >&2
    run "$SAFE_PM_PM" audit --json
    ;;
esac
