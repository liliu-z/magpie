// tests/orchestrator/ledger-orchestrator.test.ts
import { describe, it, expect } from 'vitest'
import { LedgerOrchestrator, toMergedIssues } from '../../src/orchestrator/ledger-orchestrator.js'
import type { AIProvider, Message } from '../../src/providers/types.js'
import type { Reviewer } from '../../src/orchestrator/types.js'

/** Provider that answers from a script and records every prompt it was given. */
class ScriptedProvider implements AIProvider {
  prompts: string[] = []
  constructor(public name: string, private reply: (prompt: string, callIndex: number) => string) {}

  async chat(messages: Message[]): Promise<string> {
    const prompt = messages.map(m => m.content).join('\n')
    const idx = this.prompts.length
    this.prompts.push(prompt)
    return this.reply(prompt, idx)
  }

  async *chatStream(): AsyncGenerator<string, void, unknown> {
    yield ''
  }
}

function reviewer(id: string, reply: (prompt: string, i: number) => string): Reviewer {
  return { id, provider: new ScriptedProvider(id, reply), systemPrompt: `system for ${id}` }
}

const findingJson = (over: Record<string, unknown> = {}) => ({
  file: 'internal/query/a.go',
  line: 100,
  category: 'correctness',
  title: 'error swallowed on load failure',
  description: 'The error return is discarded.',
  evidence: 'internal/query/a.go:100 — `return nil`',
  introducedByThisChange: 'yes',
  reachableUnderDefaults: 'yes',
  deliberate: 'no',
  boundedImpact: 'Caller sees success on a failed load.',
  correctnessConfidence: 'high',
  impactSeverity: 'high',
  actionability: 'high',
  ...over,
})

const findings = (...f: Record<string, unknown>[]) =>
  '```json\n' + JSON.stringify({ findings: f, coverage: { filesReviewed: ['internal/query/a.go'], notReviewed: [] } }) + '\n```'

/** Findings plus an explicit coverage claim, for tests about who is allowed to rule on what */
const covered = (filesReviewed: string[], ...f: Record<string, unknown>[]) =>
  '```json\n' + JSON.stringify({ findings: f, coverage: { filesReviewed, notReviewed: [] } }) + '\n```'

const adjudications = (...a: Record<string, unknown>[]) =>
  '```json\n' + JSON.stringify({ adjudications: a }) + '\n```'

/** The verifier has its own vocabulary — keep/rewrite/drop — and no way to express "add" */
const verdicts = (...v: Record<string, unknown>[]) =>
  '```json\n' + JSON.stringify({ verdicts: v }) + '\n```'

const DIFF = [
  'diff --git a/internal/query/a.go b/internal/query/a.go',
  '@@ -1,2 +95,20 @@',
  ' ctx',
  'diff --git a/internal/store/b.go b/internal/store/b.go',
  '@@ -1,2 +10,5 @@',
  ' ctx',
].join('\n')

/** Classify a prompt by which stage produced it. */
const isFinderPrompt = (p: string) => p.includes('Review ') && p.includes('"findings"') && !p.includes('already reported')
const isAdjudicationPrompt = (p: string) => p.includes('"adjudications"')

