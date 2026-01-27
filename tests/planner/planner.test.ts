// tests/planner/planner.test.ts
import { describe, it, expect } from 'vitest'
import { ReviewPlanner } from '../../src/planner/planner.js'
import type { FileInfo } from '../../src/repo-scanner/types.js'

describe('ReviewPlanner', () => {
  it('should group files by directory', () => {
    const files: FileInfo[] = [
      { path: '/p/src/core/a.ts', relativePath: 'src/core/a.ts', language: 'typescript', lines: 100, size: 1024 },
      { path: '/p/src/core/b.ts', relativePath: 'src/core/b.ts', language: 'typescript', lines: 50, size: 512 },
      { path: '/p/src/utils/c.ts', relativePath: 'src/utils/c.ts', language: 'typescript', lines: 30, size: 256 }
    ]

    const planner = new ReviewPlanner(files)
    const plan = planner.createPlan()

    expect(plan.steps.length).toBeGreaterThanOrEqual(2)
    expect(plan.steps.some(s => s.name.includes('core'))).toBe(true)
  })

  it('should estimate tokens per step', () => {
    const files: FileInfo[] = [
      { path: '/p/src/a.ts', relativePath: 'src/a.ts', language: 'typescript', lines: 100, size: 4000 }
    ]

    const planner = new ReviewPlanner(files)
    const plan = planner.createPlan()

    expect(plan.steps[0].estimatedTokens).toBe(1000) // 4000 / 4
  })

  it('should calculate total estimated tokens', () => {
    const files: FileInfo[] = [
      { path: '/p/a.ts', relativePath: 'a.ts', language: 'typescript', lines: 100, size: 4000 },
      { path: '/p/b.ts', relativePath: 'b.ts', language: 'typescript', lines: 100, size: 4000 }
    ]

    const planner = new ReviewPlanner(files)
    const plan = planner.createPlan()

    expect(plan.totalEstimatedTokens).toBe(2000)
  })
})
