#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

run_case() {
  local name="$1"
  shift
  echo
  echo "==> Smoke: $name"
  "$@"
}

tmp_root="$(mktemp -d)"
smoke_repo_url="${AGENT_CONTROL_SMOKE_REPO_URL:-$ROOT}"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

run_case "inner dry-run, non-interactive" \
  bash scripts/install-agent-control.sh --dry-run --non-interactive

run_case "inner deps-only with tool check" \
  bash scripts/install-agent-control.sh --install-tools --deps-only

run_case "inner deps-only with restricted PATH" \
  env PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  bash scripts/install-agent-control.sh --install-tools --deps-only

run_case "bootstrap dry-run, fresh checkout" \
  env AGENT_CONTROL_HOME="$tmp_root/dry-run" \
  AGENT_CONTROL_REPO_URL="$smoke_repo_url" \
  bash install.sh --non-interactive --dry-run --no-start

run_case "bootstrap deps-only, fresh checkout" \
  env AGENT_CONTROL_HOME="$tmp_root/deps-only" \
  AGENT_CONTROL_REPO_URL="$smoke_repo_url" \
  bash install.sh --install-tools --deps-only --no-start

echo
echo "Installer smoke matrix passed."
