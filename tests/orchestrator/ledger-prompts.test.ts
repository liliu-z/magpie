// tests/orchestrator/ledger-prompts.test.ts
import { describe, it, expect } from 'vitest'
import {
  applySelfCheck,
  parseFinderOutput,
  parseAdjudications,
  buildFinderPrompt,
  buildAdjudicationPrompt,
  type RawFinding,
} from '../../src/orchestrator/prompts/ledger-prompts.js'

function raw(over: Partial<RawFinding> = {}): RawFinding {
  return {
    file: 'src/a.go',
    line: 10,
    title: 'error swallowed',
    description: 'desc',
    evidence: 'src/a.go:10 — `return nil`',
    introducedByThisChange: 'yes',
    reachableUnderDefaults: 'yes',
    deliberate: 'no',
    boundedImpact: 'Caller sees success on a failed load.',
    correctnessConfidence: 'high',
    impactSeverity: 'high',
    actionability: 'high',
    ...over,
  }
}

describe('applySelfCheck', () => {
  it('keeps high confidence when every check passes', () => {
    expect(applySelfCheck(raw())).toBe('high')
  })

  // These caps are the point: the self-check has to move something or it is decoration
  it('caps at low when the problem predates this change', () => {
    expect(applySelfCheck(raw({ introducedByThisChange: 'no' }))).toBe('low')
  })

  it('caps at low when the path is unreachable under defaults', () => {
    expect(applySelfCheck(raw({ reachableUnderDefaults: 'no' }))).toBe('low')
  })

  it('caps at low when the behaviour is deliberate', () => {
    expect(applySelfCheck(raw({ deliberate: 'yes' }))).toBe('low')
  })

  it('caps at low with no evidence', () => {
    expect(applySelfCheck(raw({ evidence: '' }))).toBe('low')
  })

  it('caps at medium on an unsure answer', () => {
    expect(applySelfCheck(raw({ reachableUnderDefaults: 'unsure' }))).toBe('medium')
  })

  it('caps at medium when a self-check answer is missing entirely', () => {
    expect(applySelfCheck(raw({ deliberate: undefined }))).toBe('medium')
  })

  it('caps at medium when the impact is not bounded', () => {
    expect(applySelfCheck(raw({ boundedImpact: '  ' }))).toBe('medium')
  })

  it('never raises a self-reported low confidence', () => {
    expect(applySelfCheck(raw({ correctnessConfidence: 'low' }))).toBe('low')
  })

  it('treats a missing confidence as low', () => {
    expect(applySelfCheck(raw({ correctnessConfidence: undefined }))).toBe('low')
  })
})

describe('parseFinderOutput', () => {
  const good = JSON.stringify({
    findings: [raw()],
    coverage: { filesReviewed: ['src/a.go'], notReviewed: ['src/gen.go'], notes: 'skipped generated' },
  })

  it('parses a fenced response', () => {
    const r = parseFinderOutput('preamble\n```json\n' + good + '\n```\n')
    expect(r?.findings).toHaveLength(1)
    expect(r?.findings[0].file).toBe('src/a.go')
  })

  it('parses bare JSON', () => {
    expect(parseFinderOutput(good)?.findings).toHaveLength(1)
  })

  it('returns null when there is no JSON', () => {
    expect(parseFinderOutput('I looked and everything seems fine.')).toBeNull()
  })

  it('returns null when findings is missing', () => {
    expect(parseFinderOutput('{"coverage": {}}')).toBeNull()
  })

  it('distinguishes an honest empty result from a parse failure', () => {
    const r = parseFinderOutput('{"findings": [], "coverage": {"filesReviewed": ["a.go"], "notReviewed": []}}')
    expect(r).not.toBeNull()
    expect(r!.findings).toHaveLength(0)
    expect(r!.coverage.filesReviewed).toEqual(['a.go'])
  })

  it('applies the self-check caps while parsing', () => {
    const r = parseFinderOutput(JSON.stringify({ findings: [raw({ deliberate: 'yes' })], coverage: {} }))
    expect(r!.findings[0].correctnessConfidence).toBe('low')
  })

  it('drops entries with no file or title', () => {
    const r = parseFinderOutput(JSON.stringify({
      findings: [raw(), { title: 'no file' }, { file: 'x.go' }],
      coverage: {},
    }))
    expect(r!.findings).toHaveLength(1)
  })

  it('falls back to safe values for bad scores', () => {
    const r = parseFinderOutput(JSON.stringify({
      findings: [raw({ impactSeverity: 'catastrophic' as never, actionability: 'yes' as never })],
      coverage: {},
    }))
    expect(r!.findings[0].impactSeverity).toBe('low')
    expect(r!.findings[0].actionability).toBe('low')
  })

  it('tags findings with the shard they came from', () => {
    const r = parseFinderOutput(good, 'S3')
    expect(r!.findings[0].shard).toBe('S3')
  })

  it('tolerates a missing coverage block', () => {
    const r = parseFinderOutput(JSON.stringify({ findings: [raw()] }))
    expect(r!.coverage.filesReviewed).toEqual([])
    expect(r!.coverage.notReviewed).toEqual([])
  })
})

