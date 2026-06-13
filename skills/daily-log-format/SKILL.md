---
name: daily-log-format
description: Sektions-Struktur und Schreibregeln für den Daily Log in ~/agent/brain/daily-log/. Aktivieren, wann immer ein Job in den Daily Log schreibt oder aus ihm liest.
category: Logging / Format
triggers:
- 'Christian fragt nach: Sektions-Struktur und Schreibregeln für den Daily Log in ~/agent/brain/daily-log/. Aktivieren, wann immer ein Job in den Daily Log schreibt oder aus ihm liest.'
inputs:
- User request
- Relevant local files, APIs or context named in the skill
outputs:
- Completed task, edited artifact or concrete recommendation according to the skill
permissions:
- Read relevant local files and context
- Edit or create files only when the user task or skill workflow requires it
- Call local tools or APIs named in the skill when needed
risks:
- Wrong trigger or stale context can produce bad work
- External sends, deploys, deletes or purchases need the explicit approvals defined by the skill and bootstrap rules
owner: klaus
status: active
---

# daily-log-format

Eine Quelle der Wahrheit für den Daily Log. Alle Jobs, die schreiben oder lesen, greifen hier zu. Änderungen passieren nur hier.

## Was der Daily Log ist

Ein Spiegel des Tages, nicht ein Tech-Protokoll. Er soll zeigen, **was Christian dachte, fühlte, anschnitt und verwarf** — und **wie Klaus mitgedacht hat**. Bauarbeit ist Teil davon, nicht das Zentrum. Wenn man den Log nach drei Monaten liest, soll man den Menschen und den Tag spüren, nicht nur Commit-Zeilen.

Faustregel: wenn der Tag substantiell war und nichts Persönliches/Stimmungsmäßiges im Log steht, fehlt etwas. Das gilt umgekehrt nicht: ein ruhiger Mensch-Tag ohne viel Build-Output ist ein gültiger Log.

## Pfad

`~/agent/brain/daily-log/YYYY-MM-DD.md`

Datum per `date +%Y-%m-%d`, nie manuell rechnen, nie "gestern" annehmen. Der Daily Log gilt immer für den Tag, an dem der Job feuert.

Wenn die Datei oder der Ordner fehlt, anlegen. Wenn die Datei existiert, ergänzen und nie überschreiben.

## Sektionen

Reihenfolge fest, leere Sektionen weglassen.

```markdown
## Claude Code

### Stimmung / Energie
- Wie war Christians Energie heute? Wo war er fokussiert, wo abgelenkt, wo gereizt, wo angesprungen?
- Lust- und Frustpunkte, Tempo, Mood-Wechsel. Konkrete Auslöser nennen, nicht generisch.
- Auch persönliches Leben gehört hier rein: Hochzeit, Familie, Gesundheit, Kunden-Sorgen, Geld-Themen, FCH, PT-Zweifel — alles was den Kopf gefüllt hat, auch wenn es nichts mit Build zu tun hatte.

### Christians Gedanken
- Ideen, Visionen, Wünsche, Zweifel, Sorgen — möglichst nah an seiner Wortwahl.
- **Was hat ihn angesprungen?** Welche Idee hat sofort Energie gehabt?
- **Welche Ideen wurden verworfen** und warum (eigenes Veto, andere Priorität, technisch nicht greifbar)?
- Längere Zitate sind erwünscht, wenn sie den Ton tragen. Verdichten, nicht glätten.

### Klaus' Gedanken
- Wie Klaus auf Christians Gedanken reagiert hat: zugestimmt, widersprochen, weitergesponnen.
- Eigene Beobachtungen, Muster, Sorgen, die Klaus während des Tages aufgefallen sind.
- Bewusst kurz, keine zweite Christian-Sektion. Aber sichtbar — der Log ist Zwiegespräch, nicht Monolog.

### Menschen / CRM
- Wer war heute Thema: Kunden, Leads, Freunde, Familie. Aus `data/people.db`, WhatsApp-Chats, Mails, Kalendern, FOCUS-Tags.
- **Bewegung in der Pipeline**: neue Leads, Status-Wechsel (Lead→Kunde, Kunde→inaktiv), Nachfass fällig, Abschluss, Verlust.
- **WhatsApp-Spuren**: mit wem ein längerer Schlagabtausch lief, welche Drafts raus oder liegen geblieben sind, welche Stimmung im Chat war.
- **Termin-Highlights**: was lief, was steht morgen/diese Woche an, wer sagte ab, wer kam neu rein.
- **FOCUS / @slug-Bewegung**: neue Personen-Tags in FOCUS, abgeschlossene Tags, lange offene Tags die mahnen.
- Verdichten, nicht jeden Namen aufzählen — nur wo Bewegung war oder bewusst keine (Funkstille bei wichtigem Lead = ebenfalls erwähnenswert).

### Gebaut / Umgesetzt
- Konkrete Features, Fixes, Änderungen mit Commit/Pfad/Dateiname wenn relevant.
- Zahlen wo sie tragen (Zeilen-Delta, Bundle-Größe, Anzahl Datensätze).

### Besprochen / Entschieden
- Richtungswechsel, Strategie-Entscheide, Architektur-Festlegungen. Mit kurzer Begründung.

### Was gut / schlecht lief
- Wo lief der Tag rund, wo zog er sich, wo waren Sackgassen, wo lag ein Aha-Moment.
- Dauerthemen markieren wenn sie wiederkommen (Server-Restart-Drama, Outbound-Vorfälle, Modularisierungs-Faden).
- Tempo, Reibung, Methodik — das WIE neben dem WAS.

### Probleme / Reibung
- Konkrete Bugs, Frust, abgebrochene Versuche, ungelöste Konflikte.
- Was hakte technisch, wo haben wir uns im Kreis gedreht.

### Offen / Nächste Schritte
- Was als nächstes ansteht, gerne mit Verknüpfung zu `/fokus`, `threads.md` oder Projektstand.
```