describe('LedgerOrchestrator', () => {
  it('runs round 1 without showing finders each other’s work', async () => {
    const a = reviewer('finderA', () => findings(findingJson()))
    const b = reviewer('finderB', () => findings(findingJson({ file: 'internal/store/b.go', line: 12, title: 'missing retry on upload' })))
    const verifier = reviewer('verifier', () => verdicts(
      { id: 'F1', verdict: 'keep', evidence: 'checked' },
      { id: 'F2', verdict: 'keep', evidence: 'checked' },
    ))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    await orch.run('PR #1', 'title', DIFF)

    const aProvider = a.provider as ScriptedProvider
    const round1Prompt = aProvider.prompts[0]
    // finderA's first prompt must not contain finderB's finding, nor any reviewer identity
    expect(round1Prompt).not.toContain('missing retry on upload')
    expect(round1Prompt).not.toContain('finderB')
  })

  it('promotes to confirmed when both finders independently report the same thing', async () => {
    const same = findings(findingJson())
    const a = reviewer('finderA', () => same)
    const b = reviewer('finderB', () => same)
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].state).toBe('confirmed')
    expect(result.entries[0].raisedBy.sort()).toEqual(['finderA', 'finderB'])
  })

  it('marks an entry challenged when the other finder refutes it', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const b = reviewer('finderB', p => {
      if (isFinderPrompt(p)) return findings()
      return adjudications({ id: 'F1', stance: 'refute', evidence: 'caller checks err at a.go:80' })
    })
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    // Round 3 is not run at maxRounds: 2, so it finalizes as disputed
    expect(result.entries[0].state).toBe('disputed')
    expect(result.inline).toHaveLength(0)
    expect(result.summary).toHaveLength(1)
  })

  it('does not treat an evidence-free agreement as verification', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const b = reviewer('finderB', p => {
      if (isFinderPrompt(p)) return findings()
      return adjudications({ id: 'F1', stance: 'confirm' })    // no evidence
    })
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries[0].state).toBe('raised')       // still single-sourced
    expect(result.entries[0].raisedBy).toEqual(['finderA'])
  })

  it('runs a conflict round only for contested entries', async () => {
    let bAdjudicationCalls = 0
    const a = reviewer('finderA', p => isFinderPrompt(p)
      ? findings(findingJson(), findingJson({ file: 'internal/store/b.go', line: 12, title: 'missing retry on upload' }))
      : adjudications())
    const b = reviewer('finderB', p => {
      if (isFinderPrompt(p)) return findings()
      bAdjudicationCalls++
      if (bAdjudicationCalls === 1) {
        return adjudications(
          { id: 'F1', stance: 'refute', evidence: 'caller checks err' },
          { id: 'F2', stance: 'confirm', evidence: 'confirmed at b.go:12' },
        )
      }
      // conflict round: settle F1
      return adjudications({ id: 'F1', stance: 'confirm', evidence: 'on re-reading, the check is not there' })
    })
    const verifier = reviewer('verifier', () => verdicts(
      { id: 'F1', verdict: 'keep', evidence: 'checked' },
      { id: 'F2', verdict: 'keep', evidence: 'checked' },
    ))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 3, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    const conflictPrompt = (b.provider as ScriptedProvider).prompts.find(p => p.includes('have not agreed on the findings'))
    expect(conflictPrompt).toBeDefined()
    expect(conflictPrompt).toContain('F1')
    expect(conflictPrompt).not.toContain('F2')      // uncontested entries are not re-litigated
    // Both sides' arguments travel with the entry, otherwise the round is just re-assertion
    expect(conflictPrompt).toContain('caller checks err')
    expect(result.roundsRun).toBe(3)
  })

  it('drops what the verifier refutes', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'drop', evidence: 'a.go:100 has no such call' }))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries[0].verification).toBe('drop')
    expect(result.inline).toHaveLength(0)
    expect(result.summary).toHaveLength(0)
  })

  // The old auditor could invent findings and ship them in the same breath
  it('ignores entries the verifier tries to invent', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const verifier = reviewer('verifier', () => verdicts(
      { id: 'F1', verdict: 'keep', evidence: 'checked' },
      { id: 'F999', verdict: 'keep', evidence: 'a problem I noticed myself' },
    ))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries).toHaveLength(1)
    expect(result.entries.map(e => e.id)).toEqual(['F1'])
  })

  // The silent-omission bug: an unanswered finding used to ship as if verified
  it('will not post inline anything the verifier skipped', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p)
      ? findings(findingJson(), findingJson({ file: 'internal/store/b.go', line: 12, title: 'missing retry on upload' }))
      : adjudications())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    const f2 = result.entries.find(e => e.id === 'F2')!
    expect(f2.verification).toBe('unanswered')
    expect(result.inline.map(e => e.id)).toEqual(['F1'])
    expect(result.summary.map(e => e.id)).toEqual(['F2'])
  })

  it('marks everything unverified when verification cannot be parsed', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const verifier = reviewer('verifier', () => 'I read the code and it all looks reasonable to me.')

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries[0].verification).toBe('unanswered')
    expect(result.inline).toHaveLength(0)
  })

  it('sends gap-finder additions back through verification', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const gap = reviewer('gapFinder', () => findings(findingJson({
      file: 'internal/store/b.go', line: 12, title: 'unbounded retry loop on upload',
    })))
    let verifyCalls = 0
    const verifier = reviewer('verifier', () => {
      verifyCalls++
      return verifyCalls === 1
        ? verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' })
        : verdicts({ id: 'F2', verdict: 'drop', evidence: 'the loop is bounded at b.go:20' })
    })

    const orch = new LedgerOrchestrator([a], verifier, gap, { maxRounds: 2 })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(verifyCalls).toBe(2)
    const f2 = result.entries.find(e => e.id === 'F2')!
    expect(f2.raisedBy).toEqual(['gapFinder'])
    expect(f2.verification).toBe('drop')       // an unchecked addition can no longer ship
    expect(result.inline.map(e => e.id)).toEqual(['F1'])
  })

  it('tells the gap finder which areas nobody reviewed', async () => {
    const a = reviewer('finderA', p => {
      // fail on the store shard so it stays uncovered
      if (isFinderPrompt(p) && p.includes('internal/store')) return 'no json'
      return isFinderPrompt(p) ? findings(findingJson()) : adjudications()
    })
    const gap = reviewer('gapFinder', () => findings())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a], verifier, gap, { maxRounds: 2, maxFilesPerShard: 1 })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.coverageSummary).toContain('NOT reviewed')
    const gapPrompt = (gap.provider as ScriptedProvider).prompts[0]
    expect(gapPrompt).toContain('Nobody reviewed these areas')
    expect(gapPrompt).toContain('internal/store')
  })

  it('reports coverage across shards', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings() : adjudications())
    const verifier = reviewer('verifier', () => verdicts())

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, maxFilesPerShard: 1, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.coverage).toHaveLength(2)
    expect(result.coverage.every(c => c.reviewedBy.includes('finderA'))).toBe(true)
    expect(result.coverageSummary).toBe('2/2 shards reviewed')
  })

  it('survives a finder that fails outright', async () => {
    const a = reviewer('finderA', () => { throw new Error('CLI exploded') })
    const b = reviewer('finderB', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries).toHaveLength(1)
    expect(result.inline).toHaveLength(1)
  })

  it('tracks token usage per participant', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.tokenUsage.map(t => t.reviewerId).sort()).toEqual(['finderA', 'verifier'])
    expect(result.tokenUsage.every(t => t.inputTokens > 0 && t.outputTokens > 0)).toBe(true)
  })
})

