// tests/providers/factory.test.ts
import { describe, it, expect } from 'vitest'
import { createProvider, getProviderForModel } from '../../src/providers/factory.js'
import type { MagpieConfig } from '../../src/config/types.js'

describe('Provider Factory', () => {
  const mockConfig: MagpieConfig = {
    providers: {
      anthropic: { api_key: 'ant-key' },
      openai: { api_key: 'oai-key' },
      'claude-code': { enabled: true }
    },
    defaults: { max_rounds: 3, output_format: 'markdown' },
    reviewers: {},
    summarizer: { model: 'claude-sonnet-4-20250514', prompt: '' },
    analyzer: { model: 'claude-sonnet-4-20250514', prompt: '' }
  }

  describe('getProviderForModel', () => {
    it('should return anthropic for claude models', () => {
      expect(getProviderForModel('claude-sonnet-4-20250514')).toBe('anthropic')
      expect(getProviderForModel('claude-3-opus-20240229')).toBe('anthropic')
    })

    it('should return openai for gpt models', () => {
      expect(getProviderForModel('gpt-4o')).toBe('openai')
      expect(getProviderForModel('gpt-4-turbo')).toBe('openai')
    })

    it('should return google for gemini models', () => {
      expect(getProviderForModel('gemini-pro')).toBe('google')
    })

    it('should return claude-code for claude-code model', () => {
      expect(getProviderForModel('claude-code')).toBe('claude-code')
    })
  })

  describe('createProvider', () => {
    it('should create anthropic provider', () => {
      const provider = createProvider('claude-sonnet-4-20250514', mockConfig)
      expect(provider.name).toBe('anthropic')
    })

    it('should create openai provider', () => {
      const provider = createProvider('gpt-4o', mockConfig)
      expect(provider.name).toBe('openai')
    })

    it('should throw for missing provider config', () => {
      const configWithoutOpenAI = { ...mockConfig, providers: { anthropic: { api_key: 'key' } } }
      expect(() => createProvider('gpt-4o', configWithoutOpenAI)).toThrow()
    })

    it('should create claude-code provider', () => {
      const provider = createProvider('claude-code', mockConfig)
      expect(provider.name).toBe('claude-code')
    })

    it('should create gemini provider', () => {
      const configWithGoogle = {
        ...mockConfig,
        providers: { ...mockConfig.providers, google: { api_key: 'google-key' } }
      }
      const provider = createProvider('gemini-pro', configWithGoogle)
      expect(provider.name).toBe('gemini')
    })
  })
})
