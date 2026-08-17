// tests/orchestrator/shard-planner.test.ts
import { describe, it, expect } from 'vitest'
import { planShards, CoverageLedger } from '../../src/orchestrator/shard-planner.js'

describe('planShards', () => {
  it('returns nothing for no files', () => {
    expect(planShards([], 5)).toEqual([])
  })

  it('keeps a small change as one shard', () => {
    const shards = planShards(['a/b/x.go', 'a/b/y.go'], 5)
    expect(shards).toHaveLength(1)
    expect(shards[0].files).toEqual(['a/b/x.go', 'a/b/y.go'])
  })

  it('splits once the change exceeds the budget', () => {
    const files = Array.from({ length: 12 }, (_, i) => `mod${i % 4}/sub/f${i}.go`)
    const shards = planShards(files, 5)
    expect(shards.length).toBeGreaterThan(1)
    expect(shards.every(s => s.files.length <= 5)).toBe(true)
  })

  it('covers every file exactly once', () => {
    const files = Array.from({ length: 23 }, (_, i) => `mod${i % 5}/sub/f${i}.go`)
    const shards = planShards(files, 4)
    const flat = shards.flatMap(s => s.files)
    expect(flat.slice().sort()).toEqual(files.slice().sort())
    expect(new Set(flat).size).toBe(files.length)
  })

  // Cross-file bugs are mostly within a module, so splitting one across shards is the
  // costly mistake
  it('keeps a module together when it fits', () => {
    const files = [
      'internal/query/a.go', 'internal/query/b.go', 'internal/query/c.go',
      'internal/store/x.go', 'internal/store/y.go',
      'pkg/util/z.go',
    ]
    const shards = planShards(files, 3)
    const queryShard = shards.find(s => s.files.includes('internal/query/a.go'))!
    expect(queryShard.files).toEqual(['internal/query/a.go', 'internal/query/b.go', 'internal/query/c.go'])
  })

  it('splits an oversized module into numbered parts', () => {
    const files = Array.from({ length: 7 }, (_, i) => `internal/query/f${i}.go`)
    const shards = planShards(files, 3)
    expect(shards.length).toBe(3)
    expect(shards[0].scope).toContain('part 1')
    expect(shards.every(s => s.files.length <= 3)).toBe(true)
  })

  it('packs several small modules into one shard', () => {
    const files = ['a/one/f.go', 'b/two/f.go', 'c/three/f.go', 'd/four/f.go', 'e/five/f.go', 'f/six/f.go']
    const shards = planShards(files, 4)
    expect(shards.length).toBe(2)
    expect(shards[0].scope.split(',').length).toBeGreaterThan(1)
  })

  it('gives every shard a unique id', () => {
    const files = Array.from({ length: 30 }, (_, i) => `mod${i % 7}/sub/f${i}.go`)
    const shards = planShards(files, 3)
    expect(new Set(shards.map(s => s.id)).size).toBe(shards.length)
  })

  it('handles root-level files', () => {
    const shards = planShards(['README.md', 'go.mod', 'a/b/c.go', 'a/b/d.go'], 2)
    expect(shards.flatMap(s => s.files)).toHaveLength(4)
  })
})

describe('CoverageLedger', () => {
  const shards = planShards(
    ['internal/query/a.go', 'internal/query/b.go', 'internal/store/x.go', 'pkg/util/z.go'],
    2,
  )

  it('starts with nothing covered', () => {
    const cov = new CoverageLedger(shards)
    expect(cov.isComplete()).toBe(false)
    expect(cov.uncovered()).toHaveLength(shards.length)
  })

  it('is complete once every shard has a reviewer', () => {
    const cov = new CoverageLedger(shards)
    for (const s of shards) cov.markReviewed(s.id, 'finderA')
    expect(cov.isComplete()).toBe(true)
    expect(cov.summary()).toMatch(/^\d+\/\d+ shards reviewed$/)
  })

  // The whole point: a gap must be visible in the output, not implied by silence
  it('names the shards nobody reviewed', () => {
    const cov = new CoverageLedger(shards)
    cov.markReviewed(shards[0].id, 'finderA')
    expect(cov.isComplete()).toBe(false)
    expect(cov.summary()).toContain('NOT reviewed')
    expect(cov.summary()).toContain(shards[1].scope)
  })

  it('does not count a failed shard as covered', () => {
    const cov = new CoverageLedger(shards)
    cov.markFailed(shards[0].id, 'finderA')
    expect(cov.uncovered().map(r => r.shardId)).toContain(shards[0].id)
    expect(cov.all()[0].failures).toEqual(['finderA'])
  })

  it('records each finder once per shard', () => {
    const cov = new CoverageLedger(shards)
    cov.markReviewed(shards[0].id, 'finderA')
    cov.markReviewed(shards[0].id, 'finderA')
    cov.markReviewed(shards[0].id, 'finderB')
    expect(cov.all()[0].reviewedBy).toEqual(['finderA', 'finderB'])
  })

  it('ignores unknown shard ids', () => {
    const cov = new CoverageLedger(shards)
    cov.markReviewed('S999', 'finderA')
    expect(cov.uncovered()).toHaveLength(shards.length)
  })
})
