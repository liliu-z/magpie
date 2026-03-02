import { logger } from './logger.js'

// Built-in patterns for generated/vendored files that are almost never worth reviewing
const BUILTIN_EXCLUDE_PATTERNS = [
  '*.pb.go',           // protobuf generated Go files
  '*.pb.cc',           // protobuf generated C++ files
  '*.pb.h',            // protobuf generated C++ headers
  '*generated*',       // any file with 'generated' in its name
  '**/generated/**',   // files under any 'generated/' directory
  '*.gen.go',          // go generate output
  '*.gen.ts',          // codegen output
  'vendor/**',         // vendored dependencies
  '**/vendor/**',      // nested vendor dirs
  'go.sum',            // go dependency checksums
  'package-lock.json', // npm lockfile
  'yarn.lock',         // yarn lockfile
  'pnpm-lock.yaml',    // pnpm lockfile
]

/**
 * Filter a unified diff to remove files matching exclude patterns.
 * Parses the diff into per-file hunks and drops matching ones.
 */
export function filterDiff(diff: string, userPatterns?: string[]): string {
  const patterns = [...BUILTIN_EXCLUDE_PATTERNS, ...(userPatterns || [])]
  if (patterns.length === 0) return diff

  const fileSections = splitDiffByFile(diff)

  let excludedCount = 0
  let excludedLines = 0
  const kept: string[] = []

  for (const section of fileSections) {
    const filePath = extractFilePath(section)
    if (filePath && shouldExclude(filePath, patterns)) {
      excludedCount++
      excludedLines += section.split('\n').length
      continue
    }
    kept.push(section)
  }

  if (excludedCount > 0) {
    logger.info(`Diff filter: excluded ${excludedCount} file(s) (~${excludedLines} lines)`)
  }

  return kept.join('')
}

/** Split a unified diff into per-file sections. */
function splitDiffByFile(diff: string): string[] {
  const sections: string[] = []
  const lines = diff.split('\n')
  let current: string[] = []

  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      sections.push(current.join('\n') + '\n')
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) {
    sections.push(current.join('\n'))
  }

  return sections
}

/** Extract file path from "diff --git a/path b/path". */
function extractFilePath(section: string): string | null {
  const match = section.match(/^diff --git a\/(.+?) b\//)
  return match ? match[1] : null
}

/**
 * Simple glob match supporting:
 *  - `*` matches any chars except `/`
 *  - `**` matches any chars including `/`
 *  - `?` matches a single char
 *  matchBase: pattern without `/` matches against basename only.
 */
function globMatch(filePath: string, pattern: string): boolean {
  // matchBase: if pattern has no slash, match against the basename
  if (!pattern.includes('/')) {
    const basename = filePath.split('/').pop() || filePath
    return regexMatch(basename, pattern)
  }
  return regexMatch(filePath, pattern)
}

function regexMatch(str: string, pattern: string): boolean {
  // Convert glob to regex
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches everything including /
        regex += '.*'
        i += 2
        if (pattern[i] === '/') i++ // skip trailing /
        continue
      }
      regex += '[^/]*'
    } else if (c === '?') {
      regex += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      regex += '\\' + c
    } else {
      regex += c
    }
    i++
  }
  return new RegExp(`^${regex}$`).test(str)
}

function shouldExclude(filePath: string, patterns: string[]): boolean {
  return patterns.some(p => globMatch(filePath, p))
}
