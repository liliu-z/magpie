// src/orchestrator/orchestrator.ts
import type { Message } from '../providers/types.js'
import type {
  Reviewer,
  DebateMessage,
  DebateResult,
  OrchestratorOptions,
  TokenUsage,
  ReviewerStatus,
  MergedIssue
} from './types.js'
import type { ContextGatherer } from '../context-gatherer/gatherer.js'
import type { GatheredContext } from '../context-gatherer/types.js'
import { parseReviewerOutput, parseFocusAreas } from './issue-parser.js'
import { formatCallChainForReviewer } from '../context-gatherer/collectors/reference-collector.js'
import { logger } from '../utils/logger.js'

export class InterruptedError extends Error {
  constructor() { super('Interrupted by user') }
}

/**
 * Extract changed file paths from a diff/prompt containing `diff --git` headers.
 */
export function extractChangedFiles(taskPrompt: string): string[] {
  const files: string[] = []
  const regex = /diff --git a\/.+ b\/(.+)/g
  let match
  while ((match = regex.exec(taskPrompt)) !== null) {
    files.push(match[1])
  }
  return [...new Set(files)]
}

/**
 * Extract per-file hunk line ranges from a unified diff.
 * Returns a formatted string like:
 *   src/foo.ts: 35-46, 80-95
 *   src/bar.ts: 10-25
 */
export function extractDiffLineRanges(diff: string): string {
  const ranges = new Map<string, Array<string>>()
  let currentFile = ''

  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)/)
    if (fileMatch) {
      currentFile = fileMatch[1]
      continue
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1])
      const count = hunkMatch[2] ? parseInt(hunkMatch[2]) : 1
      const end = start + count - 1
      if (!ranges.has(currentFile)) {
        ranges.set(currentFile, [])
      }
      ranges.get(currentFile)!.push(end > start ? `${start}-${end}` : `${start}`)
    }
  }

  return [...ranges.entries()]
    .map(([file, r]) => `  ${file}: ${r.join(', ')}`)
    .join('\n')
}

export class DebateOrchestrator {
  private reviewers: Reviewer[]
  private summarizer: Reviewer
  private analyzer: Reviewer
  private contextGatherer: ContextGatherer | null
  private options: OrchestratorOptions
  private conversationHistory: DebateMessage[] = []
  private tokenUsage: Map<string, { input: number; output: number }> = new Map()
  private analysis: string = ''  // Store analysis to avoid repeating diff
  private gatheredContext: GatheredContext | null = null  // Store gathered context
  private taskPrompt: string = ''  // Original task prompt (contains PR number, etc.)
  private lastSeenIndex: Map<string, number> = new Map()  // Track what each reviewer has seen

  constructor(
    reviewers: Reviewer[],
    summarizer: Reviewer,
    analyzer: Reviewer,
    options: OrchestratorOptions,
    contextGatherer?: ContextGatherer
  ) {
    this.reviewers = reviewers
    this.summarizer = summarizer
    this.analyzer = analyzer
    this.contextGatherer = contextGatherer || null
    this.options = options
  }

  /** Throw if externally interrupted (e.g., Ctrl+C) */
  private checkInterrupt(): void {
    if (this.options.interruptState?.interrupted) {
      throw new InterruptedError()
    }
  }

  /** Build a language instruction suffix (empty string if no language configured) */
  private get langSuffix(): string {
    if (!this.options.language) return ''
    return `\n\nIMPORTANT: You MUST respond in ${this.options.language}. All your analysis, comments, and explanations must be written in ${this.options.language}.`
  }

  /** Build a language instruction prefix for system prompts (stronger than suffix) */
  private get langPrefix(): string {
    if (!this.options.language) return ''
    return `[LANGUAGE REQUIREMENT] You MUST write ALL responses in ${this.options.language}. This applies to all analysis, comments, summaries, and explanations. Only code snippets, variable names, and JSON keys should remain in English.\n\n`
  }

  /** Prepend language prefix to a system prompt */
  private withLang(systemPrompt?: string): string | undefined {
    if (!systemPrompt) return systemPrompt
    return this.langPrefix + systemPrompt
  }

  // Estimate tokens from text (CJK ~0.7 tokens/char, English ~0.25 tokens/char)
  private estimateTokens(text: string): number {
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
    return Math.ceil(cjkCount * 0.7 + (text.length - cjkCount) / 4)
  }

  private trackTokens(reviewerId: string, input: string, output: string) {
    const existing = this.tokenUsage.get(reviewerId) || { input: 0, output: 0 }
    existing.input += this.estimateTokens(input)
    existing.output += this.estimateTokens(output)
    this.tokenUsage.set(reviewerId, existing)
  }

