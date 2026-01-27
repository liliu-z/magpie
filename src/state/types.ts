// src/state/types.ts
import type { ReviewFocus } from '../orchestrator/repo-orchestrator.js'
import type { ReviewIssue } from '../reporter/types.js'

export type SessionStatus = 'planning' | 'in_progress' | 'completed' | 'paused'

export interface Feature {
  id: string
  name: string
  description: string
  entryPoints: string[]
  files: Array<{ path: string; relativePath: string; language: string; lines: number; size: number }>
  estimatedTokens: number
}

export interface FeatureAnalysis {
  features: Feature[]
  uncategorized: Array<{ path: string; relativePath: string; language: string; lines: number; size: number }>
  analyzedAt: Date
  codebaseHash: string
}

export interface FeatureReviewResult {
  featureId: string
  issues: ReviewIssue[]
  summary: string
  reviewedAt: Date
}

export interface ReviewSession {
  id: string
  startedAt: Date
  updatedAt: Date
  status: SessionStatus

  config: {
    focusAreas: ReviewFocus[]
    selectedFeatures: string[]
  }

  plan: {
    features: Feature[]
    totalFeatures: number
    selectedCount: number
  }

  progress: {
    currentFeatureIndex: number
    completedFeatures: string[]
    featureResults: Record<string, FeatureReviewResult>
  }
}
