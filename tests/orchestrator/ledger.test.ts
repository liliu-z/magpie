// tests/orchestrator/ledger.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  IssueLedger,
  publishDecision,
  isSameFinding,
  titleSimilarity,
  type Finding,
  type LedgerEntry,
} from '../../src/orchestrator/ledger.js'

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/a.go',
    line: 100,
    category: 'correctness',
    title: 'nil pointer dereference on empty segment list',
    description: 'desc',
    evidence: 'a.go:100 saw `segments[0]`',
    correctnessConfidence: 'high',
    impactSeverity: 'high',
    actionability: 'high',
    ...over,
  }
}

describe('titleSimilarity', () => {
  it('scores identical titles as 1', () => {
    expect(titleSimilarity('nil deref on empty list', 'nil deref on empty list')).toBe(1)
  })

  it('ignores stop words', () => {
    expect(titleSimilarity('the nil deref', 'nil deref')).toBe(1)
  })

  it('scores unrelated titles near 0', () => {
    expect(titleSimilarity('nil deref on segments', 'missing retry backoff in uploader')).toBeLessThan(0.3)
  })

  it('returns 0 for an empty title', () => {
    expect(titleSimilarity('', 'anything')).toBe(0)
  })

  // Observed in a real run: two finders reported one bug, wording differed only by word form,
  // and the corroboration was lost
  it('matches across word forms', () => {
    expect(titleSimilarity(
      'Negative limit makes the eviction loop index out of range and panic',
      'Evict indexes keys out of range when limit is negative',
    )).toBeGreaterThanOrEqual(0.6)
  })

  it('still separates genuinely different problems', () => {
    expect(titleSimilarity(
      'Evict mutates the map without holding the write lock',
      'Get returns the internal slice by reference',
    )).toBeLessThan(0.45)
  })
})

describe('isSameFinding', () => {
  it('matches same file, nearby line, similar title', () => {
    expect(isSameFinding(
      finding({ line: 100 }),
      finding({ line: 104, title: 'nil pointer dereference when segment list empty' }),
    )).toBe(true)
  })

  it('does not match across files', () => {
    expect(isSameFinding(finding({ file: 'src/a.go' }), finding({ file: 'src/b.go' }))).toBe(false)
  })

  it('does not match distant lines', () => {
    expect(isSameFinding(finding({ line: 100 }), finding({ line: 400 }))).toBe(false)
  })

  it('does not match different problems on the same line', () => {
    expect(isSameFinding(
      finding({ line: 100, title: 'nil pointer dereference on empty segment list' }),
      finding({ line: 100, title: 'error return value discarded without logging' }),
    )).toBe(false)
  })

  it('still matches when one side has no line', () => {
    expect(isSameFinding(finding({ line: undefined }), finding({ line: 100 }))).toBe(true)
  })

  it('merges two paraphrases of the same bug on the same line', () => {
    expect(isSameFinding(
      finding({ line: 23, title: 'Negative limit makes the eviction loop index out of range and panic' }),
      finding({ line: 23, title: 'Evict indexes keys out of range when limit is negative' }),
    )).toBe(true)
  })

  it('does not merge two different bugs that happen to share a line', () => {
    expect(isSameFinding(
      finding({ line: 23, title: 'Evict mutates the map without holding the write lock' }),
      finding({ line: 23, title: 'Get returns the internal slice by reference to callers' }),
    )).toBe(false)
  })
})

