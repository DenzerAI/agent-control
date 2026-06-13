import type { ToolPhrasePhase } from './chatToolPhrases.base'

export type GeneratedSubtypeSpec = {
  read: string
  edit: string
  write: string
  search: string
}

function buildGeneratedSubtypePhrases(spec: GeneratedSubtypeSpec): Record<string, string[]> {
  return {
    start: [
      `Ich schaue gerade in ${spec.read} rein.`,
      `Ich prüfe gerade ${spec.read}.`,
      `Ich gehe gerade ${spec.read} durch.`,
      `Ich lese gerade ${spec.read} an.`,
      `Ich taste mich gerade in ${spec.read} rein.`,
      `Ich halte gerade kurz die Lupe auf ${spec.read}.`,
    ],
    steady: [
      `Ich prüfe ${spec.read} gerade noch.`,
      `Ich lese ${spec.read} gerade weiter.`,
      `Ich bin noch an ${spec.read} dran.`,
      `Ich gleiche ${spec.read} gerade ab.`,
      `Ich schaue mir ${spec.read} gerade weiter an.`,
      `Ich bleibe gerade noch kurz bei ${spec.read}.`,
    ],
    deep: [
      `Ich prüfe ${spec.read} noch gründlicher.`,
      `Ich gehe ${spec.read} noch tiefer durch.`,
      `Ich bleibe noch kurz bei ${spec.read}.`,
      `Ich gleiche ${spec.read} noch genauer ab.`,
      `Ich lese ${spec.read} noch sauber zu Ende ein.`,
      `Ich halte ${spec.read} noch einen Tick länger im Blick.`,
    ],
  }
}

function buildGeneratedEditPhrases(spec: GeneratedSubtypeSpec): Record<string, string[]> {
  return {
    start: [
      `Ich passe gerade ${spec.edit} an.`,
      `Ich ändere gerade ${spec.edit}.`,
      `Ich richte gerade ${spec.edit} aus.`,
      `Ich schraube gerade an ${spec.edit}.`,
      `Ich ziehe gerade ${spec.edit} gerade.`,
      `Ich feile gerade an ${spec.edit}.`,
    ],
    steady: [
      `Ich arbeite gerade noch an ${spec.edit}.`,
      `Ich gleiche ${spec.edit} gerade weiter ab.`,
      `Ich bin noch an ${spec.edit} dran.`,
      `Ich richte ${spec.edit} gerade noch aus.`,
      `Ich poliere ${spec.edit} gerade weiter.`,
      `Ich ziehe ${spec.edit} gerade noch in Ruhe gerade.`,
    ],
    deep: [
      `Ich feile noch an ${spec.edit}.`,
      `Ich bringe ${spec.edit} noch sauber in Form.`,
      `Ich gleiche ${spec.edit} noch genauer ab.`,
      `Ich bleibe noch kurz an ${spec.edit} dran.`,
      `Ich mache ${spec.edit} gerade noch belastbarer.`,
      `Ich ziehe ${spec.edit} noch auf die saubere Linie.`,
    ],
  }
}

function buildGeneratedWritePhrases(spec: GeneratedSubtypeSpec): Record<string, string[]> {
  return {
    start: [
      `Ich baue gerade ${spec.write} auf.`,
      `Ich schreibe gerade ${spec.write} aus.`,
      `Ich setze gerade ${spec.write} auf.`,
      `Ich tippe gerade ${spec.write} ein.`,
      `Ich ziehe gerade ${spec.write} hoch.`,
      `Ich lege gerade ${spec.write} frisch an.`,
    ],
    steady: [
      `Ich schreibe ${spec.write} gerade weiter.`,
      `Ich baue ${spec.write} gerade noch aus.`,
      `Ich bin noch an ${spec.write} dran.`,
      `Ich setze ${spec.write} gerade weiter zusammen.`,
      `Ich ergänze ${spec.write} gerade noch.`,
      `Ich ziehe ${spec.write} gerade Stück für Stück hoch.`,
    ],
    deep: [
      `Ich schreibe ${spec.write} noch sauber zu Ende.`,
      `Ich baue ${spec.write} noch fertig aus.`,
      `Ich bringe ${spec.write} noch in Form.`,
      `Ich bleibe noch kurz an ${spec.write} dran.`,
      `Ich ziehe ${spec.write} noch vollständig hoch.`,
      `Ich mache ${spec.write} gerade noch komplett rund.`,
    ],
  }
}

