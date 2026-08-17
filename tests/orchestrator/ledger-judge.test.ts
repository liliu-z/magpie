// tests/orchestrator/ledger-judge.test.ts
//
// The judge is the only stage that sees every finding, which is the position the old
// summarizer occupied and abused. These tests pin the two limits that make handing it that
// position safe: it cannot lose a finding, and it cannot state more than the evidence supports.
import { describe, it, expect } from 'vitest'
import { IssueLedger, type Finding } from '../../src/orchestrator/ledger.js'
import {
  buildJudgeClusterPrompt,
  buildJudgeStatePrompt,
  parseClusters,
  parseRulings,
  parseVerdicts,
} from '../../src/orchestrator/prompts/ledger-prompts.js'

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: 'a.go',
  line: 10,
  category: 'correctness',
  title: 'error swallowed',
  description: 'the error return is discarded',
  evidence: 'a.go:10 — `return nil`',
  correctnessConfidence: 'high',
  impactSeverity: 'high',
  actionability: 'high',
  ...over,
})

const clusterJson = (groups: unknown) => '```json\n' + JSON.stringify({ groups }) + '\n```'

describe('parseClusters', () => {
  it('parses the groups the judge produced', () => {
    const r = parseClusters(clusterJson([{ members: ['A1', 'B1'], canonical: 'B1', reason: 'same bug' }]), ['A1', 'B1'])
    expect(r).toEqual([{ members: ['A1', 'B1'], canonical: 'B1', reason: 'same bug' }])
  })

  // The safety property: clustering may reorganise findings but may never lose one
  it('gives a ref the judge forgot a group of its own', () => {
    const r = parseClusters(clusterJson([{ members: ['A1'], canonical: 'A1' }]), ['A1', 'B1', 'B2'])
    expect(r!.flatMap(g => g.members).sort()).toEqual(['A1', 'B1', 'B2'])
    expect(r!.find(g => g.members.includes('B1'))!.members).toEqual(['B1'])
  })

  // Two groups claiming the same finding would double-count it as independent corroboration
  it('lets only the first group claim a ref', () => {
    const r = parseClusters(clusterJson([
      { members: ['A1', 'B1'], canonical: 'A1' },
      { members: ['B1', 'B2'], canonical: 'B1' },
    ]), ['A1', 'B1', 'B2'])
    expect(r!.flatMap(g => g.members).sort()).toEqual(['A1', 'B1', 'B2'])
    expect(r![1].members).toEqual(['B2'])
  })

  it('ignores refs that were never sent', () => {
    const r = parseClusters(clusterJson([{ members: ['A1', 'Z9'], canonical: 'Z9' }]), ['A1'])
    expect(r).toEqual([{ members: ['A1'], canonical: 'A1', reason: undefined }])
  })

  it('falls back to a member when the canonical is not one of them', () => {
    const r = parseClusters(clusterJson([{ members: ['A1', 'B1'], canonical: 'C7' }]), ['A1', 'B1'])
    expect(r![0].canonical).toBe('A1')
  })

  it('returns null when the response is unusable', () => {
    expect(parseClusters('I grouped them by theme.', ['A1'])).toBeNull()
  })

  it('treats an empty group list as every finding standing alone', () => {
    const r = parseClusters(clusterJson([]), ['A1', 'B1'])
    expect(r).toHaveLength(2)
  })
})

describe('parseRulings', () => {
  it('parses a state ruling', () => {
    const r = parseRulings('```json\n' + JSON.stringify({
      rulings: [{ id: 'F1', state: 'confirmed', rationale: 'the rebuttal answers a different claim' }],
    }) + '\n```')
    expect(r).toEqual([{ id: 'F1', state: 'confirmed', rationale: 'the rebuttal answers a different claim' }])
  })

  it('drops states that are not in the vocabulary', () => {
    const r = parseRulings(JSON.stringify({ rulings: [{ id: 'F1', state: 'probably fine' }] }))
    expect(r).toEqual([])
  })

  it('returns null when the response is unusable', () => {
    expect(parseRulings('F1 seems right to me.')).toBeNull()
  })
})

