#!/usr/bin/env bash
# Engine-CLI mitinstallieren und Login mitfuehren.
#
# Fuer die CLI-Engines (codex, claude, gemini):
#   1. CLI installieren, falls sie fehlt (npm global bzw. offizieller Installer).
#   2. Login-Status pruefen.
#   3. Falls nicht angemeldet: Login-Flow anstossen und den Nutzer durchfuehren.
#   4. Erneut pruefen und Ergebnis melden.
#
# Fuer *-api-Engines bleibt der Weg ueber den API-Key in .env — hier wird nur
# geprueft und ein klarer Hinweis gegeben, nichts installiert.
#
# OAuth laesst sich nicht voll automatisieren: der Browser-Login muss der Nutzer
# selbst bestaetigen. Dieses Skript fuehrt klar dorthin und prueft danach.
#
# Aufruf:
#   bash scripts/engine-setup.sh <engine-id> [--yes] [--dry-run] [--check-only]
#
# Exit-Codes:
#   0  Engine bereit (CLI vorhanden und angemeldet, oder API-Key gesetzt)
#   0  --check-only: immer 0, Status nur als Text (kein Abbruch)
#   1  Engine nicht bereit (CLI fehlt/Login offen) und nicht reparierbar ohne Nutzer
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/agent-control-env.sh
source "$HERE/lib/agent-control-env.sh"

ENGINE="${1:-}"
shift || true

YES=0
DRY_RUN=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --check-only) CHECK_ONLY=1 ;;
  esac
done

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_ACCENT=$'\033[38;5;173m'; C_GREEN=$'\033[38;5;107m'; C_GOLD=$'\033[38;5;179m'
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_ACCENT=""; C_GREEN=""; C_GOLD=""; C_BOLD=""; C_DIM=""; C_RESET=""
fi

