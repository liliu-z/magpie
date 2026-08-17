// src/orchestrator/ledger.ts
//
// The issue ledger replaces "the conversation" as the pipeline's carrier.
//
// The old flow's only durable artifact was reviewer prose; structure was squeezed out of
// it once, at the end, from each reviewer's LAST message. That single choice produced
// several separate failures: findings raised early vanished when a later round said "I
// agree"; reviewers reading each other's prose converged instead of cross-validating; and
// "how much of the diff did we actually look at" was inexpressible.
//
// Here every finding is a structured entry from the moment it is raised, carries a stable
// id, and only ever changes state. Later rounds adjudicate entries; they never rewrite the
// review.

export type LedgerState =
  | 'raised'      // one source, nobody has checked it yet
  | 'confirmed'   // independently found or checked by a second party, with evidence
  | 'challenged'  // a second party checked it and disagrees
  | 'disputed'    // still contested after the conflict round — do not treat as verified
  | 'retracted'   // the party that raised it withdrew it

/**
 * A checker's position on someone else's finding.
 *
 * There is deliberately no "abstain". It carried no information the pipeline could act on —
 * an abstention and a missing answer led to the identical outcome — while giving a model an
 * easy exit from actually reading the code. What actually prevents agreeable-but-empty
 * confirmations is the evidence requirement below, not a third option: a stance without the
 * checker's own `file:LINE` + quote is discarded at parse time. Finders are also only asked
 * about entries inside the scope they reviewed, which was abstain's one legitimate use.
 */
export type Stance = 'confirm' | 'refute' | 'refine'

export type Confidence = 'high' | 'medium' | 'low'
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'nitpick'

export interface Adjudication {
  by: string
  stance: Stance
  /** Required for confirm/refute/refine — a stance without evidence is an opinion, not a check */
  evidence?: string
  note?: string
  round: number
}

/** What a finder reports. Scores are separate on purpose — see `publishDecision`. */
export interface Finding {
  file: string
  line?: number
  category: string
  title: string
  description: string
  evidence?: string
  correctnessConfidence: Confidence
  impactSeverity: Severity
  actionability: Confidence
  /** Which shard of the change this came from, when sharding is in play */
  shard?: string
}

/**
 * The verifier's ruling on an entry.
 * 'unanswered' is explicit: an entry the verifier never returned a ruling for was NOT
 * fact-checked, and must not be published as though it were.
 */
export type Verification = 'keep' | 'rewrite' | 'drop' | 'unanswered'

export interface LedgerEntry extends Finding {
  id: string
  raisedBy: string[]
  state: LedgerState
  adjudications: Adjudication[]
  raisedInRound: number
  verification?: Verification
  verifierEvidence?: string
  /**
   * How the other finders in this cluster worded the same problem. Clustering picks one
   * canonical wording; without this the alternatives would be destroyed, and a second
   * phrasing is often what makes a finding legible to the author.
   */
  variants?: string[]
  /** Why the judge put this entry in its current state — shown in the report, never to finders. */
  judgeRationale?: string
}

const CONFIDENCE_ORDER: Confidence[] = ['low', 'medium', 'high']
const SEVERITY_ORDER: Severity[] = ['nitpick', 'low', 'medium', 'high', 'critical']

/**
 * The stronger of two scores.
 *
 * Used when several finders report one problem. A score is a claim about how well the finder
 * could demonstrate something, so the strongest one is the best evidence anybody produced —
 * and letting the weakest reporter set the level would mean an extra reviewer finding a bug
 * could only ever bury it. Observed live: two finders both found a real out-of-range panic,
 * one scored it low, and taking the canonical member's scores dropped it from the report.
 */
function strongest<T extends string>(order: T[], a: T, b: T): T {
  return order.indexOf(b) > order.indexOf(a) ? b : a
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'in', 'on', 'of', 'to', 'and', 'for', 'with', 'this', 'that', 'it', 'be', 'can', 'not', 'no', 'when', 'makes', 'make', 'cause', 'causes'])

