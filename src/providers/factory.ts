// src/providers/factory.ts
import type { AIProvider } from './types.js'
import type { MagpieConfig } from '../config/types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import { ClaudeCodeProvider } from './claude-code.js'
import { CodexCliProvider } from './codex-cli.js'
import { GeminiCliProvider } from './gemini-cli.js'
import { GeminiProvider } from './gemini.js'
import { QwenCodeProvider } from './qwen-code.js'
import { MiniMaxProvider } from './minimax.js'
import { MockProvider } from './mock.js'

export function getProviderForModel(model: string): 'anthropic' | 'openai' | 'google' | 'claude-code' | 'codex-cli' | 'gemini-cli' | 'qwen-code' | 'minimax' | 'mock' {
  if (model === 'claude-code') {
    return 'claude-code'
  }
  if (model === 'codex-cli') {
    return 'codex-cli'
  }
  if (model === 'gemini-cli') {
    return 'gemini-cli'
  }
  if (model === 'qwen-code') {
    return 'qwen-code'
  }
  if (model === 'minimax') {
    return 'minimax'
  }
  if (model.startsWith('mock')) {
    return 'mock'
  }
  if (model.startsWith('claude')) {
    return 'anthropic'
  }
  if (model.startsWith('gpt')) {
    return 'openai'
  }
  if (model.startsWith('gemini')) {
    return 'google'
  }
  throw new Error(`Unknown model: ${model}`)
}

export function createProvider(model: string, config: MagpieConfig): AIProvider {
  // Global mock mode: override all models to MockProvider
  if (config.mock) {
    return new MockProvider()
  }

  const providerName = getProviderForModel(model)

  // Claude Code doesn't need API key config
  if (providerName === 'claude-code') {
    return new ClaudeCodeProvider()
  }

  // Codex CLI doesn't need API key config
  if (providerName === 'codex-cli') {
    return new CodexCliProvider()
  }

  // Gemini CLI doesn't need API key config (uses Google account)
  if (providerName === 'gemini-cli') {
    return new GeminiCliProvider()
  }

  // Qwen Code CLI doesn't need API key config (uses OAuth)
  if (providerName === 'qwen-code') {
    return new QwenCodeProvider()
  }

  // Mock provider for debug mode — no API key needed
  if (providerName === 'mock') {
    return new MockProvider()
  }

  // MiniMax uses API key from config or env
  if (providerName === 'minimax') {
    const providerConfig = config.providers['minimax']
    return new MiniMaxProvider({
      apiKey: providerConfig?.api_key || process.env.MINIMAX_API_KEY || '',
      model: 'MiniMax-M2.5',
      baseURL: providerConfig?.base_url,
    })
  }

  const providerConfig = config.providers[providerName]

  if (!providerConfig) {
    throw new Error(`Provider ${providerName} not configured for model ${model}`)
  }

  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: providerConfig.api_key, model, baseURL: providerConfig.base_url })
    case 'openai':
      return new OpenAIProvider({ apiKey: providerConfig.api_key, model, baseURL: providerConfig.base_url })
    case 'google':
      return new GeminiProvider({ apiKey: providerConfig.api_key, model, baseURL: providerConfig.base_url })
    default:
      throw new Error(`Unknown provider: ${providerName}`)
  }
}