  private getTokenUsage(): TokenUsage[] {
    const usage: TokenUsage[] = []
    for (const [reviewerId, tokens] of this.tokenUsage) {
      usage.push({
        reviewerId,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        // Rough cost estimate: $0.01 per 1K tokens (varies by model)
        estimatedCost: (tokens.input + tokens.output) * 0.00001
      })
    }
    return usage
  }

  // Check if reviewers have converged (reached consensus)
  private async checkConvergence(): Promise<boolean> {
    if (this.conversationHistory.length < this.reviewers.length) {
      return false // Need at least 1 complete round to check
    }

    // Count how many rounds have been completed
    const roundsCompleted = Math.floor(this.conversationHistory.length / this.reviewers.length)

    // Get last round's messages
    const lastRoundMessages = this.conversationHistory.slice(-this.reviewers.length)
    const messagesText = lastRoundMessages
      .map(m => `[${m.reviewerId}]: ${m.content}`)
      .join('\n\n---\n\n')

    const isFirstRound = roundsCompleted <= 1
    const roundContext = isFirstRound
      ? `IMPORTANT: This is Round 1. Reviewers have NOT seen each other's opinions - they reviewed independently. If they independently arrived at the same conclusions, that IS valid convergence.`
      : `IMPORTANT: This is Round ${roundsCompleted}. Reviewers have now seen each other's opinions.`

    const prompt = `You are a strict consensus judge. Analyze whether these ${this.reviewers.length} reviewers have reached TRUE CONSENSUS.

${roundContext}

TRUE CONSENSUS requires ALL of the following:
1. All reviewers agree on the SAME final verdict (all approve OR all request changes)
2. Critical/blocking issues identified by ANY reviewer are acknowledged by ALL others
3. No reviewer has raised a concern that others have ignored or dismissed without addressing
4. They explicitly agree on what actions to take (not just "no disagreement")

NOT CONSENSUS if ANY of these:
- One reviewer identified a Critical/Important issue that others didn't address
- Reviewers found DIFFERENT sets of issues without cross-validating each other's findings
- One reviewer says "I disagree" or challenges another's reasoning
- Reviewers give different verdicts or severity assessments
- Silence on another's point (not responding to it) - silence is NOT agreement
- They list problems but haven't confirmed they agree on the complete list

Reviews from Round ${roundsCompleted}:
${messagesText}

First, provide a brief reasoning (2-3 sentences) explaining your judgment.
Then on the LAST line, respond with EXACTLY one word: CONVERGED or NOT_CONVERGED`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(
      messages,
      'You are a strict consensus judge. Be VERY conservative - if there is ANY doubt, respond NOT_CONVERGED. Provide brief reasoning, then on the last line respond with exactly one word: CONVERGED or NOT_CONVERGED.'
    )

    // Parse response - extract verdict from last line, rest is reasoning
    const lines = response.trim().split('\n')
    const lastLine = lines[lines.length - 1].trim().toUpperCase()
    const verdict = lastLine.split(/\s+/)[0]
    const isConverged = verdict === 'CONVERGED'

    // Extract reasoning (everything except the last line)
    const reasoning = lines.slice(0, -1).join('\n').trim()

    // Notify callback with judgment details
    this.options.onConvergenceJudgment?.(
      isConverged ? 'CONVERGED' : 'NOT_CONVERGED',
      reasoning || response.trim()
    )

    return isConverged
  }

  /**
   * Extract diff content from prompt (for local/branch reviews)
   */
  private extractDiffFromPrompt(prompt: string): string {
    // If prompt contains diff directly (local/branch review), extract it
    const diffMatch = prompt.match(/```diff\n([\s\S]*?)```/)
    if (diffMatch) {
      return diffMatch[1]
    }
    // For PR reviews, return the full prompt (diff will be fetched by reviewer)
    return prompt
  }

  private async preAnalyze(prompt: string): Promise<string> {
    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.analyzer.provider.chat(messages, this.withLang(this.analyzer.systemPrompt))
    this.trackTokens('analyzer', prompt + (this.analyzer.systemPrompt || ''), response)
    return response
  }

