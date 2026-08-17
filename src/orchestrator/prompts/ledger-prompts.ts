// src/orchestrator/prompts/ledger-prompts.ts
import type { Finding, Confidence, Severity, Stance, LedgerState, Verification } from '../ledger.js'
import type { Shard } from '../shard-planner.js'

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'nitpick']
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low']

const SCORE_RUBRIC = `Score each finding on three INDEPENDENT axes. Do not average them.

- "correctnessConfidence": how sure you are the mechanism is real and you have shown it.
    high   = you read the code and can point at the exact lines that make it happen
    medium = the mechanism is clear but one link is inferred
    low    = plausible, not demonstrated
- "impactSeverity": how bad it is IF real. critical | high | medium | low | nitpick
    nitpick = style or preference only, no behavioural consequence
- "actionability": can the author act on this right now?
    high   = exact location and a concrete fix or check
    medium = clear location, fix needs a design decision
    low    = vague location, or resolution needs information you don't have

A small but certain and fixable bug scores high/low/high — that is a valuable finding,
not a weak one. Do not inflate impact to make something get reported.`

const SELF_CHECK = `Every finding MUST answer these. They are fields, not suggestions —
an unanswered or "unsure" answer lowers the finding's confidence automatically.

- "introducedByThisChange": is this introduced by THIS change, or pre-existing? (yes|no|unsure)
- "reachableUnderDefaults": is the path reachable under current defaults and feature gates? (yes|no|unsure)
- "deliberate": do tests, comments, or commit history show this is intentional? (yes|no|unsure)
- "boundedImpact": one sentence stating the concrete, bounded consequence. No "may cause issues".

One finding = one failure mode. Do not bundle.
No evidence = no finding. Evidence means \`path/file.ext:LINE\` plus a short verbatim quote.`

export interface FinderPromptInput {
  target: string
  targetDescription?: string
  shard?: Shard
  /**
   * Optional extra angle for this finder. Off by default: finders asked different questions
   * produce agreement and silence the ledger cannot interpret — see the note in
   * ledger-orchestrator.ts.
   */
  lens?: string
  /**
   * Facts gathered once and shared by every finder: call sites, callers of changed symbols,
   * related files. Facts only — never an assessment of what matters or where to look, which
   * would give every finder the same framing and turn agreement back into an echo.
   */
  sharedContext?: string
  /**
   * How this finder gets at the diff, phrased for the target actually under review.
   * Without it the instruction was a bare "get the diff", which is unactionable on a local
   * review — and a finder that cannot reach the diff falls back to whatever fragment of it
   * reached the prompt and never opens a source file.
   */
  changeAccess?: string
  langSuffix?: string
}

/**
 * Round 1: find problems, independently.
 *
 * Nothing here mentions another reviewer, and the caller must not pass in a shared
 * "focus areas" summary — the point of round 1 is that two findings arriving at the same
 * conclusion is evidence. Once both parties start from the same framing, agreement means
 * only that the framing was persuasive.
 */
