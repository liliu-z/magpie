// tests/feature-analyzer/hash.test.ts
import { describe, it, expect } from 'vitest'
import { computeCodebaseHash } from '../../src/feature-analyzer/hash.js'
import type { FileInfo } from '../../src/repo-scanner/types.js'

describe('computeCodebaseHash', () => {
  it('should return consistent hash for same files', () => {
    const files: FileInfo[] = [
      { path: '/a.ts', relativePath: 'a.ts', language: 'typescript', lines: 100, size: 1000 },
      { path: '/b.ts', relativePath: 'b.ts', language: 'typescript', lines: 50, size: 500 }
    ]

    const hash1 = computeCodebaseHash(files)
    const hash2 = computeCodebaseHash(files)

    expect(hash1).toBe(hash2)
    expect(hash1).toHaveLength(16) // Short hash
  })

  it('should return different hash for different files', () => {
    const files1: FileInfo[] = [
      { path: '/a.ts', relativePath: 'a.ts', language: 'typescript', lines: 100, size: 1000 }
    ]
    const files2: FileInfo[] = [
      { path: '/b.ts', relativePath: 'b.ts', language: 'typescript', lines: 100, size: 1000 }
    ]

    const hash1 = computeCodebaseHash(files1)
    const hash2 = computeCodebaseHash(files2)

    expect(hash1).not.toBe(hash2)
  })

  it('should detect size changes', () => {
    const files1: FileInfo[] = [
      { path: '/a.ts', relativePath: 'a.ts', language: 'typescript', lines: 100, size: 1000 }
    ]
    const files2: FileInfo[] = [
      { path: '/a.ts', relativePath: 'a.ts', language: 'typescript', lines: 100, size: 2000 }
    ]

    const hash1 = computeCodebaseHash(files1)
    const hash2 = computeCodebaseHash(files2)

    expect(hash1).not.toBe(hash2)
  })
})
