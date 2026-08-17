// src/context-gatherer/prompts/agent-prompt.ts

export interface AgentPromptInput {
  /** What is being reviewed — a PR URL for PR reviews, or a branch/local description */
  target: string
  /** Optional PR title/body, when the caller already has it */
  targetDescription?: string
  maxFilesToRead: number
  maxRelatedPRs: number
  historyDays: number
}

/**
 * Prompt for the agent-mode context gatherer.
 *
 * Deliberately states the goal and the boundaries, not a step list: the whole point
 * of using a tool-capable model here is that it can decide what is worth looking at.
 * A step list would just reproduce the deterministic collector it replaces.
 *
 * Two things are non-negotiable and stated as hard rules:
 *  - a budget, or the agent will read the entire repository;
 *  - evidence (file:line) for every claim, or it will invent call chains — which is
 *    exactly the failure this mode exists to fix.
 */
export function buildAgentContextPrompt(input: AgentPromptInput, language?: string): string {
  const langNote = language
    ? `\n\nWrite every description and the summary in ${language}. Keep file paths, symbol names and JSON keys in English.`
    : ''

  return `You are preparing background context for a code review of ${input.target}.
${input.targetDescription ? `\nTitle and description:\n${input.targetDescription}\n` : ''}
## Your job

Reviewers will read the code themselves. You are NOT reviewing it — do not report bugs,
do not judge the code, do not suggest fixes. Your job is to answer the questions a reviewer
would otherwise have to spend their first 20 minutes answering:

- Which modules does this change actually touch, and is each one core or peripheral to it?
- Who calls the functions/interfaces that changed? What breaks if their contract changed?
- Why were these files touched recently — is this change continuing or reverting something?
- Are there design docs, ADRs, or conventions in this repo that govern this area?

Use your tools to find out. Start by getting the actual diff, then follow whatever thread
looks most informative. You decide what is worth reading — that judgement is why you are
doing this instead of a script.

## Hard rules

1. **Read-only.** Do not modify, create, or delete any file. Do not commit, push, or run any
   git write command. Do not post comments anywhere.
2. **Budget.** Read at most ${input.maxFilesToRead} files. Prefer breadth (many greps) over
   depth (reading whole large files). Stop when the budget is spent and report what you have.
3. **Evidence or silence.** Every module, caller, and pattern you report must come from
   something you actually read, cited as \`path/to/file.ext:LINE\`. If you did not verify it,
   leave it out. An empty list is a correct answer; a plausible guess is not.
4. **At most ${input.maxRelatedPRs} related PRs**, from the last ${input.historyDays} days.

## Output

Output ONLY this JSON block. No narrative before or after.

\`\`\`json
{
  "affectedModules": [
    {
      "name": "querynode",
      "path": "internal/querynodev2",
      "description": "What this module does and how this change affects it.",
      "affectedFiles": ["internal/querynodev2/segments/segment.go"],
      "totalFiles": 42,
      "impactLevel": "core"
    }
  ],
  "callChain": [
    {
      "symbol": "LoadSegment",
      "file": "internal/querynodev2/segments/segment.go:118",
      "callers": [
        { "symbol": "handleLoad", "file": "internal/querynodev2/services.go:340", "context": "gRPC entry point" }
      ]
    }
  ],
  "designPatterns": [
    {
      "pattern": "Name of the convention or pattern",
      "location": "docs/design/x.md:20 or the file that establishes it",
      "description": "What the rule is and whether this change follows it.",
      "source": "documentation"
    }
  ],
  "summary": "2-3 paragraphs for the reviewer: what area this lands in, which contracts it touches, what an experienced reviewer of this codebase should look at first. State plainly what you could NOT determine."
}
\`\`\`

- \`impactLevel\`: "core" (the change is about this module), "moderate" (this module is
  meaningfully involved), "peripheral" (incidental edits only).
- \`source\`: "documentation" if a doc states it, "inferred" if you concluded it from code.
- If a section has nothing verified, return an empty array for it. Do not pad.${langNote}`
}
