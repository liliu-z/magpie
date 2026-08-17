// tests/orchestrator/audit-reconcile.test.ts
import { describe, it, expect } from 'vitest'
import { reconcileAuditVerdicts, clampIssuesToDiff, parseAuditVerdicts } from '../../src/orchestrator/orchestrator.js'
import type { MergedIssue } from '../../src/orchestrator/types.js'

function issue(over: Partial<MergedIssue> = {}): MergedIssue {
  return {
    severity: 'medium',
    category: 'correctness',
    file: 'src/a.go',
    line: 10,
    title: 'title',
    description: 'description',
    raisedBy: ['claude'],
    descriptions: ['description'],
    ...over,
  } as MergedIssue
}

describe('reconcileAuditVerdicts', () => {
  it('keeps an issue the auditor confirmed', () => {
    const input = [issue({ title: 'A' })]
    const r = reconcileAuditVerdicts(input, [{ verdict: 'keep', originalIndex: 0 }])
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].title).toBe('A')
    expect(r.stats.unanswered).toBe(0)
  })

  it('applies a rewrite to body, line and severity', () => {
    const input = [issue({ line: 10, severity: 'low' })]
    const r = reconcileAuditVerdicts(input, [
      { verdict: 'rewrite', originalIndex: 0, line: 42, severity: 'high', body: 'new body', evidence: 'saw x' }
    ])
    expect(r.issues[0].line).toBe(42)
    expect(r.issues[0].severity).toBe('high')
    expect(r.issues[0].body).toBe('new body')
    expect(r.stats.rewrites).toBe(1)
  })

  it('drops an issue the auditor rejected', () => {
    const r = reconcileAuditVerdicts([issue()], [{ verdict: 'drop', originalIndex: 0, reason: 'not real' }])
    expect(r.issues).toHaveLength(0)
    expect(r.stats.dropped).toBe(1)
  })

  it('records the drop reason so it is not lost', () => {
    const r = reconcileAuditVerdicts([issue({ title: 'T' })], [
      { verdict: 'drop', originalIndex: 0, reason: 'contradicted by code' }
    ])
    expect(r.dropReasons).toEqual([{ index: 0, title: 'T', reason: 'contradicted by code' }])
  })

  it('accepts auditReason as an alias for reason', () => {
    const r = reconcileAuditVerdicts([issue()], [
      { verdict: 'drop', originalIndex: 0, auditReason: 'codebase-convention' }
    ])
    expect(r.dropReasons[0].reason).toBe('codebase-convention')
  })

  it('marks a drop with no reason instead of silently accepting it', () => {
    const r = reconcileAuditVerdicts([issue()], [{ verdict: 'drop', originalIndex: 0 }])
    expect(r.stats.dropped).toBe(1)
    expect(r.dropReasons[0].reason).toBe('(no reason given)')
  })

  // The core fix: the auditor used to be able to silently delete findings by
  // simply not mentioning them.
  it('keeps issues the auditor never answered, and counts them', () => {
    const input = [issue({ title: 'A' }), issue({ title: 'B' }), issue({ title: 'C' })]
    const r = reconcileAuditVerdicts(input, [{ verdict: 'keep', originalIndex: 0 }])
    expect(r.issues.map(i => i.title)).toEqual(['A', 'B', 'C'])
    expect(r.stats.unanswered).toBe(2)
    expect(r.unanswered).toEqual([1, 2])
  })

  it('preserves input order when answers arrive out of order', () => {
    const input = [issue({ title: 'A' }), issue({ title: 'B' }), issue({ title: 'C' })]
    const r = reconcileAuditVerdicts(input, [
      { verdict: 'keep', originalIndex: 2 },
      { verdict: 'keep', originalIndex: 0 },
      { verdict: 'keep', originalIndex: 1 },
    ])
    expect(r.issues.map(i => i.title)).toEqual(['A', 'B', 'C'])
  })

  it('adds new issues after the verified ones', () => {
    const r = reconcileAuditVerdicts([issue({ title: 'A' })], [
      { verdict: 'keep', originalIndex: 0 },
      { verdict: 'new', file: 'src/b.go', line: 7, severity: 'high', category: 'correctness', body: 'Fresh problem.', evidence: 'at b.go:7' },
    ])
    expect(r.issues).toHaveLength(2)
    expect(r.issues[1].raisedBy).toEqual(['auditor'])
    expect(r.issues[1].verdict).toBe('new')
    expect(r.stats.added).toBe(1)
  })

  it('rejects a new issue that carries no evidence', () => {
    const r = reconcileAuditVerdicts([], [
      { verdict: 'new', file: 'src/b.go', line: 7, body: 'Fresh problem.' }
    ])
    expect(r.issues).toHaveLength(0)
    expect(r.stats.added).toBe(0)
  })

  it('ignores verdicts pointing at an index that does not exist', () => {
    const r = reconcileAuditVerdicts([issue()], [
      { verdict: 'keep', originalIndex: 0 },
      { verdict: 'rewrite', originalIndex: 99, body: 'ghost' },
    ])
    expect(r.issues).toHaveLength(1)
  })

  it('lets a drop win over a duplicate keep for the same issue', () => {
    const r = reconcileAuditVerdicts([issue()], [
      { verdict: 'keep', originalIndex: 0 },
      { verdict: 'drop', originalIndex: 0, reason: 'on reflection, not real' },
    ])
    expect(r.issues).toHaveLength(0)
    expect(r.stats.dropped).toBe(1)
  })
})