export function buildFinderPrompt(input: FinderPromptInput): string {
  const scope = input.shard
    ? `## Your scope

Review ONLY these files. Another reviewer covers the rest; work outside your scope is wasted.

${input.shard.files.map(f => `- ${f}`).join('\n')}

You may read anything in the repository for context, but only report findings whose fix
lands in the files above.`
    : `## Your scope

The entire change. Work through every changed file systematically.`

  return `Review ${input.target} for defects.
${input.targetDescription ? `\nTitle and description:\n${input.targetDescription}\n` : ''}
${scope}
${input.lens ? `
## Where to go deeper

Sweep your whole scope first — every changed file, every changed function. This angle is
where you spend the EXTRA effort once that sweep is done. It is not a filter: a serious
problem outside it is still yours to report, and skipping code because it looks like
someone else's angle is the one failure this cannot recover from.

${input.lens}
` : ''}${input.sharedContext ? `
## Known call sites and related code

Gathered mechanically to save you the lookup. It is a starting point, NOT a boundary:
this list is incomplete by construction, so code that does not appear here has not been
cleared — it has only not been looked up. Verify anything you rely on.

${input.sharedContext}
` : ''}
## How to work

${input.changeAccess || 'Get the diff'}, then read the actual source around every change. Check
callers of anything whose contract moved. Report what you can demonstrate.

${SELF_CHECK}

${SCORE_RUBRIC}

## Coverage

Report honestly which files you actually examined. "notReviewed" is a valid answer and is
more useful than a confident silence — never imply you covered something you did not.

## Output

Output ONLY this JSON block.

\`\`\`json
{
  "findings": [
    {
      "file": "internal/x/y.go",
      "line": 42,
      "category": "correctness",
      "title": "One line naming the failure mode",
      "description": "Plain prose: the mechanism, and what goes wrong.",
      "evidence": "internal/x/y.go:42 — \`if err != nil { return nil }\` — swallows the error",
      "introducedByThisChange": "yes",
      "reachableUnderDefaults": "yes",
      "deliberate": "no",
      "boundedImpact": "A failed load returns an empty result set instead of an error, so the caller reports success.",
      "correctnessConfidence": "high",
      "impactSeverity": "high",
      "actionability": "high"
    }
  ],
  "coverage": {
    "filesReviewed": ["internal/x/y.go"],
    "notReviewed": ["internal/x/big_generated.go"],
    "notes": "Skipped the generated file."
  }
}
\`\`\`

An empty "findings" array is an acceptable answer if the coverage is honest.${input.langSuffix || ''}`
}

export interface AdjudicationPromptInput {
  target: string
  entries: Array<{ id: string; file: string; line?: number; title: string; description: string; evidence?: string }>
  langSuffix?: string
}

/**
 * Round 2: check someone else's findings against the code.
 *
 * Entries arrive without authorship on purpose. Every entry sent here is inside the scope
 * this checker actually reviewed, so "I never looked at that" is not a possible answer —
 * which is why there is no abstain option to hide behind. The guard against agreeable-but-
 * empty confirmations is the evidence requirement: a stance without the checker's own
 * `file:LINE` + quote is discarded before it reaches the ledger.
 */
export function buildAdjudicationPrompt(input: AdjudicationPromptInput): string {
  const list = input.entries.map(e =>
    `### ${e.id}\nfile: ${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}\ntitle: ${e.title}\ndescription: ${e.description}${e.evidence ? `\nclaimed evidence: ${e.evidence}` : ''}`
  ).join('\n\n')

  return `These findings were reported against ${input.target} by another reviewer. Check each
one against the actual code and state your own position.

${list}

## Rules

- Verify from the code, not from how convincing the description sounds. Read the cited
  location and enough context to judge it yourself.
- Every stance REQUIRES your own evidence (\`file:LINE\` + a short verbatim quote you read
  yourself). A stance with no evidence is discarded, so an agreeable "confirm" you did not
  check buys nothing — it is simply thrown away.
- Do not agree to be agreeable. If you read the code and the claim does not hold, "refute"
  is the useful answer.
- Use "refine" when the underlying problem is real but the location, wording, or scores are wrong.

## Output

Output ONLY this JSON block, one entry per finding above.

\`\`\`json
{
  "adjudications": [
    {
      "id": "F1",
      "stance": "confirm",
      "evidence": "internal/x/y.go:42 — \`return nil\` — confirmed, error is dropped",
      "note": "Optional short remark.",
      "patch": { "line": 44, "impactSeverity": "medium" }
    }
  ]
}
\`\`\`

"patch" is only for "refine" — include just the fields that need correcting.${input.langSuffix || ''}`
}

export interface ConflictPromptInput {
  target: string
  entries: Array<{
    id: string
    file: string
    line?: number
    title: string
    description: string
    evidence?: string
    /** Every position taken so far, anonymised — not just the ones arguing against */
    positions: Array<{ stance: string; evidence?: string; note?: string; round: number }>
    judgeRationale?: string
  }>
  langSuffix?: string
}