function buildGeneratedSearchPhrases(spec: GeneratedSubtypeSpec): Record<string, string[]> {
  return {
    start: [
      `Ich suche gerade ${spec.search}.`,
      `Ich prüfe gerade, wo ${spec.search} sitzt.`,
      `Ich scanne gerade ${spec.search} ab.`,
      `Ich bin gerade bei ${spec.search} auf Spurensuche.`,
      `Ich suche gerade den passenden Punkt in ${spec.search}.`,
      `Ich halte gerade den Suchscheinwerfer auf ${spec.search}.`,
    ],
    steady: [
      `Ich suche in ${spec.search} gerade noch weiter.`,
      `Ich gleiche gerade mehrere Stellen in ${spec.search} ab.`,
      `Ich bin noch bei ${spec.search} auf Spur.`,
      `Ich prüfe gerade noch den richtigen Treffer in ${spec.search}.`,
      `Ich taste ${spec.search} gerade weiter ab.`,
      `Ich ziehe gerade noch falsche Fährten aus ${spec.search} raus.`,
    ],
    deep: [
      `Ich gehe ${spec.search} noch gründlicher durch.`,
      `Ich prüfe noch tiefer, welche Spur in ${spec.search} trägt.`,
      `Ich gleiche die Treffer in ${spec.search} noch genauer ab.`,
      `Ich bleibe noch kurz auf der Spur in ${spec.search}.`,
      `Ich suche noch tiefer in ${spec.search}.`,
      `Ich bohre mich noch etwas tiefer durch ${spec.search}.`,
    ],
  }
}