  async run(label: string, prompt: string): Promise<DebateResult> {
    this.conversationHistory = []
    this.tokenUsage.clear()
    this.lastSeenIndex.clear()
    this.taskPrompt = prompt
    let convergedAtRound: number | undefined

    try {
      // Run pre-analysis first and store it
      this.analysis = await this.preAnalyze(prompt)
      this.checkInterrupt()

      // Run debate rounds
      for (let round = 1; round <= this.options.maxRounds; round++) {
        this.checkInterrupt()
        for (const reviewer of this.reviewers) {
          // Check for user interruption in interactive mode
          if (this.options.interactive && this.options.onInteractive) {
            const userInput = await this.options.onInteractive()
            if (userInput === 'q') {
              break
            }
            if (userInput) {
              this.conversationHistory.push({
                reviewerId: 'user',
                content: userInput,
                timestamp: new Date()
              })
            }
          }

          const messages = this.buildMessages(reviewer.id)
          const response = await reviewer.provider.chat(messages, this.withLang(reviewer.systemPrompt))

          const inputText = messages.map(m => m.content).join('\n') + (reviewer.systemPrompt || '')
          this.trackTokens(reviewer.id, inputText, response)

          this.conversationHistory.push({
            reviewerId: reviewer.id,
            content: response,
            timestamp: new Date()
          })
          this.markAsSeen(reviewer.id)

          this.options.onMessage?.(reviewer.id, response)
        }

        // Check convergence if enabled
        let converged = false
        if (this.options.checkConvergence && round < this.options.maxRounds) {
          converged = await this.checkConvergence()
          if (converged) {
            convergedAtRound = round
          }
        }

        this.options.onRoundComplete?.(round, converged)

        if (converged) {
          break
        }
      }

      this.checkInterrupt()

      let finalConclusion = ''
      let verifiedConclusion: string | undefined

      if (!this.options.skipConclusion) {
        finalConclusion = await this.getFinalConclusion()
      }

      // End summarizer session for clean JSON extraction call
      this.summarizer.provider.endSession?.()
      const parsedIssues = await this.extractIssues()

      if (parsedIssues.length > 0) {
        await this.verifyIssues(parsedIssues)
      }

      if (finalConclusion && !this.options.skipConclusion) {
        verifiedConclusion = await this.verifyConclusion(finalConclusion)
      }

      return {
        prNumber: label,
        analysis: this.analysis,
        messages: this.conversationHistory,
        finalConclusion,
        verifiedConclusion,
        tokenUsage: this.getTokenUsage(),
        convergedAtRound,
        ...(parsedIssues.length > 0 ? { parsedIssues } : {})
      }
    } finally {
      for (const reviewer of this.reviewers) {
        reviewer.provider.endSession?.()
      }
      this.analyzer.provider.endSession?.()
      this.summarizer.provider.endSession?.()
    }
  }

