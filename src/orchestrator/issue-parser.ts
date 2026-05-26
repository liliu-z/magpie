// src/orchestrator/issue-parser.ts
import type { ReviewIssue, ReviewerOutput, MergedIssue } from './types.js'

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'nitpick'] as const
const VALID_VERDICTS = ['approve', 'request_changes', 'comment'] as const
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, nitpick: 4 }

/**
 * Parse structured ReviewerOutput from a reviewer's response text.
 * Looks for a ```json block containing { issues, verdict, summary }.
 * Returns null if no valid JSON block found.
 */
export function parseReviewerOutput(response: string): ReviewerOutput | null {
  // Try ```json fenced block first, then raw JSON object
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/)
  let jsonStr = jsonMatch?.[1]

  if (!jsonStr) {
    // Try to find a raw JSON object with "issues" array
    const rawMatch = response.match(/\{[\s\S]*"issues"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
    if (rawMatch) jsonStr = rawMatch[0]
  }

  if (!jsonStr) return null

  try {
    const parsed = JSON.parse(jsonStr)

    if (!Array.isArray(parsed.issues)) {
      return null
    }

    const verdict = (typeof parsed.verdict === 'string' && VALID_VERDICTS.includes(parsed.verdict))
      ? parsed.verdict : 'comment'

    const issues: ReviewIssue[] = parsed.issues
      .filter((issue: Record<string, unknown>) =>
        typeof issue === 'object' &&
        VALID_SEVERITIES.includes(issue.severity as typeof VALID_SEVERITIES[number]) &&
        typeof issue.file === 'string' &&
        typeof issue.title === 'string' && (issue.title as string).trim().length > 0 &&
        typeof issue.description === 'string' && (issue.description as string).trim().length > 0
      )
      .map((issue: Record<string, unknown>) => {
        const line = typeof issue.line === 'number' && issue.line > 0 ? issue.line : undefined
        const endLine = typeof issue.endLine === 'number' && issue.endLine > 0 ? issue.endLine : undefined
        return {
          severity: issue.severity as ReviewIssue['severity'],
          category: typeof issue.category === 'string' ? issue.category : 'general',
          file: issue.file as string,
          line,
          endLine: line != null && endLine != null && endLine >= line ? endLine : undefined,
          title: (issue.title as string).trim(),
          description: (issue.description as string).trim(),
          suggestedFix: typeof issue.suggestedFix === 'string' ? issue.suggestedFix : undefined,
          codeSnippet: typeof issue.codeSnippet === 'string' ? issue.codeSnippet : undefined,
          raisedBy: Array.isArray(issue.raisedBy) ? issue.raisedBy as string[] : undefined
        }
      })

    return { issues, verdict, summary: parsed.summary || '' }
  } catch {
    return null
  }
}

/**
 * Deduplicate issues across multiple reviewers.
 * Issues with the same file + overlapping line + similar title are merged.
 * Merged issues keep the highest severity and track all contributing reviewers.
 */
export function deduplicateIssues(
  issuesByReviewer: Map<string, ReviewIssue[]>
): MergedIssue[] {
  const merged: MergedIssue[] = []

  for (const [reviewerId, issues] of issuesByReviewer) {
    for (const issue of issues) {
      const existing = merged.find(m => isSimilarIssue(m, issue))
      if (existing) {
        existing.raisedBy.push(reviewerId)
        existing.descriptions.push(issue.description)
        // Keep highest severity
        if (SEVERITY_ORDER[issue.severity] < SEVERITY_ORDER[existing.severity]) {
          existing.severity = issue.severity
        }
        // Keep suggested fix if we don't have one
        if (!existing.suggestedFix && issue.suggestedFix) {
          existing.suggestedFix = issue.suggestedFix
        }
      } else {
        merged.push({
          ...issue,
          raisedBy: [reviewerId],
          descriptions: [issue.description]
        })
      }
    }
  }

  // Sort by severity (critical first)
  merged.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  return merged
}

/**
 * Extract suggested review focus areas from analyzer output.
 * Matches the focus section heading in several flavors:
 *   - "## Suggested Review Focus" (English heading)
 *   - "## 建议的 review 重点" (Chinese heading with space)
 *   - "## 建议的review重点" (Chinese heading no space)
 *   - "**建议的 review 重点**" (bold variant)
 *   - "**Suggested Review Focus**" (English bold variant)
 * Reads until the next heading (##, **bold heading**) or end of section.
 */
export function parseFocusAreas(analysis: string): string[] {
  // Heading pattern: either a markdown heading (##) or a standalone bold line (**...**)
  // Title text matches Chinese or English variants.
  const titlePattern = '(?:Suggested\\s+Review\\s+Focus|建议的\\s*review\\s*重点)'
  // Optional leading numbering like "6.", "6、", "6）" before the title (analyzer may inline-number sections).
  const numberPrefix = '(?:\\d+[\\.、\\)）]\\s*)?'
  const headingRegex = new RegExp(
    // Either: line starting with ## (optional number prefix), then title (optionally wrapped in **)
    // Or: a standalone bold line **title** (with optional number prefix inside)
    `(?:^|\\n)(?:#{1,6}\\s*${numberPrefix}\\*{0,2}${titlePattern}\\*{0,2}|\\*\\*${numberPrefix}${titlePattern}\\*\\*)[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s|\\n\\*\\*[^\\n*]+\\*\\*\\s*\\n|$)`,
    'i'
  )
  const match = analysis.match(headingRegex)
  if (!match) return []

  const body = match[1].trim()
  if (!body) return []

  // Pull out lines that look like bulleted items.
  // Supported markers: "-", "*", "1.", "1)", "1、", "①", "•", and Chinese full-width number variants.
  const bulletRegex = /^\s*(?:[-*•·]|[①-⑳]|[\d]+[\.、\)）])\s+/u
  const lines = body.split('\n')
  const items: string[] = []
  for (const raw of lines) {
    if (!bulletRegex.test(raw)) continue
    const stripped = raw.replace(bulletRegex, '').trim()
    if (stripped.length === 0) continue
    items.push(stripped)
  }
  return items
}

