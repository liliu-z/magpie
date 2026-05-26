import { describe, it, expect } from 'vitest'
import { DebateOrchestrator } from '../../src/orchestrator/orchestrator.js'
import type { AIProvider } from '../../src/providers/types.js'
import type { Reviewer } from '../../src/orchestrator/types.js'

function makeProvider(name: string, response: string): AIProvider {
  return {
    name,
    async chat() { return response },
    async *chatStream() { yield response },
  }
}

function makeFailingProvider(name: string): AIProvider {
  return {
    name,
    async chat() { throw new Error(`${name} crashed`) },
    async *chatStream() { throw new Error(`${name} crashed`) },
  }
}

function makeReviewer(id: string, provider: AIProvider): Reviewer {
  return { id, provider, systemPrompt: 'Review the code.' }
}

describe('DebateOrchestrator resilience', () => {
  it('should complete review when one reviewer fails in streaming mode', async () => {
    const goodProvider = makeProvider('good', 'LGTM, no issues found.')
    const badProvider = makeFailingProvider('bad')

    const reviewers = [
      makeReviewer('good-reviewer', goodProvider),
      makeReviewer('bad-reviewer', badProvider),
    ]
    const summarizer = makeReviewer('summarizer', makeProvider('sum', 'Final conclusion.'))
    const analyzer = makeReviewer('analyzer', makeProvider('analyzer', 'Analysis done.'))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
    })

    const result = await orchestrator.runStreaming('test', 'Review this code')
    expect(result.finalConclusion).toBeTruthy()
    expect(result.messages.some(m => m.reviewerId === 'good-reviewer')).toBe(true)
  })

  it('should fail if ALL reviewers fail', async () => {
    const reviewers = [
      makeReviewer('bad-1', makeFailingProvider('bad1')),
      makeReviewer('bad-2', makeFailingProvider('bad2')),
    ]
    const summarizer = makeReviewer('summarizer', makeProvider('sum', 'Final conclusion.'))
    const analyzer = makeReviewer('analyzer', makeProvider('analyzer', 'Analysis done.'))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
    })

    await expect(orchestrator.runStreaming('test', 'Review this code'))
      .rejects.toThrow('All reviewers failed')
  })

  it('should abort immediately when failFast is enabled and any reviewer fails', async () => {
    const goodProvider = makeProvider('good', 'LGTM, no issues found.')
    const badProvider = makeFailingProvider('bad')

    const reviewers = [
      makeReviewer('good-reviewer', goodProvider),
      makeReviewer('bad-reviewer', badProvider),
    ]
    const summarizer = makeReviewer('summarizer', makeProvider('sum', 'Final conclusion.'))
    const analyzer = makeReviewer('analyzer', makeProvider('analyzer', 'Analysis done.'))

    const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
      maxRounds: 1,
      interactive: false,
      checkConvergence: false,
      failFast: true,
    })

    await expect(orchestrator.runStreaming('test', 'Review this code'))
      .rejects.toThrow(/bad-reviewer.*fail-fast/)
  })
})
