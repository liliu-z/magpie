// tests/orchestrator/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DebateOrchestrator } from '../../src/orchestrator/orchestrator'
import type { AIProvider } from '../../src/providers/types'
import type { Reviewer } from '../../src/orchestrator/types'

const createMockProvider = (name: string, responses: string[]): AIProvider => {
  let callCount = 0
  return {
    name,
    chat: vi.fn().mockImplementation(async () => responses[callCount++] || 'default'),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield responses[callCount++] || 'default'
    })
  }
}

describe('DebateOrchestrator', () => {
  it('should run debate for specified rounds', async () => {
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: createMockProvider('a', ['Round 1 from A', 'Round 2 from A', 'Summary A']),
      systemPrompt: 'You are reviewer A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: createMockProvider('b', ['Round 1 from B', 'Round 2 from B', 'Summary B']),
      systemPrompt: 'You are reviewer B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider('s', ['Final conclusion']),
      systemPrompt: 'You are a summarizer'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: createMockProvider('analyzer', ['PR analysis result']),
      systemPrompt: 'You are an analyzer'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      analyzer,
      { maxRounds: 2, interactive: false }
    )

    const result = await orchestrator.run('123', 'Review this PR')

    expect(result.prNumber).toBe('123')
    expect(result.analysis).toBe('PR analysis result')
    expect(result.messages.length).toBe(4) // 2 reviewers * 2 rounds
    expect(result.summaries.length).toBe(2)
    expect(result.finalConclusion).toBe('Final conclusion')
  })

  it('should pass conversation history to reviewers', async () => {
    const mockChat = vi.fn().mockResolvedValue('response')
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: { name: 'a', chat: mockChat, chatStream: vi.fn() },
      systemPrompt: 'You are A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: { name: 'b', chat: vi.fn().mockResolvedValue('B response'), chatStream: vi.fn() },
      systemPrompt: 'You are B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: { name: 's', chat: vi.fn().mockResolvedValue('summary'), chatStream: vi.fn() },
      systemPrompt: 'Summarize'
    }
    const analyzer: Reviewer = {
      id: 'analyzer',
      provider: { name: 'analyzer', chat: vi.fn().mockResolvedValue('analysis'), chatStream: vi.fn() },
      systemPrompt: 'Analyze'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      analyzer,
      { maxRounds: 1, interactive: false }
    )

    await orchestrator.run('123', 'Review PR')

    // First call should have initial prompt
    expect(mockChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Review PR') })
      ]),
      'You are A'
    )
  })
})