describe('IssueLedger', () => {
  let ledger: IssueLedger

  beforeEach(() => {
    ledger = new IssueLedger()
  })

  it('assigns stable ids', () => {
    const a = ledger.add('finderA', finding({ title: 'first problem here' }), 1)
    const b = ledger.add('finderA', finding({ file: 'src/b.go', title: 'second problem there' }), 1)
    expect(a.id).toBe('F1')
    expect(b.id).toBe('F2')
    expect(ledger.get('F1')).toBe(a)
  })

  it('starts an entry as raised with a single source', () => {
    const e = ledger.add('finderA', finding(), 1)
    expect(e.state).toBe('raised')
    expect(e.raisedBy).toEqual(['finderA'])
  })

  // This is the payoff of independent round 1: two parties arriving separately is the
  // only agreement signal that means anything.
  it('promotes to confirmed when a second finder independently raises the same thing', () => {
    ledger.add('finderA', finding(), 1)
    const e = ledger.add('finderB', finding({ line: 102, title: 'nil pointer dereference, empty segment list' }), 1)
    expect(e.state).toBe('confirmed')
    expect(e.raisedBy).toEqual(['finderA', 'finderB'])
    expect(ledger.all()).toHaveLength(1)
  })

  it('does not double-count the same finder repeating itself', () => {
    ledger.add('finderA', finding(), 1)
    const e = ledger.add('finderA', finding({ line: 101 }), 2)
    expect(e.raisedBy).toEqual(['finderA'])
    expect(e.state).toBe('raised')
  })

  it('fills in a missing line from the corroborating report', () => {
    ledger.add('finderA', finding({ line: undefined, evidence: undefined }), 1)
    const e = ledger.add('finderB', finding({ line: 100, evidence: 'a.go:100' }), 1)
    expect(e.line).toBe(100)
    expect(e.evidence).toBe('a.go:100')
  })

  describe('adjudicate', () => {
    it('confirms on a stance backed by evidence', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'confirm', evidence: 'read a.go:100, confirmed', round: 2 })
      expect(ledger.get(e.id)!.state).toBe('confirmed')
    })

    // An unbacked "I agree" is the exact failure mode being designed out
    it('does not confirm on a stance with no evidence', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'confirm', round: 2 })
      expect(ledger.get(e.id)!.state).toBe('raised')
    })

    it('challenges on refute', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'refute', evidence: 'the caller checks len() first', round: 2 })
      expect(ledger.get(e.id)!.state).toBe('challenged')
    })

    it('escalates a second refute to disputed', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'refute', evidence: 'x', round: 2 })
      ledger.adjudicate(e.id, { by: 'finderC', stance: 'refute', evidence: 'y', round: 3 })
      expect(ledger.get(e.id)!.state).toBe('disputed')
    })

    // Evidence-free stances never reach the ledger (they are dropped at parse time), but if
    // one did it must not silently count as corroboration
    it('does not promote on a confirm with no evidence', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'confirm', note: 'sounds right', round: 2 })
      expect(ledger.get(e.id)!.state).toBe('raised')
      expect(ledger.get(e.id)!.adjudications).toHaveLength(1)
    })

    it('refuses to let a finder vouch for its own finding', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.adjudicate(e.id, { by: 'finderA', stance: 'confirm', evidence: 'trust me', round: 2 })
      expect(ledger.get(e.id)!.state).toBe('raised')
      expect(ledger.get(e.id)!.adjudications).toHaveLength(0)
    })

    it('confirms and corrects on refine', () => {
      const e = ledger.add('finderA', finding({ line: 100, impactSeverity: 'low' }), 1)
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'refine', evidence: 'actual site is 140', round: 2 })
      ledger.refine(e.id, { line: 140, impactSeverity: 'high' })
      const after = ledger.get(e.id)!
      expect(after.state).toBe('confirmed')
      expect(after.line).toBe(140)
      expect(after.impactSeverity).toBe('high')
    })

    it('ignores adjudication of an unknown id', () => {
      expect(ledger.adjudicate('F99', { by: 'finderB', stance: 'confirm', evidence: 'x', round: 2 })).toBeUndefined()
    })
  })

  describe('retract', () => {
    it('lets the source withdraw its own finding', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.retract(e.id, 'finderA')
      expect(ledger.get(e.id)!.state).toBe('retracted')
    })

    it('does not let another party withdraw it', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.retract(e.id, 'finderB')
      expect(ledger.get(e.id)!.state).toBe('raised')
    })

    it('keeps a retracted entry out of later adjudication', () => {
      const e = ledger.add('finderA', finding(), 1)
      ledger.retract(e.id, 'finderA')
      expect(ledger.forAdjudicationBy('finderB')).toHaveLength(0)
    })
  })

  describe('forAdjudicationBy', () => {
    it('hides a finder’s own entries', () => {
      ledger.add('finderA', finding({ title: 'problem alpha here' }), 1)
      ledger.add('finderB', finding({ file: 'src/b.go', title: 'problem beta there' }), 1)
      const forA = ledger.forAdjudicationBy('finderA')
      expect(forA).toHaveLength(1)
      expect(forA[0].title).toContain('beta')
    })

    // Authorship is stripped so the other finder checks the code, not the reputation
    it('strips authorship', () => {
      ledger.add('finderA', finding(), 1)
      const forB = ledger.forAdjudicationBy('finderB') as Array<Record<string, unknown>>
      expect(forB[0].raisedBy).toBeUndefined()
      expect(forB[0].adjudications).toBeUndefined()
      expect(forB[0].id).toBe('F1')
    })
  })

  it('reports only challenged entries as conflicts', () => {
    const a = ledger.add('finderA', finding({ title: 'alpha problem one' }), 1)
    ledger.add('finderA', finding({ file: 'src/b.go', title: 'beta problem two' }), 1)
    ledger.adjudicate(a.id, { by: 'finderB', stance: 'refute', evidence: 'x', round: 2 })
    expect(ledger.conflicts().map(e => e.id)).toEqual([a.id])
  })

  it('demotes anything still challenged when the conflict rounds end', () => {
    const a = ledger.add('finderA', finding(), 1)
    ledger.adjudicate(a.id, { by: 'finderB', stance: 'refute', evidence: 'x', round: 2 })
    ledger.finalizeDisputes()
    expect(ledger.get(a.id)!.state).toBe('disputed')
    expect(ledger.conflicts()).toHaveLength(0)
  })
})

