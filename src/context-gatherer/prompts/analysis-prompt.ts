// src/context-gatherer/prompts/analysis-prompt.ts
import type { RawReference, RawHistoryItem, RawDoc, RelatedPR } from '../types.js'

export interface PromptData {
  prDiff: string
  changedFiles: string[]
  references: RawReference[]
  history: RawHistoryItem[]
  relatedPRs: RelatedPR[]
  docs: RawDoc[]
}

export function buildAnalysisPrompt(data: PromptData): string {
  const { prDiff, changedFiles, references, history, relatedPRs, docs } = data

  // Truncate diff if too long
  const maxDiffLength = 10000
  const truncatedDiff = prDiff.length > maxDiffLength
    ? prDiff.slice(0, maxDiffLength) + '\n... (truncated)'
    : prDiff

  // Format references (limit to top 20 files per symbol)
  const referencesText = references.map(ref => {
    const files = ref.foundInFiles.slice(0, 20)
    return `### ${ref.symbol}
Found in ${ref.foundInFiles.length} locations:
${files.map(f => `- ${f.file}:${f.line}: ${f.content.slice(0, 100)}`).join('\n')}`
  }).join('\n\n')

  // Format related PRs
  const relatedPRsText = relatedPRs.map(pr =>
    `- PR #${pr.number}: "${pr.title}" by ${pr.author} (${pr.relevance})`
  ).join('\n')

  // Format docs (limit content)
  const docsText = docs.map(doc => {
    const content = doc.content.length > 2000
      ? doc.content.slice(0, 2000) + '\n... (truncated)'
      : doc.content
    return `### ${doc.path}\n${content}`
  }).join('\n\n---\n\n')

  return `You are a senior software architect analyzing a PR's impact on the system.

## PR Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

## Changed Files
${changedFiles.map(f => `- ${f}`).join('\n')}

## Code References (grep results)
These are all the places where the changed functions/classes are referenced:

${referencesText || 'No references found.'}

## Related Recent PRs
${relatedPRsText || 'No related PRs found.'}

## Project Documentation
${docsText || 'No documentation found.'}

---

Based on the above information, analyze and provide:

1. **Affected Modules**: Identify which logical modules/features this PR affects. For each:
   - name: module name
   - path: base path
   - description: what this module does
   - affectedFiles: which PR files belong to this module
   - impactLevel: "core" (critical path), "moderate" (important but not critical), or "peripheral" (utilities/helpers)

2. **Call Chain Analysis**: From the grep results, identify the REAL call chains (not just string matches). For key functions/classes being modified:
   - Who calls them? (callers)
   - What's the calling context? (API endpoint, background job, test, etc.)

3. **Design Patterns**: Based on the code and documentation:
   - What design patterns are used in the affected areas?
   - Are there any conventions that this PR should follow?
   - Note if the pattern was found in documentation or inferred from code.

4. **Summary**: Write a 2-3 paragraph summary for code reviewers explaining:
   - What system areas this PR touches
   - What the impact and risks are
   - What reviewers should pay attention to

Respond in JSON format:
\`\`\`json
{
  "affectedModules": [...],
  "callChain": [...],
  "designPatterns": [...],
  "summary": "..."
}
\`\`\``
}