/**
 * Round 3+: only the contested entries, with every position taken so far in view.
 *
 * A later round can only change someone's mind if it shows them what the other side actually
 * argued, so the full set of stances travels with the entry — an argument nobody can read is
 * an argument nobody can answer. It stays affordable because the round costs a handful of
 * contested entries instead of a full re-review.
 */
export function buildConflictPrompt(input: ConflictPromptInput): string {
  const list = input.entries.map(e => {
    const positions = e.positions.length > 0
      ? e.positions.map(p =>
          `  - [round ${p.round}] ${p.stance}: ${p.evidence || '(no evidence given)'}${p.note ? ` — ${p.note}` : ''}`
        ).join('\n')
      : '  - (none recorded)'
    return `### ${e.id}
file: ${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}
title: ${e.title}
description: ${e.description}
original evidence: ${e.evidence || '(none given)'}
positions taken so far:
${positions}${e.judgeRationale ? `\nwhy this is still open: ${e.judgeRationale}` : ''}`
  }).join('\n\n')

  return `The reviewers of ${input.target} have not agreed on the findings below. Every position
taken so far is shown, with authorship removed. Go read the code and settle each one.

${list}

## Rules

- Decide from the code. Neither side gets the benefit of the doubt, and the number of people
  on a side is not evidence.
- Every stance requires your own evidence (\`file:LINE\` + quote). Restating someone else's
  argument is not evidence; a stance without your own is discarded.
- Changing your earlier position is a good outcome if the code says so. Say what changed it.
- An honest unresolved disagreement is a legitimate result — it is reported to the author as
  unresolved rather than as fact — so do not manufacture agreement to close the round.

## Output

\`\`\`json
{
  "adjudications": [
    { "id": "F1", "stance": "confirm", "evidence": "file:LINE — quote — reasoning" }
  ]
}
\`\`\`${input.langSuffix || ''}`
}

export interface JudgeClusterPromptInput {
  target: string
  /** Findings from every finder, in one flat list, with authorship removed */
  findings: Array<{ ref: string; file: string; line?: number; title: string; description: string; evidence?: string }>
  langSuffix?: string
}

/**
 * The judge's first job: decide which of the raw findings are the same problem.
 *
 * This replaces a string-similarity merge, which could not tell "deadlock from lock ordering"
 * from "mutex acquired twice on the same path" and had to be patched every time two reviewers
 * chose different words for one bug. Semantic grouping is exactly the judgement a model adds.
 *
 * Two limits make it safe to hand over. The judge never writes finding text — it picks which
 * existing wording is canonical — and every input ref must come back in exactly one group,
 * which the caller enforces by giving any unmentioned ref a group of its own. So the judge can
 * group and rank, but it cannot quietly delete a finding or invent one, which is precisely how
 * the summarizer it replaces used to lose things.
 */
export function buildJudgeClusterPrompt(input: JudgeClusterPromptInput): string {
  const list = input.findings.map(f =>
    `### ${f.ref}\nfile: ${f.file}${typeof f.line === 'number' ? `:${f.line}` : ''}\ntitle: ${f.title}\ndescription: ${f.description}${f.evidence ? `\nevidence: ${f.evidence}` : ''}`
  ).join('\n\n')

  return `Several reviewers examined ${input.target} independently. Below is every finding they
reported, in one list, with authorship removed. Group the ones that describe the SAME problem.

${list}

## What counts as the same problem

Same underlying defect and same fix. Different wording, different line within the same
function, or different framing of one root cause all still count as the same problem.

These are NOT the same problem:
- two separate bugs that happen to sit in the same function
- a root cause and one of its downstream symptoms in another file
- the same category of mistake ("missing error check") at two unrelated call sites

When you are unsure, keep them separate. A wrong merge destroys one finding AND fabricates
agreement between two reviewers; a wrong split only leaves a near-duplicate to be sorted out
in the next round.

## Rules

- Every ref above must appear in exactly one group. A finding you are unsure about goes in a
  group by itself. Never drop a ref.
- "canonical" must be one of the refs in that group — pick the one whose wording is clearest
  and most precise about location. You do not write new text.
- A group of one is normal and expected.

## Output

Output ONLY this JSON block.

\`\`\`json
{
  "groups": [
    { "members": ["A1", "B3"], "canonical": "A1", "reason": "Both describe the map write outside the lock in Evict." },
    { "members": ["B1"], "canonical": "B1", "reason": "Only one reviewer raised this." }
  ]
}
\`\`\`${input.langSuffix || ''}`
}

