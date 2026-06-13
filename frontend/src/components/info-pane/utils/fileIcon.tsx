import { FileText, FileCode, FileJson, FileType, FileImage, FileCog } from 'lucide-react'

// ── File type icon mapping ──

export function fileIcon(filename: string) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  switch (ext) {
    case '.md': case '.txt': case '.mdx':
      return FileText
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.py': case '.swift':
    case '.sh': case '.sql': case '.css': case '.html': case '.go': case '.rs':
      return FileCode
    case '.json':
      return FileJson
    case '.yml': case '.yaml': case '.toml': case '.cfg': case '.env': case '.ini':
      return FileCog
    case '.png': case '.jpg': case '.jpeg': case '.svg': case '.gif': case '.webp':
      return FileImage
    default:
      return FileType
  }
}
