// tests/planner/feature-planner.test.ts
import { describe, it, expect } from 'vitest'
import { FeaturePlanner } from '../../src/planner/feature-planner.js'
import type { Feature, FeatureAnalysis } from '../../src/state/types.js'

describe('FeaturePlanner', () => {
  const mockAnalysis: FeatureAnalysis = {
    features: [
      { id: 'write', name: 'Write', description: 'Write ops', entryPoints: [], files: [
        { path: '/a.ts', relativePath: 'a.ts', language: 'ts', lines: 100, size: 4000 }
      ], estimatedTokens: 1000 },
      { id: 'query', name: 'Query', description: 'Query ops', entryPoints: [], files: [
        { path: '/b.ts', relativePath: 'b.ts', language: 'ts', lines: 50, size: 2000 }
      ], estimatedTokens: 500 }
    ],
    uncategorized: [],
    analyzedAt: new Date(),
    codebaseHash: 'abc123'
  }

  it('should create plan with selected features only', () => {
    const planner = new FeaturePlanner(mockAnalysis)
    const plan = planner.createPlan(['write'])

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].featureId).toBe('write')
  })

  it('should create plan with all features when none selected', () => {
    const planner = new FeaturePlanner(mockAnalysis)
    const plan = planner.createPlan([])

    expect(plan.steps).toHaveLength(2)
  })

  it('should calculate total tokens for selected features', () => {
    const planner = new FeaturePlanner(mockAnalysis)
    const plan = planner.createPlan(['write'])

    expect(plan.totalEstimatedTokens).toBe(1000)
  })

  it('should include feature metadata in steps', () => {
    const planner = new FeaturePlanner(mockAnalysis)
    const plan = planner.createPlan(['write', 'query'])

    expect(plan.steps[0].name).toBe('Write')
    expect(plan.steps[0].description).toBe('Write ops')
    expect(plan.steps[0].files).toHaveLength(1)
  })
})
