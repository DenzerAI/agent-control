#!/usr/bin/env bash
# Doctor mit Reparatur. Erweitert den Python-Selbstcheck um sichere
# Selbstheilung: fehlende venv neu anlegen, requirements nachziehen, Frontend
# bauen falls dist fehlt, launchd-Dienst (neu) laden, Engine-Login-Hinweis.
#
# Aufruf:
#   bash scripts/doctor.sh [--no-repair] [--engine=<id>] [weitere Setup-Args...]
#
# Repariert nur, was sicher reparierbar ist. Was Nutzer-Aktion braucht
# (OAuth-Login, API-Key), wird klar als Hinweis ausgegeben, nicht erzwungen.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/agent-control-env.sh
source "$HERE/lib/agent-control-env.sh"
cd "$AC_ROOT"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_ACCENT=$'\033[38;5;173m'; C_GREEN=$'\033[38;5;107m'; C_GOLD=$'\033[38;5;179m'
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_ACCENT=""; C_GREEN=""; C_GOLD=""; C_BOLD=""; C_DIM=""; C_RESET=""
fi
say()  { echo; echo "${C_ACCENT}▸${C_RESET} ${C_BOLD}$1${C_RESET}"; }
ok()   { echo "${C_GREEN}✓ $1${C_RESET}"; }
warn() { echo "${C_GOLD}! $1${C_RESET}"; }
dim()  { echo "${C_DIM}  $1${C_RESET}"; }

REPAIR=1
ENGINE=""
SETUP_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-repair) REPAIR=0 ;;
    --engine=*) ENGINE="${arg#*=}"; SETUP_ARGS+=("$arg") ;;
    *) SETUP_ARGS+=("$arg") ;;
  esac
done

find_python310() {
  local c
  for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3 python; do
    command -v "$c" >/dev/null 2>&1 || continue
    if "$c" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)' >/dev/null 2>&1; then
      echo "$c"; return 0
    fi
  done
  return 1
}

# Engine aus der Instanz-Config lesen, falls nicht per Flag gesetzt.
if [ -z "$ENGINE" ] && [ -f "config/agent-control.json" ]; then
  ENGINE="$(python3 - <<'PY' 2>/dev/null || true
import json,sys
try:
    d=json.load(open("config/agent-control.json"))
    print(d.get("default_engine") or "")
except Exception:
    print("")
PY
)"
fi

# ---- Reparaturen ------------------------------------------------------------
if [ "$REPAIR" -eq 1 ]; then
  say "Reparatur"

  # 1. venv sicherstellen.
  if [ ! -x ".venv/bin/python" ] && [ ! -x ".venv/bin/python3" ]; then
    PY_BIN="$(find_python310 || echo python3)"
    warn "venv fehlt oder ist zerschossen — wird neu angelegt mit $("$PY_BIN" --version 2>&1)."
    rm -rf .venv
    "$PY_BIN" -m venv .venv
    ok "venv neu angelegt."
    NEED_REQS=1
  else
    ok "venv vorhanden."
    # Pruefen, ob ein Kernpaket fehlt (Indiz fuer unvollstaendige Installation).
    if ! .venv/bin/python -c "import fastapi, uvicorn" >/dev/null 2>&1; then
      warn "Kernpakete fehlen in der venv."
      NEED_REQS=1
    fi
  fi

  # 2. requirements nachziehen, wenn noetig.
  if [ "${NEED_REQS:-0}" -eq 1 ] && [ -f "requirements.txt" ]; then
    say "Python-Abhaengigkeiten nachinstallieren"
    .venv/bin/python -m pip install --upgrade pip >/dev/null
    .venv/bin/python -m pip install -r requirements.txt
    ok "requirements installiert."
  fi

  # 3. Frontend-Build nachholen, wenn dist fehlt.
  if [ -f "frontend/package.json" ]; then
    if [ ! -d "frontend/dist" ] || [ -z "$(ls -A frontend/dist 2>/dev/null)" ]; then
      say "Frontend-Build nachholen (dist fehlt)"
      if command -v npm >/dev/null 2>&1; then
        (cd frontend && npm install && npm run build)
        ok "Frontend gebaut."
      else
        warn "npm fehlt — Frontend kann nicht gebaut werden. Node/npm installieren."
      fi
    else
      ok "Frontend-Build (dist) vorhanden."
    fi
  fi

  # 4. launchd-Dienst (neu) laden, wenn ein Label festgeschrieben ist oder eine
  #    plist erwartet wird. Nur additiv: laeuft schon, wird nur reloaded.
  if [ -f "$AC_PLIST" ]; then
    say "Autostart-Dienst pruefen ($AC_LABEL)"
    if launchctl print "gui/$(id -u)/$AC_LABEL" >/dev/null 2>&1; then
      ok "LaunchAgent ist geladen."
    else
      warn "plist vorhanden, aber nicht geladen — wird geladen."
      launchctl bootstrap "gui/$(id -u)" "$AC_PLIST" >/dev/null 2>&1 \
        || launchctl load -w "$AC_PLIST" >/dev/null 2>&1 \
        || warn "Konnte LaunchAgent nicht laden: launchctl bootstrap gui/$(id -u) $AC_PLIST"
    fi
  else
    dim "Kein Autostart registriert. Einrichten mit: bash scripts/install-launchd.sh"
  fi

  # 5. Engine-Login-Status (nur Hinweis, kein Eingriff).
  if [ -n "$ENGINE" ]; then
    say "Engine-Anmeldung ($ENGINE)"
    bash "$HERE/engine-setup.sh" "$ENGINE" --check-only || true
  fi
fi

# ---- Python-Selbstcheck (Bericht) ------------------------------------------
say "Selbstcheck"
PY="python3"
[ -x ".venv/bin/python" ] && PY=".venv/bin/python"
if [ "${#SETUP_ARGS[@]}" -gt 0 ]; then
  AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py --doctor --yes "${SETUP_ARGS[@]}"
else
  AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py --doctor --yes
fi