/**
 * Crude suffix stripping.
 *
 * Two reviewers describing one bug rarely pick the same word forms — observed in practice:
 * "eviction loop indexes out of range" vs "Evict indexes keys out of range". Without this,
 * evict/eviction and index/indexes count as different words, the two reports stay separate,
 * and a genuine independent corroboration is silently lost.
 */
function stem(word: string): string {
  for (const suffix of ['ations', 'ation', 'ingly', 'ing', 'ers', 'er', 'ies', 'ied', 'ion', 'es', 'ed', 's']) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length)
    }
  }
  return word
}

/** Word-overlap similarity, used only to merge near-identical findings from two finders. */
export function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(w => !STOP_WORDS.has(w)).map(stem)
  const setA = new Set(norm(a))
  const setB = new Set(norm(b))
  if (setA.size === 0 || setB.size === 0) return 0
  let shared = 0
  for (const w of setA) if (setB.has(w)) shared++
  return shared / Math.min(setA.size, setB.size)
}

const LINE_PROXIMITY = 10
const TITLE_MATCH_THRESHOLD = 0.6
/** Two findings on effectively the same line are usually the same problem, so wording matters less. */
const SAME_LINE_PROXIMITY = 2
const SAME_LINE_THRESHOLD = 0.45

/**
 * Whether two findings describe the same problem.
 *
 * Deliberately conservative: a false merge silently destroys a finding AND fabricates
 * agreement between two finders, which is worse than carrying a near-duplicate into
 * adjudication where a human-readable stance can sort it out.
 */
export function isSameFinding(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false

  let threshold = TITLE_MATCH_THRESHOLD
  if (typeof a.line === 'number' && typeof b.line === 'number') {
    const gap = Math.abs(a.line - b.line)
    if (gap > LINE_PROXIMITY) return false
    if (gap <= SAME_LINE_PROXIMITY) threshold = SAME_LINE_THRESHOLD
  }
  return titleSimilarity(a.title, b.title) >= threshold
}

export interface IssueLedgerOptions {
  /**
   * When a judge is running, states are assigned by `applyJudgeState` instead of derived
   * from each stance as it lands. Stances are still recorded — the judge reads them, and
   * they remain the evidence that constrains what state it is allowed to pick.
   */
  judgeDriven?: boolean
}

export class IssueLedger {
  private entries: LedgerEntry[] = []
  private seq = 0
  private judgeDriven: boolean

  constructor(options: IssueLedgerOptions = {}) {
    this.judgeDriven = !!options.judgeDriven
  }

  /**
   * Record a cluster of findings that a judge decided are the same problem.
   *
   * `canonical` selects which member's wording is kept; the judge picks it, but it must be
   * one of the members — the judge never authors finding text. That restriction is what
   * keeps it from becoming the old summarizer, whose freedom to rewrite is where fidelity
   * was lost.
   */
  addCluster(members: Array<{ by: string; finding: Finding }>, canonical: number, round: number): LedgerEntry | undefined {
    if (members.length === 0) return undefined
    const pick = canonical >= 0 && canonical < members.length ? canonical : 0
    const base = members[pick].finding
    const raisedBy = [...new Set(members.map(m => m.by))]

    const entry: LedgerEntry = {
      ...base,
      id: `F${++this.seq}`,
      raisedBy,
      // Two parties arriving at it separately is the strongest signal available at this point
      state: raisedBy.length >= 2 ? 'confirmed' : 'raised',
      adjudications: [],
      raisedInRound: round,
    }

    for (const [i, m] of members.entries()) {
      if (i === pick) continue
      if (typeof entry.line !== 'number' && typeof m.finding.line === 'number') entry.line = m.finding.line
      if (!entry.evidence && m.finding.evidence) entry.evidence = m.finding.evidence
      if (m.finding.title !== base.title) (entry.variants ??= []).push(m.finding.title)
      // The canonical member decides the wording only. Scores come from whoever made the
      // strongest case, otherwise the judge's choice of phrasing would quietly rescore the
      // finding — and a weakly-worded duplicate could sink a bug the other finder nailed.
      entry.correctnessConfidence = strongest(CONFIDENCE_ORDER, entry.correctnessConfidence, m.finding.correctnessConfidence)
      entry.impactSeverity = strongest(SEVERITY_ORDER, entry.impactSeverity, m.finding.impactSeverity)
      entry.actionability = strongest(CONFIDENCE_ORDER, entry.actionability, m.finding.actionability)
    }

    this.entries.push(entry)
    return entry
  }