const STOP_WORDS = new Set(['the', 'a', 'in', 'of', 'is', 'to', 'and', 'for', 'with', 'this', 'that', 'it'])

function filterStopWords(words: string[]): string[] {
  return words.filter(w => w.length > 0 && !STOP_WORDS.has(w))
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  const intersection = [...setA].filter(w => setB.has(w))
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection.length / union.size
}

/** Check if two line ranges overlap or are within proximity */
function linesOverlap(a: ReviewIssue, b: ReviewIssue): boolean {
  if (a.line == null || b.line == null) return true // No line info → don't reject
  const aStart = a.line
  const aEnd = a.endLine ?? a.line
  const bStart = b.line
  const bEnd = b.endLine ?? b.line
  // Overlap or within 5 lines of each other
  return aStart <= bEnd + 5 && bStart <= aEnd + 5
}

/** Check if two issues are similar enough to merge */
function isSimilarIssue(a: ReviewIssue, b: ReviewIssue): boolean {
  // Must be same file
  if (a.file !== b.file) return false

  // Check line range overlap
  if (!linesOverlap(a, b)) return false

  // Check title similarity (with stop words filtered)
  const wordsA = filterStopWords(a.title.toLowerCase().split(/\s+/))
  const wordsB = filterStopWords(b.title.toLowerCase().split(/\s+/))
  const titleSim = jaccardSimilarity(wordsA, wordsB)

  // Check description similarity (first 50 words)
  const descWordsA = filterStopWords(a.description.toLowerCase().split(/\s+/).slice(0, 50))
  const descWordsB = filterStopWords(b.description.toLowerCase().split(/\s+/).slice(0, 50))
  const descSim = jaccardSimilarity(descWordsA, descWordsB)

  return titleSim * 0.7 + descSim * 0.3 > 0.35
}
