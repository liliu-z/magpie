// src/planner/planner.ts
import type { FileInfo } from '../repo-scanner/types.js'
import type { ReviewPlan, ReviewStep } from './types.js'

export class ReviewPlanner {
  private files: FileInfo[]

  constructor(files: FileInfo[]) {
    this.files = files
  }

  createPlan(): ReviewPlan {
    const groups = this.groupByDirectory()
    const steps: ReviewStep[] = []

    for (const [dir, files] of Object.entries(groups)) {
      const totalSize = files.reduce((sum, f) => sum + f.size, 0)
      const estimatedTokens = Math.ceil(totalSize / 4)

      steps.push({
        name: dir || 'root',
        description: `Review ${files.length} files in ${dir || 'root directory'}`,
        files,
        estimatedTokens
      })
    }

    // Sort by priority (larger directories first)
    steps.sort((a, b) => b.files.length - a.files.length)

    const totalEstimatedTokens = steps.reduce((sum, s) => sum + s.estimatedTokens, 0)

    return {
      steps,
      totalEstimatedTokens,
      totalEstimatedCost: totalEstimatedTokens * 0.00001
    }
  }

  private groupByDirectory(): Record<string, FileInfo[]> {
    const groups: Record<string, FileInfo[]> = {}

    for (const file of this.files) {
      const parts = file.relativePath.split('/')
      // Use first two levels as group key (e.g., src/core)
      const dir = parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0]

      if (!groups[dir]) {
        groups[dir] = []
      }
      groups[dir].push(file)
    }

    return groups
  }
}
