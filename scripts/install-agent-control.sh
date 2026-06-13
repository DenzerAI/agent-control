#!/usr/bin/env bash
set -euo pipefail

# NOTIZ / spaetere Ausbaustufen (bewusst NICHT in dieser Stufe gebaut):
#   - TUI zum Chatten direkt im Terminal (terminal-first, statt Browser).
#   - Update-Rollback (Version vor dem Update zuruecksichern).
#   - Browser-Onboarding wurde bewusst verworfen (Terminal-first bleibt der Weg).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEPS_ONLY=0
DOCTOR=0
DRY_RUN=0
INSTALL_TOOLS=0
INSTALL_LOCAL_LLM=0
YES=0
# Engine-Login, globaler CLI-Befehl und launchd-Autostart sind im One-Click-Pfad
# standardmaessig an. Einzeln abschaltbar fuer Sonderfaelle / des Nutzers Checkout.
SETUP_ENGINE=1
INSTALL_CLI=1
INSTALL_AUTOSTART=1

# Auto-Install standardmäßig an. Mit --no-auto-install (oder
# AGENT_CONTROL_NO_AUTO_INSTALL=1, gesetzt vom äußeren install.sh) fällt der
# Installer auf das alte Verhalten zurück: fehlende Voraussetzungen werden
# nur angezeigt, nicht selbst nachinstalliert.
AUTO_INSTALL="${AGENT_CONTROL_NO_AUTO_INSTALL:+0}"
AUTO_INSTALL="${AUTO_INSTALL:-1}"
PROFILE="${AGENT_CONTROL_PROFILE:-}"
ENGINE="${AGENT_CONTROL_ENGINE:-}"
NAME="${AGENT_CONTROL_NAME:-}"
SETUP_ARGS=()

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_ACCENT=$'\033[38;5;173m'
  C_LINE=$'\033[38;5;240m'
  C_GREEN=$'\033[38;5;107m'
  C_GOLD=$'\033[38;5;179m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_ACCENT=""
  C_LINE=""
  C_GREEN=""
  C_GOLD=""
  C_BOLD=""
  C_DIM=""
  C_RESET=""
fi

rule() {
  echo "${C_LINE}────────────────────────────────────────────────────────────${C_RESET}"
}

