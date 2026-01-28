// src/orchestrator/orchestrator.ts
import type { Message } from '../providers/types.js'
import type {
  Reviewer,
  DebateMessage,
  DebateSummary,
  DebateResult,
  OrchestratorOptions,
  TokenUsage,
  ReviewerStatus
} from './types.js'

export class DebateOrchestrator {
  private reviewers: Reviewer[]
  private summarizer: Reviewer
  private analyzer: Reviewer
  private options: OrchestratorOptions
  private conversationHistory: DebateMessage[] = []
  private tokenUsage: Map<string, { input: number; output: number }> = new Map()
  private analysis: string = ''  // Store analysis to avoid repeating diff
  private taskPrompt: string = ''  // Original task prompt (contains PR number, etc.)
  private lastSeenIndex: Map<string, number> = new Map()  // Track what each reviewer has seen

  constructor(
    reviewers: Reviewer[],
    summarizer: Reviewer,
    analyzer: Reviewer,
    options: OrchestratorOptions
  ) {
    this.reviewers = reviewers
    this.summarizer = summarizer
    this.analyzer = analyzer
    this.options = options
  }

  // Estimate tokens from text (~4 chars per token)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
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

Respond with EXACTLY one word on its own line: CONVERGED or NOT_CONVERGED`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(
      messages,
      'You are a strict consensus judge. Be VERY conservative - if there is ANY doubt, respond NOT_CONVERGED. Respond with exactly one word: CONVERGED or NOT_CONVERGED. Nothing else.'
    )

    // Parse response strictly - only accept exact match
    const result = response.trim().toUpperCase()
    const firstWord = result.split(/\s+/)[0] // Take only the first word
    return firstWord === 'CONVERGED'
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

    // Run pre-analysis first and store it
    this.analysis = await this.preAnalyze(prompt)

    // Run debate rounds
    for (let round = 1; round <= this.options.maxRounds; round++) {
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

    // Collect summaries from each reviewer
    const summaries = await this.collectSummaries()

    // Get final conclusion from summarizer
    const finalConclusion = await this.getFinalConclusion(summaries)

    return {
      prNumber: label,
      analysis: this.analysis,
      messages: this.conversationHistory,
      summaries,
      finalConclusion,
      tokenUsage: this.getTokenUsage(),
      convergedAtRound
    }
  }

  async runStreaming(label: string, prompt: string): Promise<DebateResult> {
    this.conversationHistory = []
    this.tokenUsage.clear()
    this.lastSeenIndex.clear()
    this.analysis = ''
    this.taskPrompt = prompt
    let convergedAtRound: number | undefined

    // Start sessions for reviewers that support it
    for (const reviewer of this.reviewers) {
      reviewer.provider.startSession?.()
    }
    this.analyzer.provider.startSession?.()
    this.summarizer.provider.startSession?.()

    try {
      // Run pre-analysis first (with streaming)
      const analyzeMessages: Message[] = [{ role: 'user', content: prompt }]

      // Stream the analysis
      this.options.onWaiting?.('analyzer')
      for await (const chunk of this.analyzer.provider.chatStream(analyzeMessages, this.analyzer.systemPrompt)) {
        this.analysis += chunk
        this.options.onMessage?.('analyzer', chunk)
      }
      this.trackTokens('analyzer', prompt + (this.analyzer.systemPrompt || ''), this.analysis)

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

      this.options.onWaiting?.('summarizer')
      const summaries = await this.collectSummaries()
      const finalConclusion = await this.getFinalConclusion(summaries)

      return {
        prNumber: label,
        analysis: this.analysis,
        messages: this.conversationHistory,
        summaries,
        finalConclusion,
        tokenUsage: this.getTokenUsage(),
        convergedAtRound
      }
    } finally {
      // End sessions
      for (const reviewer of this.reviewers) {
        reviewer.provider.endSession?.()
      }
      this.analyzer.provider.endSession?.()
      this.summarizer.provider.endSession?.()
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
      // First round - independent review, no other reviewers' opinions
      const prompt = `Task: ${this.taskPrompt}

Here is the analysis:

${this.analysis}

You are [${currentReviewerId}]. Please review and provide your independent assessment.
Focus on finding real issues - be thorough and critical.`

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
        content: `You are [${currentReviewerId}]. Here's what others said in the previous round:\n\n${newContent}\n\nRespond to their points - agree where valid, challenge where you disagree.`
      }]
    }

    // Non-session mode: full context with all previous rounds
    const debateContext = `You are [${currentReviewerId}] in a code review debate with [${otherReviewerIds.join('], [')}].
Your shared goal: find real issues in the code and reach the best conclusion.

IMPORTANT:
- You are [${currentReviewerId}], the other reviewer${otherReviewerIds.length > 1 ? 's are' : ' is'} [${otherReviewerIds.join('], [')}]
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

  private async collectSummaries(): Promise<DebateSummary[]> {
    const summaries: DebateSummary[] = []
    const summaryPrompt = 'Please summarize your key points and conclusions. Do not reveal your identity or role.'

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

${summaryText}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(messages, this.summarizer.systemPrompt)
    this.trackTokens('summarizer', prompt + (this.summarizer.systemPrompt || ''), response)
    return response
  }
}
