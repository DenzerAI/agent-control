export function cleanForTTS(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}