export const GENERATED_SUBTYPE_SPECS: Record<string, GeneratedSubtypeSpec> = {
  frontend_component: {
    read: 'die Komponente',
    edit: 'der Komponente',
    write: 'die Komponente',
    search: 'der Komponente',
  },
  frontend_layout: {
    read: 'das Layout',
    edit: 'dem Layout',
    write: 'das Layout',
    search: 'dem Layout',
  },
  frontend_chat: {
    read: 'den Chat-Bereich',
    edit: 'dem Chat-Bereich',
    write: 'den Chat-Bereich',
    search: 'dem Chat-Bereich',
  },
  frontend_settings_ui: {
    read: 'die Einstellungsansicht',
    edit: 'der Einstellungsansicht',
    write: 'die Einstellungsansicht',
    search: 'der Einstellungsansicht',
  },
  frontend_mobile: {
    read: 'die mobile Ansicht',
    edit: 'der mobilen Ansicht',
    write: 'die mobile Ansicht',
    search: 'der mobilen Ansicht',
  },
  frontend_state: {
    read: 'die Zustandslogik',
    edit: 'der Zustandslogik',
    write: 'die Zustandslogik',
    search: 'der Zustandslogik',
  },
  frontend_auth: {
    read: 'den Login-Bereich',
    edit: 'dem Login-Bereich',
    write: 'den Login-Bereich',
    search: 'dem Login-Bereich',
  },
  frontend_routing: {
    read: 'die Navigation',
    edit: 'der Navigation',
    write: 'die Navigation',
    search: 'der Navigation',
  },
  frontend_forms: {
    read: 'die Formulare',
    edit: 'den Formularen',
    write: 'die Formulare',
    search: 'den Formularen',
  },
  frontend_table: {
    read: 'die Tabelle',
    edit: 'der Tabelle',
    write: 'die Tabelle',
    search: 'der Tabelle',
  },
  frontend_list: {
    read: 'die Liste',
    edit: 'der Liste',
    write: 'die Liste',
    search: 'der Liste',
  },
  frontend_search_ui: {
    read: 'die Suche und Filter',
    edit: 'der Suche und den Filtern',
    write: 'die Suche und Filter',
    search: 'der Suche und den Filtern',
  },
  frontend_modal: {
    read: 'die Pop-up-Ansicht',
    edit: 'der Pop-up-Ansicht',
    write: 'die Pop-up-Ansicht',
    search: 'der Pop-up-Ansicht',
  },
  frontend_upload: {
    read: 'den Upload-Bereich',
    edit: 'dem Upload-Bereich',
    write: 'den Upload-Bereich',
    search: 'dem Upload-Bereich',
  },
  frontend_animation: {
    read: 'die Bewegung',
    edit: 'der Bewegung',
    write: 'die Bewegung',
    search: 'der Bewegung',
  },
  frontend_sound: {
    read: 'den Ton-Bereich',
    edit: 'dem Ton-Bereich',
    write: 'den Ton-Bereich',
    search: 'dem Ton-Bereich',
  },
  frontend_analytics: {
    read: 'die Auswertung im Frontend',
    edit: 'der Auswertung im Frontend',
    write: 'die Auswertung im Frontend',
    search: 'der Auswertung im Frontend',
  },
  backend_api: {
    read: 'die API-Stelle',
    edit: 'der API-Stelle',
    write: 'die API-Stelle',
    search: 'der API-Stelle',
  },
  backend_db: {
    read: 'die Datenbanklogik',
    edit: 'der Datenbanklogik',
    write: 'die Datenbanklogik',
    search: 'der Datenbanklogik',
  },
  backend_stream: {
    read: 'die Streaming-Stelle',
    edit: 'der Streaming-Stelle',
    write: 'die Streaming-Stelle',
    search: 'der Streaming-Stelle',
  },
  backend_integration: {
    read: 'die Anbindung',
    edit: 'der Anbindung',
    write: 'die Anbindung',
    search: 'der Anbindung',
  },
  backend_script: {
    read: 'das Script',
    edit: 'dem Script',
    write: 'das Script',
    search: 'dem Script',
  },
  backend_job: {
    read: 'den Job',
    edit: 'dem Job',
    write: 'den Job',
    search: 'dem Job',
  },
  backend_auth: {
    read: 'die Zugangslogik',
    edit: 'der Zugangslogik',
    write: 'die Zugangslogik',
    search: 'der Zugangslogik',
  },
  backend_queue: {
    read: 'die Warteschlange',
    edit: 'der Warteschlange',
    write: 'die Warteschlange',
    search: 'der Warteschlange',
  },
  backend_worker: {
    read: 'den Worker',
    edit: 'dem Worker',
    write: 'den Worker',
    search: 'dem Worker',
  },
  backend_cron: {
    read: 'den Zeitplan',
    edit: 'dem Zeitplan',
    write: 'den Zeitplan',
    search: 'dem Zeitplan',
  },
  backend_filesystem: {
    read: 'die Dateienlogik',
    edit: 'der Dateienlogik',
    write: 'die Dateienlogik',
    search: 'der Dateienlogik',
  },
  backend_permissions: {
    read: 'die Rechte-Logik',
    edit: 'der Rechte-Logik',
    write: 'die Rechte-Logik',
    search: 'der Rechte-Logik',
  },
  backend_env: {
    read: 'die Umgebungswerte',
    edit: 'den Umgebungswerten',
    write: 'die Umgebungswerte',
    search: 'den Umgebungswerten',
  },
  backend_secrets: {
    read: 'die geheimen Zugänge',
    edit: 'den geheimen Zugängen',
    write: 'die geheimen Zugänge',
    search: 'den geheimen Zugängen',
  },
  backend_logging: {
    read: 'die Log-Ausgabe',
    edit: 'der Log-Ausgabe',
    write: 'die Log-Ausgabe',
    search: 'der Log-Ausgabe',
  },
  backend_errors: {
    read: 'die Fehlerbehandlung',
    edit: 'der Fehlerbehandlung',
    write: 'die Fehlerbehandlung',
    search: 'der Fehlerbehandlung',
  },
  backend_import_export: {
    read: 'den Ein- und Ausgabepfad',
    edit: 'dem Ein- und Ausgabepfad',
    write: 'den Ein- und Ausgabepfad',
    search: 'dem Ein- und Ausgabepfad',
  },
  backend_analytics: {
    read: 'die Auswertung im Hintergrund',
    edit: 'der Auswertung im Hintergrund',
    write: 'die Auswertung im Hintergrund',
    search: 'der Auswertung im Hintergrund',
  },
  backend_mail: {
    read: 'die Mail-Anbindung',
    edit: 'der Mail-Anbindung',
    write: 'die Mail-Anbindung',
    search: 'der Mail-Anbindung',
  },
  backend_calendar: {
    read: 'die Kalender-Anbindung',
    edit: 'der Kalender-Anbindung',
    write: 'die Kalender-Anbindung',
    search: 'der Kalender-Anbindung',
  },
  backend_whatsapp: {
    read: 'die WhatsApp-Anbindung',
    edit: 'der WhatsApp-Anbindung',
    write: 'die WhatsApp-Anbindung',
    search: 'der WhatsApp-Anbindung',
  },
  tests_unit: {
    read: 'die Unit-Tests',
    edit: 'den Unit-Tests',
    write: 'die Unit-Tests',
    search: 'den Unit-Tests',
  },
  tests_integration: {
    read: 'die Integrationstests',
    edit: 'den Integrationstests',
    write: 'die Integrationstests',
    search: 'den Integrationstests',
  },
  tests_e2e: {
    read: 'die End-to-End-Tests',
    edit: 'den End-to-End-Tests',
    write: 'die End-to-End-Tests',
    search: 'den End-to-End-Tests',
  },
}