  /**
   * Record a finding. If another finder already raised the same thing, this is independent
   * corroboration — merge and promote to confirmed rather than creating a duplicate.
   */
  add(finderId: string, finding: Finding, round: number): LedgerEntry {
    const existing = this.entries.find(e => e.state !== 'retracted' && isSameFinding(e, finding))
    if (existing) {
      if (!existing.raisedBy.includes(finderId)) {
        existing.raisedBy.push(finderId)
        // Two parties arrived at it separately — that is the strongest signal available here
        if (existing.state === 'raised') existing.state = 'confirmed'
        // Keep the more specific line and the stronger evidence
        if (typeof existing.line !== 'number' && typeof finding.line === 'number') existing.line = finding.line
        if (!existing.evidence && finding.evidence) existing.evidence = finding.evidence
      }
      return existing
    }

    const entry: LedgerEntry = {
      ...finding,
      id: `F${++this.seq}`,
      raisedBy: [finderId],
      state: 'raised',
      adjudications: [],
      raisedInRound: round,
    }
    this.entries.push(entry)
    return entry
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries.find(e => e.id === id)
  }

  all(): LedgerEntry[] {
    return [...this.entries]
  }

  /**
   * Record one party's stance on an entry.
   *
   * In judge-driven mode this only files the stance; the judge decides what it means for the
   * entry's state. Without a judge the state transitions here, which keeps the flow usable
   * when no judge model is configured.
   */
  adjudicate(id: string, adj: Adjudication): LedgerEntry | undefined {
    const entry = this.get(id)
    if (!entry) return undefined
    if (entry.state === 'retracted') return entry
    // A party cannot vouch for its own finding
    if (entry.raisedBy.includes(adj.by)) return entry

    entry.adjudications.push(adj)
    if (this.judgeDriven) return entry

    switch (adj.stance) {
      case 'confirm':
        // Evidence-free confirmation is not corroboration
        if (adj.evidence) entry.state = 'confirmed'
        break
      case 'refute':
        entry.state = entry.state === 'challenged' ? 'disputed' : 'challenged'
        break
      case 'refine':
        if (adj.evidence) entry.state = 'confirmed'
        break
    }
    return entry
  }

  /**
   * States the recorded evidence can actually support.
   *
   * The judge supplies semantic judgement — whether two descriptions are one problem, whether
   * a rebuttal lands — which no string comparison can. It does not get to supply facts. So it
   * chooses among the states below, and anything outside them is refused rather than trusted:
   * a judge cannot promote a single unchecked finding to "confirmed", and cannot mark an entry
   * contested when nobody actually contested it. That boundary is the reason a single judge
   * does not become a single point of fabrication.
   */
  legalStates(entry: LedgerEntry): LedgerState[] {
    const supported = entry.raisedBy.length >= 2
      || entry.adjudications.some(a => (a.stance === 'confirm' || a.stance === 'refine') && a.evidence)
    const refuted = entry.adjudications.some(a => a.stance === 'refute' && a.evidence)

    const states: LedgerState[] = ['raised']
    if (supported) states.push('confirmed')
    if (refuted) states.push('challenged', 'disputed')
    return states
  }

