// tests/orchestrator/repo-orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { RepoOrchestrator } from '../../src/orchestrator/repo-orchestrator.js'
import type { AIProvider } from '../../src/providers/types.js'
import type { Reviewer } from '../../src/orchestrator/types.js'
import type { ReviewPlan, ReviewStep } from '../../src/planner/types.js'
import type { FeaturePlan, FeatureStep } from '../../src/planner/feature-planner.js'

const createMockProvider = (responses: string[]): AIProvider => {
  let callCount = 0
  return {
    name: 'mock',
    chat: vi.fn().mockImplementation(async () => responses[callCount++] || 'default'),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield responses[callCount++] || 'default'
    })
  }
}

describe('RepoOrchestrator', () => {
  it('should execute review steps sequentially', async () => {
    const reviewerA: Reviewer = {
      id: 'security',
      provider: createMockProvider(['Found issue 1', 'Summary A']),
      systemPrompt: 'Security expert'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Final report']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [
        { name: 'src/core', description: 'Review core', files: [], estimatedTokens: 1000 }
      ],
      totalEstimatedTokens: 1000,
      totalEstimatedCost: 0.01
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer, {
      onStepStart: vi.fn(),
      onStepComplete: vi.fn()
    })

    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(result.issues).toBeDefined()
    expect(result.architectureAnalysis).toBeDefined()
  })

  it('should parse issues from reviewer responses', async () => {
    const reviewerA: Reviewer = {
      id: 'security',
      provider: createMockProvider([
        'ISSUE: [src/api.ts:10] - [SQL injection vulnerability] - [severity: high]'
      ]),
      systemPrompt: 'Security expert'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Architecture looks good']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [
        { name: 'src/api', description: 'Review API', files: [], estimatedTokens: 500 }
      ],
      totalEstimatedTokens: 500,
      totalEstimatedCost: 0.005
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer)
    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(result.issues.length).toBe(1)
    expect(result.issues[0].location).toBe('src/api.ts:10')
    expect(result.issues[0].description).toBe('SQL injection vulnerability')
    expect(result.issues[0].severity).toBe('high')
  })

  it('should call onStepStart and onStepComplete callbacks', async () => {
    const reviewerA: Reviewer = {
      id: 'reviewer',
      provider: createMockProvider(['No issues found']),
      systemPrompt: 'Reviewer'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Summary']),
      systemPrompt: 'Summarizer'
    }

    const onStepStart = vi.fn()
    const onStepComplete = vi.fn()

    const plan: ReviewPlan = {
      steps: [
        { name: 'step1', description: 'Step 1', files: [], estimatedTokens: 100 },
        { name: 'step2', description: 'Step 2', files: [], estimatedTokens: 100 }
      ],
      totalEstimatedTokens: 200,
      totalEstimatedCost: 0.002
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer, {
      onStepStart,
      onStepComplete
    })

    await orchestrator.executePlan(plan, 'test-repo')

    expect(onStepStart).toHaveBeenCalledTimes(2)
    expect(onStepComplete).toHaveBeenCalledTimes(2)
    expect(onStepStart).toHaveBeenCalledWith(plan.steps[0], 0, 2)
    expect(onStepStart).toHaveBeenCalledWith(plan.steps[1], 1, 2)
  })

  it('should debate high-severity issues', async () => {
    const reviewerA: Reviewer = {
      id: 'security',
      provider: createMockProvider([
        'ISSUE: [src/auth.ts:5] - [Hardcoded credentials] - [severity: high]',
        'This is definitely a critical issue'
      ]),
      systemPrompt: 'Security expert'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Architecture analysis']),
      systemPrompt: 'Summarizer'
    }

    const onDebate = vi.fn()

    const plan: ReviewPlan = {
      steps: [
        { name: 'src/auth', description: 'Review auth', files: [], estimatedTokens: 300 }
      ],
      totalEstimatedTokens: 300,
      totalEstimatedCost: 0.003
    }

    const orchestrator = new RepoOrchestrator([reviewerA], summarizer, { onDebate })
    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(onDebate).toHaveBeenCalled()
    expect(result.issues[0].debateSummary).toBeDefined()
  })

  it('should return correct token usage from plan', async () => {
    const reviewer: Reviewer = {
      id: 'reviewer',
      provider: createMockProvider(['No issues']),
      systemPrompt: 'Reviewer'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider(['Summary']),
      systemPrompt: 'Summarizer'
    }

    const plan: ReviewPlan = {
      steps: [{ name: 'step1', description: 'Step 1', files: [], estimatedTokens: 1500 }],
      totalEstimatedTokens: 1500,
      totalEstimatedCost: 0.015
    }

    const orchestrator = new RepoOrchestrator([reviewer], summarizer)
    const result = await orchestrator.executePlan(plan, 'test-repo')

    expect(result.tokenUsage.total).toBe(1500)
    expect(result.tokenUsage.cost).toBe(0.015)
  })
})

describe('RepoOrchestrator - Feature Based', () => {
  const mockProvider = {
    chat: vi.fn().mockResolvedValue('ISSUE: [test.ts:10] - [test issue] - [severity: medium]')
  }

  const mockReviewer = {
    id: 'reviewer1',
    provider: mockProvider,
    systemPrompt: 'Review code'
  }

  const mockSummarizer = {
    id: 'summarizer',
    provider: mockProvider,
    systemPrompt: 'Summarize'
  }

  it('should execute feature plan and track results', async () => {
    const featurePlan: FeaturePlan = {
      steps: [
        {
          featureId: 'write',
          name: 'Write Operations',
          description: 'Insert and update',
          files: [{ path: '/a.ts', relativePath: 'a.ts', language: 'ts', lines: 100, size: 1000 }],
          estimatedTokens: 250
        }
      ],
      totalEstimatedTokens: 250,
      totalEstimatedCost: 0.0025
    }

    const orchestrator = new RepoOrchestrator([mockReviewer], mockSummarizer, {})
    const result = await orchestrator.executeFeaturePlan(featurePlan, 'test-repo')

    expect(result.featureResults).toBeDefined()
    expect(result.featureResults['write']).toBeDefined()
    expect(result.featureResults['write'].issues.length).toBeGreaterThanOrEqual(0)
  })

  it('should call onFeatureComplete callback', async () => {
    const onFeatureComplete = vi.fn()

    const featurePlan: FeaturePlan = {
      steps: [
        { featureId: 'write', name: 'Write', description: '', files: [], estimatedTokens: 100 }
      ],
      totalEstimatedTokens: 100,
      totalEstimatedCost: 0.001
    }

    const orchestrator = new RepoOrchestrator([mockReviewer], mockSummarizer, {
      onFeatureComplete
    })

    await orchestrator.executeFeaturePlan(featurePlan, 'test-repo')

    expect(onFeatureComplete).toHaveBeenCalledWith('write', expect.any(Object))
  })
})
