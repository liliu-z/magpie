// src/orchestrator/shard-planner.ts
//
// A single review pass over a large PR spends a fixed attention budget on an unbounded
// amount of code, and — worse — reports a confident-looking conclusion without ever
// stating what it did not read. Splitting the change into shards makes the budget scale
// with the diff, and makes "not reviewed" an expressible outcome.

export interface Shard {
  id: string
  /** Human-readable scope, e.g. "internal/querynodev2" */
  scope: string
  files: string[]
}

/** Group key = the first two path segments, which in practice tracks module boundaries. */
function moduleKey(file: string): string {
  const parts = file.split('/')
  if (parts.length <= 1) return '(root)'
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/')
}

/**
 * Split changed files into review shards.
 *
 * Files that live together get reviewed together — cross-file bugs are overwhelmingly
 * within-module, so splitting a module across shards is the expensive mistake, while an
 * over-large shard merely degrades to today's behaviour.
 */
export function planShards(files: string[], maxFilesPerShard: number): Shard[] {
  const unique = [...new Set(files)].filter(Boolean).sort()
  if (unique.length === 0) return []
  if (unique.length <= maxFilesPerShard) {
    return [{ id: 'S1', scope: 'entire change', files: unique }]
  }

  const groups = new Map<string, string[]>()
  for (const f of unique) {
    const key = moduleKey(f)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(f)
  }

  const shards: Shard[] = []
  let seq = 0
  const push = (scope: string, group: string[]) => {
    shards.push({ id: `S${++seq}`, scope, files: group })
  }

  // Keep insertion order stable: sorted module keys
  const keys = [...groups.keys()].sort()

  let pending: { scope: string[]; files: string[] } = { scope: [], files: [] }
  const flushPending = () => {
    if (pending.files.length > 0) {
      push(pending.scope.join(', '), pending.files)
      pending = { scope: [], files: [] }
    }
  }

  for (const key of keys) {
    const group = groups.get(key)!
    if (group.length >= maxFilesPerShard) {
      // Big module: flush anything accumulated, then split it into chunks of its own
      flushPending()
      for (let i = 0; i < group.length; i += maxFilesPerShard) {
        const chunk = group.slice(i, i + maxFilesPerShard)
        const part = group.length > maxFilesPerShard ? ` (part ${Math.floor(i / maxFilesPerShard) + 1})` : ''
        push(`${key}${part}`, chunk)
      }
      continue
    }
    // Small module: accumulate with neighbours until the shard is full
    if (pending.files.length + group.length > maxFilesPerShard) flushPending()
    pending.scope.push(key)
    pending.files.push(...group)
  }
  flushPending()

  return shards
}

export interface CoverageRecord {
  shardId: string
  scope: string
  files: string[]
  reviewedBy: string[]
  /** Set when a finder failed or was skipped for this shard */
  failures: string[]
}

/**
 * Tracks which shards actually got reviewed.
 *
 * Exists so a run can never report "no issues found" over code nobody looked at — the
 * silent-coverage-gap failure is indistinguishable from a clean review in the output today.
 */
export class CoverageLedger {
  private records = new Map<string, CoverageRecord>()

  constructor(shards: Shard[]) {
    for (const s of shards) {
      this.records.set(s.id, { shardId: s.id, scope: s.scope, files: s.files, reviewedBy: [], failures: [] })
    }
  }

  markReviewed(shardId: string, finderId: string): void {
    const rec = this.records.get(shardId)
    if (rec && !rec.reviewedBy.includes(finderId)) rec.reviewedBy.push(finderId)
  }

  markFailed(shardId: string, finderId: string): void {
    const rec = this.records.get(shardId)
    if (rec && !rec.failures.includes(finderId)) rec.failures.push(finderId)
  }

  all(): CoverageRecord[] {
    return [...this.records.values()]
  }

  /** Shards no finder completed. Any "clean" verdict must be qualified by these. */
  uncovered(): CoverageRecord[] {
    return this.all().filter(r => r.reviewedBy.length === 0)
  }

  /** True when every shard was seen by at least one finder. */
  isComplete(): boolean {
    return this.uncovered().length === 0
  }

  /** One-line summary for the report — coverage has to be visible, not implied. */
  summary(): string {
    const total = this.all().length
    if (total === 0) return 'no shards planned'
    const covered = total - this.uncovered().length
    const gaps = this.uncovered()
    const base = `${covered}/${total} shards reviewed`
    if (gaps.length === 0) return base
    return `${base}; NOT reviewed: ${gaps.map(g => g.scope).join(', ')}`
  }
}
