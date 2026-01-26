// src/orchestrator/types.ts
import type { AIProvider } from '../providers/types.js'

export interface Reviewer {
  id: string
  provider: AIProvider
  systemPrompt: string
}

export interface DebateMessage {
  reviewerId: string
  content: string
  timestamp: Date
}

export interface DebateSummary {
  reviewerId: string
  summary: string
}

export interface TokenUsage {
  reviewerId: string
  inputTokens: number
  outputTokens: number
  estimatedCost?: number  // USD
}

export interface DebateResult {
  prNumber: string
  analysis: string
  messages: DebateMessage[]
  summaries: DebateSummary[]
  finalConclusion: string
  tokenUsage: TokenUsage[]
  convergedAtRound?: number  // If converged early
}

export interface OrchestratorOptions {
  maxRounds: number
  interactive: boolean
  onMessage?: (reviewerId: string, chunk: string) => void
  onRoundComplete?: (round: number, converged: boolean) => void
  onInteractive?: () => Promise<string | null>
  onWaiting?: (reviewerId: string) => void
  checkConvergence?: boolean  // Enable convergence detection
  // Post-analysis Q&A: return { target: '@reviewer_id', question: 'text' } or null to continue
  onPostAnalysisQA?: () => Promise<{ target: string; question: string } | null>
}