step() {
  echo
  echo "${C_ACCENT}▸${C_RESET} ${C_BOLD}$1${C_RESET}"
  [[ $# -gt 1 ]] && echo "${C_DIM}  $2${C_RESET}"
}

# Gemeinsames ANSI-Shadow-Banner aus der geteilten lib (ein Quellort, kein figlet).
# shellcheck source=lib/agent-control-banner.sh
if [ -f "$ROOT/scripts/lib/agent-control-banner.sh" ]; then
  . "$ROOT/scripts/lib/agent-control-banner.sh"
fi

print_banner() {
  echo
  if command -v agent_control_banner_logo >/dev/null 2>&1; then
    agent_control_banner_logo
  else
    # Fallback, falls die lib fehlt: einfarbiger Akzent-Schriftzug.
    printf '%s%sAGENT CONTROL%s\n' "$C_ACCENT" "$C_BOLD" "$C_RESET"
  fi
  echo
  rule
  echo "${C_DIM}Setup: Profil wählen, Engine verbinden, lokal starten.${C_RESET}"
  rule
}

usage() {
  cat <<'EOF'
Usage:
  bash scripts/install-agent-control.sh [options]

Options:
  --profile=<core|client-demo|client-basic|christian>
  --engine=<codex|claude|gemini|openai-api|anthropic-api|gemini-api|xai-api|lmstudio|ollama|manual>
  --name=<instance name>
  --enable-module=<module>
  --server-url=<url>
  --deps-only
  --yes                 Use defaults and do not prompt.
  --doctor
  --dry-run             Print setup writes without changing files.
  --skip-doctor         Do not run readiness checks after setup.
  --force-env           Recreate .env from .env.example.
  --install-tools       Install missing core tools via Homebrew when possible.
  --install-local-llm   Install/check Ollama and LM Studio helpers when possible.
  --no-auto-install     Do not auto-install missing prerequisites; only show steps.
  --no-engine-setup     Skip installing the engine CLI and the login flow.
  --no-cli              Skip linking the global 'agent-control' command.
  --no-autostart        Skip registering the launchd autostart service.
  --no-demo-data        Skip demo seed writes for demo profiles.
  --force-demo-data     Overwrite generated demo seed files.
  --no-soul             Skip generated soul bootstrap files.
  --force-soul          Overwrite generated soul bootstrap files.
  --package-plan        Print install package boundary.
  --help
EOF
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# Findet den besten installierten Python-Interpreter mit Version >= 3.10.
# Apples System-python3 ist oft 3.9 und wird nur akzeptiert, wenn es >= 3.10 meldet.
find_python310() {
  local candidate
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3 python; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# Macht brew in der LAUFENDEN Shell verfügbar (Apple Silicon vs. Intel),
# damit es direkt nach der Homebrew-Installation ohne neue Shell nutzbar ist.
# Liefert 0, wenn brew danach auffindbar ist.
load_brew_shellenv() {
  if have brew; then
    eval "$(brew shellenv)" 2>/dev/null || true
    return 0
  fi
  local candidate
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then
      eval "$("$candidate" shellenv)" 2>/dev/null || true
      have brew && return 0
    fi
  done
  have brew
}

# Installiert Homebrew non-interaktiv und macht es sofort nutzbar.
# Liefert 0 bei Erfolg, 1 bei Fehlschlag.
auto_install_homebrew() {
  step "Homebrew wird installiert…" "Der Paketmanager für den Mac."
  echo "${C_DIM}  Gleich fragt der Mac einmal nach deinem Passwort. Das ist normal und sicher.${C_RESET}"
  if NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
    if load_brew_shellenv; then
      echo "${C_GREEN}✓ Homebrew installiert.${C_RESET}"
      return 0
    fi
    echo "${C_GOLD}  Homebrew wurde installiert, ist aber noch nicht auffindbar.${C_RESET}"
    return 1
  fi
  return 1
}

# Ruhige Stopp-Box im Banner-Stil. Sagt in Laiensprache, was zu tun ist, dann exit 1.
preflight_stop() {
  local brew_ok="$1"
  echo
  rule
  echo "${C_GOLD}${C_BOLD}  Stopp. Es fehlen noch Voraussetzungen.${C_RESET}"
  rule
  echo "${C_DIM}  Agent Control braucht ein paar Bausteine, bevor es laufen kann.${C_RESET}"
  echo "${C_DIM}  Bitte führe die folgenden Schritte der Reihe nach im Terminal aus:${C_RESET}"
  echo
  local n=1
  if [[ "$brew_ok" != "1" ]]; then
    echo "  ${C_ACCENT}${n}.${C_RESET} ${C_BOLD}Homebrew installieren${C_RESET} ${C_DIM}(der Paketmanager für den Mac)${C_RESET}"
    echo "     ${C_DIM}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${C_RESET}"
    echo "     ${C_DIM}Am Ende zeigt Homebrew zwei Zeilen an, die mit 'echo' beginnen.${C_RESET}"
    echo "     ${C_DIM}Diese beiden Zeilen bitte kopieren und ausführen, sonst wird brew nicht gefunden.${C_RESET}"
    echo "     ${C_DIM}(Apple Silicon: /opt/homebrew, ältere Intel-Macs: /usr/local)${C_RESET}"
    n=$((n + 1))
  fi
  echo "  ${C_ACCENT}${n}.${C_RESET} ${C_BOLD}Python, Node und Git installieren${C_RESET}"
  echo "     ${C_DIM}brew install python node git${C_RESET}"
  n=$((n + 1))
  echo "  ${C_ACCENT}${n}.${C_RESET} ${C_BOLD}Setup erneut starten${C_RESET}"
  echo "     ${C_DIM}bash scripts/install-agent-control.sh${C_RESET}"
  echo
  echo "${C_DIM}  Es wurde noch nichts installiert oder gebaut. Du kannst in Ruhe nachholen.${C_RESET}"
  echo "${C_DIM}  Falls ein halber Ordner aus einem früheren Versuch übrig ist:${C_RESET}"
  echo "${C_DIM}    rm -rf \"$HOME/agent-control\"${C_RESET}"
  rule
  exit 1
}

# Installiert ein fehlendes Paket via Homebrew, mit sichtbarem Fortschritt.
# $1 = brew-Paketname, $2 = Anzeigename. Liefert 0 bei Erfolg, 1 bei Fehlschlag.
auto_install_pkg() {
  local pkg="$1" label="$2"
  step "${label} wird installiert…"
  if brew install "$pkg"; then
    echo "${C_GREEN}✓ ${label} installiert.${C_RESET}"
    return 0
  fi
  return 1
}

# Versucht, fehlende Voraussetzungen selbst nachzuinstallieren.
# brew_ok=1 wenn Homebrew schon da ist. need_py/need_node/need_git = 1 wenn fehlend.
# Liefert 0, wenn am Ende alles vorhanden ist, sonst 1 (-> manuelle Stopp-Box).
auto_install_prereqs() {
  local brew_ok="$1" need_py="$2" need_node="$3" need_git="$4"

  if [[ "$brew_ok" != "1" ]]; then
    have curl || return 1
    auto_install_homebrew || return 1
  else
    load_brew_shellenv || return 1
  fi

  have brew || return 1

  [[ "$need_py"   == "1" ]] && { auto_install_pkg python "Python" || return 1; }
  [[ "$need_node" == "1" ]] && { auto_install_pkg node "Node"   || return 1; }
  [[ "$need_git"  == "1" ]] && { auto_install_pkg git "Git"     || return 1; }

  return 0
}

# Zweite Schranke: prüft Voraussetzungen direkt vor venv/pip. Setzt PY_BIN.
# Auto-Install (Default): fehlende Sachen werden selbst nachinstalliert und der
# passende Python-Interpreter danach erneut gesucht. Schlägt das fehl, erscheint
# die manuelle Stopp-Box. Mit --no-auto-install wird nur gestoppt.
preflight() {
  [[ "$(uname -s)" == "Darwin" ]] || { PY_BIN="$(find_python310 || echo python3)"; return 0; }

  local brew_ok=1 missing=0
  have brew || { brew_ok=0; missing=1; }

  local need_py=0 need_node=0 need_git=0
  PY_BIN="${AGENT_CONTROL_PYTHON:-}"
  if [[ -z "$PY_BIN" ]] || ! command -v "$PY_BIN" >/dev/null 2>&1; then
    PY_BIN="$(find_python310 || true)"
  fi
  [[ -n "$PY_BIN" ]] || { need_py=1; missing=1; }

  have node || { need_node=1; missing=1; }
  have git  || { need_git=1;  missing=1; }

  if [[ "$missing" -eq 1 ]]; then
    if [[ "$AUTO_INSTALL" == "1" ]]; then
      step "Voraussetzungen werden eingerichtet" "Fehlende Bausteine werden jetzt automatisch nachinstalliert."
      if auto_install_prereqs "$brew_ok" "$need_py" "$need_node" "$need_git"; then
        # Frischen Python-Interpreter nach der Installation suchen.
        PY_BIN="$(find_python310 || true)"
        if [[ -z "$PY_BIN" ]] || ! have node || ! have git; then
          preflight_stop "$( have brew && echo 1 || echo 0 )"
        fi
      else
        preflight_stop "$( have brew && echo 1 || echo 0 )"
      fi
    else
      preflight_stop "$brew_ok"
    fi
  fi
}

install_tools() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Tool-Installation ist aktuell auf macOS/Homebrew ausgelegt; überspringe."
    return 0
  fi

  if ! have brew; then
    # brew vielleicht nur nicht im PATH der laufenden Shell.
    load_brew_shellenv >/dev/null 2>&1 || true
  fi

  if ! have brew; then
    if [[ "$AUTO_INSTALL" == "1" ]]; then
      auto_install_homebrew || {
        echo "${C_GOLD}Homebrew-Installation fehlgeschlagen. Bitte manuell installieren:${C_RESET}"
        echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        return 0
      }
    else
      echo "Homebrew fehlt."
      echo "Bitte zuerst installieren:"
      echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
      return 0
    fi
  fi

  step "Basis-Werkzeuge prüfen" "git, python und node"
  for pkg in git python node; do
    if brew list "$pkg" >/dev/null 2>&1; then
      echo "${C_GREEN}✓ $pkg${C_RESET}"
    else
      brew install "$pkg"
    fi
  done

  if [[ "$INSTALL_LOCAL_LLM" -eq 1 ]]; then
    step "Lokale Modelle prüfen" "Ollama und LM Studio sind optional."
    if brew list ollama >/dev/null 2>&1; then
      echo "${C_GREEN}✓ ollama${C_RESET}"
    else
      brew install ollama
    fi
    if brew info --cask lm-studio >/dev/null 2>&1; then
      if brew list --cask lm-studio >/dev/null 2>&1; then
        echo "${C_GREEN}✓ lm-studio${C_RESET}"
      else
        brew install --cask lm-studio
      fi
    else
      echo "LM Studio ist in diesem Homebrew-Setup nicht verfügbar; bei Bedarf manuell installieren."
    fi
  fi
}

for arg in "$@"; do
  case "$arg" in
    --deps-only) DEPS_ONLY=1 ;;
    --doctor) DOCTOR=1 ;;
    --dry-run) DRY_RUN=1; SETUP_ARGS+=("$arg") ;;
    --yes) YES=1; SETUP_ARGS+=("$arg") ;;
    --install-tools) INSTALL_TOOLS=1 ;;
    --install-local-llm) INSTALL_LOCAL_LLM=1 ;;
    --no-auto-install) AUTO_INSTALL=0 ;;
    --no-engine-setup) SETUP_ENGINE=0 ;;
    --no-cli) INSTALL_CLI=0 ;;
    --no-autostart) INSTALL_AUTOSTART=0 ;;
    --help|-h) usage; exit 0 ;;
    --profile=*) PROFILE="${arg#*=}" ;;
    --engine=*) ENGINE="${arg#*=}" ;;
    --name=*) NAME="${arg#*=}" ;;
    --enable-module=*|--server-url=*|--skip-doctor|--force-env|--no-demo-data|--force-demo-data|--no-soul|--force-soul|--package-plan) SETUP_ARGS+=("$arg") ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