export function createGeneratedSubtypePhrases(): Record<string, Record<ToolPhrasePhase, string[]>> {
  const out: Record<string, Record<ToolPhrasePhase, string[]>> = {}
  for (const [suffix, spec] of Object.entries(GENERATED_SUBTYPE_SPECS)) {
    out[`read_${suffix}`] = buildGeneratedSubtypePhrases(spec)
    out[`edit_${suffix}`] = buildGeneratedEditPhrases(spec)
    out[`write_${suffix}`] = buildGeneratedWritePhrases(spec)
    out[`search_${suffix}`] = buildGeneratedSearchPhrases(spec)
  }
  return out
}

export const EXTRA_EXEC_PHRASES: Record<string, Record<ToolPhrasePhase, string[]>> = {
  exec_install: {
  
    start: [
      'Ich stoße gerade die Installation an.',
      'Ich lade gerade die Pakete rein.',
      'Ich kümmere mich gerade um die Abhängigkeiten.',
      'Ich starte gerade den Installlauf.',
      'Ich hole gerade die fehlenden Bausteine rein.',
    ],
    steady: [
      'Ich lasse die Installation gerade noch laufen.',
      'Ich warte gerade noch auf die Pakete.',
      'Ich bin noch bei den Abhängigkeiten dran.',
      'Ich halte den Installlauf gerade noch offen.',
      'Ich prüfe gerade noch, ob alles sauber reinkommt.',
    ],
    deep: [
      'Ich warte noch, bis die Installation sauber durch ist.',
      'Ich prüfe die Abhängigkeiten noch genauer.',
      'Ich bleibe noch kurz beim Installlauf.',
      'Ich halte die Paketlage noch unter Beobachtung.',
      'Ich prüfe noch, ob alles vollständig angekommen ist.',
    ],
  },

  exec_format: {
  
    start: [
      'Ich stoße gerade das Formatieren an.',
      'Ich ziehe gerade den Code glatt.',
      'Ich räume gerade die Formatierung auf.',
      'Ich starte gerade den Schönheitslauf.',
      'Ich richte gerade den Code sauber aus.',
    ],
    steady: [
      'Ich lasse das Formatieren gerade noch laufen.',
      'Ich bin noch an der Formatierung dran.',
      'Ich halte den Schönheitslauf gerade noch offen.',
      'Ich prüfe gerade noch, ob alles sauber ausgerichtet ist.',
      'Ich ziehe den Code gerade noch weiter glatt.',
    ],
    deep: [
      'Ich prüfe die Formatierung noch gründlicher.',
      'Ich bleibe noch kurz beim Ausrichten dran.',
      'Ich halte den Schönheitslauf noch unter Beobachtung.',
      'Ich prüfe noch, ob der Code jetzt überall ruhig sitzt.',
      'Ich ziehe die Formatierung noch sauber zu Ende.',
    ],
  },

  exec_migrate: {
  
    start: [
      'Ich stoße gerade die Umstellung an.',
      'Ich ziehe gerade die Datenstruktur nach.',
      'Ich starte gerade den Migrationslauf.',
      'Ich passe gerade die Datenbasis an.',
      'Ich kümmere mich gerade um die Strukturänderung.',
    ],
    steady: [
      'Ich lasse die Umstellung gerade noch laufen.',
      'Ich bin noch an der Datenstruktur dran.',
      'Ich halte den Migrationslauf gerade noch offen.',
      'Ich prüfe gerade noch, ob die Struktur sauber nachzieht.',
      'Ich warte gerade noch auf die Datenumstellung.',
    ],
    deep: [
      'Ich prüfe die Umstellung noch gründlicher.',
      'Ich bleibe noch kurz bei der Datenstruktur dran.',
      'Ich halte den Migrationslauf noch unter Beobachtung.',
      'Ich prüfe noch, ob die Struktur jetzt sauber sitzt.',
      'Ich warte noch, bis die Umstellung ruhig durch ist.',
    ],
  },

  exec_deploy: {
  
    start: [
      'Ich stoße gerade das Live-Schalten an.',
      'Ich bringe die Änderung gerade raus.',
      'Ich starte gerade den Deploy-Lauf.',
      'Ich schiebe gerade die Fassung nach draußen.',
      'Ich mache die Änderung gerade live.',
    ],
    steady: [
      'Ich lasse das Live-Schalten gerade noch laufen.',
      'Ich warte gerade noch auf den Deploy-Lauf.',
      'Ich bin noch beim Rausbringen dran.',
      'Ich halte den Deploy gerade noch im Blick.',
      'Ich prüfe gerade noch, ob alles sauber live geht.',
    ],
    deep: [
      'Ich warte noch, bis das Live-Schalten sauber durch ist.',
      'Ich prüfe den Deploy noch gründlicher.',
      'Ich bleibe noch kurz beim Rausbringen dran.',
      'Ich halte den Live-Gang noch unter Beobachtung.',
      'Ich prüfe noch, ob draußen alles ruhig ankommt.',
    ],
  },

  exec_ci: {
  
    start: [
      'Ich stoße gerade die Prüfpipeline an.',
      'Ich starte gerade den Automatentest.',
      'Ich lasse gerade die Pipeline laufen.',
      'Ich schicke die Änderung gerade durch die Kontrollstraße.',
      'Ich werfe gerade die CI an.',
    ],
    steady: [
      'Ich lasse die Prüfpipeline gerade noch laufen.',
      'Ich warte gerade noch auf den Automatentest.',
      'Ich bin noch in der Kontrollstraße dran.',
      'Ich halte die Pipeline gerade noch offen.',
      'Ich prüfe gerade noch, ob die Kette sauber durchläuft.',
    ],
    deep: [
      'Ich prüfe die Pipeline noch gründlicher.',
      'Ich warte noch, bis die Kontrollstraße sauber durch ist.',
      'Ich bleibe noch kurz an der CI dran.',
      'Ich halte den Automatentest noch unter Beobachtung.',
      'Ich prüfe noch, ob die ganze Kette Ruhe gibt.',
    ],
  },

  exec_backup: {
  
    start: [
      'Ich stoße gerade die Sicherung an.',
      'Ich sichere gerade den Stand weg.',
      'Ich starte gerade das Backup.',
      'Ich packe gerade eine Sicherheitskopie.',
      'Ich bringe den Stand gerade in Sicherheit.',
    ],
    steady: [
      'Ich lasse die Sicherung gerade noch laufen.',
      'Ich warte gerade noch auf das Backup.',
      'Ich bin noch bei der Sicherheitskopie dran.',
      'Ich halte die Sicherung gerade noch offen.',
      'Ich prüfe gerade noch, ob der Stand sauber gesichert wird.',
    ],
    deep: [
      'Ich prüfe die Sicherung noch gründlicher.',
      'Ich warte noch, bis das Backup sauber durch ist.',
      'Ich bleibe noch kurz bei der Sicherheitskopie.',
      'Ich halte die Sicherung noch unter Beobachtung.',
      'Ich prüfe noch, ob der Stand wirklich sicher liegt.',
    ],
  },

  exec_diff: {
  
    start: [
      'Ich schaue gerade auf den Unterschied.',
      'Ich prüfe gerade, was sich geändert hat.',
      'Ich lese gerade den Diff an.',
      'Ich halte gerade die Änderungen nebeneinander.',
      'Ich vergleiche gerade alt gegen neu.',
    ],
    steady: [
      'Ich prüfe den Unterschied gerade noch.',
      'Ich gleiche die Änderungen gerade weiter ab.',
      'Ich bin noch im Diff dran.',
      'Ich halte den Vergleich gerade noch offen.',
      'Ich prüfe gerade noch, was genau gekippt ist.',
    ],
    deep: [
      'Ich gehe den Unterschied noch gründlicher durch.',
      'Ich prüfe den Diff noch genauer.',
      'Ich bleibe noch kurz beim Vergleich.',
      'Ich gleiche die Änderungen noch tiefer ab.',
      'Ich prüfe noch, welche Stelle wirklich neu ist.',
    ],
  },

  exec_test_unit: {
  
    start: [
      'Ich starte gerade die kleinen Einzeltests.',
      'Ich prüfe gerade die Unit-Tests.',
      'Ich lasse gerade die schnellen Checks laufen.',
      'Ich werfe gerade die Einzelprüfung an.',
      'Ich teste gerade die kleinsten Bausteine.',
    ],
    steady: [
      'Ich lasse die Unit-Tests gerade noch laufen.',
      'Ich warte gerade noch auf die Einzeltests.',
      'Ich bin noch bei der kleinen Prüfung dran.',
      'Ich halte die Unit-Checks gerade noch offen.',
      'Ich prüfe gerade noch die schnellen Rückmeldungen.',
    ],
    deep: [
      'Ich prüfe die Unit-Tests noch gründlicher.',
      'Ich warte noch, bis die Einzeltests sauber durch sind.',
      'Ich bleibe noch kurz bei den kleinen Checks.',
      'Ich halte die Unit-Prüfung noch unter Beobachtung.',
      'Ich prüfe noch, ob die Bausteine wirklich ruhig bleiben.',
    ],
  },

  exec_test_integration: {
  
    start: [
      'Ich starte gerade den Zusammenspiel-Test.',
      'Ich prüfe gerade, ob die Teile zusammenpassen.',
      'Ich lasse gerade die Integrationstests laufen.',
      'Ich werfe gerade den Teamwork-Check an.',
      'Ich teste gerade, ob die Bausteine sauber zusammenlaufen.',
    ],
    steady: [
      'Ich lasse die Integrationstests gerade noch laufen.',
      'Ich warte gerade noch auf den Zusammenspiel-Test.',
      'Ich bin noch beim Teamwork-Check dran.',
      'Ich halte die Integrationsprüfung gerade noch offen.',
      'Ich prüfe gerade noch, ob die Teile ruhig zusammenspielen.',
    ],
    deep: [
      'Ich prüfe die Integrationstests noch gründlicher.',
      'Ich warte noch, bis der Zusammenspiel-Test sauber durch ist.',
      'Ich bleibe noch kurz bei der Integrationsprüfung.',
      'Ich halte das Zusammenspiel noch unter Beobachtung.',
      'Ich prüfe noch, ob die Bausteine wirklich sauber zusammenhalten.',
    ],
  },

  exec_test_e2e: {
  
    start: [
      'Ich starte gerade den Weg von vorne bis hinten.',
      'Ich prüfe gerade den ganzen Ablauf.',
      'Ich lasse gerade die End-to-End-Tests laufen.',
      'Ich werfe gerade den Komplett-Check an.',
      'Ich teste gerade die ganze Strecke am Stück.',
    ],
    steady: [
      'Ich lasse die End-to-End-Tests gerade noch laufen.',
      'Ich warte gerade noch auf den Komplett-Check.',
      'Ich bin noch beim ganzen Ablauf dran.',
      'Ich halte die Gesamtprüfung gerade noch offen.',
      'Ich prüfe gerade noch, ob der Weg von vorne bis hinten sitzt.',
    ],
    deep: [
      'Ich prüfe den ganzen Ablauf noch gründlicher.',
      'Ich warte noch, bis die End-to-End-Tests sauber durch sind.',
      'Ich bleibe noch kurz bei der Gesamtprüfung.',
      'Ich halte die komplette Strecke noch unter Beobachtung.',
      'Ich prüfe noch, ob der ganze Weg wirklich ruhig bleibt.',
    ],
  }
}
