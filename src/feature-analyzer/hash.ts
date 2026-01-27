// src/feature-analyzer/hash.ts
import { createHash } from 'crypto'
import type { FileInfo } from '../repo-scanner/types.js'

export function computeCodebaseHash(files: FileInfo[]): string {
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const content = sorted.map(f => `${f.relativePath}:${f.size}`).join('\n')
  return createHash('md5').update(content).digest('hex').slice(0, 16)
}
