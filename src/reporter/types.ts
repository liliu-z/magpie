// src/reporter/types.ts
import type { RepoStats } from '../repo-scanner/types.js'

export interface ReviewIssue {
  id: number
  location: string
  description: string
  severity: 'high' | 'medium' | 'low'
  consensus: string
  details?: string
  debateSummary?: string
  suggestedFix?: string
}

export interface RepoReviewResult {
  repoName: string
  timestamp: Date
  stats: RepoStats
  architectureAnalysis: string
  architectureStrengths?: string[]
  architectureImprovements?: string[]
  issues: ReviewIssue[]
  tokenUsage: {
    total: number
    cost: number
    breakdown?: Record<string, number>
  }
}
