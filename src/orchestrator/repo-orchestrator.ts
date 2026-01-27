// src/orchestrator/repo-orchestrator.ts
import type { Message } from '../providers/types.js'
import type { Reviewer } from './types.js'
import type { ReviewPlan, ReviewStep } from '../planner/types.js'
import type { RepoReviewResult, ReviewIssue } from '../reporter/types.js'
import type { RepoStats } from '../repo-scanner/types.js'
import type { FeatureReviewResult } from '../state/types.js'

export type ReviewFocus = 'security' | 'performance' | 'architecture' | 'code-quality' | 'testing' | 'documentation'

export interface RepoOrchestratorOptions {
  onStepStart?: (step: ReviewStep, index: number, total: number) => void
  onStepComplete?: (step: ReviewStep, index: number) => void
  onMessage?: (reviewerId: string, chunk: string) => void
  onDebate?: (issue: string, messages: string[]) => void
  focusAreas?: ReviewFocus[]
  onFeatureComplete?: (featureId: string, result: FeatureReviewResult) => void
}

export interface FeatureRepoReviewResult extends RepoReviewResult {
  featureResults: Record<string, FeatureReviewResult>
}

export class RepoOrchestrator {
  private reviewers: Reviewer[]
  private summarizer: Reviewer
  private options: RepoOrchestratorOptions
  private allIssues: ReviewIssue[] = []
  private issueCounter = 0

  constructor(
    reviewers: Reviewer[],
    summarizer: Reviewer,
    options: RepoOrchestratorOptions = {}
  ) {
    this.reviewers = reviewers
    this.summarizer = summarizer
    this.options = options
  }

  async executePlan(plan: ReviewPlan, repoName: string, stats?: RepoStats): Promise<RepoReviewResult> {
    this.allIssues = []
    this.issueCounter = 0

    // Phase 1: Architecture analysis (first step overview)
    const architectureAnalysis = await this.analyzeArchitecture(plan)

    // Phase 2: Execute each step
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      this.options.onStepStart?.(step, i, plan.steps.length)

      await this.executeStep(step)

      this.options.onStepComplete?.(step, i)
    }

    // Phase 3: Debate on found issues
    await this.debateIssues()