  /**
   * Apply the judge's ruling, clamped to what the evidence supports.
   * Returns the state actually applied, which the caller logs when it differs from the ask.
   */
  applyJudgeState(id: string, state: LedgerState, rationale?: string): LedgerState | undefined {
    const entry = this.get(id)
    if (!entry || entry.state === 'retracted') return undefined

    const legal = this.legalStates(entry)
    if (legal.includes(state)) {
      entry.state = state
    } else {
      // Fall back to the most conservative state the facts allow. Dropping a refuted entry
      // all the way to "raised" would erase the rebuttal, so a live refutation still shows.
      entry.state = legal.includes('challenged') ? 'challenged' : 'raised'
    }
    if (rationale) entry.judgeRationale = rationale
    return entry.state
  }

  /** Snapshot of every entry's state, used to detect a round in which nothing moved. */
  stateSignature(): string {
    return this.entries.map(e => `${e.id}:${e.state}`).join('|')
  }

  /** Apply a correction from a `refine` stance. */
  refine(id: string, patch: Partial<Pick<Finding, 'file' | 'line' | 'title' | 'description' | 'impactSeverity' | 'correctnessConfidence' | 'actionability'>>): void {
    const entry = this.get(id)
    if (!entry || entry.state === 'retracted') return
    Object.assign(entry, patch)
  }

  retract(id: string, by: string): void {
    const entry = this.get(id)
    if (!entry) return
    if (!entry.raisedBy.includes(by)) return   // only the source can withdraw it
    entry.state = 'retracted'
  }

  /** Entries that a later round still has to resolve. */
  conflicts(): LedgerEntry[] {
    return this.entries.filter(e => e.state === 'challenged')
  }

  /**
   * What another party should see: entries they did not raise, with authorship stripped.
   * Hiding "Claude said this" removes the authority bias that makes one finder defer to
   * another instead of checking the code.
   */
  forAdjudicationBy(finderId: string, inScope?: (e: LedgerEntry) => boolean): Array<Omit<LedgerEntry, 'raisedBy' | 'adjudications'>> {
    return this.entries
      .filter(e => !e.raisedBy.includes(finderId) && e.state !== 'retracted')
      // Only ask about code this finder actually covered. Asking someone to rule on a shard
      // they never opened is what an "abstain" answer used to absorb; scoping the question
      // is better than offering an exit, because it removes the guesswork instead of
      // recording it.
      .filter(e => !inScope || inScope(e))
      .map(({ raisedBy: _r, adjudications: _a, ...rest }) => rest)
  }

  /** Entries still contested after the conflict rounds are demoted, not silently kept. */
  finalizeDisputes(): void {
    for (const e of this.entries) {
      if (e.state === 'challenged') e.state = 'disputed'
    }
  }

  /**
   * Record the verifier's ruling.
   *
   * The verifier may kill a finding but may never add one — additions come from the gap
   * finder and go back through here. Splitting those two powers is what stops the final
   * stage from being an unchecked third reviewer whose additions ship unexamined.
   */
  applyVerification(id: string, ruling: Verification, evidence?: string, patch?: Parameters<IssueLedger['refine']>[1]): void {
    const entry = this.get(id)
    if (!entry) return
    entry.verification = ruling
    if (evidence) entry.verifierEvidence = evidence
    if (ruling === 'rewrite' && patch) Object.assign(entry, patch)
  }

  /**
   * Mark every entry the verifier failed to rule on. Called after the verifier runs so a
   * truncated or unparseable audit degrades to "unverified" instead of either erasing
   * findings or passing them off as checked.
   */
  markUnverified(ids?: string[]): number {
    let count = 0
    for (const e of this.entries) {
      if (e.state === 'retracted') continue
      if (ids && !ids.includes(e.id)) continue
      if (!e.verification) {
        e.verification = 'unanswered'
        count++
      }
    }
    return count
  }
}

export type PublishChannel = 'inline' | 'summary' | 'drop'

