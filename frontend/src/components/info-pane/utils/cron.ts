export function groupForCron(id: string): 'briefings' | 'radar' | 'social' | 'sync' | 'other' {
  const slug = id.replace(/^local:/, '').toLowerCase()
  if (slug === 'morgenbriefing' || slug === 'wochenrueckblick' || slug === 'dreaming') return 'briefings'
  if (slug.startsWith('radar-')) return 'radar'
  if (slug.startsWith('instagram-') || slug === 'reels-nightly') return 'social'
  if (slug === 'crypto' || slug === 'ptdesk-sync') return 'sync'
  return 'other'
}

export const JOB_GROUP_LABELS: Record<'briefings' | 'radar' | 'social' | 'sync' | 'other', string> = {
  briefings: 'Briefings',
  radar: 'Radar',
  social: 'Social',
  sync: 'Sync',
  other: 'Sonstiges',
}

export const JOB_GROUP_ORDER: Array<'briefings' | 'radar' | 'social' | 'sync' | 'other'> = ['briefings', 'radar', 'social', 'sync', 'other']