  async runStreaming(label: string, prompt: string): Promise<DebateResult> {
    this.conversationHistory = []
    this.tokenUsage.clear()
    this.lastSeenIndex.clear()
    this.analysis = ''
    this.taskPrompt = prompt
    let convergedAtRound: number | undefined

    // Start sessions for reviewers that support it (with descriptive names for session listings)
    for (const reviewer of this.reviewers) {
      reviewer.provider.startSession?.(`Magpie | ${label} | reviewer:${reviewer.id}`)
    }
    this.analyzer.provider.startSession?.(`Magpie | ${label} | analyzer`)
    this.summarizer.provider.startSession?.(`Magpie | ${label} | summarizer`)

    try {
      // Run context gathering and analysis in parallel (they're independent)
      // Display is sequential: analysis streams first, then context appears after
      const contextPromise = this.contextGatherer
        ? (async () => {
            this.options.onWaiting?.('context-gatherer')
            try {
              const diff = this.extractDiffFromPrompt(prompt)
              this.gatheredContext = await this.contextGatherer!.gather(diff, label, 'main')
            } catch (error) {
              if (this.options.failFast) {
                throw new Error(`Context gathering failed (fail-fast): ${error instanceof Error ? error.message : String(error)}`)
              }
              logger.warn('Context gathering failed:', error)
            }
          })()
        : Promise.resolve()

      const analysisPromise = (async () => {
        const analyzeMessages: Message[] = [{ role: 'user', content: prompt }]
        this.options.onWaiting?.('analyzer')
        for await (const chunk of this.analyzer.provider.chatStream(analyzeMessages, this.withLang(this.analyzer.systemPrompt))) {
          this.analysis += chunk
          this.options.onMessage?.('analyzer', chunk)
        }
        this.trackTokens('analyzer', prompt + (this.analyzer.systemPrompt || ''), this.analysis)
      })()

      await Promise.all([contextPromise, analysisPromise])
      this.checkInterrupt()

      // Display context after analysis completes (parallel work, sequential display)
      if (this.gatheredContext) {
        this.options.onContextGathered?.(this.gatheredContext)
      }

      // Post-analysis Q&A: let user ask specific reviewers questions before debate
      if (this.options.onPostAnalysisQA) {
        while (true) {
          const qa = await this.options.onPostAnalysisQA()
          if (!qa) break  // User wants to proceed to debate

          // Find target reviewer (strip @ prefix if present)
          const targetId = qa.target.replace(/^@/, '')
          const targetReviewer = this.reviewers.find(r => r.id.toLowerCase() === targetId.toLowerCase())

          if (!targetReviewer) {
            // Invalid target, skip
            continue
          }

          // Build Q&A message
          const qaMessages: Message[] = [{
            role: 'user',
            content: `Based on the analysis above, please answer this question:\n\n${qa.question}`
          }]

          let qaResponse = ''
          this.options.onWaiting?.(targetReviewer.id)
          for await (const chunk of targetReviewer.provider.chatStream(qaMessages, this.withLang(targetReviewer.systemPrompt))) {
            qaResponse += chunk
            this.options.onMessage?.(targetReviewer.id, chunk)
          }

          // Track tokens and add to history
          this.trackTokens(targetReviewer.id, qa.question, qaResponse)
          this.conversationHistory.push({
            reviewerId: 'user',
            content: `[Question to ${targetReviewer.id}]: ${qa.question}`,
            timestamp: new Date()
          })
          this.conversationHistory.push({
            reviewerId: targetReviewer.id,
            content: qaResponse,
            timestamp: new Date()
          })
          this.markAsSeen(targetReviewer.id)
        }
      }

      for (let round = 1; round <= this.options.maxRounds; round++) {
        this.checkInterrupt()
        // Handle interactive mode before round starts
        if (this.options.interactive && this.options.onInteractive) {
          const userInput = await this.options.onInteractive()
          if (userInput === 'q') break
          if (userInput) {
            this.conversationHistory.push({
              reviewerId: 'user',
              content: userInput,
              timestamp: new Date()
            })
          }
        }

        // Build messages for all reviewers BEFORE any execution (same info for all)
        const reviewerTasks = this.reviewers.map(reviewer => ({
          reviewer,
          messages: this.buildMessages(reviewer.id)
        }))

        // Initialize status tracking for parallel execution
        const statuses: ReviewerStatus[] = this.reviewers.map(r => ({
          reviewerId: r.id,
          status: 'pending' as const
        }))

        // Execute all reviewers in parallel with status tracking
        this.options.onWaiting?.(`round-${round}`)
        this.options.onParallelStatus?.(round, statuses)

        const results = await Promise.all(
          reviewerTasks.map(async ({ reviewer, messages }, index) => {
            statuses[index] = {
              reviewerId: reviewer.id,
              status: 'thinking',
              startTime: Date.now()
            }
            this.options.onParallelStatus?.(round, statuses)

            try {
              let fullResponse = ''
              for await (const chunk of reviewer.provider.chatStream(messages, this.withLang(reviewer.systemPrompt))) {
                fullResponse += chunk
              }

              const endTime = Date.now()
              const startTime = statuses[index].startTime!
              statuses[index] = {
                reviewerId: reviewer.id,
                status: 'done',
                startTime,
                endTime,
                duration: (endTime - startTime) / 1000
              }
              this.options.onParallelStatus?.(round, statuses)

              const inputText = messages.map(m => m.content).join('\n') + (reviewer.systemPrompt || '')
              return { reviewer, fullResponse, inputText, failed: false as const }
            } catch (err) {
              const endTime = Date.now()
              const startTime = statuses[index].startTime ?? endTime
              statuses[index] = {
                reviewerId: reviewer.id,
                status: 'error',
                startTime,
                endTime,
                duration: (endTime - startTime) / 1000
              }
              this.options.onParallelStatus?.(round, statuses)
              if (this.options.failFast) {
                // Re-throw so Promise.all rejects immediately and aborts the whole flow
                throw new Error(`Reviewer ${reviewer.id} failed in round ${round} (fail-fast): ${err instanceof Error ? err.message : String(err)}`)
              }
              logger.warn(`Reviewer ${reviewer.id} failed in round ${round}:`, err)
              return { reviewer, fullResponse: '', inputText: '', failed: true as const, error: err }
            }
          })
        )

        // Fail only if ALL reviewers failed
        const successResults = results.filter(r => !r.failed)
        if (successResults.length === 0) {
          const errors = results.map(r => r.failed ? `${r.reviewer.id}: ${r.error instanceof Error ? r.error.message : r.error}` : '').filter(Boolean)
          throw new Error(`All reviewers failed in round ${round}:\n${errors.join('\n')}`)
        }

        // Process results - only add successful ones to history
        for (const result of results) {
          if (result.failed) {
            this.options.onMessage?.(result.reviewer.id, `[Review failed: ${result.error instanceof Error ? result.error.message : 'unknown error'}]`)
            continue
          }
          this.trackTokens(result.reviewer.id, result.inputText, result.fullResponse)
          this.conversationHistory.push({
            reviewerId: result.reviewer.id,
            content: result.fullResponse,
            timestamp: new Date()
          })
          this.markAsSeen(result.reviewer.id)
          this.options.onMessage?.(result.reviewer.id, result.fullResponse)
        }

        // Check convergence if enabled
        let converged = false
        if (this.options.checkConvergence && round < this.options.maxRounds) {
          this.options.onWaiting?.('convergence-check')
          converged = await this.checkConvergence()
          if (converged) {
            convergedAtRound = round
          }
        }

        this.options.onRoundComplete?.(round, converged)

        if (converged) {
          break
        }
      }

      this.checkInterrupt()

      let finalConclusion = ''
      let verifiedConclusion: string | undefined

      if (!this.options.skipConclusion) {
        this.options.onWaiting?.('summarizer')
        finalConclusion = await this.getFinalConclusion()
      }

      // End summarizer session before structurization so it gets a clean,
      // non-session call. The session context (convergence + conclusion) would
      // pollute the JSON extraction and --resume ignores custom system prompts.
      this.summarizer.provider.endSession?.()
      const parsedIssues = await this.extractIssues()

      // Verify+Audit: check each issue against actual code using tools.
      // This replaces both the old text-only verifyConclusion and the
      // downstream audit step in li-bot.
      if (parsedIssues.length > 0) {
        this.options.onWaiting?.('verifier')
        await this.verifyIssues(parsedIssues)
      }

      // Legacy: if conclusion was generated and skipConclusion is false,
      // also verify conclusion text (for CLI interactive mode)
      if (finalConclusion && !this.options.skipConclusion) {
        verifiedConclusion = await this.verifyConclusion(finalConclusion)
      }

      return {
        prNumber: label,
        analysis: this.analysis,
        context: this.gatheredContext || undefined,
        messages: this.conversationHistory,
        finalConclusion,
        verifiedConclusion,
        tokenUsage: this.getTokenUsage(),
        convergedAtRound,
        ...(parsedIssues.length > 0 ? { parsedIssues } : {})
      }
    } finally {
      // End sessions
      for (const reviewer of this.reviewers) {
        reviewer.provider.endSession?.()
      }
      this.analyzer.provider.endSession?.()
      this.summarizer.provider.endSession?.()  // Safe to call again (idempotent)
    }
  }