describe('IssueLedger.addCluster', () => {
  it('records one entry crediting every finder in the cluster', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding() },
      { by: 'finderB', finding: finding({ title: 'load error is dropped' }) },
    ], 0, 1)!
    expect(e.raisedBy).toEqual(['finderA', 'finderB'])
    expect(e.state).toBe('confirmed')      // two parties arrived at it independently
    expect(ledger.all()).toHaveLength(1)
  })

  it('keeps the other wording instead of destroying it', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding() },
      { by: 'finderB', finding: finding({ title: 'load error is dropped' }) },
    ], 0, 1)!
    expect(e.title).toBe('error swallowed')
    expect(e.variants).toEqual(['load error is dropped'])
  })

  it('uses the canonical member the judge chose', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding() },
      { by: 'finderB', finding: finding({ title: 'load error is dropped' }) },
    ], 1, 1)!
    expect(e.title).toBe('load error is dropped')
  })

  it('leaves a single-member cluster single-sourced', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    expect(e.state).toBe('raised')
  })

  it('backfills a missing line and evidence from the other members', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding({ line: undefined, evidence: undefined }) },
      { by: 'finderB', finding: finding({ line: 42, evidence: 'a.go:42 — quote' }) },
    ], 0, 1)!
    expect(e.line).toBe(42)
    expect(e.evidence).toBe('a.go:42 — quote')
  })

  // Caught live: a real out-of-range panic scored high by one finder and low by the other was
  // dropped, because the judge happened to pick the low-scoring wording as canonical
  it('takes the strongest score any member gave, not the canonical member’s', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding({ correctnessConfidence: 'low', impactSeverity: 'low', actionability: 'medium' }) },
      { by: 'finderB', finding: finding({ title: 'other wording', correctnessConfidence: 'high', impactSeverity: 'critical', actionability: 'high' }) },
    ], 0, 1)!
    expect(e.title).toBe('error swallowed')          // wording still comes from the canonical
    expect(e.correctnessConfidence).toBe('high')
    expect(e.impactSeverity).toBe('critical')
    expect(e.actionability).toBe('high')
  })

  it('does not weaken a score because a duplicate scored it lower', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding({ correctnessConfidence: 'high', impactSeverity: 'high' }) },
      { by: 'finderB', finding: finding({ title: 'other wording', correctnessConfidence: 'low', impactSeverity: 'nitpick' }) },
    ], 0, 1)!
    expect(e.correctnessConfidence).toBe('high')
    expect(e.impactSeverity).toBe('high')
  })

  it('does not count the same finder twice', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding() },
      { by: 'finderA', finding: finding({ title: 'same thing again' }) },
    ], 0, 1)!
    expect(e.raisedBy).toEqual(['finderA'])
    expect(e.state).toBe('raised')     // one finder saying it twice is not corroboration
  })
})

describe('judge-driven state', () => {
  it('records stances without moving the state itself', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    ledger.adjudicate(e.id, { by: 'finderB', stance: 'refute', evidence: 'a.go:12 — the caller checks it', round: 2 })
    expect(ledger.get(e.id)!.state).toBe('raised')       // the judge decides what that means
    expect(ledger.get(e.id)!.adjudications).toHaveLength(1)
  })

  it('still transitions automatically when no judge is configured', () => {
    const ledger = new IssueLedger()
    const e = ledger.add('finderA', finding(), 1)
    ledger.adjudicate(e.id, { by: 'finderB', stance: 'refute', evidence: 'a.go:12 — checked', round: 2 })
    expect(ledger.get(e.id)!.state).toBe('challenged')
  })

  describe('legalStates', () => {
    it('offers only "raised" for a finding nobody has checked', () => {
      const ledger = new IssueLedger({ judgeDriven: true })
      const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
      expect(ledger.legalStates(ledger.get(e.id)!)).toEqual(['raised'])
    })

    it('allows "confirmed" once a second party checked it with evidence', () => {
      const ledger = new IssueLedger({ judgeDriven: true })
      const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'confirm', evidence: 'a.go:10 — quote', round: 2 })
      expect(ledger.legalStates(ledger.get(e.id)!)).toContain('confirmed')
    })

    it('does not allow contested states when nobody contested it', () => {
      const ledger = new IssueLedger({ judgeDriven: true })
      const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
      ledger.adjudicate(e.id, { by: 'finderB', stance: 'confirm', evidence: 'a.go:10 — quote', round: 2 })
      expect(ledger.legalStates(ledger.get(e.id)!)).not.toContain('challenged')
    })
  })

  // The core guarantee: judgement yes, facts no
  it('refuses to promote a single unchecked finding to confirmed', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    const applied = ledger.applyJudgeState(e.id, 'confirmed', 'looks convincing')
    expect(applied).toBe('raised')
    expect(ledger.get(e.id)!.state).toBe('raised')
  })

  it('refuses to invent a dispute nobody raised', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    expect(ledger.applyJudgeState(e.id, 'disputed')).toBe('raised')
  })

  it('applies a state the evidence supports', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    ledger.adjudicate(e.id, { by: 'finderB', stance: 'refute', evidence: 'a.go:12 — the caller checks it', round: 2 })
    expect(ledger.applyJudgeState(e.id, 'challenged', 'rebuttal cites the caller')).toBe('challenged')
    expect(ledger.get(e.id)!.judgeRationale).toBe('rebuttal cites the caller')
  })

  // A judge may overrule a rebuttal — that is the judgement it was added for
  it('lets the judge confirm over a refutation when support also exists', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([
      { by: 'finderA', finding: finding() },
      { by: 'finderB', finding: finding({ title: 'load error dropped' }) },
    ], 0, 1)!
    ledger.adjudicate(e.id, { by: 'finderC', stance: 'refute', evidence: 'a.go:12 — checked', round: 2 })
    expect(ledger.applyJudgeState(e.id, 'confirmed', 'the rebuttal reads the wrong branch')).toBe('confirmed')
  })

  it('keeps a live refutation visible when the ask is illegal', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    ledger.adjudicate(e.id, { by: 'finderB', stance: 'refute', evidence: 'a.go:12 — checked', round: 2 })
    // "confirmed" is not supported — but falling back to "raised" would erase the rebuttal
    expect(ledger.applyJudgeState(e.id, 'confirmed')).toBe('challenged')
  })

  it('will not rule on a retracted entry', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    ledger.retract(e.id, 'finderA')
    expect(ledger.applyJudgeState(e.id, 'confirmed')).toBeUndefined()
    expect(ledger.get(e.id)!.state).toBe('retracted')
  })
})

