#!/usr/bin/env bash
#
# The Pub — pre-merge check gate.
#
# Runs the full suite against a *fresh full clone* of committed history in a
# throwaway directory. Running in place would reuse the existing node_modules/
# and out/, so it could pass on a tree that would not build for anyone else —
# which is exactly the failure this is meant to catch. A clone only ever
# contains committed state, so a file that was never `git add`-ed simply is not
# there.
#
# GitHub Actions is deliberately off for this repository and there is no
# workflow file in the repo; this script is the gate. See ci/README.md.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="HEAD"
KEEP=0
SKIP_E2E=0

usage() {
  cat <<'EOF'
Usage: bash ci/run-checks.sh [options]

  --ref <git-ref>   Commit, branch or tag to check out (default: HEAD)
  --keep            Keep the temporary clone even when everything passes
  --skip-e2e        Skip the Playwright stage (typecheck, unit tests and build only)
  --help            Show this message

The clone is always kept when a stage fails — that copy is the thing worth
inspecting — and its path is printed at the end.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; [ -n "$REF" ] || { echo "--ref needs a value" >&2; exit 2; }; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --skip-e2e) SKIP_E2E=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# --- output helpers ---------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""
fi

STAGE_NAMES=()
STAGE_RESULTS=()
FAILED=0

note()  { printf '%s\n' "$*"; }
warn()  { printf '%s%s%s\n' "$YELLOW" "$*" "$RESET"; }
head2() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }

# Run one stage, recording its outcome. Later stages still run only if this one
# passed — a failed build makes every downstream result meaningless.
stage() {
  local name="$1"; shift
  STAGE_NAMES+=("$name")

  if [ "$FAILED" -ne 0 ]; then
    STAGE_RESULTS+=("skipped")
    return
  fi

  head2 "$name"
  if "$@"; then
    STAGE_RESULTS+=("passed")
  else
    STAGE_RESULTS+=("FAILED")
    FAILED=1
  fi
}

record_skip() {
  STAGE_NAMES+=("$1")
  STAGE_RESULTS+=("skipped")
}

# --- 1. report the working tree ---------------------------------------------

head2 "Source"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short "$REF" 2>/dev/null)" || {
  echo "${RED}Not a valid git ref: $REF${RESET}" >&2
  exit 2
}
note "repository ${DIM}${REPO_ROOT}${RESET}"
note "ref        ${REF} (${COMMIT})"

DIRTY="$(git -C "$REPO_ROOT" status --porcelain)"
if [ -n "$DIRTY" ]; then
  warn ""
  warn "Working tree is dirty. These changes are NOT being checked —"
  warn "only committed history is cloned:"
  printf '%s\n' "$DIRTY" | sed 's/^/    /'
  warn ""
else
  note "tree       clean"
fi

# --- 2. clone ----------------------------------------------------------------

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/pub-ci-XXXXXX")"
CLONE="$WORKDIR/the_pub"

cleanup() {
  if [ "$FAILED" -ne 0 ] || [ "$KEEP" -eq 1 ]; then
    printf '\n%sClone kept at:%s %s\n' "$BOLD" "$RESET" "$CLONE"
  else
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

head2 "Clone"
# A full clone — every branch and the whole object store, so --ref can name
# anything. --no-hardlinks copies the objects rather than linking them, so a
# broken run in the clone can never damage the real repository.
if ! git clone --local --no-hardlinks --quiet "$REPO_ROOT" "$CLONE"; then
  echo "${RED}Clone failed${RESET}" >&2
  FAILED=1
  exit 1
fi
git -C "$CLONE" checkout --quiet --detach "$COMMIT" || { echo "${RED}Checkout failed${RESET}" >&2; FAILED=1; exit 1; }
note "cloned to ${DIM}${CLONE}${RESET}"

cd "$CLONE" || exit 1

# --- 3-7. the gate -----------------------------------------------------------

install_deps() {
  # --prefer-offline uses the npm cache; Electron's own binary is cached in
  # ~/.cache/electron, so only the first run pays the download.
  npm ci --prefer-offline --no-audit --no-fund
}

stage "Install (npm ci)" install_deps
stage "Typecheck"        npm run typecheck
stage "Unit tests"       npm test

# Playwright launches the built app (`args: ['.']` resolves package.json's
# `main: ./out/main/index.js`), so the build has to come first. Nothing in the
# npm scripts enforces that ordering.
stage "Build"            npm run build

# Windows and macOS always have a display; only Linux can be genuinely headless.
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*|Darwin) HAS_DISPLAY=1 ;;
  *) HAS_DISPLAY=0 ;;
esac
[ -n "${OS:-}" ] && [ "${OS:-}" = "Windows_NT" ] && HAS_DISPLAY=1

if [ "$SKIP_E2E" -eq 1 ]; then
  record_skip "End-to-end tests"
  warn "End-to-end tests skipped (--skip-e2e)."
elif [ "$HAS_DISPLAY" -eq 1 ] || [ -n "${DISPLAY:-}" ]; then
  stage "End-to-end tests" npm run e2e
elif command -v xvfb-run >/dev/null 2>&1; then
  stage "End-to-end tests" xvfb-run -a npm run e2e
else
  # Never let an unrunnable stage look like a passing one.
  record_skip "End-to-end tests"
  warn "End-to-end tests SKIPPED: no \$DISPLAY and xvfb-run is not installed."
  warn "Install xvfb, or run on a machine with a display, before trusting this result."
fi

# --- 8. summary --------------------------------------------------------------

printf '\n%s==> Summary%s  (%s @ %s)\n' "$BOLD" "$RESET" "$REF" "$COMMIT"
for i in "${!STAGE_NAMES[@]}"; do
  result="${STAGE_RESULTS[$i]}"
  case "$result" in
    passed)  printf '  %s✓%s %-20s %s\n' "$GREEN" "$RESET" "${STAGE_NAMES[$i]}" "passed" ;;
    FAILED)  printf '  %s✗%s %-20s %s%s%s\n' "$RED" "$RESET" "${STAGE_NAMES[$i]}" "$RED" "FAILED" "$RESET" ;;
    *)       printf '  %s-%s %-20s %s%s%s\n' "$DIM" "$RESET" "${STAGE_NAMES[$i]}" "$DIM" "skipped" "$RESET" ;;
  esac
done

if [ -n "$DIRTY" ]; then
  warn ""
  warn "Reminder: uncommitted changes in the working tree were not included."
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\n%sGate failed.%s\n' "$RED" "$RESET"
  exit 1
fi

printf '\n%sGate passed.%s\n' "$GREEN" "$RESET"