  private buildMessages(currentReviewerId: string): Message[] {
    const reviewer = this.reviewers.find(r => r.id === currentReviewerId)
    const hasSession = reviewer?.provider.sessionId !== undefined
    const lastSeen = this.lastSeenIndex.get(currentReviewerId) ?? -1
    const isFirstCall = lastSeen < 0
    const otherReviewerIds = this.reviewers.filter(r => r.id !== currentReviewerId).map(r => r.id)

    // Round 1: Each reviewer gives independent opinion (no other reviewers' responses)
    // Round 2+: See all previous context
    if (isFirstCall) {
      // Build context section if available
      let contextSection = ''
      if (this.gatheredContext?.summary) {
        contextSection = `
## System Context
${this.gatheredContext.summary}

`
      }

      // Extract and inject focus hints from analysis
      let focusSection = ''
      const focusAreas = parseFocusAreas(this.analysis)
      if (focusAreas.length > 0) {
        focusSection = `\nThe analyzer suggests focusing on: ${focusAreas.join('; ')}.\nThese are suggestions — also flag anything else you notice beyond these areas.\n`
      }

      // Add structured call chain context if available
      let callChainSection = ''
      if (this.gatheredContext?.rawReferences && this.gatheredContext.rawReferences.length > 0) {
        callChainSection = '\n' + formatCallChainForReviewer(this.gatheredContext.rawReferences) + '\n'
      }

      // First round - independent, exhaustive review
      const prompt = `Task: ${this.taskPrompt}
${contextSection}${focusSection}${callChainSection}Here is the analysis:

${this.analysis}

You are [${currentReviewerId}]. Review EVERY changed file and EVERY changed function/block — do not skip any.
For each change, check: correctness, security, performance, error handling, edge cases, maintainability.
If you reviewed a file and found no issues, say so briefly. Do not stop early.${this.langSuffix}`

      return [{ role: 'user', content: prompt }]
    }

    // Round 2+: Each reviewer sees only PREVIOUS rounds (not current round's earlier reviewers)
    // This ensures everyone in the same round has the same information
    const myMessageCount = this.conversationHistory.filter(m => m.reviewerId === currentReviewerId).length

    // Get messages from previous rounds only (each reviewer's first N messages where N = myMessageCount)
    const messageCountByReviewer = new Map<string, number>()
    const previousRoundsMessages = this.conversationHistory.filter(msg => {
      if (msg.reviewerId === currentReviewerId) return false // Exclude own messages
      if (msg.reviewerId === 'user') return true // Include human interjections
      const count = messageCountByReviewer.get(msg.reviewerId) || 0
      if (count < myMessageCount) {
        messageCountByReviewer.set(msg.reviewerId, count + 1)
        return true
      }
      return false // Skip current round messages from other reviewers
    })

    if (hasSession) {
      // Session mode: send only new messages (increment from last round)
      const prevRoundCount = myMessageCount - 1
      const messageCountByReviewer2 = new Map<string, number>()
      const newMessages = previousRoundsMessages.filter(msg => {
        if (msg.reviewerId === 'user') return true
        const count = messageCountByReviewer2.get(msg.reviewerId) || 0
        messageCountByReviewer2.set(msg.reviewerId, count + 1)
        return count >= prevRoundCount // Only messages from round myMessageCount
      })

      if (newMessages.length === 0) {
        return [{ role: 'user', content: 'Please continue with your review.' }]
      }

      const newContent = newMessages
        .map(m => `[${m.reviewerId}]: ${m.content}`)
        .join('\n\n---\n\n')

      return [{
        role: 'user',
        content: `You are [${currentReviewerId}]. Here's what others said in the previous round:\n\n${newContent}\n\nDo three things:\n1. Continue your own exhaustive review — are there changed files or functions you haven't covered yet? Cover them now.\n2. Point out what the other reviewers MISSED — which files or changes did they skip or gloss over?\n3. Respond to their points — agree where valid, challenge where you disagree.${this.langSuffix}`
      }]
    }

    // Non-session mode: full context with all previous rounds
    const debateContext = `You are [${currentReviewerId}] in a code review debate with [${otherReviewerIds.join('], [')}].
Your shared goal: find ALL real issues in the code — leave nothing uncovered.

IMPORTANT:
- You are [${currentReviewerId}], the other reviewer${otherReviewerIds.length > 1 ? 's are' : ' is'} [${otherReviewerIds.join('], [')}]
- Continue your own exhaustive review — cover any changed files or functions you haven't addressed yet
- Point out what others MISSED — which files or changes did they skip or gloss over?
- Challenge weak arguments - don't agree just to be polite
- Acknowledge good points and build on them
- If you disagree, explain why with evidence`

    let prompt = `Task: ${this.taskPrompt}

Here is the analysis:

${this.analysis}

${debateContext}

Previous rounds discussion:`

    const messages: Message[] = [
      { role: 'user', content: prompt }
    ]

    // Add previous rounds messages (excluding current round)
    for (const msg of previousRoundsMessages) {
      const prefix = msg.reviewerId === 'user' ? '[Human]: ' : `[${msg.reviewerId}]: `
      messages.push({
        role: 'user',
        content: prefix + msg.content
      })
    }

    // Add own previous messages as assistant
    const myMessages = this.conversationHistory.filter(m => m.reviewerId === currentReviewerId)
    for (const msg of myMessages) {
      messages.push({
        role: 'assistant',
        content: msg.content
      })
    }

    return messages
  }

