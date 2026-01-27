// tests/feature-analyzer/analyzer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { FeatureAnalyzer } from '../../src/feature-analyzer/analyzer.js'
import type { FileInfo } from '../../src/repo-scanner/types.js'

describe('FeatureAnalyzer', () => {
  const mockProvider = {
    chat: vi.fn()
  }

  const sampleFiles: FileInfo[] = [
    { path: '/src/insert.ts', relativePath: 'src/insert.ts', language: 'typescript', lines: 100, size: 1000 },
    { path: '/src/query.ts', relativePath: 'src/query.ts', language: 'typescript', lines: 150, size: 1500 },
    { path: '/src/auth/rbac.ts', relativePath: 'src/auth/rbac.ts', language: 'typescript', lines: 80, size: 800 },
    { path: '/src/utils/helper.ts', relativePath: 'src/utils/helper.ts', language: 'typescript', lines: 50, size: 500 }
  ]

  it('should call AI provider with file list', async () => {
    mockProvider.chat.mockResolvedValueOnce(JSON.stringify({
      features: [
        { id: 'write', name: 'Write', description: 'Insert ops', entryPoints: ['src/insert.ts'], filePatterns: ['insert'], confidence: 0.9 }
      ],
      reasoning: 'test'
    }))

    const analyzer = new FeatureAnalyzer({ provider: mockProvider })
    await analyzer.analyze(sampleFiles)

    expect(mockProvider.chat).toHaveBeenCalledTimes(1)
    expect(mockProvider.chat.mock.calls[0][0][0].content).toContain('src/insert.ts')
  })

  it('should parse AI response into features', async () => {
    mockProvider.chat.mockResolvedValueOnce(JSON.stringify({
      features: [
        { id: 'write', name: 'Write Operations', description: 'Handles inserts', entryPoints: ['src/insert.ts'], filePatterns: ['insert', 'upsert'], confidence: 0.9 },
        { id: 'query', name: 'Query Operations', description: 'Handles queries', entryPoints: ['src/query.ts'], filePatterns: ['query', 'search'], confidence: 0.85 }
      ],
      reasoning: 'Identified based on file names'
    }))

    const analyzer = new FeatureAnalyzer({ provider: mockProvider })
    const result = await analyzer.analyze(sampleFiles)

    expect(result.features).toHaveLength(2)
    expect(result.features[0].id).toBe('write')
    expect(result.features[1].id).toBe('query')
  })

  it('should map files to features based on patterns', async () => {
    mockProvider.chat.mockResolvedValueOnce(JSON.stringify({
      features: [
        { id: 'write', name: 'Write', description: 'Insert ops', entryPoints: ['src/insert.ts'], filePatterns: ['insert'], confidence: 0.9 }
      ],
      reasoning: 'test'
    }))

    const analyzer = new FeatureAnalyzer({ provider: mockProvider })
    const result = await analyzer.analyze(sampleFiles)

    // insert.ts should be mapped to 'write' feature
    expect(result.features[0].files.some(f => f.relativePath === 'src/insert.ts')).toBe(true)
  })

  it('should track uncategorized files', async () => {
    mockProvider.chat.mockResolvedValueOnce(JSON.stringify({
      features: [
        { id: 'write', name: 'Write', description: 'Insert ops', entryPoints: ['src/insert.ts'], filePatterns: ['insert'], confidence: 0.9 }
      ],
      reasoning: 'test'
    }))

    const analyzer = new FeatureAnalyzer({ provider: mockProvider })
    const result = await analyzer.analyze(sampleFiles)

    // Files not matching any pattern should be uncategorized
    expect(result.uncategorized.length).toBeGreaterThan(0)
  })
})
