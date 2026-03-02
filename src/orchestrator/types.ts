// src/orchestrator/types.ts
import type { AIProvider } from '../providers/types.js'
import type { GatheredContext } from '../context-gatherer/types.js'

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
  context?: GatheredContext
  messages: DebateMessage[]
  summaries: DebateSummary[]
  finalConclusion: string
  tokenUsage: TokenUsage[]
  convergedAtRound?: number  // If converged early
  parsedIssues?: MergedIssue[]   // Deduplicated structured issues (if reviewers output JSON)
}

export interface ReviewerStatus {
  reviewerId: string
  status: 'pending' | 'thinking' | 'done'
  startTime?: number  // timestamp ms
  endTime?: number    // timestamp ms
  duration?: number   // seconds
}

export interface OrchestratorOptions {
  maxRounds: number
  interactive: boolean
  language?: string  // Output language instruction to inject into prompts
  onMessage?: (reviewerId: string, chunk: string) => void
  onRoundComplete?: (round: number, converged: boolean) => void
  onInteractive?: () => Promise<string | null>
  onWaiting?: (reviewerId: string) => void
  onParallelStatus?: (round: number, statuses: ReviewerStatus[]) => void  // Track parallel execution
  checkConvergence?: boolean  // Enable convergence detection
  onConvergenceJudgment?: (verdict: 'CONVERGED' | 'NOT_CONVERGED', reasoning: string) => void  // Convergence judgment details
  // Post-analysis Q&A: return { target: '@reviewer_id', question: 'text' } or null to continue
  onPostAnalysisQA?: () => Promise<{ target: string; question: string } | null>
  onContextGathered?: (context: GatheredContext) => void  // Context gathering complete callback
  interruptState?: { interrupted: boolean }  // External interrupt signal (e.g., Ctrl+C)
}

/** Structured issue from a reviewer */
export interface ReviewIssue {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nitpick'
  category: string
  file: string
  line?: number
  endLine?: number
  title: string
  description: string
  suggestedFix?: string
  codeSnippet?: string
  raisedBy?: string[]  // preserved from structurizer output
}

/** Structured output from a reviewer (parsed from JSON block in response) */
export interface ReviewerOutput {
  issues: ReviewIssue[]
  verdict: 'approve' | 'request_changes' | 'comment'
  summary: string
}

/** Deduplicated issue with attribution */
export interface MergedIssue extends ReviewIssue {
  raisedBy: string[]       // reviewer IDs who found this issue
  descriptions: string[]   // each reviewer's description
}