const clusters = (...g: Record<string, unknown>[]) =>
  '```json\n' + JSON.stringify({ groups: g }) + '\n```'
const rulings = (...r: Record<string, unknown>[]) =>
  '```json\n' + JSON.stringify({ rulings: r }) + '\n```'

const isClusterPrompt = (p: string) => p.includes('Group the ones that describe the SAME problem')

describe('LedgerOrchestrator with a judge', () => {
  // Word overlap cannot see that these are one bug; that is the whole reason for the judge
  it('merges paraphrases the similarity merge would have missed', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p)
      ? findings(findingJson({ title: 'Evict deletes from the map without holding the write lock' }))
      : adjudications())
    const b = reviewer('finderB', p => isFinderPrompt(p)
      ? findings(findingJson({ title: 'concurrent map write during cache expiry' }))
      : adjudications())
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1', 'B1'], canonical: 'A1', reason: 'one unlocked map write' })
      : rulings())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].raisedBy).toEqual(['finderA', 'finderB'])
    expect(result.entries[0].state).toBe('confirmed')
    expect(result.entries[0].variants).toEqual(['concurrent map write during cache expiry'])
  })

  it('keeps a finding the judge forgot to place', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p)
      ? findings(findingJson(), findingJson({ file: 'internal/store/b.go', line: 12, title: 'missing retry on upload' }))
      : adjudications())
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1'], canonical: 'A1' })     // A2 simply omitted
      : rulings())
    const verifier = reviewer('verifier', () => verdicts(
      { id: 'F1', verdict: 'keep', evidence: 'checked' },
      { id: 'F2', verdict: 'keep', evidence: 'checked' },
    ))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries).toHaveLength(2)
  })

  it('falls back to the similarity merge when the judge output is unusable', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const judge = reviewer('judge', () => 'I looked them over and they seem distinct.')
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries).toHaveLength(1)
    expect(result.inline).toHaveLength(1)
  })

  it('lets the judge set the state from the recorded positions', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const b = reviewer('finderB', p => isFinderPrompt(p)
      ? findings()
      : adjudications({ id: 'F1', stance: 'refute', evidence: 'a.go:80 — the caller checks err' }))
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1'], canonical: 'A1' })
      : rulings({ id: 'F1', state: 'challenged', rationale: 'the rebuttal cites the caller' }))
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries[0].state).toBe('disputed')       // still contested when rounds ran out
    expect(result.entries[0].judgeRationale).toBe('the rebuttal cites the caller')
    expect(result.inline).toHaveLength(0)                  // contested findings never go inline
  })

  // The judge sees everything, so this is the failure that would matter most
  it('will not let the judge confirm something the evidence does not support', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const b = reviewer('finderB', p => isFinderPrompt(p)
      ? findings()
      : adjudications({ id: 'F1', stance: 'confirm' }))     // no evidence — discarded at parse time
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1'], canonical: 'A1' })
      : rulings({ id: 'F1', state: 'confirmed', rationale: 'everyone agrees' }))
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.entries[0].state).toBe('raised')
  })

  it('stops early once a round changes nothing', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const b = reviewer('finderB', p => isFinderPrompt(p)
      ? findings()
      : adjudications({ id: 'F1', stance: 'refute', evidence: 'a.go:80 — the caller checks err' }))
    // The judge keeps ruling "challenged", so nothing moves after round 2
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1'], canonical: 'A1' })
      : rulings({ id: 'F1', state: 'challenged' }))
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 6, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.roundsRun).toBe(3)      // round 3 argued, moved nothing, and stopped
    expect(result.converged).toBe(true)
  })

  // "We ran out of rounds" and "nobody was still moving" are different claims about how
  // settled the result is, and the report distinguishes them
  it('reports when the rounds ran out with an entry still open', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const b = reviewer('finderB', p => isFinderPrompt(p)
      ? findings()
      : adjudications({ id: 'F1', stance: 'refute', evidence: 'a.go:80 — the caller checks err' }))
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1'], canonical: 'A1' })
      : rulings({ id: 'F1', state: 'challenged' }))
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.roundsRun).toBe(2)
    expect(result.converged).toBe(false)
    expect(result.entries[0].state).toBe('disputed')     // demoted rather than reported as fact
  })

  // Asking someone to rule on a shard they never opened is what an "abstain" answer used to
  // absorb. Removing abstain is only safe because the question is now scoped instead.
  it('does not ask a finder to rule on a shard it never got through', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const b = reviewer('finderB', p => {
      if (isFinderPrompt(p)) {
        if (p.includes('internal/query')) throw new Error('CLI exploded on the query shard')
        return covered(['internal/store/b.go'])
      }
      return adjudications()
    })
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1'], canonical: 'A1' })
      : rulings())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, maxFilesPerShard: 1, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    // The only finding is in internal/query, which finderB never got through
    expect((b.provider as ScriptedProvider).prompts.find(isAdjudicationPrompt)).toBeUndefined()
    expect(result.entries[0].state).toBe('raised')       // single-sourced, and honestly so
    // finderA did get through that shard, so the change is still covered — it is this one
    // finder's standing to rule that is limited, not the review's coverage
    expect(result.coverageSummary).toBe('2/2 shards reviewed')
  })
})

