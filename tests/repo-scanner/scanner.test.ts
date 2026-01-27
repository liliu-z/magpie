// tests/repo-scanner/scanner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RepoScanner } from '../../src/repo-scanner/scanner.js'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('fs')
vi.mock('path')

describe('RepoScanner', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('should scan directory and return file list', async () => {
    // Mock directory structure: /project/src/index.ts
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (String(p) === '/project') return ['src'] as any
      if (String(p) === '/project/src') return ['index.ts', 'utils.ts'] as any
      return [] as any
    })
    vi.mocked(fs.statSync).mockImplementation((p) => ({
      isDirectory: () => String(p) === '/project/src',
      isFile: () => String(p).endsWith('.ts'),
      size: 1024
    }) as any)
    vi.mocked(fs.readFileSync).mockReturnValue('line1\nline2\nline3')
    vi.mocked(path.join).mockImplementation((...args) => args.join('/'))
    vi.mocked(path.relative).mockImplementation((from, to) => String(to).replace(from + '/', ''))

    const scanner = new RepoScanner('/project')
    const files = await scanner.scanFiles()

    expect(files.length).toBe(2)
    expect(files[0].relativePath).toBe('src/index.ts')
    expect(files[0].language).toBe('typescript')
    expect(files[0].lines).toBe(3)
  })

  it('should calculate repo stats', async () => {
    const scanner = new RepoScanner('/project')
    scanner['files'] = [
      { path: '/project/src/a.ts', relativePath: 'src/a.ts', language: 'typescript', lines: 100, size: 1024 },
      { path: '/project/src/b.ts', relativePath: 'src/b.ts', language: 'typescript', lines: 50, size: 512 }
    ]

    const stats = scanner.getStats()

    expect(stats.totalFiles).toBe(2)
    expect(stats.totalLines).toBe(150)
    expect(stats.languages.typescript).toBe(2)
  })

  it('should estimate tokens based on file content', () => {
    const scanner = new RepoScanner('/project')
    const tokens = scanner['estimateTokens'](1000) // 1000 characters
    expect(tokens).toBe(250) // ~4 chars per token
  })
})
