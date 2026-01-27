// src/planner/types.ts
import type { FileInfo } from '../repo-scanner/types.js'

export interface ReviewStep {
  name: string
  description: string
  files: FileInfo[]
  estimatedTokens: number
}

export interface ReviewPlan {
  steps: ReviewStep[]
  totalEstimatedTokens: number
  totalEstimatedCost: number
}