print_banner
echo "${C_DIM}Installiert nach: $ROOT${C_RESET}"

ARGS=()
[[ -n "$PROFILE" ]] && ARGS+=(--profile "$PROFILE")
[[ -n "$ENGINE" ]] && ARGS+=(--engine "$ENGINE")
[[ -n "$NAME" ]] && ARGS+=(--name "$NAME")
if [[ "${#SETUP_ARGS[@]}" -gt 0 ]]; then
  ARGS+=("${SETUP_ARGS[@]}")
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  PY="python3"
  [[ -x ".venv/bin/python" ]] && PY=".venv/bin/python"
  step "Dry-Run" "Zeigt, was geschrieben würde, ohne Dateien zu ändern."
  if [[ "$YES" -eq 1 ]]; then
    if [[ "${#ARGS[@]}" -gt 0 ]]; then
      AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py "${ARGS[@]}"
    else
      AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py
    fi
  else
    if [[ "${#ARGS[@]}" -gt 0 ]]; then
      AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py --yes "${ARGS[@]}"
    else
      AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py --yes
    fi
  fi
  exit $?
fi

if [[ "$INSTALL_TOOLS" -eq 1 || "$INSTALL_LOCAL_LLM" -eq 1 ]]; then
  install_tools
fi

if [[ "$DOCTOR" -eq 1 ]]; then
  PY="python3"
  [[ -x ".venv/bin/python" ]] && PY=".venv/bin/python"
  step "Doctor" "Prüft, ob diese Installation startklar ist."
  if [[ "${#ARGS[@]}" -gt 0 ]]; then
    AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py --doctor --yes "${ARGS[@]}"
  else
    AGENT_CONTROL_PARENT_UI=1 "$PY" scripts/agent-control-setup.py --doctor --yes
  fi
  exit $?
