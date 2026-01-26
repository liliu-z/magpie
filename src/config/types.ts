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
}

export interface MagpieConfig {
  providers: {
    anthropic?: ProviderConfig
    openai?: ProviderConfig
    google?: ProviderConfig
  }
  defaults: DefaultsConfig
  reviewers: Record<string, ReviewerConfig>
  summarizer: ReviewerConfig
}