describe('parseAuditVerdicts', () => {
  it('parses a fenced JSON block', () => {
    const r = parseAuditVerdicts('blah\n```json\n{"verifiedIssues": [{"verdict": "keep", "originalIndex": 0}]}\n```\ntrailing')
    expect(r).toEqual([{ verdict: 'keep', originalIndex: 0 }])
  })

  it('parses bare JSON with no fence', () => {
    const r = parseAuditVerdicts('{"verifiedIssues": [{"verdict": "drop", "originalIndex": 1}]}')
    expect(r?.[0].verdict).toBe('drop')
  })

  // Returning null (not []) is what stops the caller from treating a broken audit as a clean one
  it('returns null on prose with no JSON', () => {
    expect(parseAuditVerdicts('I checked everything and it all looks fine.')).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    expect(parseAuditVerdicts('```json\n{"verifiedIssues": [{"verdict": ]}\n```')).toBeNull()
  })

  it('returns null when verifiedIssues is not an array', () => {
    expect(parseAuditVerdicts('{"verifiedIssues": "all good"}')).toBeNull()
  })

  it('distinguishes an empty verdict list from a parse failure', () => {
    expect(parseAuditVerdicts('{"verifiedIssues": []}')).toEqual([])
  })
})

describe('clampIssuesToDiff', () => {
  const diff = [
    'diff --git a/src/a.go b/src/a.go',
    '--- a/src/a.go',
    '+++ b/src/a.go',
    '@@ -30,4 +35,12 @@ func A() {',
    ' ctx',
    'diff --git a/src/b.go b/src/b.go',
    '--- a/src/b.go',
    '+++ b/src/b.go',
    '@@ -1,2 +10,3 @@ func B() {',
    ' ctx',
  ].join('\n')

  it('leaves a line inside a hunk untouched', () => {
    const r = clampIssuesToDiff([issue({ file: 'src/a.go', line: 40 })], diff)
    expect(r.issues[0].line).toBe(40)
    expect(r.adjusted).toBe(0)
  })

  it('accepts the first and last line of a hunk', () => {
    const r = clampIssuesToDiff([issue({ file: 'src/a.go', line: 35 }), issue({ file: 'src/a.go', line: 46 })], diff)
    expect(r.issues.map(i => i.line)).toEqual([35, 46])
    expect(r.adjusted).toBe(0)
  })

  it('clears a line that falls outside every hunk', () => {
    const r = clampIssuesToDiff([issue({ file: 'src/a.go', line: 200 })], diff)
    expect(r.issues[0].line).toBeUndefined()
    expect(r.adjusted).toBe(1)
  })

  it('clears the line when the file is not in the diff at all', () => {
    const r = clampIssuesToDiff([issue({ file: 'src/untouched.go', line: 5 })], diff)
    expect(r.issues[0].line).toBeUndefined()
    expect(r.adjusted).toBe(1)
  })

  it('keeps the issue itself — only the unusable line is removed', () => {
    const r = clampIssuesToDiff([issue({ file: 'src/a.go', line: 200, title: 'still useful' })], diff)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].title).toBe('still useful')
  })

  it('leaves issues without a line alone', () => {
    const r = clampIssuesToDiff([issue({ file: 'src/a.go', line: undefined })], diff)
    expect(r.adjusted).toBe(0)
  })

  it('is a no-op when no diff is available', () => {
    const r = clampIssuesToDiff([issue({ file: 'src/a.go', line: 999 })], '')
    expect(r.issues[0].line).toBe(999)
    expect(r.adjusted).toBe(0)
  })
})
