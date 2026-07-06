import type { ReactNode } from 'react'

export function WorkspaceShell({
  title,
  subtitle,
  eyebrow,
  action,
  children,
  className = '',
}: {
  title: string
  subtitle: string
  eyebrow?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`workspace-shell workspace-system ${className}`.trim()}>
      <header className="workspace-shell-hero">
        <div>
          {eyebrow && <p className="workspace-shell-eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
          <span>{subtitle}</span>
        </div>
        {action && <div className="workspace-shell-action">{action}</div>}
      </header>
      {children}
    </div>
  )
}
