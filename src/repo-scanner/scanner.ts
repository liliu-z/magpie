// src/repo-scanner/scanner.ts
import * as fs from 'fs'
import * as path from 'path'
import type { FileInfo, RepoStats, ScanOptions } from './types.js'
import { shouldIgnore, detectLanguage } from './filter.js'

export class RepoScanner {
  private rootPath: string
  private options: ScanOptions
  private files: FileInfo[] = []

  constructor(rootPath: string, options: ScanOptions = {}) {
    this.rootPath = rootPath
    this.options = options
  }

  async scanFiles(): Promise<FileInfo[]> {
    this.files = []
    const targetPath = this.options.path
      ? path.join(this.rootPath, this.options.path)
      : this.rootPath

    this.scanDirectory(targetPath)
    return this.files
  }

  private scanDirectory(dirPath: string): void {
    const entries = fs.readdirSync(dirPath)

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry)
      const relativePath = path.relative(this.rootPath, fullPath)

      if (shouldIgnore(relativePath, this.options.ignore || [])) {
        continue
      }

      const stat = fs.statSync(fullPath)

      if (stat.isDirectory()) {
        this.scanDirectory(fullPath)
      } else if (stat.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8')
          // Check for binary content (files with null bytes are likely binary)
          if (content.includes('\0')) {
            continue
          }
          const lines = content.split('\n').length

          this.files.push({
            path: fullPath,
            relativePath,
            language: detectLanguage(relativePath),
            lines,
            size: stat.size
          })
        } catch {
          // Skip files that can't be read as UTF-8 (likely binary or permission denied)
          continue
        }
      }
    }
  }

  getStats(): RepoStats {
    const languages: Record<string, number> = {}
    let totalLines = 0
    let totalSize = 0

    for (const file of this.files) {
      totalLines += file.lines
      totalSize += file.size
      languages[file.language] = (languages[file.language] || 0) + 1
    }

    const estimatedTokens = this.estimateTokens(totalSize)
    const estimatedCost = estimatedTokens * 0.00001 // Rough estimate

    return {
      totalFiles: this.files.length,
      totalLines,
      languages,
      estimatedTokens,
      estimatedCost
    }
  }

  getFiles(): FileInfo[] {
    return this.files
  }

  private estimateTokens(charCount: number): number {
    return Math.ceil(charCount / 4) // ~4 chars per token
  }
}
