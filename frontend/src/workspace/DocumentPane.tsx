import { useEffect, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { WorkspaceFile } from './types'
import { FilePathHeader } from './FilePathHeader'

export function DocumentPane({ file, onRevealPath }: { file: WorkspaceFile | null; onRevealPath?: (path: string) => void }) {
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const path = file?.path || '~/workspace/brain/threads.md'

  useEffect(() => {
    setContent('')
    setError('')
    if (!file) return
    fetch(`/api/file?path=${encodeURIComponent(file.path)}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => setContent(d.content || ''))
      .catch(e => setError(`Laden fehlgeschlagen: ${e.message}`))
  }, [file])

  return (
    <div className="workspace-reader">
      <FilePathHeader path={path} onRevealPath={file ? onRevealPath : undefined} />
      <div className="workspace-reader-scroll">
        {error ? (
          <div className="workspace-reader-error">{error}</div>
        ) : file ? (
          <article
            className="chat-md-agent workspace-reader-content"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(content) as string) }}
          />
        ) : (
          <article className="workspace-reader-empty">
            <p className="workspace-kicker">Markdown Reader</p>
            <h1>Dokument öffnen</h1>
            <p>Markdown-Dateien aus Chat, Suche oder Workspace erscheinen hier mit echtem Pfad.</p>
          </article>
        )}
      </div>
    </div>
  )
}
