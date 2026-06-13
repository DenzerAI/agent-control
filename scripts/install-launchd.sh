#!/usr/bin/env bash
# Registriert Agent Control als launchd-LaunchAgent, der beim Login startet und
# am Leben gehalten wird (KeepAlive). Idempotent: laeuft der Dienst schon unter
# diesem Label, wird er nur neu geladen, nicht doppelt gebootet.
#
# Das Label kommt aus scripts/lib/agent-control-env.sh (eine Wahrheit fuer
# restart-server.sh, health-watchdog.sh, install-launchd.sh und den
# agent-control-CLI-Wrapper). Fresh-Install-Default: com.agentcontrol.server.
# des Nutzers bestehender Checkout in $HOME/agent behaelt com.klaus.agent.
#
# Sicherheit: Eine bereits vorhandene plist mit identischem Label wird nur
# ueberschrieben, wenn sie auf denselben AC_ROOT zeigt oder --force gesetzt ist.
# So kann ein Fresh-Install niemals versehentlich eine fremde Instanz kapern.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/agent-control-env.sh
source "$HERE/lib/agent-control-env.sh"

FORCE=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --help|-h)
      echo "Usage: $0 [--force] [--uninstall]"
      echo "  Registriert ($AC_LABEL) als LaunchAgent fuer Autostart nach Reboot."
      echo "  --force      vorhandene plist ueberschreiben, auch wenn fremd."
      echo "  --uninstall  LaunchAgent entladen und plist entfernen."
      exit 0
      ;;
  esac
done

LAUNCH_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
START_SH="$AC_ROOT/scripts/launchd-start.sh"

bootout_if_loaded() {
  if launchctl print "$DOMAIN/$AC_LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$AC_LABEL" >/dev/null 2>&1 || true
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  bootout_if_loaded
  if [ -f "$AC_PLIST" ]; then
    rm -f "$AC_PLIST"
    echo "entfernt: $AC_PLIST"
  fi
  echo "ok: $AC_LABEL entladen."
  exit 0
fi

mkdir -p "$LAUNCH_DIR" "$AC_ROOT/logs"

# Schutz vor Kapern einer fremden Instanz: zeigt eine vorhandene plist mit
# gleichem Label auf einen anderen AC_ROOT, nur mit --force ueberschreiben.
if [ -f "$AC_PLIST" ] && [ "$FORCE" -ne 1 ]; then
  if ! grep -q "$START_SH" "$AC_PLIST" 2>/dev/null; then
    echo "Stopp: $AC_PLIST existiert und zeigt nicht auf diese Installation." >&2
    echo "  Diese Installation: $AC_ROOT" >&2
    echo "  Mit --force ueberschreiben, oder ein eigenes Label setzen via:" >&2
    echo "    echo 'com.agentcontrol.<name>' > $AC_ROOT/config/launchd-label" >&2
    exit 1
  fi
fi

# Label fuer die anderen Skripte festschreiben, damit alle dasselbe Label nutzen.
mkdir -p "$AC_ROOT/config"
printf '%s\n' "$AC_LABEL" > "$AC_ROOT/config/launchd-label"

PATH_VALUE="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Port nur dann ins plist schreiben, wenn er vom Default abweicht. So bleibt
# des Nutzers bestehende plist (8890) Byte-fuer-Byte unveraendert, eine zweite
# Instanz mit AC_PORT bekommt aber ihren eigenen Port in die Autostart-Umgebung.
PORT_ENV_XML=""
if [ -n "${AC_PORT:-}" ] && [ "${AC_PORT}" != "8890" ]; then
  PORT_ENV_XML="    <key>AC_PORT</key>
    <string>${AC_PORT}</string>
"
fi

cat > "$AC_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$AC_LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$START_SH</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH_VALUE</string>
    <key>HOME</key>
    <string>$HOME</string>
$PORT_ENV_XML  </dict>

  <key>WorkingDirectory</key>
  <string>$AC_ROOT/backend</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>
  <key>HardResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>$AC_ROOT/logs/server.log</string>
  <key>StandardErrorPath</key>
  <string>$AC_ROOT/logs/server.err.log</string>
</dict>
</plist>
PLIST

# Idempotent neu laden: erst (falls geladen) ausbooten, dann bootstrappen.
bootout_if_loaded
if launchctl bootstrap "$DOMAIN" "$AC_PLIST" >/dev/null 2>&1; then
  launchctl enable "$DOMAIN/$AC_LABEL" >/dev/null 2>&1 || true
  echo "ok: $AC_LABEL als Autostart registriert (startet nach Login, KeepAlive)."
else
  # Aelterer Fallback fuer macOS ohne bootstrap-Semantik.
  if launchctl load -w "$AC_PLIST" >/dev/null 2>&1; then
    echo "ok: $AC_LABEL geladen (load -w)."
  else
    echo "Hinweis: plist geschrieben, launchctl-Load fehlgeschlagen. Manuell:" >&2
    echo "  launchctl bootstrap $DOMAIN $AC_PLIST" >&2
    exit 1
  fi
fi
