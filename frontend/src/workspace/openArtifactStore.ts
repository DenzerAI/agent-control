// Hält den Pfad der aktuell im Workspace geöffneten Datei (HTML/MD).
// Wird vom Workspace-Controller beim Öffnen gesetzt und vom Voice-Tool
// get_open_artifact gelesen, damit Agent im Call über die offene Seite reden kann.
let current: string | null = null

export function setOpenArtifact(path: string | null): void {
  current = path || null
}

export function getOpenArtifact(): string | null {
  return current
}