export interface JudgeStatePromptInput {
  target: string
  round: number
  entries: Array<{
    id: string
    file: string
    line?: number
    title: string
    description: string
    evidence?: string
    /** How many distinct reviewers independently raised this */
    sources: number
    positions: Array<{ stance: string; evidence?: string; note?: string; round: number }>
    /** States the recorded evidence permits — the judge must pick one of these */
    allowed: string[]
  }>
  langSuffix?: string
}

/**
 * The judge's second job: read the positions on each entry and set its state.
 *
 * `allowed` is computed from what was actually recorded, and the caller rejects anything
 * outside it. So the judge decides whether a rebuttal lands — a real judgement call — but
 * cannot promote an unchecked finding to "confirmed" or invent a dispute nobody raised.
 */
export function buildJudgeStatePrompt(input: JudgeStatePromptInput): string {
  const list = input.entries.map(e => {
    const positions = e.positions.length > 0
      ? e.positions.map(p => `  - [round ${p.round}] ${p.stance}: ${p.evidence || '(no evidence given)'}${p.note ? ` — ${p.note}` : ''}`).join('\n')
      : '  - (nobody has checked this yet)'
    return `### ${e.id}
file: ${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}
title: ${e.title}
description: ${e.description}
original evidence: ${e.evidence || '(none given)'}
raised independently by: ${e.sources} reviewer(s)
positions:
${positions}
allowed states: ${e.allowed.join(', ')}`
  }).join('\n\n')

  return `You are the judge for the review of ${input.target}, after round ${input.round}.
For each entry below, weigh the positions and decide its state.

${list}

## States

- "confirmed"  — the claim holds. Either two reviewers found it independently, or someone
                 checked it against the code and their evidence stands up.
- "challenged" — someone rebutted it with evidence that has not been answered. Still open;
                 the next round will put it back in front of the reviewers.
- "disputed"   — both sides have real evidence and the disagreement is genuine. Use this only
                 when another round would not help.
- "raised"     — nobody has actually checked it yet, or the checks carry no evidence.

## How to weigh

- Evidence beats assertion, and quoted code beats paraphrase. A position with no evidence
  carries no weight regardless of how confidently it is stated.
- Counting positions is not judging. One rebuttal that quotes the line the claim depends on
  settles it against three confirmations that quote nothing.
- A rebuttal that answers a different claim than the one made does not land — say so.
- You may only pick from that entry's "allowed states". Anything else will be rejected and
  replaced with the conservative default, which helps nobody.
- Your "rationale" is one sentence and goes to the reviewers in the next round, so make it
  say what would actually resolve the entry.

## Output

Output ONLY this JSON block, one ruling per entry above.

\`\`\`json
{
  "rulings": [
    { "id": "F1", "state": "confirmed", "rationale": "The rebuttal cites the read path; the claim is about the write path." }
  ]
}
\`\`\`${input.langSuffix || ''}`
}

export interface VerifierPromptInput {
  target: string
  entries: Array<{ id: string; file: string; line?: number; title: string; description: string; evidence?: string; state: string }>
  langSuffix?: string
}

/**
 * Final fact-check. Three verdicts, and adding a finding is not one of them.
 *
 * Splitting "may kill" from "may add" is the point: when one call held both powers, whatever
 * it added had been read by nobody and shipped to the author unexamined. Additions now come
 * from the gap finder and come back through here.
 */
