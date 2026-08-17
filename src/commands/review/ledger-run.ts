// src/commands/review/ledger-run.ts
import chalk from 'chalk'
import type { Reviewer, DebateResult } from '../../orchestrator/types.js'
import { LedgerOrchestrator, toMergedIssues } from '../../orchestrator/ledger-orchestrator.js'
import type { LedgerEntry } from '../../orchestrator/ledger.js'

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
  interruptState?: { interrupted: boolean }
}

function describe(e: LedgerEntry): string {
  const loc = `${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}`
  const why = e.state === 'disputed' || e.state === 'challenged'
    ? 'reviewers disagree'
    : e.verification === 'unanswered'
      ? 'not fact-checked'
      : e.correctnessConfidence === 'low'
        ? 'low confidence'
        : e.actionability === 'low'
          ? 'no clear action'
          : e.state === 'raised'
            ? 'single source'
            : 'held back'
  // The judge's one-liner is the only place that says WHY a disagreement stayed open, which
  // is what a reader needs to decide whether to look themselves
  const rationale = e.judgeRationale ? `  \n  ${e.judgeRationale}` : ''
  return `- **${loc}** — ${e.title} _(${why})_${rationale}`
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

  const dropped = run.entries.length - run.inline.length - run.summary.length
  if (dropped > 0) {
    sections.push(`## Discarded (${dropped})\n\nRejected during verification, withdrawn, or style-only.`)
  }

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
