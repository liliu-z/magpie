// tests/providers/factory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProvider, getProviderForModel } from '../../src/providers/factory.js'
import { checkCliBinary } from '../../src/providers/cli-check.js'
import type { MagpieConfig } from '../../src/config/types.js'

// CLI providers verify their binary exists; stub it so these tests don't depend on
// which CLIs happen to be installed on the machine running them.
vi.mock('../../src/providers/cli-check.js', () => ({ checkCliBinary: vi.fn() }))

describe('Provider Factory', () => {
  const mockConfig: MagpieConfig = {
    providers: {
      anthropic: { api_key: 'ant-key' },
      openai: { api_key: 'oai-key' },
      'claude-code': { enabled: true },
      'codex-cli': { enabled: true }
    },
    defaults: { max_rounds: 3, output_format: 'markdown' },
    reviewers: {},
    summarizer: { model: 'claude-sonnet-4-20250514', prompt: '' },
    analyzer: { model: 'claude-sonnet-4-20250514', prompt: '' }
  }

  beforeEach(() => {
    vi.mocked(checkCliBinary).mockClear()
  })

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

    it('should return codex-cli for codex-cli model', () => {
      expect(getProviderForModel('codex-cli')).toBe('codex-cli')
    })

    it('should return antigravity for antigravity model', () => {
      expect(getProviderForModel('antigravity')).toBe('antigravity')
    })

    it('should return opencode for opencode model', () => {
      expect(getProviderForModel('opencode')).toBe('opencode')
      expect(getProviderForModel('opencode:anthropic/claude-sonnet-4-5')).toBe('opencode')
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

    // Effort is configured per role, so the factory is the one place it can go missing
    it('forwards the role effort to the provider', () => {
      const provider = createProvider('claude-code', mockConfig, 'xhigh') as unknown as { effort: string }
      expect(provider.effort).toBe('xhigh')
    })

    it('leaves the provider default in place when no effort is configured', () => {
      const provider = createProvider('claude-code', mockConfig) as unknown as { effort: string }
      expect(provider.effort).toBe('max')
    })

    it('forwards a pinned model alongside the effort', () => {
      const provider = createProvider('claude-code:claude-opus-5', mockConfig, 'xhigh') as unknown as { cliModel: string; effort: string }
      expect(provider.cliModel).toBe('claude-opus-5')
      expect(provider.effort).toBe('xhigh')
    })

    it('should create gemini provider', () => {
      const configWithGoogle = {
        ...mockConfig,
        providers: { ...mockConfig.providers, google: { api_key: 'google-key' } }
      }
      const provider = createProvider('gemini-pro', configWithGoogle)
      expect(provider.name).toBe('gemini')
    })

    it('should create codex-cli provider', () => {
      const provider = createProvider('codex-cli', mockConfig)
      expect(provider.name).toBe('codex-cli')
    })

    it('should create antigravity provider', () => {
      const provider = createProvider('antigravity', mockConfig)
      expect(provider.name).toBe('antigravity')
    })

    it('should create opencode provider', () => {
      const provider = createProvider('opencode', mockConfig)
      expect(provider.name).toBe('opencode')
      expect(checkCliBinary).toHaveBeenCalledWith('opencode', 'OpenCode')
    })

    it('should pass base_url through to API providers', () => {
      const configWithBaseUrl: MagpieConfig = {
        ...mockConfig,
        providers: {
          anthropic: { api_key: 'ant-key', base_url: 'https://my-proxy.example.com' },
          openai: { api_key: 'oai-key', base_url: 'https://my-openai-proxy.example.com/v1' },
        }
      }
      const anthropicProvider = createProvider('claude-sonnet-4-20250514', configWithBaseUrl)
      expect(anthropicProvider.name).toBe('anthropic')

      const openaiProvider = createProvider('gpt-4o', configWithBaseUrl)
      expect(openaiProvider.name).toBe('openai')
    })

    it('should work without base_url (backwards compatible)', () => {
      const provider = createProvider('claude-sonnet-4-20250514', mockConfig)
      expect(provider.name).toBe('anthropic')
    })
  })
})