fi

# Schranke vor jeglichem Bauen: Voraussetzungen prüfen und passenden Python wählen.
# Stoppt sauber, falls brew/Python>=3.10/node/git fehlen, bevor venv/pip läuft.
preflight

if [[ ! -d ".venv" ]]; then
  step "Python-Umgebung" "Wird lokal im Projekt angelegt mit $("$PY_BIN" --version 2>&1)."
  "$PY_BIN" -m venv .venv
fi

step "Python-Abhängigkeiten" "Backend-Pakete installieren."
".venv/bin/python" -m pip install --upgrade pip >/dev/null
".venv/bin/python" -m pip install -r requirements.txt

if [[ -f "frontend/package.json" ]]; then
  step "Frontend-Abhängigkeiten" "App-Pakete installieren."
  (cd frontend && npm install)
  step "Frontend bauen" "Die Browser-App wird vorbereitet."
  (cd frontend && npm run build)
fi

if [[ "$DEPS_ONLY" -eq 1 ]]; then
  echo "${C_GREEN}✓ Abhängigkeiten installiert.${C_RESET}"
  exit 0
fi

step "Setup-Assistent" "Profil, Name, Engine und Module."
if [[ "${#ARGS[@]}" -gt 0 ]]; then
  AGENT_CONTROL_PARENT_UI=1 ".venv/bin/python" scripts/agent-control-setup.py "${ARGS[@]}"