export function buildVerifierPrompt(input: VerifierPromptInput): string {
  const list = input.entries.map(e =>
    `### ${e.id}\nfile: ${e.file}${typeof e.line === 'number' ? `:${e.line}` : ''}\nstate: ${e.state}\ntitle: ${e.title}\ndescription: ${e.description}${e.evidence ? `\nclaimed evidence: ${e.evidence}` : ''}`
  ).join('\n\n')

  return `Verify each finding below against the actual code of ${input.target}, from first
principles. The description is a hypothesis; the code is the source of truth.

${list}

## Verdicts (exactly three)

- "keep"    — you read the code and the claim holds as written.
- "rewrite" — there is a real defect here, but the location, wording, or scores are wrong.
              Supply the corrections in "patch".
- "drop"    — the claim is contradicted by the code, or cannot be established from it.

There is no verdict for adding a finding. If you notice something nobody reported, it is out
of scope here — do not smuggle it in as a "rewrite" of an unrelated entry.

## How to verify

- Read the cited location plus enough surrounding code to judge it yourself.
- For a claim that something is MISSING ("no validation", "never unlocked", "silently"),
  search for the allegedly missing thing before concluding it is absent. A negative claim
  needs search evidence.
- For a claim that something HAPPENS, trace the path from entry point to the failure.

## Evidence is mandatory

Every verdict needs the exact \`file:LINE\` you read, a short verbatim quote, and one sentence
on how it supports or contradicts the claim. If you cannot produce all three, the verdict is
"drop".

## Output

Output ONLY this JSON block, one verdict per finding above. Every id must appear exactly once.

\`\`\`json
{
  "verdicts": [
    {
      "id": "F1",
      "verdict": "keep",
      "evidence": "internal/x/y.go:42 — \`m.data[k] = v\` — runs outside the RLock, confirming the claim",
      "patch": { "line": 44, "impactSeverity": "medium" }
    }
  ]
}
\`\`\`

"patch" is only for "rewrite" — include just the fields that need correcting.${input.langSuffix || ''}`
}

export interface GapFinderPromptInput {
  target: string
  knownTitles: string[]
  uncoveredScopes: string[]
  langSuffix?: string
}

/**
 * The gap-filling half of the old auditor, now a separate call with separate authority.
 *
 * It may raise new findings, but what it produces is a claim, not a conclusion: everything
 * it adds goes back through verification before it can reach the author. The old design let
 * the same call both add findings and decide what ships, so its additions had no check at all.
 */
export function buildGapFinderPrompt(input: GapFinderPromptInput): string {
  return `Reviewers have examined ${input.target} and already reported the findings listed below.
Your job is only to find what they MISSED.

Already reported (do not repeat these):
${input.knownTitles.map(t => `- ${t}`).join('\n') || '- (nothing reported)'}

${input.uncoveredScopes.length > 0
    ? `Nobody reviewed these areas — start there:\n${input.uncoveredScopes.map(s => `- ${s}`).join('\n')}`
    : 'All areas had a reviewer, so look for what a reviewer would systematically overlook.'}

Where gaps usually are:
- files or functions in the diff that nobody cited
- the same faulty pattern repeated in other files (if one instance was reported, grep for others)
- callers and consumers of a changed interface that were not updated together
- error paths, cancellation, and cleanup, which reviewers skim

${SELF_CHECK}

${SCORE_RUBRIC}

## Output

Same schema as a reviewer. Only NEW findings.

\`\`\`json
{
  "findings": [
    {
      "file": "internal/x/z.go", "line": 88, "category": "correctness",
      "title": "...", "description": "...", "evidence": "internal/x/z.go:88 — quote",
      "introducedByThisChange": "yes", "reachableUnderDefaults": "yes", "deliberate": "no",
      "boundedImpact": "...",
      "correctnessConfidence": "high", "impactSeverity": "medium", "actionability": "high"
    }
  ],
  "coverage": { "filesReviewed": [], "notReviewed": [], "notes": "" }
}
\`\`\`${input.langSuffix || ''}`
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function extractJson(response: string): any | null {
  const fenced = response.match(/```json\s*([\s\S]*?)\s*```/)
  const candidates = [fenced?.[1], response.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[]
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      continue
    }
  }
  return null
}

export interface RawFinding extends Partial<Finding> {
  introducedByThisChange?: string
  reachableUnderDefaults?: string
  deliberate?: string
  boundedImpact?: string
}