Parallel dazu schreibt der Radar-Verdichter (`jobs/radar-konsolidiert`) eine eigene H2-Sektion:

```markdown
## Morgenradar

_Volltext: `jobs/radar-konsolidiert/data/YYYY-MM-DD-radar-konsolidiert.md`_

### Highlights
- Drei bis fünf verdichtete Punkte: was ist heute am Markt wirklich wichtig, mit klickbarem Link und einem Satz Einordnung.
```

Die Einzel-Radare (X, Web, Tech, YouTube, AGI) schreiben **nicht** mehr in den Daily Log. Sie speichern ihre Volltexte in `jobs/radar-*/data/YYYY-MM-DD-radar-*.md` und werden anschließend von `radar-konsolidiert` zu einem dedup-sauberen Tagesbericht zusammengeführt — dieser Bericht ist die Quelle für die Daily-Log-Highlights.

## Schreibregeln

**Stimmung vor Bauarbeit.** Wenn beide Sektionen Material haben, kommt Stimmung/Energie zuerst, dann Christians Gedanken, dann Klaus' Gedanken, dann Build. Mensch vor Code.

**Rohstoff aus den Chats ziehen.** Der Daily Log ist kein abstrakter Bericht, er soll an realen Sätzen Christians hängen. Verdichten ja, glätten nein. Wenn Christian "großes Foul" sagt, steht "großes Foul" im Log, nicht "negative Rückmeldung".

**Auch das Verworfene loggen.** Nicht nur was gebaut wurde, sondern auch was angedacht und wieder fallengelassen wurde, mit Grund. Das ist später Goldwert.

**Nicht überschreiben.** Bestehende Inhalte anderer Sessions oder anderer Jobs nie antasten. Nur die eigene Sektion ergänzen oder, wenn sie schon existiert, ersetzen.

**Datei unmittelbar vor dem Write nochmal lesen.** Nie aus dem Kontext-Cache arbeiten, weil parallele Jobs dieselbe Datei anfassen können. Kein File-Locking.

**Verdichten, nicht aufzählen.** Jeder Eintrag bringt Substanz. Wenn nichts Relevantes zu sagen ist, Sektion weglassen oder mit `NO_REPLY` antworten, je nach Job.

**Knapp wo's reicht, ausführlich wo's trägt.** Stimmung, Gedanken und Verworfenes dürfen mehr Raum nehmen. Build-Listen bleiben Listen. Maximale Knappheit gilt für Build, nicht für Mensch.

## Integrationen

Wenn ein Job eine bestehende `## Claude Code`-Sektion bereits vorfindet, ersetzt er sie mit der aktualisierten Version, statt eine zweite anzuhängen.

Wenn ein Verdichter-Job (memory-log) läuft und eine `## Claude Code`-Sektion findet, integriert er ihre Punkte in die übergeordnete Verdichtung und entfernt die Sektion danach.

Volltext-Radare schreiben in `brain/radar/YYYY-MM-DD.md` (eigenes Format, frei). Der Morgenradar-Verdichter zieht daraus die Top-3-5 Highlights in den Daily Log.
