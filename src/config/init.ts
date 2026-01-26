// src/config/init.ts
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const DEFAULT_CONFIG = `# Magpie Configuration

# AI Provider API Keys (use environment variables)
providers:
  anthropic:
    api_key: \${ANTHROPIC_API_KEY}
  openai:
    api_key: \${OPENAI_API_KEY}
  google:
    api_key: \${GOOGLE_API_KEY}

# Default settings
defaults:
  max_rounds: 3
  output_format: markdown
  check_convergence: true  # Stop early when reviewers reach consensus

# Reviewer configurations
reviewers:
  claude:
    model: claude-code
    prompt: |
      Review this PR thoroughly. Analyze the code changes and provide feedback on:
      - Code correctness and potential bugs
      - Security concerns
      - Performance implications
      - Code quality and maintainability
      - Any other issues you notice

      Use 'gh pr view' and 'gh pr diff' to get the PR details.

  gemini:
    model: gemini-1.5-flash
    prompt: |
      Review this PR thoroughly. Analyze the code changes and provide feedback on:
      - Code correctness and potential bugs
      - Security concerns
      - Performance implications
      - Code quality and maintainability
      - Any other issues you notice

      Use 'gh pr view' and 'gh pr diff' to get the PR details.

# Analyzer configuration - runs before debate to provide context
analyzer:
  model: claude-code
  prompt: |
    You are a senior engineer providing PR context analysis.
    Before the review debate begins, analyze this PR and provide:

    1. **What this PR does** - A clear summary of the changes
    2. **Architecture/Design** - Key architectural decisions and patterns used
    3. **Purpose** - What problem this solves or what feature it adds
    4. **Trade-offs** - Any trade-offs made and why
    5. **Things to note** - Important details reviewers should pay attention to

    Use 'gh pr view' and 'gh pr diff' to get the PR details.
    Be concise but thorough.

# Summarizer configuration
summarizer:
  model: claude-code
  prompt: |
    You are a neutral technical reviewer.
    Based on the anonymous reviewer summaries, provide:
    - Points of consensus
    - Points of disagreement with analysis
    - Recommended action items
`

export function initConfig(baseDir?: string): string {
  const base = baseDir || homedir()
  const magpieDir = join(base, '.magpie')
  const configPath = join(magpieDir, 'config.yaml')

  if (existsSync(configPath)) {
    throw new Error(`Config already exists: ${configPath}`)
  }

  mkdirSync(magpieDir, { recursive: true })
  writeFileSync(configPath, DEFAULT_CONFIG, 'utf-8')

  return configPath
}
