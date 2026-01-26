// src/orchestrator/orchestrator.ts
import type { Message } from '../providers/types.js'
import type {
  Reviewer,
  DebateMessage,
  DebateSummary,
  DebateResult,
  OrchestratorOptions
} from './types.js'

export class DebateOrchestrator {
  private reviewers: Reviewer[]
  private summarizer: Reviewer
  private analyzer: Reviewer
  private options: OrchestratorOptions
  private conversationHistory: DebateMessage[] = []

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

  private async preAnalyze(prNumber: string): Promise<string> {
    const prompt = `Please analyze PR #${prNumber}. Use 'gh pr view ${prNumber}' and 'gh pr diff ${prNumber}' to get the PR details.`
    const messages: Message[] = [{ role: 'user', content: prompt }]
    return this.analyzer.provider.chat(messages, this.analyzer.systemPrompt)
  }

  async run(prNumber: string, initialPrompt: string): Promise<DebateResult> {
    this.conversationHistory = []

    // Run pre-analysis first
    const analysis = await this.preAnalyze(prNumber)

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

        const messages = this.buildMessages(initialPrompt, reviewer.id)
        const response = await reviewer.provider.chat(messages, reviewer.systemPrompt)

        this.conversationHistory.push({
          reviewerId: reviewer.id,
          content: response,
          timestamp: new Date()
        })

        this.options.onMessage?.(reviewer.id, response)
      }

      this.options.onRoundComplete?.(round)
    }

    // Collect summaries from each reviewer
    const summaries = await this.collectSummaries()

    // Get final conclusion from summarizer
    const finalConclusion = await this.getFinalConclusion(summaries)

    return {
      prNumber,
      analysis,
      messages: this.conversationHistory,
      summaries,
      finalConclusion
    }
  }

  async runStreaming(prNumber: string, initialPrompt: string): Promise<DebateResult> {
    this.conversationHistory = []

    // Run pre-analysis first (with streaming)
    let analysis = ''
    const analyzePrompt = `Please analyze PR #${prNumber}. Use 'gh pr view ${prNumber}' and 'gh pr diff ${prNumber}' to get the PR details.`
    const analyzeMessages: Message[] = [{ role: 'user', content: analyzePrompt }]

    // Stream the analysis
    for await (const chunk of this.analyzer.provider.chatStream(analyzeMessages, this.analyzer.systemPrompt)) {
      analysis += chunk
      this.options.onMessage?.('analyzer', chunk)
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

        const messages = this.buildMessages(initialPrompt, reviewer.id)
        let fullResponse = ''

        // Stream the response
        for await (const chunk of reviewer.provider.chatStream(messages, reviewer.systemPrompt)) {
          fullResponse += chunk
          this.options.onMessage?.(reviewer.id, chunk)
        }

        this.conversationHistory.push({
          reviewerId: reviewer.id,
          content: fullResponse,
          timestamp: new Date()
        })
      }

      this.options.onRoundComplete?.(round)
    }

    const summaries = await this.collectSummaries()
    const finalConclusion = await this.getFinalConclusion(summaries)

    return {
      prNumber,
      analysis,
      messages: this.conversationHistory,
      summaries,
      finalConclusion
    }
  }

  private buildMessages(initialPrompt: string, currentReviewerId: string): Message[] {
    const messages: Message[] = [
      { role: 'user', content: initialPrompt }
    ]

    for (const msg of this.conversationHistory) {
      const role = msg.reviewerId === currentReviewerId ? 'assistant' : 'user'
      const prefix = msg.reviewerId === 'user' ? '[User]: ' : `[Reviewer]: `
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
      const messages = this.buildMessages(summaryPrompt, reviewer.id)
      messages.push({ role: 'user', content: summaryPrompt })

      const summary = await reviewer.provider.chat(messages, reviewer.systemPrompt)
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

    const prompt = `Based on the following anonymous reviewer summaries, provide a final conclusion including:
- Points of consensus
- Points of disagreement with analysis
- Recommended action items

${summaryText}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    return this.summarizer.provider.chat(messages, this.summarizer.systemPrompt)
  }
}
