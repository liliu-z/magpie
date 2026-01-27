// tests/state/types.test.ts
import { describe, it, expect } from 'vitest'
import type { ReviewSession, FeatureReviewResult } from '../../src/state/types.js'

describe('State Types', () => {
  it('should define ReviewSession structure', () => {
    const session: ReviewSession = {
      id: 'test-id',
      startedAt: new Date(),
      updatedAt: new Date(),
      status: 'in_progress',
      config: {
        focusAreas: ['security', 'performance'],
        selectedFeatures: ['write', 'query']
      },
      plan: {
        features: [],
        totalFeatures: 5,
        selectedCount: 2
      },
      progress: {
        currentFeatureIndex: 1,
        completedFeatures: ['write'],
        featureResults: {}
      }
    }

    expect(session.id).toBe('test-id')
    expect(session.status).toBe('in_progress')
    expect(session.config.selectedFeatures).toContain('write')
  })

  it('should define FeatureReviewResult structure', () => {
    const result: FeatureReviewResult = {
      featureId: 'write',
      issues: [
        { id: 1, location: 'insert.ts:50', description: 'Missing validation', severity: 'medium', consensus: '2/2' }
      ],
      summary: 'Write functionality has 1 medium issue',
      reviewedAt: new Date()
    }

    expect(result.featureId).toBe('write')
    expect(result.issues).toHaveLength(1)
  })
})
