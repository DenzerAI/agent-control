#!/usr/bin/env bash
# setup.sh — Erstinstallation von Agent Control beim Kunden.
#
# Was es tut:
#   1. Fragt Agent-Name, Nutzer-Name, Sprache, Voice-ID ab.
#   2. Rendert die *.template-Dateien (soul/*, config/agents.json, CLAUDE.md)
#      durch Platzhalter-Ersetzung in echte Dateien.
#   3. Legt .env aus .env.example an (sofern noch nicht vorhanden).
#   4. Generiert AGENT_TOKEN automatisch, falls leer.
#   5. Installiert Python-Deps (requirements.txt) und Frontend-Deps (npm install).
#   6. Sagt klar, was als nächstes manuell zu tun ist (Keys, launchd, Tailscale).
#
# Idempotent: kann beliebig oft laufen. Bereits gerenderte Dateien werden
# nur überschrieben, wenn der Owner explizit zustimmt.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
note() { printf "  %s\n" "$*"; }
warn() { printf "\033[33m⚠ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓ %s\033[0m\n" "$*"; }

ask() {
  # ask "Frage" "default"
  local prompt="$1" default="${2:-}" answer
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " answer
    echo "${answer:-$default}"
  else
    read -r -p "$prompt: " answer
    echo "$answer"
  fi
}

confirm() {
  local prompt="$1" answer
  read -r -p "$prompt (y/N): " answer
  [[ "$answer" =~ ^[YyJj]$ ]]
}

bold "── Agent Control — Setup ──"
echo ""
echo "Dieses Skript richtet deine persönliche Instanz ein."
echo "Du kannst es jederzeit erneut starten."
echo ""

# ── 1. Fragen ──────────────────────────────────────────────────────────────
AGENT_NAME=$(ask "Wie soll dein Agent heißen?" "Agent")
USER_NAME=$(ask "Dein Vorname")
USER_FULLNAME=$(ask "Voller Name" "$USER_NAME")
USER_CITY=$(ask "Stadt" "")
TIMEZONE=$(ask "Zeitzone" "Europe/Berlin")
LANGUAGE=$(ask "Sprache" "Deutsch")
VOICE_ID=$(ask "ElevenLabs Voice-ID (optional, später nachtragbar)" "")

echo ""
bold "── Zusammenfassung ──"
note "Agent:       $AGENT_NAME"
note "Nutzer:      $USER_FULLNAME ($USER_NAME)"
note "Stadt:       $USER_CITY"
note "Zeitzone:    $TIMEZONE"
note "Sprache:     $LANGUAGE"
note "Voice-ID:    ${VOICE_ID:-(leer)}"
echo ""

confirm "Stimmt das so?" || { echo "Abgebrochen."; exit 0; }

# ── 2. Templates rendern ──────────────────────────────────────────────────
render() {
  local src="$1" dst="$2"
  if [[ -f "$dst" ]] && ! confirm "$dst existiert bereits — überschreiben?"; then
    warn "$dst übersprungen."
    return
  fi
  sed \
    -e "s|{{AGENT_NAME}}|$AGENT_NAME|g" \
    -e "s|{{USER_NAME}}|$USER_NAME|g" \
    -e "s|{{USER_FULLNAME}}|$USER_FULLNAME|g" \
    -e "s|{{USER_CITY}}|$USER_CITY|g" \
    -e "s|{{TIMEZONE}}|$TIMEZONE|g" \
    -e "s|{{LANGUAGE}}|$LANGUAGE|g" \
    -e "s|{{VOICE_ID}}|$VOICE_ID|g" \
    "$src" > "$dst"
  ok "$dst gerendert."
}

echo ""
bold "── Rendere Templates ──"
render "soul/IDENTITY.md.template" "soul/IDENTITY.md"
render "soul/MORAL.md.template"    "soul/MORAL.md"
render "soul/STYLE.md.template"    "soul/STYLE.md"
render "CLAUDE.md.template"        "CLAUDE.md"
render "config/agents.json.template" "config/agents.json"

# ── 3. .env anlegen ───────────────────────────────────────────────────────
echo ""
bold "── .env ──"
if [[ -f .env ]]; then
  ok ".env existiert schon, lass ich in Ruhe."
else
  cp .env.example .env
  TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  # AGENT_TOKEN= → AGENT_TOKEN=<generated>
  sed -i.bak "s|^AGENT_TOKEN=$|AGENT_TOKEN=$TOKEN|" .env && rm -f .env.bak
  chmod 600 .env
  ok ".env angelegt (chmod 600), AGENT_TOKEN generiert."
  warn "API-Keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) musst du noch eintragen."
fi

# ── 4. Python-Deps ────────────────────────────────────────────────────────
echo ""
bold "── Python-Abhängigkeiten ──"
if command -v python3 >/dev/null; then
  if [[ ! -d .venv ]]; then
    python3 -m venv .venv
    ok ".venv erstellt."
  fi
  source .venv/bin/activate
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
  ok "requirements.txt installiert."
  deactivate
else
  warn "python3 nicht gefunden — bitte Python 3.11+ installieren."
fi

# ── 5. Frontend-Deps ──────────────────────────────────────────────────────
echo ""
bold "── Frontend-Abhängigkeiten ──"
if command -v npm >/dev/null; then
  (cd frontend && npm install --silent)
  ok "npm install fertig."
  warn "Vor dem ersten Start: cd frontend && npm run build"
else
  warn "npm nicht gefunden — bitte Node.js 18+ installieren."
fi

# ── 6. Nächste Schritte ───────────────────────────────────────────────────
echo ""
bold "── Nächste Schritte ──"
cat <<EOS
  1. .env öffnen und API-Keys eintragen:
       \$ \$EDITOR .env

  2. Frontend bauen:
       \$ cd frontend && npm run build

  3. Server starten:
       \$ bash scripts/start.sh
     oder als launchd-Daemon:
       \$ bash scripts/launchd-start.sh

  4. UI öffnen:  http://localhost:8000

  5. Optional: Tailscale für Remote-Zugriff einrichten.
EOS
echo ""
ok "Setup fertig. Willkommen."
