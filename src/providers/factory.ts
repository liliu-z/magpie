// src/providers/factory.ts
import type { AIProvider } from './types.js'
import type { MagpieConfig } from '../config/types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import { ClaudeCodeProvider } from './claude-code.js'
import { CodexCliProvider } from './codex-cli.js'
import { GeminiCliProvider } from './gemini-cli.js'
import { AntigravityCliProvider } from './antigravity.js'
import { GeminiProvider } from './gemini.js'
import { QwenCodeProvider } from './qwen-code.js'
import { MiniMaxProvider } from './minimax.js'
import { MockProvider } from './mock.js'
import { checkCliBinary } from './cli-check.js'

// Parse CLI model string: 'gemini-cli:gemini-2.5-pro' → { provider: 'gemini-cli', cliModel: 'gemini-2.5-pro' }
// Plain 'gemini-cli' → { provider: 'gemini-cli', cliModel: undefined }
const CLI_PROVIDERS = ['claude-code', 'codex-cli', 'gemini-cli', 'antigravity', 'qwen-code'] as const
type CliProviderName = typeof CLI_PROVIDERS[number]

export function parseCliModel(model: string): { provider: string; cliModel?: string } {
  for (const cli of CLI_PROVIDERS) {
    if (model === cli) {
      return { provider: cli }
    }
    if (model.startsWith(cli + ':')) {
      return { provider: cli, cliModel: model.slice(cli.length + 1) }
    }
  }
  return { provider: model }
}

/** Check if a model string maps to a CLI-based provider (has tool access / can read files) */
export function isCliModel(model: string): boolean {
  const { provider } = parseCliModel(model)
  return (CLI_PROVIDERS as readonly string[]).includes(provider)
}

export function getProviderForModel(model: string): 'anthropic' | 'openai' | 'google' | 'claude-code' | 'codex-cli' | 'gemini-cli' | 'antigravity' | 'qwen-code' | 'minimax' | 'mock' {
  const { provider } = parseCliModel(model)
  if ((CLI_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as CliProviderName
  }
  if (provider === 'minimax') {
    return 'minimax'
  }
  if (provider.startsWith('mock')) {
    return 'mock'
  }
  if (provider.startsWith('claude')) {
    return 'anthropic'
  }
  if (provider.startsWith('gpt')) {
    return 'openai'
  }
  if (provider.startsWith('gemini')) {
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

  const { cliModel } = parseCliModel(model)

  // Claude Code doesn't need API key config
  if (providerName === 'claude-code') {
    checkCliBinary('claude', 'Claude Code')
    return new ClaudeCodeProvider({ cliModel })
  }

  // Codex CLI doesn't need API key config
  if (providerName === 'codex-cli') {
    checkCliBinary('codex', 'Codex')
    return new CodexCliProvider({ cliModel })
  }

  // Gemini CLI doesn't need API key config (uses Google account)
  if (providerName === 'gemini-cli') {
    checkCliBinary('gemini', 'Gemini')
    return new GeminiCliProvider({ cliModel })
  }

  // Antigravity CLI (`agy`) doesn't need API key config (uses Google account)
  if (providerName === 'antigravity') {
    checkCliBinary('agy', 'Antigravity')
    return new AntigravityCliProvider({ cliModel })
  }

  // Qwen Code CLI doesn't need API key config (uses OAuth)
  if (providerName === 'qwen-code') {
    checkCliBinary('qwen', 'Qwen Code')
    return new QwenCodeProvider({ cliModel })
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
