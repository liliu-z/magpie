// src/reporter/markdown.ts
import type { RepoReviewResult, ReviewIssue } from './types.js'

export class MarkdownReporter {
  generate(result: RepoReviewResult): string {
    const lines: string[] = []

    // Header
    lines.push(`# Repository Review Report: ${result.repoName}`)
    lines.push(`Generated: ${result.timestamp.toISOString().split('T')[0]}`)
    lines.push(`Scope: Full repository (${result.stats.totalFiles} files, ${result.stats.totalLines} lines of code)`)
    lines.push('')

    // Executive summary
    lines.push('## Executive Summary')
    const highCount = result.issues.filter(i => i.severity === 'high').length
    const mediumCount = result.issues.filter(i => i.severity === 'medium').length
    const lowCount = result.issues.filter(i => i.severity === 'low').length
    lines.push(`- Issues found: ${result.issues.length} (High: ${highCount}, Medium: ${mediumCount}, Low: ${lowCount})`)
    lines.push('')

    // Architecture
    lines.push('## Architecture Assessment')
    lines.push('')
    lines.push(result.architectureAnalysis)
    lines.push('')

    if (result.architectureStrengths?.length) {
      lines.push('### Strengths')
      for (const s of result.architectureStrengths) {
        lines.push(`- ${s}`)
      }
      lines.push('')
    }

    if (result.architectureImprovements?.length) {
      lines.push('### Improvement Suggestions')
      for (const i of result.architectureImprovements) {
        lines.push(`- ${i}`)
      }
      lines.push('')
    }

    // Issues
    lines.push('## Issue List')
    lines.push('')

    const highIssues = result.issues.filter(i => i.severity === 'high')
    const mediumIssues = result.issues.filter(i => i.severity === 'medium')
    const lowIssues = result.issues.filter(i => i.severity === 'low')

    if (highIssues.length > 0) {
      lines.push('### 🔴 High Priority')
      lines.push(this.formatIssueTable(highIssues))
      lines.push('')
    }

    if (mediumIssues.length > 0) {
      lines.push('### 🟡 Medium Priority')
      lines.push(this.formatIssueTable(mediumIssues))
      lines.push('')
    }

    if (lowIssues.length > 0) {
      lines.push('### 🟢 Low Priority')
      lines.push(this.formatIssueTable(lowIssues))
      lines.push('')
    }

    // Token usage
    lines.push('## Token Usage Statistics')
    lines.push(`- Total: ${result.tokenUsage.total.toLocaleString()} tokens (~$${result.tokenUsage.cost.toFixed(4)})`)

    return lines.join('\n')
  }

  private formatIssueTable(issues: ReviewIssue[]): string {
    const lines: string[] = []
    lines.push('| # | Location | Issue | Consensus |')
    lines.push('|---|----------|-------|-----------|')
    for (const issue of issues) {
      lines.push(`| ${issue.id} | ${issue.location} | ${issue.description} | ${issue.consensus} |`)
    }
    return lines.join('\n')
  }
}