else
  AGENT_CONTROL_PARENT_UI=1 ".venv/bin/python" scripts/agent-control-setup.py
fi

# Gewaehlte Engine aus der frisch geschriebenen Instanz-Config lesen
# (Wahrheit nach dem Wizard; faellt auf das --engine-Flag zurueck).
RESOLVED_ENGINE="$ENGINE"
if [[ -f "config/agent-control.json" ]]; then
  CFG_ENGINE="$(".venv/bin/python" - <<'PY' 2>/dev/null || true
import json
try:
    print(json.load(open("config/agent-control.json")).get("default_engine") or "")
except Exception:
    print("")
PY
)"
  [[ -n "$CFG_ENGINE" ]] && RESOLVED_ENGINE="$CFG_ENGINE"
fi

# 1. Engine-CLI installieren und Login mitfuehren (wichtigster Schritt: sonst
#    kann der Chat nicht denken). API-/Local-Engines werden nur geprueft.
if [[ "$SETUP_ENGINE" -eq 1 && -n "$RESOLVED_ENGINE" && "$RESOLVED_ENGINE" != "manual" ]]; then
  step "Engine verbinden" "CLI installieren und anmelden, damit der Chat denken kann."
  ENGINE_FLAGS=()
  [[ "$YES" -eq 1 ]] && ENGINE_FLAGS+=(--yes)
  bash scripts/engine-setup.sh "$RESOLVED_ENGINE" "${ENGINE_FLAGS[@]+"${ENGINE_FLAGS[@]}"}" || \
    echo "${C_GOLD}  Engine-Anmeldung noch offen — spaeter: agent-control doctor${C_RESET}"
fi

# 2. Globalen Befehl 'agent-control' verlinken.
if [[ "$INSTALL_CLI" -eq 1 ]]; then
  step "Befehl 'agent-control'" "Damit der Agent von ueberall im Terminal startbar ist."
  bash scripts/install-cli.sh || echo "${C_GOLD}  CLI-Link uebersprungen.${C_RESET}"
fi

# 3. Autostart nach Reboot via launchd registrieren.
#    Schutz: des Nutzers bestehender Checkout in $HOME/agent wird NICHT angefasst,
#    ausser der Nutzer erzwingt es. So bleibt seine laufende Instanz unberuehrt.
if [[ "$INSTALL_AUTOSTART" -eq 1 && "$(uname -s)" == "Darwin" ]]; then
  if [[ "$ROOT" == "$HOME/agent" ]]; then
    echo "${C_DIM}  Autostart: bestehender Checkout in \$HOME/agent wird nicht automatisch umkonfiguriert.${C_RESET}"
    echo "${C_DIM}  Falls gewuenscht: bash scripts/install-launchd.sh${C_RESET}"
  else
    step "Autostart nach Reboot" "Agent Control startet beim Login und bleibt am Leben."
    bash scripts/install-launchd.sh || echo "${C_GOLD}  Autostart-Registrierung uebersprungen.${C_RESET}"
  fi
fi

echo
echo "${C_GREEN}✓ Setup abgeschlossen.${C_RESET}"
echo "${C_DIM}  Start/oeffnen:  agent-control${C_RESET}"
echo "${C_DIM}  Selbstcheck:    agent-control doctor${C_RESET}"
echo "${C_DIM}  Aktualisieren:  agent-control update${C_RESET}"
echo "${C_DIM}  Falls von Hand: bash scripts/start.sh${C_RESET}"