export interface ParsedFinderOutput {
  findings: Finding[]
  coverage: { filesReviewed: string[]; notReviewed: string[]; notes?: string }
}

const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }

/** Lower `have` to `cap` if it is currently more confident than `cap`. */
function capConfidence(have: Confidence, cap: Confidence): Confidence {
  return rank[have] >= rank[cap] ? have : cap
}

/**
 * Turn a finder's self-check answers into an actual confidence ceiling.
 *
 * Asking a model to self-assess and then ignoring the answers changes nothing; the answers
 * have to move something. These caps encode the failure modes that produced most of the
 * historical false positives: pre-existing problems reported as new, unreachable paths, and
 * deliberate design read as a bug.
 */
export function applySelfCheck(raw: RawFinding): Confidence {
  let conf: Confidence = CONFIDENCES.includes(raw.correctnessConfidence as Confidence)
    ? raw.correctnessConfidence as Confidence
    : 'low'

  if (!raw.evidence || !String(raw.evidence).trim()) conf = capConfidence(conf, 'low')
  if (raw.introducedByThisChange === 'no') conf = capConfidence(conf, 'low')
  if (raw.reachableUnderDefaults === 'no') conf = capConfidence(conf, 'low')
  if (raw.deliberate === 'yes') conf = capConfidence(conf, 'low')
  if (!raw.boundedImpact || !String(raw.boundedImpact).trim()) conf = capConfidence(conf, 'medium')

  const unsure = [raw.introducedByThisChange, raw.reachableUnderDefaults, raw.deliberate]
  if (unsure.some(a => a === undefined || a === 'unsure')) conf = capConfidence(conf, 'medium')

  return conf
}

/** Parse a finder/gap-finder response. Returns null when the response is unusable. */
export function parseFinderOutput(response: string, shardId?: string): ParsedFinderOutput | null {
  const obj = extractJson(response)
  if (!obj || !Array.isArray(obj.findings)) return null

  const findings: Finding[] = []
  for (const raw of obj.findings as RawFinding[]) {
    if (!raw || typeof raw.file !== 'string' || !raw.file.trim()) continue
    if (typeof raw.title !== 'string' || !raw.title.trim()) continue

    findings.push({
      file: raw.file.trim(),
      line: typeof raw.line === 'number' ? raw.line : undefined,
      category: typeof raw.category === 'string' && raw.category ? raw.category : 'general',
      title: raw.title.trim(),
      description: typeof raw.description === 'string' ? raw.description : raw.title.trim(),
      evidence: typeof raw.evidence === 'string' ? raw.evidence : undefined,
      correctnessConfidence: applySelfCheck(raw),
      impactSeverity: SEVERITIES.includes(raw.impactSeverity as Severity) ? raw.impactSeverity as Severity : 'low',
      actionability: CONFIDENCES.includes(raw.actionability as Confidence) ? raw.actionability as Confidence : 'low',
      shard: shardId,
    })
  }

  const cov = obj.coverage || {}
  return {
    findings,
    coverage: {
      filesReviewed: Array.isArray(cov.filesReviewed) ? cov.filesReviewed.filter((f: unknown) => typeof f === 'string') : [],
      notReviewed: Array.isArray(cov.notReviewed) ? cov.notReviewed.filter((f: unknown) => typeof f === 'string') : [],
      notes: typeof cov.notes === 'string' ? cov.notes : undefined,
    },
  }
}

export interface ParsedAdjudication {
  id: string
  stance: Stance
  evidence?: string
  note?: string
  patch?: Record<string, unknown>
}

const STANCES: Stance[] = ['confirm', 'refute', 'refine']