describe('parseAdjudications', () => {
  it('parses stances', () => {
    const r = parseAdjudications(JSON.stringify({
      adjudications: [
        { id: 'F1', stance: 'confirm', evidence: 'a.go:1 — quote' },
        { id: 'F2', stance: 'refute', evidence: 'a.go:9 — quote' },
      ],
    }))
    expect(r).toHaveLength(2)
    expect(r![1].stance).toBe('refute')
  })

  // With abstain gone, the evidence requirement is the only thing standing between a model
  // that wants to be agreeable and a ledger full of fake corroboration
  it('discards any stance with no evidence', () => {
    const r = parseAdjudications(JSON.stringify({
      adjudications: [
        { id: 'F1', stance: 'confirm' },
        { id: 'F2', stance: 'refute', note: 'looks wrong to me' },
      ],
    }))
    expect(r).toEqual([])
  })

  it('no longer accepts abstain', () => {
    const r = parseAdjudications(JSON.stringify({ adjudications: [{ id: 'F1', stance: 'abstain' }] }))
    expect(r).toEqual([])
  })

  it('drops unknown stances', () => {
    const r = parseAdjudications(JSON.stringify({
      adjudications: [{ id: 'F1', stance: 'maybe', evidence: 'x' }],
    }))
    expect(r).toEqual([])
  })

  it('keeps a refine patch', () => {
    const r = parseAdjudications(JSON.stringify({
      adjudications: [{ id: 'F1', stance: 'refine', evidence: 'x', patch: { line: 42 } }],
    }))
    expect(r![0].patch).toEqual({ line: 42 })
  })

  it('returns null on unparseable output', () => {
    expect(parseAdjudications('no json here')).toBeNull()
  })
})

describe('prompt construction', () => {
  it('scopes a finder to its shard files', () => {
    const p = buildFinderPrompt({
      target: 'https://github.com/o/r/pull/1',
      shard: { id: 'S1', scope: 'internal/query', files: ['internal/query/a.go', 'internal/query/b.go'] },
    })
    expect(p).toContain('internal/query/a.go')
    expect(p).toContain('Review ONLY these files')
  })

  // Round 1 has to be uncontaminated, or agreement in round 2 means nothing
  it('never mentions another reviewer in the round-1 prompt', () => {
    const p = buildFinderPrompt({ target: 'PR #1' }).toLowerCase()
    expect(p).not.toContain('other reviewer')
    expect(p).not.toContain('the other finder')
    expect(p).not.toContain('agree')
  })

  it('requires the self-check fields', () => {
    const p = buildFinderPrompt({ target: 'PR #1' })
    for (const field of ['introducedByThisChange', 'reachableUnderDefaults', 'deliberate', 'boundedImpact']) {
      expect(p).toContain(field)
    }
  })

  it('asks for all three scores separately', () => {
    const p = buildFinderPrompt({ target: 'PR #1' })
    expect(p).toContain('correctnessConfidence')
    expect(p).toContain('impactSeverity')
    expect(p).toContain('actionability')
  })

  it('demands the checker bring its own evidence, and offers no abstain', () => {
    const p = buildAdjudicationPrompt({
      target: 'PR #1',
      entries: [{ id: 'F1', file: 'a.go', line: 1, title: 't', description: 'd' }],
    })
    expect(p).not.toContain('abstain')
    expect(p).toContain('your own evidence')
    expect(p).toContain('F1')
  })

  it('does not leak authorship into the adjudication prompt', () => {
    const p = buildAdjudicationPrompt({
      target: 'PR #1',
      entries: [{ id: 'F1', file: 'a.go', title: 't', description: 'd' }],
    })
    expect(p).not.toContain('claude')
    expect(p).not.toContain('codex')
  })
})
