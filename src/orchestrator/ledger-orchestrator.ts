// src/orchestrator/ledger-orchestrator.ts
//
// The ledger flow:
//
//   plan shards
//     → round 1: finders work independently, shard by shard        (no shared framing)
//     → judge:   cluster the raw findings into the ledger          (may group, may not delete)
//     → round 2: finders adjudicate entries in the scope they read (evidence or nothing)
//     → judge:   weigh the positions, set each entry's state       (bounded by what was recorded)
//     → round 3+: repeat on open entries until nothing moves       (narrowing, not re-reviewing)
//     → verifier: rules on every entry, may not add                (set-in = set-out)
//     → gap finder: may add, cannot publish                        (its additions go back to verify)
//     → publish gate: three scores decide inline / summary / drop
//
// Compared with the debate flow it replaces: findings survive rounds instead of being
// squeezed out of the last message, agreement means two parties checked the code rather
// than read each other's prose, unreviewed areas are stated instead of implied, and the
// final stage can no longer both invent a finding and wave it through.
//
// The judge is the only stage that sees everything, which is exactly the position the old
// summarizer occupied and abused. Two rules keep it honest, both enforced in code rather than
// asked for in the prompt: it selects canonical wording from what finders wrote instead of
// authoring any, and it may only move an entry to a state the recorded evidence already
// permits. It supplies judgement; it cannot supply facts.

import type { Message } from '../providers/types.js'
import type { Reviewer, TokenUsage, MergedIssue } from './types.js'
import { IssueLedger, publishDecision, type Finding, type LedgerEntry, type Verification } from './ledger.js'
import { planShards, CoverageLedger, type Shard, type CoverageRecord } from './shard-planner.js'
import {
  buildFinderPrompt,
  buildAdjudicationPrompt,
  buildConflictPrompt,
  buildGapFinderPrompt,
  buildJudgeClusterPrompt,
  buildJudgeStatePrompt,
  buildVerifierPrompt,
  parseFinderOutput,
  parseAdjudications,
  parseClusters,
  parseRulings,
  parseVerdicts,
} from './prompts/ledger-prompts.js'
import { extractChangedFiles } from './orchestrator.js'
import { logger } from '../utils/logger.js'

/** Distinct angles so two finders on the same model don't retrace the same path. */
export const DEFAULT_LENSES = [
  'Focus on what breaks at runtime: nil/empty handling, error paths, concurrency, resource lifetime, and cancellation.',
  'Focus on contracts and interactions: callers of changed interfaces, rolling-upgrade and compatibility risk, shared state across features, and invariants this change relies on.',
]

export interface LedgerOrchestratorOptions {
  /** Total rounds including round 1 and 2. Rounds past 2 only handle open entries. */
  maxRounds?: number
  maxFilesPerShard?: number
  language?: string
  gapFinderEnabled?: boolean
  /** Facts gathered once and given to every finder. Facts only — see `buildFinderPrompt`. */
  sharedContext?: string
  onStage?: (stage: string, detail?: string) => void
  interruptState?: { interrupted: boolean }
}

export interface LedgerRunResult {
  entries: LedgerEntry[]
  inline: LedgerEntry[]
  summary: LedgerEntry[]
  coverage: CoverageRecord[]
  coverageSummary: string
  roundsRun: number
  /** True when the rounds ended because nothing was moving, not because we ran out of them */
  converged: boolean
  tokenUsage: TokenUsage[]
}

/** One finder's raw output before the judge decides what is a duplicate of what. */
interface RawFinding {
  ref: string
  by: string
  finding: Finding
}

export class LedgerOrchestrator {
  private ledger: IssueLedger
  private tokens = new Map<string, { input: number; output: number }>()
  /** Files each finder actually reviewed, so we only ask them about code they opened */
  private scopeByFinder = new Map<string, Set<string>>()

