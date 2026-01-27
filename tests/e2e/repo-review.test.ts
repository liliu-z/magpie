// tests/e2e/repo-review.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RepoScanner, shouldIgnore, detectLanguage } from '../../src/repo-scanner'
import { ReviewPlanner, FeaturePlanner } from '../../src/planner'
import { RepoOrchestrator } from '../../src/orchestrator/repo-orchestrator'
import { MarkdownReporter } from '../../src/reporter'
import { StateManager } from '../../src/state'
import type { FeatureAnalysis, ReviewSession } from '../../src/state/types'
import { computeCodebaseHash } from '../../src/feature-analyzer/hash'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('Repo Review Integration', () => {
  it('should complete full review pipeline', async () => {
    // Mock file system
    const mockFiles = [
      { path: '/p/src/a.ts', relativePath: 'src/a.ts', language: 'typescript', lines: 100, size: 1024 },
      { path: '/p/src/b.ts', relativePath: 'src/b.ts', language: 'typescript', lines: 50, size: 512 }
    ]

    const planner = new ReviewPlanner(mockFiles)
    const plan = planner.createPlan()

    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.totalEstimatedTokens).toBeGreaterThan(0)

    const reporter = new MarkdownReporter()
    const result = {
      repoName: 'test',
      timestamp: new Date(),
      stats: { totalFiles: 2, totalLines: 150, languages: { typescript: 2 }, estimatedTokens: 384, estimatedCost: 0.00384 },
      architectureAnalysis: 'Test analysis',
      issues: [],
      tokenUsage: { total: 1000, cost: 0.01 }
    }

    const report = reporter.generate(result)
    expect(report).toContain('test')
    expect(report).toContain('150 lines of code')
  })

  it('should filter files correctly', () => {
    expect(shouldIgnore('node_modules/test.js', [])).toBe(true)
    expect(shouldIgnore('src/index.ts', [])).toBe(false)
    expect(detectLanguage('test.ts')).toBe('typescript')
    expect(detectLanguage('test.py')).toBe('python')
  })

  it('should plan review steps by directory', () => {
    const mockFiles = [
      { path: '/p/src/core/a.ts', relativePath: 'src/core/a.ts', language: 'typescript', lines: 100, size: 1024 },
      { path: '/p/src/utils/b.ts', relativePath: 'src/utils/b.ts', language: 'typescript', lines: 50, size: 512 },
      { path: '/p/tests/test.ts', relativePath: 'tests/test.ts', language: 'typescript', lines: 30, size: 256 }
    ]

    const planner = new ReviewPlanner(mockFiles)
    const plan = planner.createPlan()

    // Should have at least 2 steps (src/core, src/utils, tests grouped differently)
    expect(plan.steps.length).toBeGreaterThanOrEqual(2)

    // Check that files are distributed among steps
    const totalFilesInSteps = plan.steps.reduce((sum, s) => sum + s.files.length, 0)
    expect(totalFilesInSteps).toBe(3)
  })

  it('should generate report with all sections', () => {
    const reporter = new MarkdownReporter()
    const result = {
      repoName: 'magpie',
      timestamp: new Date('2026-01-26'),
      stats: { totalFiles: 10, totalLines: 1000, languages: { typescript: 8, javascript: 2 }, estimatedTokens: 5000, estimatedCost: 0.05 },
      architectureAnalysis: 'Well-structured codebase',
      architectureStrengths: ['Clean separation of concerns', 'Good test coverage'],
      architectureImprovements: ['Consider adding dependency injection'],
      issues: [
        { id: 1, location: 'src/auth.ts:42', description: 'Potential SQL injection', severity: 'high' as const, consensus: '2/2' },
        { id: 2, location: 'src/api.ts:100', description: 'Missing error handling', severity: 'medium' as const, consensus: '2/2' }
      ],
      tokenUsage: { total: 10000, cost: 0.10 }
    }

    const report = reporter.generate(result)

    // Check header
    expect(report).toContain('# Repository Review Report: magpie')
    expect(report).toContain('10 files')
    expect(report).toContain('1000 lines of code')

    // Check sections
    expect(report).toContain('## Executive Summary')
    expect(report).toContain('## Architecture Assessment')
    expect(report).toContain('## Issue List')
    expect(report).toContain('## Token Usage Statistics')

    // Check issues
    expect(report).toContain('🔴 High Priority')
    expect(report).toContain('Potential SQL injection')
    expect(report).toContain('🟡 Medium Priority')
    expect(report).toContain('Missing error handling')
  })
})

