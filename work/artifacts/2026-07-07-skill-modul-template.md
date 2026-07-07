# Skill-Modul im 4222-Template

Stand: 2026-07-07

## Ergebnis

Im 4222-Template gibt es jetzt ein sichtbares Skill-Modul im Workspace. Es ist in der linken Navigation als `Skills` eingehängt und ersetzt die alte lokale Skill-Liste durch ein Agentensystem-Register.

Das Modul führt die Skills von vier angebundenen Systemen zusammen: Hermes, OpenClaw, Claude Code und Codex. Jeder Skill-Eintrag enthält Name, Beschreibung, Kategorie, Quellordner und einen lokalen Nutzungszähler. Es gibt Filter nach System, Suche über Name, Beschreibung, Ordner, Kategorie und Systemname sowie eine nach Nutzung sortierte gemeinsame Liste.

Wichtig: Das ist bewusst ein UI-Template mit Datenmodell. Es führt keine Skills aus und ruft keine externen Systeme auf.

## Geänderte Bereiche

`frontend/src/workspace/SkillsWorkspace.tsx` wurde neu aufgebaut. Die Ansicht nutzt jetzt `WorkspaceShell`, zeigt Kennzahlen, Systemfilter, Suche, Quellordner-Karten und die zusammengeführte Skill-Liste.

`frontend/src/workspace/skillRegister.ts` wurde neu angelegt. Dort liegt das Datenmodell für `AgentSkillSystem`, `AgentSkill` und `SkillRegister`. Außerdem enthält die Datei Beispielsysteme und Beispielskills für Hermes, OpenClaw, Claude Code und Codex. Die Merge-Funktion `buildSkillRegister()` sammelt alle Skills in eine gemeinsame Liste und berechnet die gesamte Nutzung.

`frontend/src/workspace/WorkspaceNav.tsx` wurde erweitert. Der Workspace hat jetzt einen eigenen Nav-Eintrag `Skills` mit Wrench-Icon.

`frontend/src/index.css` wurde um die Styles für das Skill-Modul erweitert. Enthalten sind responsive Stat-Karten, Suche, Filter, Systemkarten und Skill-Zeilen. Dynamische Zahlen nutzen tabular numbers, Buttons haben 40px Mindesthöhe und Press-State, Texte nutzen `text-wrap: pretty` beziehungsweise `balance`, wo es passt.

## Datenmodell

Das Register ist lokal und später real anbindbar:

```text
AgentSkillSystem -> skills[] -> buildSkillRegister() -> gemeinsame Skill-Liste
```

Pro System gibt es:

```text
id, name, short, folder, description, skills[]
```

Pro Skill gibt es:

```text
slug, systemId, name, description, folder, category, usageCount
```

Damit ist der spätere echte Leser klar vorbereitet: Ein Agentensystem bekommt seinen Skill-Ordner, daraus werden `SKILL.md`-Dateien gelesen, die Beschreibung wird extrahiert, und der Nutzungszähler kann aus lokalen Laufprotokollen oder einer kleinen Usage-Datei kommen.

## Entscheidungen

Ich habe die alte Backend-Ladefläche aus dem Workspace-Modul entfernt, weil der Auftrag ein reines Template ohne echte Ausführung und ohne Außen-Call verlangt. Das neue Register liegt deshalb vollständig im Frontend-Datenmodell.

Ich habe Hermes, OpenClaw, Claude Code und Codex als erste Systeme modelliert. Das passt zu Christians Ziel: ein Sammelpunkt für verschiedene Agentensysteme, nicht nur für eine einzelne Engine.

Ich habe keine neue Akzentfarbe eingeführt. Das Modul nutzt die bestehende Agent-Control-CI und Claude-Coral über `--cc-orange`.

## Prüfung

`npm run build` im Ordner `frontend/` ist grün durchgelaufen.

Die responsive Prüfung konnte nur über Code und CSS-Regeln erfolgen, nicht visuell per Screenshot. Grund: Die In-App-Browser-Verbindung war in dieser Werkbank-Session nicht verfügbar, `agent.browsers.list()` lieferte eine leere Liste. Deshalb sind Hell, Dunkel und schmal als echte Browser-Sichtprüfung offen geblieben. Das ist kein verdeckter Erfolg, sondern der ehrliche Restpunkt.

## Offene Punkte

Der echte Skill-Ordner-Leser fehlt noch. Nächster sinnvoller Schritt wäre ein kleiner lokaler Reader pro Agentensystem, der konfigurierte Ordner scannt und `SKILL.md`-Metadaten in das Register speist.

Der Nutzungszähler ist aktuell Beispieldaten. Später sollte er aus lokalen Tool- oder Werkbank-Läufen gespeist werden.

Die Browser-Sichtprüfung für hell, dunkel und schmal muss nachgeholt werden, sobald der In-App-Browser wieder verfügbar ist oder Christian 4222 selbst neu lädt und prüft.

## Laienfassung

Wir haben dem Workspace eine neue Skills-Seite gegeben.

Christian kann dort später auf einen Blick sehen, welche Fähigkeiten Hermes, OpenClaw, Claude Code und Codex mitbringen und wie oft sie genutzt wurden.

Kundensatz: "Wir bauen dir nicht nur einen Agenten, sondern eine Übersicht über alle Fähigkeiten deiner Agentensysteme, damit du sie kontrollieren, erweitern und später gezielt laden kannst."