  constructor(
    private finders: Reviewer[],
    private verifier: Reviewer,
    private gapFinder: Reviewer | undefined,
    private options: LedgerOrchestratorOptions = {},
    private judge?: Reviewer,
  ) {
    this.ledger = new IssueLedger({ judgeDriven: !!judge })
  }

  private get langSuffix(): string {
    return this.options.language
      ? `\n\n[LANGUAGE] Write "title", "description", "evidence" and "note" in ${this.options.language}. Keep file paths, symbol names and JSON keys/values in English.`
      : ''
  }

  private track(id: string, input: string, output: string): void {
    const cur = this.tokens.get(id) || { input: 0, output: 0 }
    cur.input += Math.ceil(input.length / 4)
    cur.output += Math.ceil(output.length / 4)
    this.tokens.set(id, cur)
  }

  private checkInterrupt(): void {
    if (this.options.interruptState?.interrupted) throw new Error('Interrupted by user')
  }

  private async ask(who: Reviewer, prompt: string): Promise<string> {
    const messages: Message[] = [{ role: 'user', content: prompt }]
    const response = await who.provider.chat(messages, who.systemPrompt)
    this.track(who.id, prompt + (who.systemPrompt || ''), response)
    return response
  }

  async run(target: string, targetDescription: string, diffText: string): Promise<LedgerRunResult> {
    const maxRounds = Math.max(2, this.options.maxRounds ?? 3)
    const changedFiles = extractChangedFiles(diffText)
    const shards = planShards(changedFiles, this.options.maxFilesPerShard ?? 8)
    const coverage = new CoverageLedger(shards)

    logger.info(`Ledger run: ${changedFiles.length} changed files → ${shards.length || 1} shard(s), ${this.finders.length} finder(s)`)

    const raw = await this.roundOne(target, targetDescription, shards, coverage)
    this.checkInterrupt()

    await this.buildLedger(target, raw)
    this.checkInterrupt()

    let roundsRun = 1
    let converged = false

    if (this.finders.length > 1) {
      for (let round = 2; round <= maxRounds; round++) {
        const before = this.ledger.stateSignature()

        const asked = round === 2
          ? await this.roundTwo(target)
          : await this.debateRound(target, round)
        roundsRun = round
        this.checkInterrupt()

        if (asked === 0) {
          // Nothing left that anyone can still speak to
          converged = true
          break
        }

        await this.judgeStates(target, round)
        this.checkInterrupt()

        if (this.ledger.stateSignature() === before) {
          // A full round of argument moved nothing. More rounds of the same will not either,
          // and stopping here is what makes the round budget affordable to raise.
          logger.info(`Ledger converged after round ${round}: no state changed`)
          converged = true
          break
        }
        if (this.ledger.conflicts().length === 0) {
          converged = true
          break
        }
      }
    } else {
      converged = true
    }

    // Anything still contested is reported as contested, not as fact
    this.ledger.finalizeDisputes()

    await this.verify(target, this.ledger.all().filter(e => e.state !== 'retracted').map(e => e.id))
    this.checkInterrupt()

    if (this.options.gapFinderEnabled !== false && this.gapFinder) {
      const added = await this.runGapFinder(target, coverage)
      // Additions are claims, not conclusions — they go back through verification
      if (added.length > 0) await this.verify(target, added)
    }

    const entries = this.ledger.all()
    const inline: LedgerEntry[] = []
    const summary: LedgerEntry[] = []
    for (const e of entries) {
      const channel = publishDecision(e)
      if (channel === 'inline') inline.push(e)
      else if (channel === 'summary') summary.push(e)
    }

    logger.info(`Ledger result: ${entries.length} entries → ${inline.length} inline, ${summary.length} summary; coverage ${coverage.summary()}`)

    return {
      entries,
      inline,
      summary,
      coverage: coverage.all(),
      coverageSummary: coverage.summary(),
      roundsRun,
      converged,
      tokenUsage: [...this.tokens.entries()].map(([reviewerId, t]) => ({
        reviewerId,
        inputTokens: t.input,
        outputTokens: t.output,
      })),
    }
  }

