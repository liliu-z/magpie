// src/providers/factory.ts
import type { AIProvider } from './types.js'
import type { MagpieConfig } from '../config/types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import { ClaudeCodeProvider } from './claude-code.js'
import { CodexCliProvider } from './codex-cli.js'
import { GeminiProvider } from './gemini.js'

export function getProviderForModel(model: string): 'anthropic' | 'openai' | 'google' | 'claude-code' | 'codex-cli' {
  if (model === 'claude-code') {
    return 'claude-code'
  }
  if (model === 'codex-cli') {
    return 'codex-cli'
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
  const providerName = getProviderForModel(model)

  // Claude Code doesn't need API key config
  if (providerName === 'claude-code') {
    return new ClaudeCodeProvider()
  }

  // Codex CLI doesn't need API key config
  if (providerName === 'codex-cli') {
    return new CodexCliProvider()
  }

  const providerConfig = config.providers[providerName]

  if (!providerConfig) {
    throw new Error(`Provider ${providerName} not configured for model ${model}`)
  }

  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: providerConfig.api_key, model })
    case 'openai':
      return new OpenAIProvider({ apiKey: providerConfig.api_key, model })
    case 'google':
      return new GeminiProvider({ apiKey: providerConfig.api_key, model })
    default:
      throw new Error(`Unknown provider: ${providerName}`)
  }
}
