// tests/feature-analyzer/types.test.ts
import { describe, it, expect } from 'vitest'
import type { FeatureDetectionResult, AnalyzerOptions } from '../../src/feature-analyzer/types.js'

describe('Feature Analyzer Types', () => {
  it('should define FeatureDetectionResult', () => {
    const result: FeatureDetectionResult = {
      features: [
        {
          id: 'write',
          name: 'Write Operations',
          description: 'Handles insert and upsert',
          entryPoints: ['src/insert.ts'],
          filePatterns: ['insert', 'upsert', 'write'],
          confidence: 0.9
        }
      ],
      reasoning: 'Found clear write-related files'
    }

    expect(result.features).toHaveLength(1)
    expect(result.features[0].confidence).toBeGreaterThan(0.5)
  })

  it('should define AnalyzerOptions', () => {
    const options: AnalyzerOptions = {
      maxFeatures: 10,
      minConfidence: 0.5,
      sampleSize: 20
    }

    expect(options.maxFeatures).toBe(10)
  })
})
