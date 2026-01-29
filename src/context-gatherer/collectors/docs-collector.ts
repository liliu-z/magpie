// src/context-gatherer/collectors/docs-collector.ts
import { readFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import type { RawDoc } from '../types.js'

const DEFAULT_PATTERNS = [
  'docs',
  'README.md',
  'ARCHITECTURE.md',
  'DESIGN.md',
  'CONTRIBUTING.md'
]

/**
 * Recursively find markdown files in a directory
 */
function findMarkdownFiles(dir: string, maxSize: number): string[] {
  const files: string[] = []

  if (!existsSync(dir)) return files

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      // Skip node_modules, .git, etc.
      if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue
      files.push(...findMarkdownFiles(fullPath, maxSize))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const stat = statSync(fullPath)
        if (stat.size <= maxSize) {
          files.push(fullPath)
        }
      } catch {
        // Ignore stat errors
      }
    }
  }

  return files
}

/**
 * Collect documentation files
 */
export function collectDocs(
  options: { patterns?: string[]; maxSize?: number; cwd?: string } = {}
): RawDoc[] {
  const { patterns = DEFAULT_PATTERNS, maxSize = 50000, cwd = process.cwd() } = options
  const docs: RawDoc[] = []
  const seenPaths = new Set<string>()

  for (const pattern of patterns) {
    const fullPath = join(cwd, pattern)

    if (!existsSync(fullPath)) continue

    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      // Recursively find markdown files
      const mdFiles = findMarkdownFiles(fullPath, maxSize)
      for (const file of mdFiles) {
        const relPath = relative(cwd, file)
        if (seenPaths.has(relPath)) continue
        seenPaths.add(relPath)

        try {
          const content = readFileSync(file, 'utf-8')
          docs.push({ path: relPath, content })
        } catch {
          // Ignore read errors
        }
      }
    } else if (stat.isFile() && stat.size <= maxSize) {
      const relPath = relative(cwd, fullPath)
      if (seenPaths.has(relPath)) continue
      seenPaths.add(relPath)

      try {
        const content = readFileSync(fullPath, 'utf-8')
        docs.push({ path: relPath, content })
      } catch {
        // Ignore read errors
      }
    }
  }

  return docs
}