describe('stateSignature', () => {
  it('changes when a state moves and holds still when nothing does', () => {
    const ledger = new IssueLedger({ judgeDriven: true })
    const e = ledger.addCluster([{ by: 'finderA', finding: finding() }], 0, 1)!
    const before = ledger.stateSignature()

    // A round in which only positions were filed, with no ruling, must read as "nothing moved"
    ledger.adjudicate(e.id, { by: 'finderB', stance: 'refute', evidence: 'a.go:12 — checked', round: 2 })
    expect(ledger.stateSignature()).toBe(before)

    ledger.applyJudgeState(e.id, 'challenged')
    expect(ledger.stateSignature()).not.toBe(before)
  })
})

describe('parseVerdicts', () => {
  it('parses the three verdicts', () => {
    const r = parseVerdicts(JSON.stringify({
      verdicts: [
        { id: 'F1', verdict: 'keep', evidence: 'a.go:10 — quote' },
        { id: 'F2', verdict: 'rewrite', evidence: 'a.go:20 — quote', patch: { line: 22 } },
        { id: 'F3', verdict: 'drop', evidence: 'a.go:30 — the check is right there' },
      ],
    }))
    expect(r!.map(v => v.verdict)).toEqual(['keep', 'rewrite', 'drop'])
    expect(r![1].patch).toEqual({ line: 22 })
  })

  // An unjustified "drop" would delete a real finding; degrading it to unanswered is visible
  it('discards a verdict with no evidence', () => {
    const r = parseVerdicts(JSON.stringify({ verdicts: [{ id: 'F1', verdict: 'drop' }] }))
    expect(r).toEqual([])
  })

  it('has no vocabulary for adding a finding', () => {
    const r = parseVerdicts(JSON.stringify({ verdicts: [{ id: 'F9', verdict: 'new', evidence: 'x' }] }))
    expect(r).toEqual([])
  })

  it('returns null when the response is unusable', () => {
    expect(parseVerdicts('All three look fine.')).toBeNull()
  })
})

describe('judge prompts', () => {
  it('never reveals who reported what', () => {
    const p = buildJudgeClusterPrompt({
      target: 'PR #1',
      findings: [
        { ref: 'A1', file: 'a.go', line: 10, title: 'error swallowed', description: 'd' },
        { ref: 'B1', file: 'a.go', line: 11, title: 'load error dropped', description: 'd' },
      ],
    })
    expect(p).toContain('authorship removed')
    expect(p).toContain('A1')
    expect(p).toContain('B1')
    expect(p).not.toMatch(/claude|codex|gemini|finderA/i)
  })

  it('tells the judge to split when unsure rather than merge', () => {
    const p = buildJudgeClusterPrompt({ target: 'PR #1', findings: [{ ref: 'A1', file: 'a.go', title: 't', description: 'd' }] })
    expect(p).toContain('keep them separate')
    expect(p).toContain('exactly one group')
  })

  it('states the allowed states per entry so the judge is not guessing', () => {
    const p = buildJudgeStatePrompt({
      target: 'PR #1',
      round: 2,
      entries: [{
        id: 'F1', file: 'a.go', line: 10, title: 't', description: 'd',
        sources: 1,
        positions: [{ stance: 'refute', evidence: 'a.go:12 — checked', round: 2 }],
        allowed: ['raised', 'challenged', 'disputed'],
      }],
    })
    expect(p).toContain('allowed states: raised, challenged, disputed')
    expect(p).toContain('a.go:12 — checked')
  })

  it('tells the judge to weigh evidence rather than count votes', () => {
    const p = buildJudgeStatePrompt({
      target: 'PR #1',
      round: 2,
      entries: [{ id: 'F1', file: 'a.go', title: 't', description: 'd', sources: 1, positions: [], allowed: ['raised'] }],
    })
    expect(p).toContain('Counting positions is not judging')
  })
})