say()  { echo "${C_ACCENT}▸${C_RESET} ${C_BOLD}$1${C_RESET}"; }
ok()   { echo "${C_GREEN}✓ $1${C_RESET}"; }
warn() { echo "${C_GOLD}! $1${C_RESET}"; }
dim()  { echo "${C_DIM}  $1${C_RESET}"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Lese eine .env-Variable (ohne Quotes), leer wenn nicht gesetzt.
env_val() {
  local key="$1"
  [ -f "$AC_ROOT/.env" ] || return 0
  grep -E "^${key}=" "$AC_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

has_tty() { [[ -c /dev/tty ]] && { : </dev/tty >/dev/tty; } 2>/dev/null; }

if [ -z "$ENGINE" ]; then
  echo "Usage: $0 <engine-id> [--yes] [--dry-run] [--check-only]" >&2
  exit 2
fi

# ---- npm-global-Install-Helfer ----------------------------------------------
npm_global_install() {
  local pkg="$1" label="$2"
  if ! have npm; then
    warn "npm fehlt — $label kann nicht automatisch installiert werden."
    dim "Node/npm installieren (z. B. brew install node), dann erneut."
    return 1
  fi
  say "$label wird installiert (npm global: $pkg)…"
  if [ "$DRY_RUN" -eq 1 ]; then
    dim "[dry-run] npm install -g $pkg"
    return 0
  fi
  if npm install -g "$pkg"; then
    ok "$label installiert."
    return 0
  fi
  warn "npm-Install von $pkg fehlgeschlagen. Bei Rechteproblemen npm-Prefix setzen:"
  dim "  npm config set prefix ~/.local && export PATH=\$HOME/.local/bin:\$PATH"
  return 1
}

# ---- Login-Status je Engine -------------------------------------------------
# Liefert 0 wenn angemeldet, 1 wenn nicht. Nutzt zuerst die CLI-eigene
# Statusabfrage, faellt sonst auf die bekannte Credentials-Datei zurueck.
codex_logged_in() {
  if codex login status >/dev/null 2>&1; then return 0; fi
  [ -f "$HOME/.codex/auth.json" ]
}
claude_logged_in() {
  # Claude Code legt OAuth-Daten in ~/.claude.json bzw. ~/.claude/ ab.
  if [ -s "$HOME/.claude.json" ]; then return 0; fi
  if [ -d "$HOME/.claude" ] && [ -n "$(ls -A "$HOME/.claude" 2>/dev/null)" ]; then return 0; fi
  return 1
}
gemini_logged_in() {
  [ -d "$HOME/.gemini" ] && [ -n "$(ls -A "$HOME/.gemini" 2>/dev/null)" ]
}

# ---- Pro Engine: Install + Login --------------------------------------------
setup_cli_engine() {
  local cli="$1" pkg="$2" label="$3" login_cmd="$4" status_fn="$5" api_key_env="$6"

  say "Engine: $label"

  # 1. CLI vorhanden?
  if ! have "$cli"; then
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "$label-CLi ($cli) fehlt."
      [ -n "$api_key_env" ] && dim "Alternative: $api_key_env in .env setzen."
      return 1
    fi
    npm_global_install "$pkg" "$label" || {
      [ -n "$api_key_env" ] && dim "Alternative: $api_key_env in .env setzen."
      return 1
    }
  else
    ok "$cli ist installiert ($($cli --version 2>/dev/null | head -1 || echo 'version unbekannt'))."
  fi

  # 2. Login-Status pruefen.
  if "$status_fn"; then
    ok "$label ist angemeldet."
    return 0
  fi

  # API-Key als gueltige Alternative akzeptieren.
  if [ -n "$api_key_env" ] && [ -n "$(env_val "$api_key_env")" ]; then
    ok "$label nutzt $api_key_env aus .env."
    return 0
  fi

  warn "$label ist noch nicht angemeldet."
  if [ "$CHECK_ONLY" -eq 1 ]; then
    dim "Anmelden mit: $login_cmd"
    [ -n "$api_key_env" ] && dim "Oder $api_key_env in .env setzen."
    return 1
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    dim "[dry-run] Login-Flow: $login_cmd"
    return 1
  fi

  # 3. Login anstossen. OAuth oeffnet den Browser; der Nutzer bestaetigt selbst.
  dim "Jetzt anmelden. Es oeffnet sich der Browser. Nach dem Login hierher zurueck."
  dim "Befehl: $login_cmd"
  if [ "$YES" -eq 1 ] && ! has_tty; then
    warn "Kein Terminal fuer den interaktiven Login. Bitte manuell ausfuehren:"
    dim "  $login_cmd"
    return 1
  fi
  if has_tty; then
    # In einem echten TTY laeuft der OAuth-Flow interaktiv.
    eval "$login_cmd" </dev/tty || warn "Login-Befehl endete mit Fehler."
  else
    eval "$login_cmd" || warn "Login-Befehl endete mit Fehler."
  fi

  # 4. Erneut pruefen.
  if "$status_fn"; then
    ok "$label ist jetzt angemeldet."
    return 0
  fi
  warn "$label-Anmeldung noch nicht bestaetigt. Spaeter erneut: $login_cmd"
  return 1
}

setup_api_engine() {
  local label="$1" api_key_env="$2"
  say "Engine: $label"
  if [ -n "$(env_val "$api_key_env")" ]; then
    ok "$api_key_env ist in .env gesetzt."
    return 0
  fi
  warn "$api_key_env fehlt in .env."
  dim "Trage den API-Key in $AC_ROOT/.env ein: $api_key_env=..."
  return 1
}

setup_local_engine() {
  local label="$1" url="$2"
  say "Engine: $label"
  if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
    ok "$label-Server antwortet ($url)."
    return 0
  fi
  warn "$label-Server nicht erreichbar ($url)."
  dim "Lokalen Server starten, dann erneut pruefen."
  return 1
}

# set -e darf den nicht-null-Rueckgabewert der Setup-Funktionen nicht in einen
# Abbruch verwandeln: RC bewusst einfangen.
RC=0
case "$ENGINE" in
  codex)
    setup_cli_engine codex "@openai/codex" "Codex CLI" "codex login" codex_logged_in OPENAI_API_KEY || RC=$?
    ;;
  claude)
    setup_cli_engine claude "@anthropic-ai/claude-code" "Claude Code" "claude login" claude_logged_in ANTHROPIC_API_KEY || RC=$?
    ;;
  gemini)
    # Gemini hat keinen reinen Login-Subcommand; der erste `gemini`-Start fuehrt
    # durch den Google-Login. Wir stossen genau das an.
    setup_cli_engine gemini "@google/gemini-cli" "Gemini CLI" "gemini" gemini_logged_in GEMINI_API_KEY || RC=$?
    ;;
  openai-api)    setup_api_engine "OpenAI API" OPENAI_API_KEY || RC=$? ;;
  anthropic-api) setup_api_engine "Anthropic API" ANTHROPIC_API_KEY || RC=$? ;;
  gemini-api)    setup_api_engine "Gemini API" GEMINI_API_KEY || RC=$? ;;
  xai-api)       setup_api_engine "xAI API" XAI_API_KEY || RC=$? ;;
  lmstudio)      setup_local_engine "LM Studio" "http://127.0.0.1:1234/v1/models" || RC=$? ;;
  ollama)        setup_local_engine "Ollama" "http://127.0.0.1:11434/api/tags" || RC=$? ;;
  manual)        say "Engine: spaeter konfigurieren"; dim "Keine Engine-Anmeldung noetig."; exit 0 ;;
  *)
    echo "Unbekannte Engine: $ENGINE" >&2
    exit 2
    ;;
esac

if [ "$CHECK_ONLY" -eq 1 ]; then
  exit 0
fi
exit "$RC"