    return {
      repoName,
      timestamp: new Date(),
      stats: stats || { totalFiles: 0, totalLines: 0, languages: {}, estimatedTokens: 0, estimatedCost: 0 },
      architectureAnalysis,
      issues: this.allIssues,
      tokenUsage: {
        total: plan.totalEstimatedTokens,
        cost: plan.totalEstimatedCost
      }
    }
  }

  async executeFeaturePlan(plan: { steps: Array<{ featureId: string; name: string; description: string; files: any[]; estimatedTokens: number }>; totalEstimatedTokens: number; totalEstimatedCost: number }, repoName: string, stats?: RepoStats): Promise<FeatureRepoReviewResult> {
    this.allIssues = []
    this.issueCounter = 0
    const featureResults: Record<string, FeatureReviewResult> = {}

    // Phase 1: Architecture analysis
    const architectureAnalysis = await this.analyzeArchitecture({ steps: plan.steps, totalEstimatedTokens: plan.totalEstimatedTokens, totalEstimatedCost: plan.totalEstimatedCost })

    // Phase 2: Execute each feature
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      this.options.onStepStart?.(step, i, plan.steps.length)

      const stepIssuesBefore = this.allIssues.length
      await this.executeStep(step)
      const stepIssuesAfter = this.allIssues.length

      const featureIssues = this.allIssues.slice(stepIssuesBefore, stepIssuesAfter)
      const result: FeatureReviewResult = {
        featureId: step.featureId,
        issues: featureIssues,
        summary: `Found ${featureIssues.length} issues in ${step.name}`,
        reviewedAt: new Date()
      }

      featureResults[step.featureId] = result
      this.options.onFeatureComplete?.(step.featureId, result)
      this.options.onStepComplete?.(step, i)
    }

    // Phase 3: Debate on found issues
    await this.debateIssues()

    return {
      repoName,
      timestamp: new Date(),
      stats: stats || { totalFiles: 0, totalLines: 0, languages: {}, estimatedTokens: 0, estimatedCost: 0 },
      architectureAnalysis,
      issues: this.allIssues,
      tokenUsage: {
        total: plan.totalEstimatedTokens,
        cost: plan.totalEstimatedCost
      },
      featureResults
    }
  }

  private async analyzeArchitecture(plan: ReviewPlan): Promise<string> {
    const stepNames = plan.steps.map(s => s.name).join(', ')
    const prompt = `Analyze the overall architecture of this codebase. The main modules are: ${stepNames}. Provide a brief assessment.`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await this.summarizer.provider.chat(messages, this.summarizer.systemPrompt)
    return response
  }

  private async executeStep(step: ReviewStep): Promise<void> {
    const fileList = step.files.map(f => f.relativePath).join('\n')
    const focusAreas = this.options.focusAreas || ['security', 'performance', 'code-quality']
    const focusText = this.getFocusInstructions(focusAreas)
    const prompt = `Review the following files in ${step.name}:\n${fileList}\n\n${focusText}\n\nFormat each issue as:\nISSUE: [location] - [description] - [severity: high/medium/low]`

    for (const reviewer of this.reviewers) {
      const messages: Message[] = [{ role: 'user', content: prompt }]
      const response = await reviewer.provider.chat(messages, reviewer.systemPrompt)
      this.options.onMessage?.(reviewer.id, response)

      // Parse issues from response
      this.parseIssues(response)
    }
  }

  private parseIssues(response: string): void {
    const issueRegex = /ISSUE:\s*\[([^\]]+)\]\s*-\s*\[([^\]]+)\]\s*-\s*\[severity:\s*(high|medium|low)\]/gi
    let match

    while ((match = issueRegex.exec(response)) !== null) {
      this.issueCounter++
      this.allIssues.push({
        id: this.issueCounter,
        location: match[1],
        description: match[2],
        severity: match[3] as 'high' | 'medium' | 'low',
        consensus: '1/1' // Will be updated after debate
      })
    }
  }

  private getFocusInstructions(focusAreas: ReviewFocus[]): string {
    const focusDescriptions: Record<ReviewFocus, string> = {
      'security': 'security vulnerabilities (injection, XSS, authentication, authorization, data exposure)',
      'performance': 'performance issues (N+1 queries, memory leaks, inefficient algorithms, unnecessary computation)',
      'architecture': 'architectural problems (coupling, cohesion, separation of concerns, design patterns)',
      'code-quality': 'code quality (readability, maintainability, naming, complexity, duplication)',
      'testing': 'testing gaps (missing tests, inadequate coverage, test quality)',
      'documentation': 'documentation issues (missing docs, outdated comments, unclear APIs)'
    }

    const instructions = focusAreas.map(f => focusDescriptions[f]).join(', ')
    return `Focus your review on: ${instructions}. Identify any issues in these areas.`
  }

  private async debateIssues(): Promise<void> {
    // For high-severity issues, run a debate round
    const highIssues = this.allIssues.filter(i => i.severity === 'high')

    for (const issue of highIssues) {
      const debateMessages: string[] = []
      const prompt = `Evaluate this potential issue: ${issue.description} at ${issue.location}. Is this a real problem? What's the actual severity?`

      for (const reviewer of this.reviewers) {
        const messages: Message[] = [{ role: 'user', content: prompt }]
        const response = await reviewer.provider.chat(messages, reviewer.systemPrompt)
        debateMessages.push(response)
      }

      issue.debateSummary = debateMessages.join('\n---\n')
      issue.consensus = `${this.reviewers.length}/${this.reviewers.length}`
      this.options.onDebate?.(issue.description, debateMessages)
    }
  }
}
