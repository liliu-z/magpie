// src/context-gatherer/collectors/reference-collector.ts
import { execSync } from 'child_process'
import type { RawReference } from '../types.js'

/**
 * Extract function/class names from diff
 */
export function extractSymbolsFromDiff(diff: string): string[] {
  const symbols: Set<string> = new Set()

  // Match function definitions: function name(, async function name(, const name = (, etc.
  const functionPatterns = [
    /^\+.*(?:function|async function)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm,
    /^\+.*(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(/gm,
    /^\+.*(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm,
  ]

  // Match class definitions
  const classPattern = /^\+.*class\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm

  // Match method definitions in classes
  const methodPattern = /^\+\s+(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*[:{]/gm

  // Match exported names
  const exportPattern = /^\+.*export\s+(?:const|let|var|function|class|async function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm

  for (const pattern of [...functionPatterns, classPattern, methodPattern, exportPattern]) {
    let match
    while ((match = pattern.exec(diff)) !== null) {
      const name = match[1]
      // Filter out common keywords and short names
      if (name && name.length > 2 && !['get', 'set', 'new', 'for', 'if', 'do'].includes(name)) {
        symbols.add(name)
      }
    }
  }

  return Array.from(symbols)
}

/**
 * Find references to symbols using ripgrep
 */
export function findReferences(symbols: string[], cwd: string = process.cwd()): RawReference[] {
  const references: RawReference[] = []

  for (const symbol of symbols) {
    try {
      // Use ripgrep to find all occurrences
      // -n: line numbers, -H: filename, --no-heading: no grouping
      const result = execSync(
        `rg -n -H --no-heading "${symbol}" --type ts --type js --type tsx --type jsx 2>/dev/null || true`,
        { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
      )

      if (!result.trim()) continue

      const foundInFiles: { file: string; line: number; content: string }[] = []
      const lines = result.trim().split('\n')

      for (const line of lines) {
        // Format: file:line:content
        const match = line.match(/^([^:]+):(\d+):(.*)$/)
        if (match) {
          foundInFiles.push({
            file: match[1],
            line: parseInt(match[2], 10),
            content: match[3].trim()
          })
        }
      }

      if (foundInFiles.length > 0) {
        references.push({ symbol, foundInFiles })
      }
    } catch {
      // Ignore errors (e.g., ripgrep not found)
    }
  }

  return references
}

/**
 * Collect all references for changed files
 */
export function collectReferences(diff: string, cwd: string = process.cwd()): RawReference[] {
  const symbols = extractSymbolsFromDiff(diff)
  return findReferences(symbols, cwd)
}
