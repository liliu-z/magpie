// src/config/types.ts
export interface ProviderConfig {
  api_key: string
}

export interface ReviewerConfig {
  model: string
  prompt: string
}

export interface DefaultsConfig {
  max_rounds: number
  output_format: 'markdown' | 'json'
  check_convergence: boolean
}

export interface ContextGathererConfigOptions {
  enabled: boolean
  callChain?: {
    maxDepth?: number
    maxFilesToAnalyze?: number
  }
  history?: {
    maxDays?: number
    maxPRs?: number
  }
  docs?: {
    patterns?: string[]
    maxSize?: number
  }
  model?: string  // Model to use for context analysis
}

export interface MagpieConfig {
  providers: {
    anthropic?: ProviderConfig
    openai?: ProviderConfig
    google?: ProviderConfig
    'claude-code'?: { enabled: boolean }
    'codex-cli'?: { enabled: boolean }
  }
  defaults: DefaultsConfig
  reviewers: Record<string, ReviewerConfig>
  summarizer: ReviewerConfig
  analyzer: ReviewerConfig
  contextGatherer?: ContextGathererConfigOptions
}
