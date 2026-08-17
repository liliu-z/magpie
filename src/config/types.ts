// src/config/types.ts
export interface ProviderConfig {
  api_key: string
  base_url?: string
}

export interface ReviewerConfig {
  model: string
  prompt: string
  /**
   * Ledger flow only: where this finder goes deeper than the others. It is added to the
   * review instruction, not substituted for it — every finder still sweeps its whole scope.
   * Two finders on one model with one angle cost double and cover barely more than one;
   * defaults are supplied per finder when this is unset.
   */
  lens?: string
}

export interface DefaultsConfig {
  max_rounds: number
  output_format: 'markdown' | 'json'
  check_convergence: boolean
  language?: string  // Output language (e.g., 'zh', 'en', 'ja')
  diff_exclude?: string[]  // Glob patterns for files to exclude from diff (e.g., '*.pb.go', '*generated*')
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
    'qwen-code'?: { enabled: boolean }
    minimax?: ProviderConfig
  }
  mock?: boolean
  defaults: DefaultsConfig
  reviewers: Record<string, ReviewerConfig>
  summarizer: ReviewerConfig
  analyzer: ReviewerConfig
  audit?: ReviewerConfig  // Omniscient final judge; falls back to summarizer if absent
  // Ledger flow only: the role allowed to raise findings the finders missed. Deliberately
  // separate from `audit` — the verifier rules on findings and may not add them, this one
  // adds and may not publish. Point it at a different model family from the finders, or it
  // just reproduces their blind spots.
  gapFinder?: ReviewerConfig
  // Ledger flow only: groups the finders' raw findings into ledger entries and, after each
  // round, decides what the recorded positions add up to. It reads everything, so it is kept
  // on a short leash in code — it selects canonical wording rather than writing any, and can
  // only move an entry to a state the recorded evidence already supports. Without it the flow
  // falls back to merging findings by word overlap, which misses paraphrases.
  judge?: ReviewerConfig
  contextGatherer?: ContextGathererConfigOptions
}