/**
 * Has anyone other than the finder who raised it read the code and agreed?
 *
 * Two things count, and the second one used to be missed. `confirmed` means two finders
 * landed on it independently. But an entry the verifier kept — after being handed the
 * claim and told to check it against the source, and having to cite evidence of its own to
 * be counted at all — has also been seen by a second party. That case matters because the
 * gap finder's entries can never reach `confirmed`: no finder ever adjudicates them, so
 * they sit at `raised` forever. Reading `raised` as "nobody corroborated this" therefore
 * demoted every gap-finder finding regardless of how well checked it was, which cost a real
 * high-impact upgrade-compatibility bug an inline comment on two separate runs.
 */
export function corroborated(entry: Pick<LedgerEntry, 'state'> & { verification?: Verification; verifierEvidence?: string }): boolean {
  if (entry.state === 'confirmed') return true
  return entry.verification === 'keep' && !!entry.verifierEvidence
}

/**
 * Decide where a finding goes.
 *
 * The three scores are read separately, which is the entire point of splitting them: a
 * single severity number forces the model to average "how bad" with "how sure", and that
 * average is what caused real, verifiable bugs to be filed as nitpicks and dropped.
 *
 *  - inline  = an inline PR comment. Costs the author attention, so it must be something
 *              they can act on and that we are confident is real.
 *  - summary = mentioned in the roundup. Worth saying, not worth interrupting for.
 *  - drop    = not reported.
 */
export function publishDecision(entry: Pick<LedgerEntry, 'state' | 'correctnessConfidence' | 'impactSeverity' | 'actionability'> & { verification?: Verification; verifierEvidence?: string }): PublishChannel {
  if (entry.state === 'retracted') return 'drop'
  // The verifier read the code and rejected it
  if (entry.verification === 'drop') return 'drop'
  // Style-only preferences never earn an inline comment, however sure we are
  if (entry.impactSeverity === 'nitpick') return 'drop'
  // Unresolved disagreement between finders is not something to hand the author as fact
  if (entry.state === 'disputed' || entry.state === 'challenged') return 'summary'
  // Verification ran but never ruled on this one — it is not fact-checked, so it does not
  // get to interrupt the author. This is the case that used to sail through as verified.
  if (entry.verification === 'unanswered') return 'summary'

  const bigImpact = entry.impactSeverity === 'critical' || entry.impactSeverity === 'high'

  if (entry.correctnessConfidence === 'low') {
    // Not sure it is real: only worth mentioning at all if it would matter a lot
    return bigImpact ? 'summary' : 'drop'
  }

  if (entry.correctnessConfidence === 'medium') {
    // Only moderately sure it is real, so one party's word is not enough to interrupt on
    if (!corroborated(entry)) return 'summary'
    // Corroborated: worth interrupting when we can say what to do about it, or when the
    // consequence is big enough that "we cannot name the fix" is no reason to whisper
    return entry.actionability === 'high' || bigImpact ? 'inline' : 'summary'
  }

  // High confidence
  if (entry.actionability === 'low') return 'summary'
  // A small but certain and fixable bug is exactly what reviewers value and what the old
  // severity-only gate threw away
  return 'inline'
}

/**
 * Why an entry was dropped, in the reader's words.
 *
 * Lives next to `publishDecision` and walks the same branches in the same order so the two
 * cannot drift. A report that says "Discarded (2)" and nothing else is unauditable — you
 * cannot tell a correctly-rejected false positive from a real bug the gate ate, which is
 * exactly the question anyone evaluating this flow is trying to answer.
 */
export function discardReason(entry: Pick<LedgerEntry, 'state' | 'correctnessConfidence' | 'impactSeverity' | 'actionability'> & { verification?: Verification; verifierEvidence?: string }): string {
  if (entry.state === 'retracted') return 'withdrawn by the finder who raised it'
  if (entry.verification === 'drop') return 'verifier checked the code and rejected it'
  if (entry.impactSeverity === 'nitpick') return 'style only'
  if (entry.correctnessConfidence === 'low') return 'low confidence and not enough impact to mention anyway'
  return 'below the reporting bar'
}