describe('lenses', () => {
  it('gives each finder a different angle by default', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings() : adjudications())
    const b = reviewer('finderB', p => isFinderPrompt(p) ? findings() : adjudications())
    const verifier = reviewer('verifier', () => verdicts())

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    await orch.run('PR #1', 'title', DIFF)

    const [pa] = (a.provider as ScriptedProvider).prompts
    const [pb] = (b.provider as ScriptedProvider).prompts
    expect(pa).toContain('Where to go deeper')
    expect(pa).not.toBe(pb)
  })

  it('lets config override the angle', async () => {
    const a = { ...reviewer('finderA', p => isFinderPrompt(p) ? findings() : adjudications()), lens: 'Focus on the billing rounding rules.' }
    const verifier = reviewer('verifier', () => verdicts())

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    await orch.run('PR #1', 'title', DIFF)

    expect((a.provider as ScriptedProvider).prompts[0]).toContain('Focus on the billing rounding rules.')
  })

  // The angle must widen where a finder digs, never narrow what it opens — a blind spot is
  // the one failure no later stage can recover from
  it('states that the angle is not a filter', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings() : adjudications())
    const verifier = reviewer('verifier', () => verdicts())

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    await orch.run('PR #1', 'title', DIFF)

    const prompt = (a.provider as ScriptedProvider).prompts[0]
    expect(prompt).toContain('Sweep your whole scope first')
    expect(prompt).toContain('It is not a filter')
  })
})

