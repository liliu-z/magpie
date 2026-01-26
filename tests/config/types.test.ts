// tests/config/types.test.ts
import { describe, it, expect } from 'vitest'
import type { MagpieConfig, ReviewerConfig, ProviderConfig } from '../../src/config/types'

describe('Config Types', () => {
  it('should allow valid config structure', () => {
    const config: MagpieConfig = {
      providers: {
        anthropic: { api_key: 'test-key' }
      },
      defaults: {
        max_rounds: 3,
        output_format: 'markdown'
      },
      reviewers: {
        'security-expert': {
          model: 'claude-sonnet-4-20250514',
          prompt: 'You are a security expert'
        }
      },
      summarizer: {
        model: 'claude-sonnet-4-20250514',
        prompt: 'You are a neutral summarizer'
      }
    }
    expect(config.defaults.max_rounds).toBe(3)
  })
})
