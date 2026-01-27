// src/repo-scanner/types.ts
export interface FileInfo {
  path: string
  relativePath: string
  language: string
  lines: number
  size: number
}

export interface RepoStats {
  totalFiles: number
  totalLines: number
  languages: Record<string, number>
  estimatedTokens: number
  estimatedCost: number
}

export interface ScanOptions {
  path?: string
  ignore?: string[]
}

export const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.magpie',
  'dist',
  'build',
  'coverage',
  '*.min.js',
  '*.bundle.js',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml'
]