  /** Round 1 — every finder × every shard, in parallel, with no knowledge of each other. */
  private async roundOne(target: string, targetDescription: string, shards: Shard[], coverage: CoverageLedger): Promise<RawFinding[]> {
    this.options.onStage?.('round1', `${this.finders.length} finder(s) × ${shards.length || 1} shard(s)`)

    const raw: RawFinding[] = []
    const jobs: Array<Promise<void>> = []
    const scopes: Array<Shard | undefined> = shards.length > 0 ? shards : [undefined]
    // Per-finder ref counters. Shards finish in whatever order they finish, so a shared
    // counter would hand out refs that depend on timing; these stay stable per finder.
    const refSeq = new Map<string, number>()

    for (const [i, finder] of this.finders.entries()) {
      const tag = String.fromCharCode(65 + (i % 26))   // A, B, C… — refs the judge sees
      for (const shard of scopes) {
        jobs.push((async () => {
          const prompt = buildFinderPrompt({
            target,
            targetDescription,
            shard,
            lens: DEFAULT_LENSES[i % DEFAULT_LENSES.length],
            sharedContext: this.options.sharedContext,
            langSuffix: this.langSuffix,
          })
          try {
            const response = await this.ask(finder, prompt)
            const parsed = parseFinderOutput(response, shard?.id)
            if (!parsed) {
              logger.warn(`[${finder.id}] unparseable output for shard ${shard?.id ?? 'all'}`)
              if (shard) coverage.markFailed(shard.id, finder.id)
              return
            }
            for (const f of parsed.findings) {
              const n = (refSeq.get(finder.id) ?? 0) + 1
              refSeq.set(finder.id, n)
              raw.push({ ref: `${tag}${n}`, by: finder.id, finding: f })
            }
            this.recordScope(finder.id, shard, parsed.coverage.filesReviewed)
            if (shard) coverage.markReviewed(shard.id, finder.id)
            logger.info(`[${finder.id}] shard ${shard?.id ?? 'all'}: ${parsed.findings.length} finding(s), ${parsed.coverage.notReviewed.length} file(s) not reviewed`)
          } catch (err) {
            logger.warn(`[${finder.id}] failed on shard ${shard?.id ?? 'all'}:`, err)
            if (shard) coverage.markFailed(shard.id, finder.id)
          }
        })())
      }
    }

    await Promise.all(jobs)
    return raw
  }

  /**
   * Remember what this finder covered. Its assigned shard counts even for files it did not
   * mention: it was told to review them, so it can be asked about them. Self-reported extra
   * files count too, since reading beyond the shard for context is encouraged.
   */
  private recordScope(finderId: string, shard: Shard | undefined, filesReviewed: string[]): void {
    const set = this.scopeByFinder.get(finderId) ?? new Set<string>()
    for (const f of shard?.files ?? []) set.add(f)
    for (const f of filesReviewed) set.add(f)
    this.scopeByFinder.set(finderId, set)
  }

  /** Whether this finder is in a position to rule on an entry at all. */
  private inScopeFor(finderId: string): ((e: LedgerEntry) => boolean) | undefined {
    const scope = this.scopeByFinder.get(finderId)
    // No shards, or nothing recorded — everyone saw the whole change, so nothing to narrow
    if (!scope || scope.size === 0) return undefined
    return (e: LedgerEntry) => scope.has(e.file)
  }

