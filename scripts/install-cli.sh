#!/usr/bin/env bash
# Macht `agent-control` global im Terminal aufrufbar.
#
# Strategie ohne sudo-Zwang:
#   1. Bevorzugt /usr/local/bin, wenn dort Schreibrecht besteht.
#   2. Sonst ~/.local/bin (und Hinweis, falls nicht im PATH).
# Es wird ein kleines Wrapper-Skript abgelegt (kein Symlink), in dem der echte
# Installationspfad (AC_HOME) fest eingesetzt ist, damit der Befehl von ueberall
# die richtige Instanz findet.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AC_ROOT="$(cd "$HERE/.." && pwd)"
SRC="$AC_ROOT/scripts/agent-control"

if [ ! -f "$SRC" ]; then
  echo "agent-control-Wrapper nicht gefunden: $SRC" >&2
  exit 1
fi

pick_target_dir() {
  if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    echo "/usr/local/bin"; return 0
  fi
  echo "$HOME/.local/bin"
}

TARGET_DIR="$(pick_target_dir)"
TARGET="$TARGET_DIR/agent-control"
mkdir -p "$TARGET_DIR"

# Wrapper mit fest eingesetztem AC_HOME schreiben (Platzhalter ersetzen).
# Wir nutzen ein anderes sed-Trennzeichen, weil der Pfad Slashes enthaelt.
sed "s|__AC_HOME__|$AC_ROOT|g" "$SRC" > "$TARGET"
chmod +x "$TARGET"

echo "ok: agent-control installiert nach $TARGET"

# PATH-Hinweis, falls ~/.local/bin (oder der Zielordner) nicht im PATH ist.
case ":$PATH:" in
  *":$TARGET_DIR:"*) : ;;
  *)
    echo
    echo "Hinweis: $TARGET_DIR ist nicht in deinem PATH."
    echo "Fuege diese Zeile in ~/.zshrc ein und oeffne ein neues Terminal:"
    echo "  export PATH=\"$TARGET_DIR:\$PATH\""
    ;;
esac
