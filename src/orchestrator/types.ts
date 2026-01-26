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

export interface DebateResult {
  prNumber: string
  messages: DebateMessage[]
  summaries: DebateSummary[]
  finalConclusion: string
}

export interface OrchestratorOptions {
  maxRounds: number
  interactive: boolean
  onMessage?: (reviewerId: string, chunk: string) => void
  onRoundComplete?: (round: number) => void
  onInteractive?: () => Promise<string | null>
}
