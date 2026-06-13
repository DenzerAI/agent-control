export function openPersonInInfoPane(personId: number) {
  if (!Number.isFinite(personId) || personId <= 0) return
  window.dispatchEvent(new CustomEvent('deck:openInfoPane'))
  window.dispatchEvent(new CustomEvent('deck:info-section', { detail: { section: 'people' } }))
  window.dispatchEvent(new CustomEvent('deck:open-person', { detail: { personId } }))
}
