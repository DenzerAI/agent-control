const INBOX_SEEN_STORAGE_KEY = 'deck:inbox-seen-waiting-keys'

export const INBOX_SEEN_CHANGED_EVENT = 'deck:inboxSeenChanged'

type WaWaitingItem = {
  id?: string
  last_ts?: number | null
}

type MailWaitingItem = {
  account?: string
  uid?: string
  ts?: number | null
}

function readSeenKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(INBOX_SEEN_STORAGE_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

function normalizeKeys(keys: Array<string | null | undefined>): string[] {
  return keys.filter((key): key is string => typeof key === 'string' && key.length > 0)
}

export function inboxWaWaitingKey(item: WaWaitingItem): string | null {
  if (!item.id) return null
  return `wa:${item.id}:${item.last_ts || 0}`
}

export function inboxMailWaitingKey(item: MailWaitingItem): string | null {
  if (!item.uid) return null
  return `mail:${item.account || ''}:${item.uid}:${item.ts || 0}`
}

export function hasUnseenInboxWaiting(keys: Array<string | null | undefined>): boolean {
  const clean = normalizeKeys(keys)
  if (clean.length === 0) return false
  const seen = readSeenKeys()
  return clean.some(key => !seen.has(key))
}

export function markInboxWaitingSeen(keys: Array<string | null | undefined>) {
  const clean = normalizeKeys(keys)
  if (clean.length === 0) return
  const seen = readSeenKeys()
  for (const key of clean) seen.add(key)
  try {
    localStorage.setItem(INBOX_SEEN_STORAGE_KEY, JSON.stringify([...seen].slice(-1000)))
    window.dispatchEvent(new CustomEvent(INBOX_SEEN_CHANGED_EVENT))
  } catch {}
}
