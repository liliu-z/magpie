// src/commands/review/ledger-run.ts
import chalk from 'chalk'
import type { Reviewer, DebateResult } from '../../orchestrator/types.js'
import { LedgerOrchestrator, toMergedIssues } from '../../orchestrator/ledger-orchestrator.js'
import { corroborated, discardReason, type LedgerEntry } from '../../orchestrator/ledger.js'

function location(e: LedgerEntry): string {
  return `${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}`
}

/**
 * The three scores, spelled out. Every entry that did not make it inline carries these so a
 * reader can see which score held it back instead of having to trust the one-word reason.
 */
function scores(e: LedgerEntry): string {
  return `confidence: ${e.correctnessConfidence} · impact: ${e.impactSeverity} · actionable: ${e.actionability}`
}

export interface LedgerRunInput {
  finders: Reviewer[]
  verifier: Reviewer
  gapFinder?: Reviewer
  judge?: Reviewer
  label: string
  target: string
  targetDescription: string
  diffText: string
  maxRounds: number
  maxFilesPerShard?: number
  language?: string
  /** Facts shared with every finder; see `buildFinderPrompt` for why it must stay factual */
  sharedContext?: string
  /** How finders reach the diff; see `FinderPromptInput.changeAccess` */
  changeAccess?: string
  interruptState?: { interrupted: boolean }
}

/** Walks `publishDecision`'s summary branches in the same order, so the stated reason is
 *  the one that actually held the entry back rather than a plausible-looking guess. */
function describe(e: LedgerEntry): string {
  const loc = location(e)
  const why = e.state === 'disputed' || e.state === 'challenged'
    ? 'reviewers disagree'
    : e.verification === 'unanswered'
      ? 'not fact-checked'
      : e.correctnessConfidence === 'low'
        ? 'low confidence'
        : e.correctnessConfidence === 'medium' && !corroborated(e)
          ? 'single source'
          : e.actionability === 'low'
            ? 'no clear action'
            : 'held back'
  // The judge's one-liner is the only place that says WHY a disagreement stayed open, which
  // is what a reader needs to decide whether to look themselves
  const rationale = e.judgeRationale ? `  \n  ${e.judgeRationale}` : ''
  return `- **${loc}** — ${e.title} _(${why})_  \n  ${scores(e)} · raised by: ${e.raisedBy.join(', ')}${rationale}`
}

/**
 * Run the ledger flow and shape the outcome as a DebateResult.
 *
 * Everything downstream — terminal rendering, JSON output, the bot's consumption of
 * `parsedIssues` — keeps working unchanged, so the new flow can be trialled on real PRs
 * without touching the publishing path.
 */
export async function runLedgerReview(input: LedgerRunInput): Promise<DebateResult> {
  const orchestrator = new LedgerOrchestrator(
    input.finders,
    input.verifier,
    input.gapFinder,
    {
      maxRounds: input.maxRounds,
      maxFilesPerShard: input.maxFilesPerShard,
      language: input.language,
      gapFinderEnabled: !!input.gapFinder,
      sharedContext: input.sharedContext,
      changeAccess: input.changeAccess,
      interruptState: input.interruptState,
      onStage: (stage, detail) => {
        console.log(chalk.dim(`  [ledger] ${stage}${detail ? `: ${detail}` : ''}`))
      },
    },
    input.judge,
  )

  const run = await orchestrator.run(input.target, input.targetDescription, input.diffText)

  const sections: string[] = []
  // State how the rounds ended. "Ran out of rounds" and "nobody was still moving" mean very
  // different things about how settled the findings below are, and only one of them is a
  // reason to trust the disputed entries as genuinely unresolvable.
  sections.push(`## Coverage\n\n${run.coverageSummary}\n\n${run.roundsRun} round(s) — ${
    run.converged ? 'stopped because positions stopped changing' : 'stopped at the round limit, positions were still moving'
  }`)

  if (run.inline.length > 0) {
    sections.push(`## Reported inline (${run.inline.length})\n\n${run.inline.map(e =>
      `- **${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}** — ${e.title}  \n  confidence: ${e.correctnessConfidence} · impact: ${e.impactSeverity} · actionable: ${e.actionability} · raised by: ${e.raisedBy.join(', ')}`
    ).join('\n')}`)
  } else {
    sections.push('## Reported inline (0)\n\nNothing met the bar for an inline comment.')
  }

  if (run.summary.length > 0) {
    // Stated, not hidden: these are things we saw but deliberately did not interrupt for
    sections.push(`## Noted, not posted inline (${run.summary.length})\n\n${run.summary.map(describe).join('\n')}`)
  }

  // Named, not just counted. A bare count cannot be audited: it hides whether the gate threw
  // out a false positive or a real bug, which is the only question worth asking about a gate.
  const published = new Set([...run.inline, ...run.summary].map(e => e.id))
  const dropped = run.entries.filter(e => !published.has(e.id))
  if (dropped.length > 0) {
    sections.push(`## Discarded (${dropped.length})\n\n${dropped.map(e =>
      `- **${location(e)}** — ${e.title} _(${discardReason(e)})_  \n  ${scores(e)} · raised by: ${e.raisedBy.join(', ')}`
    ).join('\n')}`)
  }

  // Reported separately so each role can be judged on its own output rather than on the
  // pipeline's aggregate, which is what makes "is this stage worth its cost" answerable
  const roles: string[] = [
    `Finders: ${run.finderStats.map(s => `${s.finderId} raised ${s.raised} (${s.unique} only-it)`).join(' · ')}`,
  ]
  if (run.gapFinderStats) {
    const g = run.gapFinderStats
    const gapEntries = run.entries.filter(e => e.raisedBy.includes(g.finderId))
    roles.push(
      `Gap finder: proposed ${g.proposed}, ${g.added} new after dedup → verifier kept ${g.kept}, rewrote ${g.rewritten}, dropped ${g.dropped}, left ${g.unverified} unverified → ${g.inline} inline, ${g.summary} noted`,
    )
    if (gapEntries.length > 0) {
      roles.push(gapEntries.map(e =>
        `  - ${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''} — ${e.title} _(${e.verification ?? 'unverified'})_`
      ).join('\n'))
    }
  }
  sections.push(`## Who found what\n\n${roles.join('\n\n')}`)

  return {
    prNumber: input.label,
    analysis: '',
    messages: [],
    finalConclusion: sections.join('\n\n'),
    tokenUsage: run.tokenUsage,
    convergedAtRound: run.roundsRun,
    parsedIssues: toMergedIssues(run.inline),
  }
}