  /**
   * The judge turns the finders' raw output into the ledger.
   *
   * Without a judge this falls back to the built-in similarity merge, so the flow still runs
   * unconfigured — but that merge compares words, and two reviewers describing one bug rarely
   * choose the same ones. Grouping by meaning is the judge's first real contribution.
   */
  private async buildLedger(target: string, raw: RawFinding[]): Promise<void> {
    if (raw.length === 0) return

    if (!this.judge) {
      for (const r of raw) this.ledger.add(r.by, r.finding, 1)
      logger.info(`No judge configured: merged ${raw.length} raw finding(s) by similarity into ${this.ledger.all().length} entr(ies)`)
      return
    }

    this.options.onStage?.('judge', `clustering ${raw.length} raw finding(s)`)
    const byRef = new Map(raw.map(r => [r.ref, r]))
    const prompt = buildJudgeClusterPrompt({
      target,
      findings: raw.map(r => ({
        ref: r.ref,
        file: r.finding.file,
        line: r.finding.line,
        title: r.finding.title,
        description: r.finding.description,
        evidence: r.finding.evidence,
      })),
      langSuffix: this.langSuffix,
    })

    let groups: ReturnType<typeof parseClusters> = null
    try {
      const response = await this.ask(this.judge, prompt)
      groups = parseClusters(response, [...byRef.keys()])
    } catch (err) {
      logger.warn('Judge clustering failed:', err)
    }

    if (!groups) {
      // Falling back to the similarity merge keeps every finding; refusing to cluster at all
      // would be safe too, but would flood the next round with duplicates.
      logger.warn('Judge clustering unusable; falling back to similarity merge')
      for (const r of raw) this.ledger.add(r.by, r.finding, 1)
      return
    }

    for (const g of groups) {
      const members = g.members.map(ref => byRef.get(ref)!).filter(Boolean)
      if (members.length === 0) continue
      const canonical = Math.max(0, members.findIndex(m => m.ref === g.canonical))
      this.ledger.addCluster(members.map(m => ({ by: m.by, finding: m.finding })), canonical, 1)
    }

    const merged = groups.filter(g => g.members.length > 1).length
    logger.info(`Judge clustered ${raw.length} raw finding(s) into ${groups.length} entr(ies) (${merged} merged)`)
  }

  /**
   * Round 2 — each finder rules on entries it did not raise, limited to code it reviewed.
   * Returns how many finders were actually given something to answer.
   */
  private async roundTwo(target: string): Promise<number> {
    this.options.onStage?.('round2', 'cross-adjudication')

    let asked = 0
    await Promise.all(this.finders.map(async finder => {
      const entries = this.ledger.forAdjudicationBy(finder.id, this.inScopeFor(finder.id))
      if (entries.length === 0) return
      asked++
      const prompt = buildAdjudicationPrompt({
        target,
        entries: entries.map(e => ({ id: e.id, file: e.file, line: e.line, title: e.title, description: e.description, evidence: e.evidence })),
        langSuffix: this.langSuffix,
      })
      try {
        const response = await this.ask(finder, prompt)
        const adjudications = parseAdjudications(response)
        if (!adjudications) {
          logger.warn(`[${finder.id}] unparseable adjudication output`)
          return
        }
        this.applyAdjudications(finder.id, adjudications, 2)
      } catch (err) {
        logger.warn(`[${finder.id}] adjudication failed:`, err)
      }
    }))
    return asked
  }

  /**
   * Rounds 3+ — open entries only, with every position taken so far in view.
   * Returns how many finders were given something to answer.
   */
  private async debateRound(target: string, round: number): Promise<number> {
    const open = this.ledger.conflicts()
    if (open.length === 0) return 0
    this.options.onStage?.(`round${round}`, `${open.length} open entr(ies)`)

    const payload = open.map(e => ({
      id: e.id,
      file: e.file,
      line: e.line,
      title: e.title,
      description: e.description,
      evidence: e.evidence,
      // Everything said so far, not only the objections — a finder cannot answer an argument
      // it was never shown, which is what limited earlier rounds to re-asserting.
      positions: e.adjudications.map(a => ({ stance: a.stance, evidence: a.evidence, note: a.note, round: a.round })),
      judgeRationale: e.judgeRationale,
    }))

    let asked = 0
    await Promise.all(this.finders.map(async finder => {
      const scope = this.inScopeFor(finder.id)
      const mine = payload.filter(p => {
        const entry = this.ledger.get(p.id)
        if (!entry || entry.raisedBy.includes(finder.id)) return false
        return !scope || scope(entry)
      })
      if (mine.length === 0) return
      asked++
      const prompt = buildConflictPrompt({ target, entries: mine, langSuffix: this.langSuffix })
      try {
        const response = await this.ask(finder, prompt)
        const adjudications = parseAdjudications(response)
        if (adjudications) this.applyAdjudications(finder.id, adjudications, round)
      } catch (err) {
        logger.warn(`[${finder.id}] round ${round} failed:`, err)
      }
    }))
    return asked
  }