/** Parse an adjudication response. Returns null when the response is unusable. */
export function parseAdjudications(response: string): ParsedAdjudication[] | null {
  const obj = extractJson(response)
  if (!obj || !Array.isArray(obj.adjudications)) return null

  const out: ParsedAdjudication[] = []
  for (const raw of obj.adjudications) {
    if (!raw || typeof raw.id !== 'string') continue
    if (!STANCES.includes(raw.stance)) continue
    // A stance is only a check if the checker brings its own evidence. This is what stops a
    // model from agreeing its way through the list, now that there is no abstain to fall back on.
    const evidence = typeof raw.evidence === 'string' && raw.evidence.trim() ? raw.evidence.trim() : undefined
    if (!evidence) continue
    out.push({
      id: raw.id,
      stance: raw.stance,
      evidence,
      note: typeof raw.note === 'string' ? raw.note : undefined,
      patch: raw.patch && typeof raw.patch === 'object' ? raw.patch : undefined,
    })
  }
  return out
}

export interface ParsedGroup {
  members: string[]
  canonical: string
  reason?: string
}

/**
 * Parse the judge's clustering, then repair it against the refs that were actually sent.
 *
 * The repair is the safety property, not a convenience: a ref the judge forgot becomes its own
 * group, and a ref claimed twice stays with the first group only. So the output is always a
 * partition of the input — the judge can reorganise findings but cannot make one disappear,
 * which is the failure mode that made the old single-summarizer stage untrustworthy.
 */
export function parseClusters(response: string, refs: string[]): ParsedGroup[] | null {
  const obj = extractJson(response)
  if (!obj || !Array.isArray(obj.groups)) return null

  const valid = new Set(refs)
  const claimed = new Set<string>()
  const groups: ParsedGroup[] = []

  for (const raw of obj.groups) {
    if (!raw || !Array.isArray(raw.members)) continue
    const members = raw.members.filter(
      (m: unknown): m is string => typeof m === 'string' && valid.has(m) && !claimed.has(m),
    )
    if (members.length === 0) continue
    for (const m of members) claimed.add(m)
    const canonical = typeof raw.canonical === 'string' && members.includes(raw.canonical)
      ? raw.canonical
      : members[0]
    groups.push({ members, canonical, reason: typeof raw.reason === 'string' ? raw.reason : undefined })
  }

  // Anything the judge did not place survives on its own rather than being lost
  for (const ref of refs) {
    if (!claimed.has(ref)) groups.push({ members: [ref], canonical: ref })
  }

  return groups
}

export interface ParsedRuling {
  id: string
  state: LedgerState
  rationale?: string
}

const STATES: LedgerState[] = ['raised', 'confirmed', 'challenged', 'disputed']

/** Parse the judge's state rulings. Returns null when the response is unusable. */
export function parseRulings(response: string): ParsedRuling[] | null {
  const obj = extractJson(response)
  if (!obj || !Array.isArray(obj.rulings)) return null

  const out: ParsedRuling[] = []
  for (const raw of obj.rulings) {
    if (!raw || typeof raw.id !== 'string') continue
    if (!STATES.includes(raw.state)) continue
    out.push({
      id: raw.id,
      state: raw.state,
      rationale: typeof raw.rationale === 'string' && raw.rationale.trim() ? raw.rationale.trim() : undefined,
    })
  }
  return out
}

export interface ParsedVerdict {
  id: string
  verdict: Exclude<Verification, 'unanswered'>
  evidence?: string
  patch?: Record<string, unknown>
}

const VERDICTS = ['keep', 'rewrite', 'drop'] as const

/**
 * Parse the verifier's response.
 *
 * A verdict with no evidence is discarded rather than applied, so a "drop" the verifier could
 * not justify does not get to delete a finding — it degrades to unanswered, which is visible.
 */
export function parseVerdicts(response: string): ParsedVerdict[] | null {
  const obj = extractJson(response)
  if (!obj || !Array.isArray(obj.verdicts)) return null

  const out: ParsedVerdict[] = []
  for (const raw of obj.verdicts) {
    if (!raw || typeof raw.id !== 'string') continue
    if (!VERDICTS.includes(raw.verdict)) continue
    const evidence = typeof raw.evidence === 'string' && raw.evidence.trim() ? raw.evidence.trim() : undefined
    if (!evidence) continue
    out.push({
      id: raw.id,
      verdict: raw.verdict,
      evidence,
      patch: raw.patch && typeof raw.patch === 'object' ? raw.patch : undefined,
    })
  }
  return out
}