describe('per-role accounting', () => {
  it('separates what each finder found alone from what they shared', async () => {
    const shared = findingJson()
    const a = reviewer('finderA', p => isFinderPrompt(p)
      ? findings(shared, findingJson({ file: 'internal/store/b.go', line: 12, title: 'missing retry on upload' }))
      : adjudications())
    const b = reviewer('finderB', p => isFinderPrompt(p) ? findings(shared) : adjudications())
    const judge = reviewer('judge', p => isClusterPrompt(p)
      ? clusters({ members: ['A1', 'B1'], canonical: 'A1' }, { members: ['A2'], canonical: 'A2' })
      : rulings())
    const verifier = reviewer('verifier', () => verdicts(
      { id: 'F1', verdict: 'keep', evidence: 'checked' },
      { id: 'F2', verdict: 'keep', evidence: 'checked' },
    ))

    const orch = new LedgerOrchestrator([a, b], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false }, judge)
    const result = await orch.run('PR #1', 'title', DIFF)

    const statsA = result.finderStats.find(s => s.finderId === 'finderA')!
    const statsB = result.finderStats.find(s => s.finderId === 'finderB')!
    expect(statsA).toMatchObject({ raised: 2, unique: 1, shared: 1 })
    expect(statsB).toMatchObject({ raised: 1, unique: 0, shared: 1 })
  })

  it('reports no gap-finder stats when none ran', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.gapFinderStats).toBeUndefined()
  })

  // Whether this role earns its cost has to be answerable from one run's output
  it('accounts for the gap finder apart from the finders', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const gap = reviewer('gapFinder', () => findings(
      findingJson({ file: 'internal/store/b.go', line: 12, title: 'unbounded retry loop on upload' }),
      findingJson({ file: 'internal/store/b.go', line: 40, title: 'temp file is never removed on error' }),
    ))
    let verifyCalls = 0
    const verifier = reviewer('verifier', () => {
      verifyCalls++
      return verifyCalls === 1
        ? verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' })
        : verdicts(
            { id: 'F2', verdict: 'keep', evidence: 'b.go:12 — the loop has no bound' },
            { id: 'F3', verdict: 'drop', evidence: 'b.go:44 — a defer removes it' },
          )
    })

    const orch = new LedgerOrchestrator([a], verifier, gap, { maxRounds: 2 })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.gapFinderStats).toMatchObject({
      finderId: 'gapFinder', proposed: 2, added: 2, kept: 1, dropped: 1, inline: 1,
    })
    // Its additions are judged in their own verifier call, not folded into the first
    expect(verifyCalls).toBe(2)
    // …and they are not counted as a finder's work
    expect(result.finderStats.map(s => s.finderId)).toEqual(['finderA'])
  })

  it('counts a gap-finder proposal that duplicates an existing entry as not added', async () => {
    const dupe = findingJson()
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(dupe) : adjudications())
    const gap = reviewer('gapFinder', () => findings(dupe))
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked' }))

    const orch = new LedgerOrchestrator([a], verifier, gap, { maxRounds: 2 })
    const result = await orch.run('PR #1', 'title', DIFF)

    expect(result.gapFinderStats).toMatchObject({ proposed: 1, added: 0 })
    expect(result.entries).toHaveLength(1)
  })
})

describe('toMergedIssues', () => {
  it('carries the verification verdict through to the publishing path', async () => {
    const a = reviewer('finderA', p => isFinderPrompt(p) ? findings(findingJson()) : adjudications())
    const verifier = reviewer('verifier', () => verdicts({ id: 'F1', verdict: 'keep', evidence: 'checked at a.go:100' }))

    const orch = new LedgerOrchestrator([a], verifier, undefined, { maxRounds: 2, gapFinderEnabled: false })
    const result = await orch.run('PR #1', 'title', DIFF)

    const issues = toMergedIssues(result.inline)
    expect(issues).toHaveLength(1)
    expect(issues[0].verdict).toBe('keep')
    expect(issues[0].severity).toBe('high')
    expect(issues[0].file).toBe('internal/query/a.go')
    expect(issues[0].evidence).toBe('checked at a.go:100')
  })
})
