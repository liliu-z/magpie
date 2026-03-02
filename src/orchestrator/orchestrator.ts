// src/orchestrator/orchestrator.ts
import type { Message } from '../providers/types.js'
import type {
  Reviewer,
  DebateMessage,
  DebateSummary,
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
    return `\n\nIMPORTANT: You MUST respond in ${this.options.language}.`
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

    // Round 1 is always independent reviews - reviewers haven't seen each other's opinions yet
    // True convergence requires at least one round of cross-examination
    if (roundsCompleted < 2) {
      return false // Need at least 2 rounds for meaningful convergence
    }

    // Get last round's messages
    const lastRoundMessages = this.conversationHistory.slice(-this.reviewers.length)
    const messagesText = lastRoundMessages
      .map(m => `[${m.reviewerId}]: ${m.content}`)
      .join('\n\n---\n\n')

    const prompt = `You are a strict consensus judge. Analyze whether these ${this.reviewers.length} reviewers have reached TRUE CONSENSUS.

IMPORTANT: This is Round ${roundsCompleted}. Reviewers have now seen each other's opinions.

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
    const response = await this.analyzer.provider.chat(messages, this.analyzer.systemPrompt)
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
          const response = await reviewer.provider.chat(messages, reviewer.systemPrompt)

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
      // Collect summaries from each reviewer
      const summaries = await this.collectSummaries()

      // Get final conclusion from summarizer
      const finalConclusion = await this.getFinalConclusion(summaries)

      // End summarizer session for clean JSON extraction call
      this.summarizer.provider.endSession?.()
      const parsedIssues = await this.extractIssues()

      return {
        prNumber: label,
        analysis: this.analysis,
        messages: this.conversationHistory,
        summaries,
        finalConclusion,
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
              logger.warn('Context gathering failed:', error)
            }
          })()
        : Promise.resolve()

      const analysisPromise = (async () => {
        const analyzeMessages: Message[] = [{ role: 'user', content: prompt }]
        this.options.onWaiting?.('analyzer')
        for await (const chunk of this.analyzer.provider.chatStream(analyzeMessages, this.analyzer.systemPrompt)) {
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
          for await (const chunk of targetReviewer.provider.chatStream(qaMessages, targetReviewer.systemPrompt)) {
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
            // Mark as thinking
            statuses[index] = {
              reviewerId: reviewer.id,
              status: 'thinking',
              startTime: Date.now()
            }
            this.options.onParallelStatus?.(round, statuses)

            let fullResponse = ''
            for await (const chunk of reviewer.provider.chatStream(messages, reviewer.systemPrompt)) {
              fullResponse += chunk
            }

            // Mark as done
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
            return { reviewer, fullResponse, inputText }
          })
        )

        // Display results and add to history (after all complete)
        for (const { reviewer, fullResponse, inputText } of results) {
          this.trackTokens(reviewer.id, inputText, fullResponse)
          this.conversationHistory.push({
            reviewerId: reviewer.id,
            content: fullResponse,
            timestamp: new Date()
          })
          this.markAsSeen(reviewer.id)
          // Display each reviewer's response
          this.options.onMessage?.(reviewer.id, fullResponse)
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
      this.options.onWaiting?.('summarizer')
      const summaries = await this.collectSummaries()
      const finalConclusion = await this.getFinalConclusion(summaries)

      // End summarizer session before structurization so it gets a clean,
      // non-session call. The session context (convergence + conclusion) would
      // pollute the JSON extraction and --resume ignores custom system prompts.
      this.summarizer.provider.endSession?.()
      const parsedIssues = await this.extractIssues()

      return {
        prNumber: label,
        analysis: this.analysis,
        context: this.gatheredContext || undefined,
        messages: this.conversationHistory,
        summaries,
        finalConclusion,
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

    const basePrompt = `Based on these code review discussions, extract ALL concrete issues mentioned by the reviewers into a structured JSON format.

${reviewText}

Output ONLY a JSON block (no other text):
\`\`\`json
{
  "issues": [
    {
      "severity": "critical|high|medium|low|nitpick",
      "category": "security|performance|error-handling|style|correctness|architecture",
      "file": "path/to/file",
      "line": 42,
      "title": "One-line summary",
      "description": "Detailed markdown explanation (see rules below)",
      "suggestedFix": "Brief one-line fix summary",
      "raisedBy": ["reviewer-id-1", "reviewer-id-2"]
    }
  ]
}
\`\`\`

Rules:
- Include every issue mentioned by any reviewer
- The "description" field will be posted as a GitHub PR comment. Make it comprehensive markdown covering: (1) What the problem is, (2) Why it matters (impact/risk), (3) The original problematic code quoted in a code block, (4) The suggested fix shown as code, (5) Why the fix is correct
- If multiple reviewers mention the same issue, list all their IDs in raisedBy
- Use the exact reviewer IDs: ${reviewerIds}
- If a file path or line number is mentioned, include it; otherwise omit the field
- Severity: critical = blocks merge, high = should fix, medium = worth fixing, low = minor, nitpick = style only${this.options.language ? `\n- Write the "title", "description", and "suggestedFix" fields in ${this.options.language}. Keep JSON keys and severity/category values in English.` : ''}`

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

  private async collectSummaries(): Promise<DebateSummary[]> {
    const summaries: DebateSummary[] = []
    const summaryPrompt = `Please summarize your key points and conclusions. Do not reveal your identity or role.${this.langSuffix}`

    for (const reviewer of this.reviewers) {
      const messages = this.buildMessages(reviewer.id)
      messages.push({ role: 'user', content: summaryPrompt })

      const summary = await reviewer.provider.chat(messages, reviewer.systemPrompt)
      const inputText = messages.map(m => m.content).join('\n') + (reviewer.systemPrompt || '')
      this.trackTokens(reviewer.id, inputText, summary)

      summaries.push({
        reviewerId: reviewer.id,
        summary
      })
    }

    return summaries
  }

  private async getFinalConclusion(summaries: DebateSummary[]): Promise<string> {
    const summaryText = summaries
      .map((s, i) => `Reviewer ${i + 1}:\n${s.summary}`)
      .join('\n\n---\n\n')

    const prompt = `There are exactly ${summaries.length} reviewers in this debate. Based on their anonymous summaries below, provide a final conclusion including:
- Points of consensus
- Points of disagreement with analysis
- Recommended action items

${summaryText}${this.langSuffix}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(messages, this.summarizer.systemPrompt)
    this.trackTokens('summarizer', prompt + (this.summarizer.systemPrompt || ''), response)
    return response
  }
}
