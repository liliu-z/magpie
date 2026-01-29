// src/context-gatherer/collectors/history-collector.ts
import { execSync } from 'child_process'
import type { RawHistoryItem, RelatedPR } from '../types.js'

/**
 * Get git history for specific files
 */
export function getFileHistory(
  files: string[],
  options: { maxDays?: number; cwd?: string } = {}
): RawHistoryItem[] {
  const { maxDays = 30, cwd = process.cwd() } = options
  const history: RawHistoryItem[] = []

  if (files.length === 0) return history

  try {
    // Get commits that touched these files in the last N days
    const fileArgs = files.map(f => `"${f}"`).join(' ')
    const result = execSync(
      `git log --since="${maxDays} days ago" --pretty=format:"%H|%s|%an|%aI" --name-only -- ${fileArgs}`,
      { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
    )

    if (!result.trim()) return history

    // Parse git log output
    const entries = result.trim().split('\n\n')
    for (const entry of entries) {
      const lines = entry.trim().split('\n')
      if (lines.length < 2) continue

      const [meta, ...fileLines] = lines
      const [hash, message, author, date] = meta.split('|')

      // Try to extract PR number from message (common formats)
      let prNumber: number | undefined
      const prMatch = message.match(/(?:#|PR\s*)(\d+)|(?:pull\/(\d+))/i)
      if (prMatch) {
        prNumber = parseInt(prMatch[1] || prMatch[2], 10)
      }

      history.push({
        commitHash: hash,
        message,
        author,
        date,
        files: fileLines.filter(f => f.trim()),
        prNumber
      })
    }
  } catch {
    // Ignore errors
  }

  return history
}

/**
 * Get directories from file paths
 */
export function getDirectories(files: string[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    if (parts.length > 1) {
      // Add immediate parent directory
      dirs.add(parts.slice(0, -1).join('/'))
      // Add top-level directory
      if (parts.length > 2) {
        dirs.add(parts.slice(0, 2).join('/'))
      }
    }
  }
  return Array.from(dirs)
}

/**
 * Get PR details using gh CLI
 */
export function getPRDetails(prNumber: number, cwd: string = process.cwd()): RelatedPR | null {
  try {
    const result = execSync(
      `gh pr view ${prNumber} --json number,title,author,mergedAt,files`,
      { cwd, encoding: 'utf-8' }
    )
    const data = JSON.parse(result)
    return {
      number: data.number,
      title: data.title,
      author: data.author?.login || 'unknown',
      mergedAt: data.mergedAt || '',
      overlappingFiles: data.files?.map((f: any) => f.path) || [],
      relevance: 'direct'
    }
  } catch {
    return null
  }
}

/**
 * Collect history for changed files and their directories
 */
export function collectHistory(
  changedFiles: string[],
  options: { maxDays?: number; maxPRs?: number; cwd?: string } = {}
): { history: RawHistoryItem[]; relatedPRs: RelatedPR[] } {
  const { maxDays = 30, maxPRs = 10, cwd = process.cwd() } = options

  // Get history for changed files
  const fileHistory = getFileHistory(changedFiles, { maxDays, cwd })

  // Get history for directories (same-module changes)
  const directories = getDirectories(changedFiles)
  const dirHistory = getFileHistory(directories, { maxDays, cwd })

  // Combine and dedupe
  const allHistory = [...fileHistory]
  const seenHashes = new Set(fileHistory.map(h => h.commitHash))
  for (const h of dirHistory) {
    if (!seenHashes.has(h.commitHash)) {
      allHistory.push(h)
      seenHashes.add(h.commitHash)
    }
  }

  // Extract unique PR numbers and fetch details
  const prNumbers = new Set<number>()
  for (const h of allHistory) {
    if (h.prNumber) prNumbers.add(h.prNumber)
  }

  const relatedPRs: RelatedPR[] = []
  let count = 0
  for (const prNum of prNumbers) {
    if (count >= maxPRs) break
    const pr = getPRDetails(prNum, cwd)
    if (pr) {
      // Determine relevance
      const hasDirectOverlap = pr.overlappingFiles.some(f => changedFiles.includes(f))
      pr.relevance = hasDirectOverlap ? 'direct' : 'same-module'
      relatedPRs.push(pr)
      count++
    }
  }

  return { history: allHistory, relatedPRs }
}
