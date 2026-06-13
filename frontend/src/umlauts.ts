// Wortbasierte Umlaut-Reparatur — spiegelt server.py _fix_umlauts.
// Genutzt für Live-Transcript-Anzeige in VoiceLine (der Server persistiert
// separat mit eigener Reparatur, das hier ist nur für die momentane Anzeige).

const MAP: Record<string, string> = {
  fuer: 'für', dafuer: 'dafür', wofuer: 'wofür', hierfuer: 'hierfür',
  ueber: 'über', darueber: 'darüber', ueberall: 'überall', uebersicht: 'übersicht',
  uebertragen: 'übertragen', uebrig: 'übrig', uebrigens: 'übrigens',
  koennen: 'können', koennte: 'könnte', koenntest: 'könntest',
  muessen: 'müssen', muesste: 'müsste', muesstest: 'müsstest',
  duerfen: 'dürfen', duerfte: 'dürfte',
  moechte: 'möchte', moechtest: 'möchtest', moeglich: 'möglich', moeglichkeit: 'möglichkeit',
  unmoeglich: 'unmöglich', vermoegen: 'vermögen',
  waere: 'wäre', waeren: 'wären', waerest: 'wärest',
  haette: 'hätte', haetten: 'hätten', haettest: 'hättest',
  naechste: 'nächste', naechsten: 'nächsten', naechster: 'nächster', naechstes: 'nächstes',
  spaeter: 'später', spaete: 'späte',
  groesser: 'größer', groesste: 'größte', groessere: 'größere',
  groessten: 'größten', groesseres: 'größeres',
  hoeren: 'hören', hoere: 'höre', hoerst: 'hörst', hoert: 'hört',
  fuehlen: 'fühlen', fuehle: 'fühle', fuehlt: 'fühlt',
  fuehren: 'führen', fuehrt: 'führt',
  erklaeren: 'erklären', erklaert: 'erklärt',
  waehlen: 'wählen', waehlt: 'wählt',
  zaehlen: 'zählen', zaehlt: 'zählt',
  aendern: 'ändern', aendere: 'ändere', aendert: 'ändert',
  oeffnen: 'öffnen', oeffne: 'öffne', oeffnet: 'öffnet',
  loeschen: 'löschen', loescht: 'löscht',
  pruefen: 'prüfen', prueft: 'prüft', pruefung: 'prüfung',
  ueberlegen: 'überlegen', ueberlegt: 'überlegt',
  schoen: 'schön', schoene: 'schöne', schoener: 'schöner', schoenes: 'schönes',
  gross: 'groß', grosse: 'große', grosser: 'großer', grosses: 'großes',
  suess: 'süß', suesse: 'süße',
  weiss: 'weiß', weisst: 'weißt',
  heiss: 'heiß', heisse: 'heiße',
  draussen: 'draußen', aussen: 'außen', ausser: 'außer',
  muede: 'müde', kuehl: 'kühl',
  natuerlich: 'natürlich',
  zurueck: 'zurück',
  gluecklich: 'glücklich', glueck: 'glück',
  stueck: 'stück', stuecke: 'stücke',
  tuer: 'tür', tueren: 'türen',
  strasse: 'straße', strassen: 'straßen',
  fuesse: 'füße', fuss: 'fuß',
  gruss: 'gruß', gruesse: 'grüße', gruessen: 'grüßen', grusse: 'grüße',
  spass: 'spaß',
  oel: 'öl',
  aerger: 'ärger', aergern: 'ärgern',
  ueberraschung: 'überraschung',
  muehe: 'mühe',
  wuensche: 'wünsche',
  koeln: 'köln',
  muenchen: 'münchen',
  oesterreich: 'österreich',
  identitaet: 'identität',
  qualitaet: 'qualität',
  aktivitaet: 'aktivität',
  realitaet: 'realität',
  laenge: 'länge', laengere: 'längere', laengste: 'längste',
  saetze: 'sätze',
  hoeflich: 'höflich', unhoeflich: 'unhöflich',
  wuerde: 'würde', wuerden: 'würden',
  huette: 'hütte',
  stuetze: 'stütze',
  taeglich: 'täglich', waehrend: 'während', gewaehren: 'gewähren',
  foerdern: 'fördern', foerderung: 'förderung',
  verfuegbar: 'verfügbar', verfuegung: 'verfügung',
  beruehren: 'berühren',
  unterstuetzen: 'unterstützen', unterstuetzung: 'unterstützung',
  erwaehnen: 'erwähnen', erwaehnt: 'erwähnt',
  geraet: 'gerät', geraete: 'geräte',
  traeumen: 'träumen',
  baeume: 'bäume',
  haeuser: 'häuser',
  laeuft: 'läuft',
  klaeren: 'klären', klaert: 'klärt',
}

export function fixUmlauts(text: string): string {
  if (!text) return text
  return text.replace(/\b[A-Za-zÄÖÜäöüß]+\b/g, (word) => {
    const lower = word.toLowerCase()
    const fix = MAP[lower]
    if (!fix) return word
    // Case preserve
    if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
      return fix[0].toUpperCase() + fix.slice(1)
    }
    return fix
  })
}
