// tests/repo-scanner/types.test.ts
import { describe, it, expect } from 'vitest'
import type { RepoStats, FileInfo, ScanOptions } from '../../src/repo-scanner/types'

describe('RepoScanner types', () => {
  it('should have correct RepoStats structure', () => {
    const stats: RepoStats = {
      totalFiles: 10,
      totalLines: 500,
      languages: { typescript: 8, javascript: 2 },
      estimatedTokens: 2000,
      estimatedCost: 0.02
    }
    expect(stats.totalFiles).toBe(10)
  })

  it('should have correct FileInfo structure', () => {
    const file: FileInfo = {
      path: 'src/index.ts',
      relativePath: 'src/index.ts',
      language: 'typescript',
      lines: 100,
      size: 2048
    }
    expect(file.language).toBe('typescript')
  })
})