  // Update what a reviewer has seen after they respond
  private markAsSeen(reviewerId: string): void {
    this.lastSeenIndex.set(reviewerId, this.conversationHistory.length - 1)
  }

  /** Expose reviewers for post-review discussion */
  getReviewers(): Reviewer[] {
    return this.reviewers
  }

  /** Expose analyzer for post-review discussion */
  getAnalyzer(): Reviewer {
    return this.analyzer
  }

  /** Expose summarizer for post-review discussion */
  getSummarizer(): Reviewer {
    return this.summarizer
  }

  /** Extract structured issues from review discussion using AI.
   *  Always uses the summarizer to produce consistent, controlled output. */
  private async extractIssues(): Promise<MergedIssue[]> {
    return this.structurizeIssues()
  }

  /** Use AI to extract structured issues from unstructured review text.
   *  Retries with feedback if the first attempt produces invalid JSON. */
  private async structurizeIssues(): Promise<MergedIssue[]> {
    // Collect last round of messages from each reviewer
    const lastMessages = new Map<string, string>()
    for (const msg of this.conversationHistory) {
      if (msg.reviewerId === 'user') continue
      lastMessages.set(msg.reviewerId, msg.content)
    }

    if (lastMessages.size === 0) return []

    const reviewText = [...lastMessages.entries()]
      .map(([id, content]) => `[${id}]:\n${content}`)
      .join('\n\n---\n\n')

    const reviewerIds = [...lastMessages.keys()].join(', ')

    // Extract changed files and valid line ranges from the diff to constrain structurizer output
    const changedFiles = extractChangedFiles(this.taskPrompt)
    const diffLineRanges = extractDiffLineRanges(this.taskPrompt)
    let changedFilesConstraint = ''
    if (changedFiles.length > 0) {
      changedFilesConstraint = `\n- IMPORTANT: Only reference files that are in the PR diff. Changed files: ${changedFiles.join(', ')}`
      if (diffLineRanges) {
        changedFilesConstraint += `\n- CRITICAL: The "line" field MUST be a number within these valid diff ranges (GitHub rejects comments on other lines). If an issue is about code outside these ranges, omit the "line" field entirely.\nValid line ranges per file:\n${diffLineRanges}`
      }
    }

    const basePrompt = `Based on these code review discussions, extract ALL concrete issues mentioned by the reviewers into a structured JSON format.

${reviewText}

Output ONLY a JSON block (no other text):
\`\`\`json
{
  "issues": [
    {
      "severity": "critical|high|medium|low|nitpick",
      "category": "correctness|security|performance|concurrency|resource-leak|error-handling|build|testing|documentation|architecture|compatibility|style",
      "file": "path/to/file",
      "line": 42,
      "title": "One-line summary",
      "description": "Concise explanation for GitHub PR comment (see rules below)",
      "suggestedFix": "Brief one-line fix summary",
      "raisedBy": ["reviewer-id-1", "reviewer-id-2"]
    }
  ]
}
\`\`\`

Rules:
- Include every issue mentioned by any reviewer
- The "description" field will be posted directly as a GitHub PR inline comment. Keep it concise: (1) What the problem is, (2) Concrete impact or risk, (3) Fix suggestion if non-obvious. Reference line numbers instead of quoting large code blocks.
- "category" MUST be one of the 12 values listed above. Choose the closest match, do not invent new categories.
- If multiple reviewers mention the same issue, list all their IDs in raisedBy
- Use the exact reviewer IDs: ${reviewerIds}
- If a file path or line number is mentioned, include it; otherwise omit the field
- Severity (STRICT — when in doubt, choose LOWER):
  critical = compilation failure, data corruption, exploitable security hole, guaranteed crash
  high = logic error that WILL trigger, resource leak, real concurrency bug
  medium = edge case, missing error handling, compatibility risk
  low = code quality, minor concern
  nitpick = style only${changedFilesConstraint}${this.options.language ? `\n- Write the "title", "description", and "suggestedFix" fields in ${this.options.language}. Keep JSON keys and severity/category values in English.` : ''}`

    const systemPrompt = 'You extract structured issues from code review text. Output only valid JSON.'
    const chatOpts = { disableTools: true }
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.options.onWaiting?.('structurizer')

        let prompt: string
        if (attempt === 1) {
          prompt = basePrompt
        } else {
          // Retry: tell the AI its previous output was not valid JSON
          prompt = `Your previous response was not valid JSON. Output ONLY a fenced JSON block with the issues array. No other text.

Here are the review discussions again:

${reviewText}

Required JSON format:
\`\`\`json
{"issues": [{"severity": "critical|high|medium|low|nitpick", "category": "string", "file": "path", "title": "summary", "description": "details", "raisedBy": ["${reviewerIds.split(', ')[0]}"]}]}
\`\`\`
Use reviewer IDs: ${reviewerIds}`
        }

        const messages: Message[] = [{ role: 'user', content: prompt }]
        const response = await this.summarizer.provider.chat(messages, systemPrompt, chatOpts)
        this.trackTokens('summarizer', prompt, response)

        const parsed = parseReviewerOutput(response)
        if (parsed && parsed.issues.length > 0) {
          return parsed.issues.map(issue => ({
            ...issue,
            raisedBy: issue.raisedBy || ['summarizer'],
            descriptions: [issue.description]
          }))
        }
        // Parse failed — will retry if attempts remain
      } catch {
        // Call failed — will retry if attempts remain
      }
    }

    return []
  }

  private async getFinalConclusion(): Promise<string> {
    // Build conversation text from all debate rounds
    const conversationText = this.conversationHistory
      .map(msg => `[${msg.reviewerId}]:\n${msg.content}`)
      .join('\n\n---\n\n')

    const prompt = `There are ${this.reviewers.length} reviewers in this debate. Based on their full discussion below, provide a final conclusion including:
- Points of consensus
- Points of disagreement with analysis
- Recommended action items

${conversationText}${this.langSuffix}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(messages, this.withLang(this.summarizer.systemPrompt))
    this.trackTokens('summarizer', prompt + (this.summarizer.systemPrompt || ''), response)
    return response
  }

  /**
   * Verify the final conclusion by cross-checking it against the actual PR diff/code.
   * The summarizer re-examines the conclusion's correctness and reasonableness,
   * then produces a verified final conclusion.
   */
  private async verifyConclusion(finalConclusion: string): Promise<string> {
    const prompt = `You are given a final review conclusion and the original PR/code changes. Your job is to VERIFY the conclusion by cross-checking it against the actual code.

## Final Conclusion to Verify

${finalConclusion}

## Original PR/Code Changes

${this.taskPrompt}

## Analysis

${this.analysis}

## Verification Task

Carefully re-read the actual code changes above and verify the conclusion:

1. **Correctness Check**: Are the issues mentioned in the conclusion actually present in the code? Are there any false positives (issues claimed but not real)?
2. **Completeness Check**: Did the conclusion miss any important issues that are visible in the code?
3. **Reasonableness Check**: Are the severity ratings appropriate? Are the recommended actions practical?
4. **Evidence Check**: For each key claim in the conclusion, can you find supporting evidence in the actual diff?

Then provide your **Verified Final Conclusion** that:
- Confirms findings that are supported by the code
- Corrects any inaccurate claims
- Adds any missed issues you found
- Adjusts severity or recommendations if needed
- Gives a final, authoritative assessment${this.langSuffix}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const systemPrompt = this.withLang('You are a meticulous code review verifier. Your job is to fact-check review conclusions against the actual code changes. Be precise and evidence-based — cite specific code when confirming or correcting claims.')
    const response = await this.summarizer.provider.chat(messages, systemPrompt)
    this.trackTokens('summarizer', prompt + (systemPrompt || ''), response)
    return response
  }

  /**
   * Verify+Audit: check each structured issue against actual code using tools.
   * Mutates the parsedIssues array in-place: adjusts severity based on verification.
   * This replaces the downstream audit step that was previously in li-bot.
   */
  private async verifyIssues(issues: MergedIssue[]): Promise<void> {
    const issuesText = issues.map((iss, i) => {
      const loc = iss.line ? `${iss.file}:${iss.line}` : iss.file
      const agreement = iss.raisedBy.length >= 2
        ? `[raised by BOTH: ${iss.raisedBy.join(', ')}]`
        : `[raised by: ${iss.raisedBy.join(', ')} only]`
      return `### Issue ${i} [${iss.severity}] ${agreement}\nLocation: ${loc}\nTitle: ${iss.title}\nDescription: ${iss.description}`
    }).join('\n\n')

    const prompt = `You are a strict code review auditor. You have access to the full repository via Read/Grep/Glob tools.

For EACH issue below:
1. Use Read/Grep/Glob to check the actual code and verify the claim is accurate
2. Check if the issue is truly introduced by this PR, or pre-existing
3. Check if the pattern is intentional/by-design (grep for similar patterns in the codebase)
4. Re-score the severity using these strict definitions:
   - critical: Compilation failure, data corruption, exploitable security hole, guaranteed crash
   - high: Logic error that WILL trigger under realistic conditions, resource leak, real concurrency bug
   - medium: Edge case that COULD trigger, missing error handling, compatibility risk
   - low: Code quality, minor concern, pre-existing issue
   - nitpick: Style only, or false positive (issue does not actually exist)

Agreement signal: Issues raised by BOTH reviewers have higher prior probability of being real.
Issues raised by only ONE reviewer should be scrutinized more carefully.

Output ONLY a JSON block:
\`\`\`json
{
  "verified": [
    {"index": 0, "severity": "high", "reason": "Verified: null deref confirmed at line 42"},
    {"index": 1, "severity": "nitpick", "reason": "False positive: caller already validates input at line 30"}
  ]
}
\`\`\`

All issues must appear in the "verified" array. Index corresponds to the issue number above.

Issues to verify:

${issuesText}${this.langSuffix}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const systemPrompt = this.withLang(
      'You are a strict code review auditor. Use Read/Grep/Glob tools to verify each issue against the actual code. Be precise — check the real code, do not guess.'
    )

    try {
      const response = await this.summarizer.provider.chat(messages, systemPrompt)
      this.trackTokens('verifier', prompt + (systemPrompt || ''), response)

      // Parse the verification result
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/)
      const jsonStr = jsonMatch?.[1] || response
      const match = jsonStr.match(/\{[\s\S]*"verified"\s*:\s*\[[\s\S]*?\]\s*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed.verified)) {
          // Apply verified severities back to issues
          for (const v of parsed.verified) {
            const idx = v.index
            if (idx >= 0 && idx < issues.length && typeof v.severity === 'string') {
              issues[idx].severity = v.severity as MergedIssue['severity']
            }
          }
          logger.info(`Verified ${parsed.verified.length} issues`)
        }
      }
    } catch (err) {
      // Verification failure is non-fatal — keep original severities
      logger.warn('Issue verification failed, keeping original severities:', err)
    }
  }
}
