// tests/reporter/markdown.test.ts
import { describe, it, expect } from 'vitest'
import { MarkdownReporter } from '../../src/reporter/markdown.js'
import type { RepoReviewResult, ReviewIssue } from '../../src/reporter/types.js'

describe('MarkdownReporter', () => {
  it('should generate report header', () => {
    const result: RepoReviewResult = {
      repoName: 'test-repo',
      timestamp: new Date('2026-01-26'),
      stats: { totalFiles: 10, totalLines: 500, languages: { typescript: 10 }, estimatedTokens: 2000, estimatedCost: 0.02 },
      architectureAnalysis: 'Good architecture',
      issues: [],
      tokenUsage: { total: 5000, cost: 0.05 }
    }

    const reporter = new MarkdownReporter()
    const report = reporter.generate(result)

    expect(report).toContain('# Repository Review Report: test-repo')
    expect(report).toContain('10 files')
    expect(report).toContain('500 lines of code')
  })

  it('should categorize issues by severity', () => {
    const result: RepoReviewResult = {
      repoName: 'test-repo',
      timestamp: new Date(),
      stats: { totalFiles: 1, totalLines: 100, languages: {}, estimatedTokens: 100, estimatedCost: 0.001 },
      architectureAnalysis: '',
      issues: [
        { id: 1, location: 'a.ts:10', description: 'SQL injection', severity: 'high', consensus: '2/2' },
        { id: 2, location: 'b.ts:20', description: 'Missing error handling', severity: 'medium', consensus: '2/2' }
      ],
      tokenUsage: { total: 1000, cost: 0.01 }
    }

    const reporter = new MarkdownReporter()
    const report = reporter.generate(result)

    expect(report).toContain('🔴 High Priority')
    expect(report).toContain('SQL injection')
    expect(report).toContain('🟡 Medium Priority')
  })
})
