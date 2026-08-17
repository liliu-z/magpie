// src/orchestrator/types.ts
import type { AIProvider } from '../providers/types.js'
import type { GatheredContext } from '../context-gatherer/types.js'

export interface Reviewer {
  id: string
  provider: AIProvider
  systemPrompt: string
  /** Ledger flow: this finder's deeper-focus angle; falls back to a built-in default */
  lens?: string
}

export interface DebateMessage {
  reviewerId: string
  content: string
  timestamp: Date
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
  finalConclusion: string
  verifiedConclusion?: string  // Verified conclusion after cross-checking with PR/code
  tokenUsage: TokenUsage[]
  convergedAtRound?: number  // If converged early
  parsedIssues?: MergedIssue[]   // Deduplicated structured issues (if reviewers output JSON)
}

export interface ReviewerStatus {
  reviewerId: string
  status: 'pending' | 'thinking' | 'done' | 'error'
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
  // Unified diff of the change under review, fetched by the caller. Used ONLY to
  // constrain and validate structurizer output (which files/lines may be cited) —
  // it is never added to the reviewer prompts. Required for the line-range guard to
  // work in CLI mode, where reviewers fetch the diff themselves and the task prompt
  // is just a PR link.
  diffText?: string
  // Let the context gatherer investigate with its own tools instead of being fed a diff.
  // Only meaningful for tool-capable (CLI) context models.
  contextAgentMode?: boolean
  skipConclusion?: boolean  // Skip getFinalConclusion + old verifyConclusion (bot mode)
  failFast?: boolean  // Abort the entire flow as soon as any reviewer (or context gatherer) fails
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

  // Populated by the audit stage (verifyIssues). Absent if audit didn't run.
  // 'unverified' = audit ran but did not return a verdict for this issue (it failed
  // to parse, or it skipped the issue). Treat as NOT fact-checked.
  verdict?: 'keep' | 'rewrite' | 'drop' | 'new' | 'unverified'
  body?: string            // Audit-authored post text (replaces description for posting). Plain prose.
  evidence?: string        // Audit's cited code reference (file:line + quote)
  auditReason?: string     // For verdict=drop: drop reason category
}