describe('Feature-Based Repo Review Integration', () => {
  let tempDir: string
  let stateManager: StateManager

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'magpie-e2e-'))
    stateManager = new StateManager(tempDir)
    await stateManager.init()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('should compute consistent codebase hash', () => {
    const files = [
      { path: '/p/a.ts', relativePath: 'a.ts', language: 'typescript', lines: 100, size: 1024 },
      { path: '/p/b.ts', relativePath: 'b.ts', language: 'typescript', lines: 50, size: 512 }
    ]

    const hash1 = computeCodebaseHash(files)
    const hash2 = computeCodebaseHash(files)
    expect(hash1).toBe(hash2)

    // Different order should produce same hash
    const hash3 = computeCodebaseHash([files[1], files[0]])
    expect(hash1).toBe(hash3)

    // Different files should produce different hash
    const hash4 = computeCodebaseHash([
      { path: '/p/c.ts', relativePath: 'c.ts', language: 'typescript', lines: 100, size: 1024 }
    ])
    expect(hash1).not.toBe(hash4)
  })

  it('should create feature-based plan from analysis', () => {
    const analysis: FeatureAnalysis = {
      features: [
        {
          id: 'write',
          name: 'Write Operations',
          description: 'Insert and update operations',
          entryPoints: ['src/insert.ts'],
          files: [
            { path: '/p/src/insert.ts', relativePath: 'src/insert.ts', language: 'typescript', lines: 200, size: 2048 },
            { path: '/p/src/update.ts', relativePath: 'src/update.ts', language: 'typescript', lines: 150, size: 1536 }
          ],
          estimatedTokens: 2000
        },
        {
          id: 'query',
          name: 'Query Operations',
          description: 'Search and read operations',
          entryPoints: ['src/query.ts'],
          files: [
            { path: '/p/src/query.ts', relativePath: 'src/query.ts', language: 'typescript', lines: 300, size: 3072 },
            { path: '/p/src/search.ts', relativePath: 'src/search.ts', language: 'typescript', lines: 250, size: 2560 }
          ],
          estimatedTokens: 3000
        }
      ],
      uncategorized: [],
      analyzedAt: new Date(),
      codebaseHash: 'abc123'
    }

    const planner = new FeaturePlanner(analysis)

    // Test full plan
    const fullPlan = planner.createPlan(['write', 'query'])
    expect(fullPlan.steps).toHaveLength(2)
    expect(fullPlan.steps[0].featureId).toBe('write')
    expect(fullPlan.steps[1].featureId).toBe('query')
    expect(fullPlan.totalEstimatedTokens).toBe(5000)

    // Test partial plan
    const partialPlan = planner.createPlan(['query'])
    expect(partialPlan.steps).toHaveLength(1)
    expect(partialPlan.steps[0].featureId).toBe('query')
    expect(partialPlan.totalEstimatedTokens).toBe(3000)
  })

  it('should persist and restore review session', async () => {
    const session: ReviewSession = {
      id: 'test-session-1',
      startedAt: new Date('2024-01-01T10:00:00Z'),
      updatedAt: new Date('2024-01-01T11:00:00Z'),
      status: 'in_progress',
      config: {
        focusAreas: ['security', 'performance'],
        selectedFeatures: ['write', 'query', 'auth']
      },
      plan: {
        features: [],
        totalFeatures: 3,
        selectedCount: 3
      },
      progress: {
        currentFeatureIndex: 1,
        completedFeatures: ['write'],
        featureResults: {
          write: {
            featureId: 'write',
            issues: [
              { id: 1, location: 'src/insert.ts:42', description: 'No input validation', severity: 'high', consensus: '2/2' }
            ],
            summary: 'Write operations need input validation',
            reviewedAt: new Date('2024-01-01T10:30:00Z')
          }
        }
      }
    }

    // Save session
    await stateManager.saveSession(session)

    // Load session
    const loaded = await stateManager.loadSession('test-session-1')
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe('test-session-1')
    expect(loaded!.status).toBe('in_progress')
    expect(loaded!.progress.completedFeatures).toEqual(['write'])
    expect(loaded!.progress.featureResults.write.issues).toHaveLength(1)

    // Find incomplete sessions
    const incomplete = await stateManager.findIncompleteSessions()
    expect(incomplete).toHaveLength(1)
    expect(incomplete[0].id).toBe('test-session-1')

    // List all sessions
    const all = await stateManager.listAllSessions()
    expect(all).toHaveLength(1)
  })

  it('should support session resume workflow', async () => {
    // Create initial session with partial progress
    const session: ReviewSession = {
      id: 'resume-test-1',
      startedAt: new Date(),
      updatedAt: new Date(),
      status: 'paused',
      config: {
        focusAreas: ['security'],
        selectedFeatures: ['f1', 'f2', 'f3']
      },
      plan: {
        features: [],
        totalFeatures: 3,
        selectedCount: 3
      },
      progress: {
        currentFeatureIndex: 1,
        completedFeatures: ['f1'],
        featureResults: {
          f1: { featureId: 'f1', issues: [], summary: 'No issues', reviewedAt: new Date() }
        }
      }
    }

    await stateManager.saveSession(session)

    // Simulate resume - load and check remaining work
    const loaded = await stateManager.loadSession('resume-test-1')!
    expect(loaded).not.toBeNull()

    const remaining = loaded!.config.selectedFeatures.filter(
      id => !loaded!.progress.completedFeatures.includes(id)
    )
    expect(remaining).toEqual(['f2', 'f3'])

    // Simulate completing another feature
    loaded!.progress.completedFeatures.push('f2')
    loaded!.progress.featureResults.f2 = {
      featureId: 'f2',
      issues: [],
      summary: 'No issues',
      reviewedAt: new Date()
    }
    loaded!.progress.currentFeatureIndex = 2
    loaded!.status = 'in_progress'
    loaded!.updatedAt = new Date()

    await stateManager.saveSession(loaded!)

    // Verify progress saved
    const reloaded = await stateManager.loadSession('resume-test-1')
    expect(reloaded!.progress.completedFeatures).toEqual(['f1', 'f2'])
    expect(reloaded!.status).toBe('in_progress')
  })

  it('should cache and retrieve feature analysis', async () => {
    const analysis: FeatureAnalysis = {
      features: [
        {
          id: 'core',
          name: 'Core Module',
          description: 'Core functionality',
          entryPoints: ['src/core.ts'],
          files: [{ path: '/p/src/core.ts', relativePath: 'src/core.ts', language: 'typescript', lines: 500, size: 5120 }],
          estimatedTokens: 5000
        }
      ],
      uncategorized: [
        { path: '/p/utils.ts', relativePath: 'utils.ts', language: 'typescript', lines: 50, size: 512 }
      ],
      analyzedAt: new Date('2024-01-01'),
      codebaseHash: 'test-hash-123'
    }

    await stateManager.saveFeatureAnalysis(analysis)

    const loaded = await stateManager.loadFeatureAnalysis()
    expect(loaded).not.toBeNull()
    expect(loaded!.features).toHaveLength(1)
    expect(loaded!.features[0].id).toBe('core')
    expect(loaded!.uncategorized).toHaveLength(1)
    expect(loaded!.codebaseHash).toBe('test-hash-123')
  })
})