  /**
   * The judge reads the positions and sets each entry's state.
   *
   * Every ruling is clamped to what the recorded evidence permits, so the worst a wrong or
   * malformed ruling can do is leave an entry more conservative than it deserves. Entries the
   * judge skips keep their previous state rather than defaulting to agreement.
   */
  private async judgeStates(target: string, round: number): Promise<void> {
    if (!this.judge) return
    const open = this.ledger.all().filter(e => e.state !== 'retracted' && e.adjudications.length > 0)
    if (open.length === 0) return

    this.options.onStage?.('judge', `ruling on ${open.length} entr(ies) after round ${round}`)
    const prompt = buildJudgeStatePrompt({
      target,
      round,
      entries: open.map(e => ({
        id: e.id,
        file: e.file,
        line: e.line,
        title: e.title,
        description: e.description,
        evidence: e.evidence,
        sources: e.raisedBy.length,
        positions: e.adjudications.map(a => ({ stance: a.stance, evidence: a.evidence, note: a.note, round: a.round })),
        allowed: this.ledger.legalStates(e),
      })),
      langSuffix: this.langSuffix,
    })

    let rulings: ReturnType<typeof parseRulings> = null
    try {
      const response = await this.ask(this.judge, prompt)
      rulings = parseRulings(response)
    } catch (err) {
      logger.warn(`Judge ruling failed after round ${round}:`, err)
    }

    if (!rulings) {
      logger.warn(`Judge output unusable after round ${round}; states left unchanged`)
      return
    }

    const ids = new Set(open.map(e => e.id))
    let applied = 0
    for (const r of rulings) {
      if (!ids.has(r.id)) continue       // the judge may not introduce entries either
      const actual = this.ledger.applyJudgeState(r.id, r.state, r.rationale)
      if (actual && actual !== r.state) {
        logger.warn(`Judge asked for ${r.id}=${r.state}, evidence only supports ${actual}`)
      }
      applied++
    }
    if (applied < open.length) {
      logger.info(`Judge ruled on ${applied}/${open.length} entries; the rest keep their previous state`)
    }
  }

  private applyAdjudications(by: string, adjudications: ReturnType<typeof parseAdjudications> & object, round: number): void {
    for (const a of adjudications) {
      this.ledger.adjudicate(a.id, { by, stance: a.stance, evidence: a.evidence, note: a.note, round })
      if (a.stance === 'refine' && a.patch) {
        this.ledger.refine(a.id, a.patch as Parameters<IssueLedger['refine']>[1])
      }
    }
  }