describe('verification', () => {
  let ledger: IssueLedger

  beforeEach(() => {
    ledger = new IssueLedger()
  })

  it('records a keep ruling', () => {
    const e = ledger.add('finderA', finding(), 1)
    ledger.applyVerification(e.id, 'keep', 'a.go:100 confirmed')
    expect(ledger.get(e.id)!.verification).toBe('keep')
    expect(ledger.get(e.id)!.verifierEvidence).toBe('a.go:100 confirmed')
  })

  it('applies corrections on a rewrite ruling', () => {
    const e = ledger.add('finderA', finding({ line: 100 }), 1)
    ledger.applyVerification(e.id, 'rewrite', 'actual site is 140', { line: 140 })
    expect(ledger.get(e.id)!.line).toBe(140)
  })

  // The silent-omission bug, in the new design
  it('marks entries the verifier never ruled on', () => {
    const a = ledger.add('finderA', finding({ title: 'alpha problem here' }), 1)
    const b = ledger.add('finderA', finding({ file: 'src/b.go', title: 'beta problem there' }), 1)
    ledger.applyVerification(a.id, 'keep')
    const count = ledger.markUnverified()
    expect(count).toBe(1)
    expect(ledger.get(a.id)!.verification).toBe('keep')
    expect(ledger.get(b.id)!.verification).toBe('unanswered')
  })

  it('does not overwrite an existing ruling when marking unverified', () => {
    const e = ledger.add('finderA', finding(), 1)
    ledger.applyVerification(e.id, 'drop', 'not real')
    ledger.markUnverified()
    expect(ledger.get(e.id)!.verification).toBe('drop')
  })

  it('can mark only a subset of ids', () => {
    const a = ledger.add('finderA', finding({ title: 'alpha problem here' }), 1)
    const b = ledger.add('finderA', finding({ file: 'src/b.go', title: 'beta problem there' }), 1)
    ledger.markUnverified([a.id])
    expect(ledger.get(a.id)!.verification).toBe('unanswered')
    expect(ledger.get(b.id)!.verification).toBeUndefined()
  })
})

describe('publishDecision', () => {
  const entry = (over: Partial<LedgerEntry>) => ({
    state: 'confirmed' as const,
    correctnessConfidence: 'high' as const,
    impactSeverity: 'high' as const,
    actionability: 'high' as const,
    ...over,
  })

  it('posts inline when we are confident and it is actionable', () => {
    expect(publishDecision(entry({}))).toBe('inline')
  })

  // The case the old severity-only gate got wrong: small but certain and fixable
  it('posts inline for a small but certain, fixable bug', () => {
    expect(publishDecision(entry({ impactSeverity: 'low', correctnessConfidence: 'high', actionability: 'high' }))).toBe('inline')
  })

  it('demotes a confident finding the author cannot act on', () => {
    expect(publishDecision(entry({ actionability: 'low' }))).toBe('summary')
  })

  it('demotes a big but uncertain finding instead of dropping it', () => {
    expect(publishDecision(entry({ correctnessConfidence: 'low', impactSeverity: 'critical' }))).toBe('summary')
  })

  it('drops a small uncertain finding', () => {
    expect(publishDecision(entry({ correctnessConfidence: 'low', impactSeverity: 'medium' }))).toBe('drop')
  })

  it('never posts style-only preferences inline', () => {
    expect(publishDecision(entry({ impactSeverity: 'nitpick', correctnessConfidence: 'high', actionability: 'high' }))).toBe('drop')
  })

  it('never presents an unresolved disagreement as fact', () => {
    expect(publishDecision(entry({ state: 'disputed' }))).toBe('summary')
    expect(publishDecision(entry({ state: 'challenged' }))).toBe('summary')
  })

  it('drops retracted findings', () => {
    expect(publishDecision(entry({ state: 'retracted' }))).toBe('drop')
  })

  it('drops what the verifier rejected', () => {
    expect(publishDecision(entry({ verification: 'drop' }))).toBe('drop')
  })

  it('posts what the verifier kept', () => {
    expect(publishDecision(entry({ verification: 'keep' }))).toBe('inline')
  })

  // Used to be the silent failure: unverified findings shipped as if fact-checked
  it('will not post inline what the verifier never ruled on', () => {
    expect(publishDecision(entry({ verification: 'unanswered' }))).toBe('summary')
  })

  it('holds back a single-sourced medium-confidence finding', () => {
    expect(publishDecision(entry({ state: 'raised', correctnessConfidence: 'medium' }))).toBe('summary')
  })

  it('posts a corroborated medium-confidence actionable finding inline', () => {
    expect(publishDecision(entry({ state: 'confirmed', correctnessConfidence: 'medium', actionability: 'high' }))).toBe('inline')
  })
})
