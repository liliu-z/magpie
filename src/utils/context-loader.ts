import { readFileSync, existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { homedir } from 'os'

// Provider → preferred context file, then fallbacks
const PROVIDER_CONTEXT_MAP: Record<string, string[]> = {
  'claude-code': ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'],
  'gemini-cli':  ['GEMINI.md', 'AGENTS.md', 'CLAUDE.md'],
  'codex-cli':   ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'],
}
const DEFAULT_CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']

/**
 * Walk up from startDir to root, find the first matching context file.
 * Returns the file content or empty string.
 */
function findContextFile(startDir: string, filename: string): string {
  let current = resolve(startDir)

  while (true) {
    const filePath = join(current, filename)
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8').trim()
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return ''
}

/**
 * Load project context for a specific provider/reviewer model.
 * - claude-code: prefers CLAUDE.md, falls back to AGENTS.md then GEMINI.md
 * - gemini-cli:  prefers GEMINI.md, falls back to AGENTS.md then CLAUDE.md
 * - codex-cli:   prefers AGENTS.md, falls back to CLAUDE.md then GEMINI.md
 * - others:      tries CLAUDE.md then AGENTS.md then GEMINI.md
 *
 * Also loads user-level ~/.claude/CLAUDE.md if it exists.
 */
export function loadProjectContext(model?: string, startDir?: string): string {
  const dir = startDir || process.cwd()
  const parts: string[] = []

  // 1. User-level context (~/.claude/CLAUDE.md)
  const userContext = join(homedir(), '.claude', 'CLAUDE.md')
  if (existsSync(userContext)) {
    parts.push(readFileSync(userContext, 'utf-8').trim())
  }

  // 2. Project-level context: try preferred file first, then fallbacks
  const candidates = (model && PROVIDER_CONTEXT_MAP[model]) || DEFAULT_CONTEXT_FILES
  for (const filename of candidates) {
    const content = findContextFile(dir, filename)
    if (content) {
      parts.push(content)
      break // Use only the first match (preferred or fallback)
    }
  }

  return parts.filter(Boolean).join('\n\n---\n\n')
}
