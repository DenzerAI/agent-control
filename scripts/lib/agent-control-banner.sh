# shellcheck shell=bash
# Geteiltes Agent-Control Terminal-Banner (CLI-Splash).
# Wird via `source` eingebunden, definiert KEINE eigene Shebang und ruft kein exit.
#
# Rendert "AGENT CONTROL" zweizeilig im ANSI-Shadow-Stil (figlet-Font, fertig
# eingebettet als Heredoc -> figlet wird zur Laufzeit NICHT gebraucht), eingefaerbt
# mit einem vertikalen Terracotta-Verlauf von hell oben (232,140,108) nach tief
# unten (176,74,48). Die ANSI-Shadow-Kantenzeichen (Box-Drawing) werden auf ~50%
# Helligkeit abgedunkelt -> dezenter 3D-Schatten.
#
# Oeffentliche Funktion:
#   agent_control_banner_logo   ASCII-Logo (gefaerbt/fallback) auf stdout ausgeben
#
# Faerbung wird automatisch gewaehlt:
#   - Truecolor (Default an Terminals mit perl): vertikaler RGB-Verlauf + Schatten.
#   - Kein TTY / NO_COLOR gesetzt: plain ASCII, keine Escape-Codes.
#   - Kein Truecolor oder kein perl: einfarbig in der 256-Farben-Akzentfarbe (173),
#     nie kaputte Escapes.
#
# Steuer-Override (optional, fuer Tests):
#   AGENT_CONTROL_BANNER_MODE = truecolor | accent | plain   erzwingt den Modus.

# Eingebettetes ANSI-Shadow-ASCII: AGENT (Zeilen 1-6) ueber CONTROL (Zeilen 7-12).
# Fest eingebettet, damit der Installer KEINE figlet-Abhaengigkeit hat.
agent_control_banner_ascii() {
  cat <<'ACBANNER'
 █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
 ██████╗ ██████╗ ███╗   ██╗████████╗██████╗  ██████╗ ██╗
██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔══██╗██╔═══██╗██║
██║     ██║   ██║██╔██╗ ██║   ██║   ██████╔╝██║   ██║██║
██║     ██║   ██║██║╚██╗██║   ██║   ██╔══██╗██║   ██║██║
╚██████╗╚██████╔╝██║ ╚████║   ██║   ██║  ██║╚██████╔╝███████╗
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
ACBANNER
}

# Modus bestimmen.
_agent_control_banner_mode() {
  if [ -n "${AGENT_CONTROL_BANNER_MODE:-}" ]; then
    printf '%s' "$AGENT_CONTROL_BANNER_MODE"
    return 0
  fi
  # Kein TTY oder NO_COLOR -> plain (keine Escape-Codes).
  if [ ! -t 1 ] || [ -n "${NO_COLOR:-}" ]; then
    printf 'plain'
    return 0
  fi
  # Truecolor braucht perl fuer sauberes UTF-8-Faerben.
  if command -v perl >/dev/null 2>&1; then
    case "${COLORTERM:-}" in
      *truecolor*|*24bit*) printf 'truecolor'; return 0 ;;
    esac
    case "${TERM:-}" in
      *-direct|iterm*|*-truecolor) printf 'truecolor'; return 0 ;;
    esac
  fi
  # Sonst: einfarbiger 256-Farben-Akzent (Terracotta 173).
  printf 'accent'
}

# Truecolor-Faerbung via perl (sauberes UTF-8, kein figlet noetig).
# Vertikaler Verlauf hell->tief je Zeile; Box-Drawing-Schattenzeichen auf ~50%.
_agent_control_banner_truecolor() {
  agent_control_banner_ascii | perl -CSDA -Mutf8 -e '
    my @lines = <STDIN>;
    chomp @lines;
    my $total = scalar @lines;
    my ($tr,$tg,$tb) = (232,140,108);   # oben, hell
    my ($br,$bg,$bb) = (176, 74, 48);   # unten, tief
    my $shadow = 0.5;                    # Schattenzeichen-Helligkeit
    my $fill  = "\x{2588}";              # █  (Vollblock = Gesicht/Fuellung)
    my %shadowset = map { $_ => 1 } (
      "\x{2550}","\x{2551}","\x{2554}","\x{2557}","\x{255a}","\x{255d}"
    );  # ═ ║ ╔ ╗ ╚ ╝  (ANSI-Shadow-Kanten)
    for my $i (0 .. $#lines) {
      my $t = $total > 1 ? $i/($total-1) : 0;
      my $r = int($tr + ($br-$tr)*$t + 0.5);
      my $g = int($tg + ($bg-$tg)*$t + 0.5);
      my $b = int($tb + ($bb-$tb)*$t + 0.5);
      my ($sr,$sg,$sb) = (int($r*$shadow+0.5), int($g*$shadow+0.5), int($b*$shadow+0.5));
      my $line = $lines[$i];
      my $out = "";
      my $cur = -1;   # 0=face, 1=shadow, 2=space (nur bei Wechsel neuen Code setzen)
      for my $ch (split //, $line) {
        my $kind;
        if    ($ch eq " ")          { $kind = 2; }
        elsif ($ch eq $fill)        { $kind = 0; }
        elsif ($shadowset{$ch})     { $kind = 1; }
        else                        { $kind = 0; }  # Sicherheitsnetz: als Gesicht
        if ($kind != $cur) {
          if    ($kind == 0) { $out .= sprintf("\e[38;2;%d;%d;%dm", $r,$g,$b); }
          elsif ($kind == 1) { $out .= sprintf("\e[38;2;%d;%d;%dm", $sr,$sg,$sb); }
          else               { $out .= "\e[0m"; }
          $cur = $kind;
        }
        $out .= $ch;
      }
      $out .= "\e[0m";
      print $out, "\n";
    }
  '
}

# 256-Farben-Akzent-Fallback: einfarbig Terracotta (173), Schatten dezent dunkler (130).
_agent_control_banner_accent() {
  if command -v perl >/dev/null 2>&1; then
    agent_control_banner_ascii | perl -CSDA -Mutf8 -e '
      my $face  = "\e[38;5;173m";   # Terracotta 256
      my $shade = "\e[38;5;130m";   # dunkler fuer Schattenzeichen
      my $reset = "\e[0m";
      my %shadowset = map { $_ => 1 } (
        "\x{2550}","\x{2551}","\x{2554}","\x{2557}","\x{255a}","\x{255d}"
      );
      while (my $line = <STDIN>) {
        chomp $line;
        my $out = ""; my $cur = -1;
        for my $ch (split //, $line) {
          my $kind = ($ch eq " ") ? 2 : ($shadowset{$ch} ? 1 : 0);
          if ($kind != $cur) {
            if    ($kind == 0) { $out .= $face; }
            elsif ($kind == 1) { $out .= $shade; }
            else               { $out .= $reset; }
            $cur = $kind;
          }
          $out .= $ch;
        }
        print $out, $reset, "\n";
      }
    '
  else
    # perl fehlt: komplett einfarbig, ohne Schattendifferenzierung.
    printf '\033[38;5;173m'
    agent_control_banner_ascii
    printf '\033[0m'
  fi
}

# Oeffentlich: Logo ausgeben (waehlt Modus automatisch / via Override).
agent_control_banner_logo() {
  local mode
  mode="$(_agent_control_banner_mode)"
  case "$mode" in
    truecolor) _agent_control_banner_truecolor ;;
    accent)    _agent_control_banner_accent ;;
    plain|*)   agent_control_banner_ascii ;;
  esac
}
