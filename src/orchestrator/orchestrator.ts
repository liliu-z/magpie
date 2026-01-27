// src/orchestrator/orchestrator.ts
import type { Message } from '../providers/types.js'
import type {
  Reviewer,
  DebateMessage,
  DebateSummary,
  DebateResult,
  OrchestratorOptions,
  TokenUsage
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
    if (this.conversationHistory.length < this.reviewers.length * 2) {
      return false // Need at least 2 rounds to check
    }

    // Get last round's messages
    const lastRoundMessages = this.conversationHistory.slice(-this.reviewers.length)
    const messagesText = lastRoundMessages
      .map(m => `[${m.reviewerId}]: ${m.content}`)
      .join('\n\n---\n\n')

    const prompt = `You are a strict judge. Analyze whether these ${this.reviewers.length} reviewers have reached TRUE CONSENSUS.

CONSENSUS means:
- All reviewers agree on the SAME final verdict (e.g., all say "approve" or all say "request changes")
- No reviewer explicitly rejects or disagrees with another's core position
- They may have minor differences but agree on what actions to take

NOT CONSENSUS if ANY of these:
- One reviewer says "I disagree with [X]" or "I reject [X]'s view"
- Reviewers give different verdicts (one approves, another requests changes)
- One reviewer explicitly challenges another's reasoning as flawed
- They agree on problems but disagree on severity or required actions

Reviews:
${messagesText}

Reply with ONLY one word: CONVERGED or NOT_CONVERGED`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(messages, 'You are a strict consensus judge. Be conservative - when in doubt, say NOT_CONVERGED. Reply with only one word.')

    return response.trim().toUpperCase().includes('CONVERGED')
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
        for (const reviewer of this.reviewers) {
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

          const messages = this.buildMessages(reviewer.id)
          let fullResponse = ''

          // Stream the response
          this.options.onWaiting?.(reviewer.id)
          for await (const chunk of reviewer.provider.chatStream(messages, reviewer.systemPrompt)) {
            fullResponse += chunk
            this.options.onMessage?.(reviewer.id, chunk)
          }

          const inputText = messages.map(m => m.content).join('\n') + (reviewer.systemPrompt || '')
          this.trackTokens(reviewer.id, inputText, fullResponse)

          this.conversationHistory.push({
            reviewerId: reviewer.id,
            content: fullResponse,
            timestamp: new Date()
          })
          this.markAsSeen(reviewer.id)
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

    // Round 2+: For session mode, only send new messages (that this reviewer hasn't seen)
    if (hasSession) {
      // Count how many times this reviewer has spoken
      const myMessageCount = this.conversationHistory.filter(m => m.reviewerId === currentReviewerId).length

      let newMessages: DebateMessage[]
      if (myMessageCount === 1) {
        // Just finished Round 1 (independent phase), entering debate phase
        // Need ALL other reviewers' messages (they weren't seen in Round 1)
        newMessages = this.conversationHistory.filter(m => m.reviewerId !== currentReviewerId)
      } else {
        // Already in debate phase, only send messages after last seen
        newMessages = this.conversationHistory.slice(lastSeen + 1)
          .filter(m => m.reviewerId !== currentReviewerId)
      }

      if (newMessages.length === 0) {
        return [{ role: 'user', content: 'Please continue with your review.' }]
      }

      // Use specific reviewer IDs so AI knows who said what
      const newContent = newMessages
        .map(m => `[${m.reviewerId}]: ${m.content}`)
        .join('\n\n---\n\n')

      return [{
        role: 'user',
        content: `You are [${currentReviewerId}]. [${otherReviewerIds.join('], [')}] responded:\n\n${newContent}\n\nRespond to their points - agree where valid, challenge where you disagree.`
      }]
    }

    // Round 2+ non-session mode: full context with all history
    const debateContext = `You are [${currentReviewerId}] in a code review debate with [${otherReviewerIds.join('], [')}].
Your shared goal: find real issues in the code and reach the best conclusion.

IMPORTANT:
- You are [${currentReviewerId}], the other reviewer${otherReviewerIds.length > 1 ? 's are' : ' is'} [${otherReviewerIds.join('], [')}]
- Challenge weak arguments - don't agree just to be polite
- If [${otherReviewerIds.join('] or [')}] makes a good point, acknowledge it and build on it
- If you disagree, explain why with evidence
- Add insights they might have missed`

    let prompt = `Task: ${this.taskPrompt}

Here is the analysis:

${this.analysis}

${debateContext}

Previous discussion:`

    const messages: Message[] = [
      { role: 'user', content: prompt }
    ]

    for (const msg of this.conversationHistory) {
      const role = msg.reviewerId === currentReviewerId ? 'assistant' : 'user'
      // Use specific reviewer ID as prefix
      const prefix = msg.reviewerId === 'user' ? '[Human]: ' : `[${msg.reviewerId}]: `
      messages.push({
        role,
        content: role === 'user' ? prefix + msg.content : msg.content
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
