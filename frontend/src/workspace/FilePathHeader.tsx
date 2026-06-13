import type { ReactNode } from 'react'
import { workspacePathParts } from './fileRouting'

export function FilePathHeader({ path, right, onRevealPath, nameOnly }: { path: string; right?: ReactNode; onRevealPath?: (path: string) => void; nameOnly?: boolean }) {
  const { dir, name } = workspacePathParts(path)
  const canReveal = Boolean(onRevealPath)
  return (
    <div className="workspace-filebar">
      <span />
      <span />
      <span />
      <button
        type="button"
        className="workspace-path"
        onClick={() => onRevealPath?.(path)}
        disabled={!canReveal}
        title={canReveal ? (nameOnly ? path : "Im File System zeigen") : undefined}
      >
        {!nameOnly && dir && <em>{dir}</em>}
        <strong>{name}</strong>
      </button>
      {right && <div className="workspace-filebar-right">{right}</div>}
    </div>
  )
}