  /**
   * Verification. The contract is a set relation, enforced here rather than requested in
   * the prompt: everything sent must come back ruled on, and whatever doesn't is marked
   * unverified. The verifier cannot add entries — anything it reports about an unknown id
   * is discarded.
   */
  private async verify(target: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    this.options.onStage?.('verify', `${ids.length} entr(ies)`)

    const entries = ids.map(id => this.ledger.get(id)).filter(Boolean) as LedgerEntry[]
    const prompt = buildVerifierPrompt({
      target,
      entries: entries.map(e => ({ id: e.id, file: e.file, line: e.line, title: e.title, description: e.description, evidence: e.evidence, state: e.state })),
      langSuffix: this.langSuffix,
    })

    let verdicts: ReturnType<typeof parseVerdicts> = null
    for (let attempt = 1; attempt <= 2 && !verdicts; attempt++) {
      try {
        const response = await this.ask(this.verifier, attempt === 1
          ? prompt
          : `${prompt}\n\n---\nYour previous response could not be parsed. Output ONLY the fenced JSON block, with exactly one entry per finding above.`)
        verdicts = parseVerdicts(response)
        if (!verdicts) logger.warn(`Verifier output unparseable (attempt ${attempt}/2)`)
      } catch (err) {
        logger.warn(`Verifier call failed (attempt ${attempt}/2):`, err)
      }
    }

    if (verdicts) {
      const answered = new Set<string>()
      for (const v of verdicts) {
        if (!ids.includes(v.id)) continue    // verifier may not introduce entries
        answered.add(v.id)
        this.ledger.applyVerification(v.id, v.verdict, v.evidence, v.patch as Parameters<IssueLedger['refine']>[1])
        if (v.verdict === 'drop') {
          logger.info(`Verifier dropped ${v.id} "${this.ledger.get(v.id)?.title.slice(0, 80)}" — ${v.evidence?.slice(0, 200) || '(no evidence)'}`)
        }
      }
      const missing = ids.filter(id => !answered.has(id))
      if (missing.length > 0) {
        logger.warn(`Verifier did not rule on ${missing.length}/${ids.length} entries (${missing.join(', ')}); marking unverified`)
      }
    } else {
      logger.error(`Verification failed after 2 attempts; marking ${ids.length} entries unverified`)
    }

    this.ledger.markUnverified(ids)
  }

  /** The gap-filling half of the old auditor — may add, may not publish. */
  private async runGapFinder(target: string, coverage: CoverageLedger): Promise<string[]> {
    if (!this.gapFinder) return []
    this.options.onStage?.('gap-finder')

    const known = this.ledger.all().filter(e => e.state !== 'retracted')
    const prompt = buildGapFinderPrompt({
      target,
      knownTitles: known.map(e => `${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''} — ${e.title}`),
      uncoveredScopes: coverage.uncovered().map(r => r.scope),
      langSuffix: this.langSuffix,
    })

    try {
      const response = await this.ask(this.gapFinder, prompt)
      const parsed = parseFinderOutput(response)
      if (!parsed) {
        logger.warn('Gap finder output unparseable')
        return []
      }
      const before = new Set(this.ledger.all().map(e => e.id))
      for (const f of parsed.findings) this.ledger.add(this.gapFinder.id, f, 99)
      const added = this.ledger.all().filter(e => !before.has(e.id)).map(e => e.id)
      logger.info(`Gap finder: ${parsed.findings.length} reported, ${added.length} new after dedup against the ledger`)
      return added
    } catch (err) {
      logger.warn('Gap finder failed:', err)
      return []
    }
  }
}

/**
 * Bridge to the existing output/publishing path, which speaks MergedIssue.
 * Only the entries meant for inline comments become issues; the summary channel is
 * reported separately so it can't be mistaken for something worth interrupting the author.
 */
export function toMergedIssues(entries: LedgerEntry[]): MergedIssue[] {
  return entries.map(e => ({
    severity: e.impactSeverity,
    category: e.category,
    file: e.file,
    line: e.line,
    title: e.title,
    description: e.description,
    raisedBy: e.raisedBy,
    descriptions: [e.description],
    verdict: e.verification === 'drop' ? 'drop'
      : e.verification === 'rewrite' ? 'rewrite'
      : e.verification === 'keep' ? 'keep'
      : 'unverified',
    body: e.description,
    evidence: e.verifierEvidence || e.evidence,
  }) as MergedIssue)
}
