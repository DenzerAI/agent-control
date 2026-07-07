# shellcheck shell=bash
# Geteilte Umgebung fuer Agent-Control-Skripte.
# Wird via `source` eingebunden, definiert KEINE eigene Shebang und ruft kein exit.
#
# Exportiert / setzt:
#   AC_ROOT     Projektwurzel (Verzeichnis ueber scripts/)
#   AC_PORT     Server-Port (Default 4222)
#   AC_LABEL    launchd-Label fuer diese Instanz
#   AC_PY       venv-Python, faellt auf /usr/bin/python3 zurueck
#   AC_PLIST    Pfad zur LaunchAgent-plist dieser Instanz
#
# Label-Logik (eine Wahrheit fuer restart/watchdog/launchd/CLI):
#   1. config/launchd-label (vom Setup geschrieben) gewinnt, falls vorhanden.
#   2. des Nutzers bestehender Checkout in $HOME/agent behaelt com.klaus.agent
#      (Abwaertskompatibilitaet: restart-server.sh/health-watchdog.sh erwarten das).
#   3. Sonst com.agentcontrol.server (neutraler Fresh-Install-Default).

# AC_ROOT bestimmen, ohne von $0 abzuhaengen (funktioniert auch beim source).
if [ -z "${AC_ROOT:-}" ]; then
  if [ -n "${BASH_SOURCE:-}" ]; then
    AC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  else
    AC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  fi
fi

if [ -z "${AC_PORT:-}" ]; then
  if [ "$AC_ROOT" = "$HOME/agent" ]; then
    AC_PORT="8890"
  else
    AC_PORT="4222"
  fi
fi

if [ -z "${AC_LABEL:-}" ]; then
  if [ -f "$AC_ROOT/config/launchd-label" ]; then
    AC_LABEL="$(tr -d '[:space:]' < "$AC_ROOT/config/launchd-label")"
  elif [ "$AC_ROOT" = "$HOME/agent" ]; then
    AC_LABEL="com.klaus.agent"
  else
    AC_LABEL="com.agentcontrol.server"
  fi
fi

AC_PY="$AC_ROOT/.venv/bin/python3"
if [ ! -x "$AC_PY" ]; then
  AC_PY="$AC_ROOT/.venv/bin/python"
fi
if [ ! -x "$AC_PY" ]; then
  AC_PY="$(command -v python3 || echo /usr/bin/python3)"
fi

AC_PLIST="$HOME/Library/LaunchAgents/$AC_LABEL.plist"

export AC_ROOT AC_PORT AC_LABEL AC_PY AC_PLIST
