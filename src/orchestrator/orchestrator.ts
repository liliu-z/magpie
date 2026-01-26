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
      .join('\n\n')

    const prompt = `There are exactly ${this.reviewers.length} reviewers in this debate. Analyze their comments below and determine if they have reached consensus.
Reply with ONLY "CONVERGED" if they mostly agree on key points, or "NOT_CONVERGED" if there are still significant disagreements.

${messagesText}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(messages, 'You are a neutral judge evaluating debate convergence. Reply only with CONVERGED or NOT_CONVERGED.')

    return response.trim().toUpperCase().includes('CONVERGED')
  }

  private async preAnalyze(label: string, diff?: string): Promise<string> {
    let prompt: string
    if (diff) {
      prompt = `Please analyze the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nProvide a summary of what these changes do.`
    } else {
      prompt = `Please analyze PR #${label}. Get the PR details and diff using any method available to you.`
    }
    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.analyzer.provider.chat(messages, this.analyzer.systemPrompt)
    this.trackTokens('analyzer', prompt + (this.analyzer.systemPrompt || ''), response)
    return response
  }

  async run(label: string, initialPrompt: string, diff?: string): Promise<DebateResult> {
    this.conversationHistory = []
    this.tokenUsage.clear()
    let convergedAtRound: number | undefined

    // Run pre-analysis first and store it
    this.analysis = await this.preAnalyze(label, diff)

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

  async runStreaming(label: string, initialPrompt: string, diff?: string): Promise<DebateResult> {
    this.conversationHistory = []
    this.tokenUsage.clear()
    this.analysis = ''
    let convergedAtRound: number | undefined

    // Run pre-analysis first (with streaming)
    let analyzePrompt: string
    if (diff) {
      analyzePrompt = `Please analyze the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nProvide a summary of what these changes do.`
    } else {
      analyzePrompt = `Please analyze PR #${label}. Get the PR details and diff using any method available to you.`
    }
    const analyzeMessages: Message[] = [{ role: 'user', content: analyzePrompt }]

    // Stream the analysis
    this.options.onWaiting?.('analyzer')
    for await (const chunk of this.analyzer.provider.chatStream(analyzeMessages, this.analyzer.systemPrompt)) {
      this.analysis += chunk
      this.options.onMessage?.('analyzer', chunk)
    }
    this.trackTokens('analyzer', analyzePrompt + (this.analyzer.systemPrompt || ''), this.analysis)

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
  }

  private buildMessages(currentReviewerId: string): Message[] {
    const hasHistory = this.conversationHistory.length > 0
    const otherReviewerCount = this.reviewers.length - 1

    // First message: the analysis (not the raw diff)
    let prompt = `Here is the analysis of the code changes:\n\n${this.analysis}\n\nPlease review these changes and provide your feedback.`

    if (hasHistory) {
      prompt += `

You are in a code review debate with ${otherReviewerCount} other AI reviewer${otherReviewerCount > 1 ? 's' : ''} (not humans).
There are ${this.reviewers.length} AI reviewers total in this debate.

IMPORTANT:
- The messages marked [AI Reviewer] are from OTHER AI models reviewing the same code
- Do NOT be sycophantic or automatically agree - they are AI peers, not users to please
- Be intellectually honest: agree only if you genuinely agree, challenge if you see flaws
- Point out if they missed something or got something wrong
- Add new insights they haven't covered
- If you agree on everything, say so briefly and add value in other ways`
    }

    const messages: Message[] = [
      { role: 'user', content: prompt }
    ]

    for (const msg of this.conversationHistory) {
      const role = msg.reviewerId === currentReviewerId ? 'assistant' : 'user'
      const prefix = msg.reviewerId === 'user' ? '[Human]: ' : `[AI Reviewer]: `
      messages.push({
        role,
        content: role === 'user' ? prefix + msg.content : msg.content
      })
    }

    return messages
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
