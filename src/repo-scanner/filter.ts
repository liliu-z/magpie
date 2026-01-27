// src/repo-scanner/filter.ts
import { DEFAULT_IGNORE } from './types.js'

const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.tar', '.gz',
  '.pdf', '.doc', '.docx'
]

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml'
}

export function shouldIgnore(filePath: string, customIgnore: string[]): boolean {
  const allIgnore = [...DEFAULT_IGNORE, ...customIgnore]
  const lowerPath = filePath.toLowerCase()
  // Split path into segments for proper matching
  const pathSegments = filePath.split(/[/\\]/)
  const lowerSegments = lowerPath.split(/[/\\]/)

  // Check binary extensions
  for (const ext of BINARY_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) return true
  }

  // Check ignore patterns
  for (const pattern of allIgnore) {
    // Reject patterns with path traversal attempts
    if (pattern.includes('..')) continue

    if (pattern.startsWith('*.')) {
      // Extension pattern
      if (lowerPath.endsWith(pattern.slice(1))) return true
    } else {
      // Directory/file pattern - match by path segment to avoid over-matching
      // e.g., "node_modules" should match "node_modules/foo" but not "my_node_modules"
      const lowerPattern = pattern.toLowerCase()
      if (lowerSegments.some(seg => seg === lowerPattern)) return true
      // Also check if pattern is a prefix of any segment (for patterns like ".git")
      if (pathSegments.some(seg => seg.startsWith(pattern))) return true
    }
  }

  return false
}

export function detectLanguage(filePath: string): string {
  const ext = '.' + filePath.split('.').pop()?.toLowerCase()
  return LANGUAGE_MAP[ext] || 'unknown'
}
