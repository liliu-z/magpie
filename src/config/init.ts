// src/config/init.ts
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface ReviewerOption {
  id: string
  name: string
  model: string
  description: string
  needsApiKey: boolean
  provider?: 'anthropic' | 'openai' | 'google'
}

export const AVAILABLE_REVIEWERS: ReviewerOption[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    model: 'claude-code',
    description: 'Uses your Claude Code subscription (no API key needed)',
    needsApiKey: false
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    model: 'codex-cli',
    description: 'Uses your OpenAI Codex CLI subscription (no API key needed)',
    needsApiKey: false
  },
  {
    id: 'claude-api',
    name: 'Claude Sonnet 4.5',
    model: 'claude-sonnet-4-5-20250514',
    description: 'Uses Anthropic API (requires ANTHROPIC_API_KEY)',
    needsApiKey: true,
    provider: 'anthropic'
  },
  {
    id: 'gpt',
    name: 'GPT-5.2',
    model: 'gpt-5.2',
    description: 'Uses OpenAI API (requires OPENAI_API_KEY)',
    needsApiKey: true,
    provider: 'openai'
  },
  {
    id: 'gemini',
    name: 'Gemini 3 Pro',
    model: 'gemini-3-pro',
    description: 'Uses Google AI API (requires GOOGLE_API_KEY)',
    needsApiKey: true,
    provider: 'google'
  }
]

const REVIEW_PROMPT = `Review this PR thoroughly. Analyze the code changes and provide feedback on:
      - Code correctness and potential bugs
      - Security concerns
      - Performance implications
      - Code quality and maintainability
      - Any other issues you notice

      Use 'gh pr view' and 'gh pr diff' to get the PR details.`

export function generateConfig(selectedReviewerIds: string[]): string {
  const selectedReviewers = AVAILABLE_REVIEWERS.filter(r => selectedReviewerIds.includes(r.id))

  // Determine which providers need API keys
  const needsAnthropic = selectedReviewers.some(r => r.provider === 'anthropic')
  const needsOpenai = selectedReviewers.some(r => r.provider === 'openai')
  const needsGoogle = selectedReviewers.some(r => r.provider === 'google')

  // Build providers section
  let providersSection = '# AI Provider API Keys (use environment variables)\nproviders:'
  if (needsAnthropic) {
    providersSection += `
  anthropic:
    api_key: \${ANTHROPIC_API_KEY}`
  }
  if (needsOpenai) {
    providersSection += `
  openai:
    api_key: \${OPENAI_API_KEY}`
  }
  if (needsGoogle) {
    providersSection += `
  google:
    api_key: \${GOOGLE_API_KEY}`
  }
  if (!needsAnthropic && !needsOpenai && !needsGoogle) {
    providersSection += ' {}'  // Empty providers if only CLI tools are used
  }

  // Build reviewers section
  let reviewersSection = '# Reviewer configurations\nreviewers:'
  for (const reviewer of selectedReviewers) {
    reviewersSection += `
  ${reviewer.id}:
    model: ${reviewer.model}
    prompt: |
      ${REVIEW_PROMPT}`
  }

  // Determine analyzer model (prefer first selected reviewer)
  const analyzerModel = selectedReviewers[0]?.model || 'claude-code'

  const config = `# Magpie Configuration

${providersSection}

# Default settings
defaults:
  max_rounds: 3
  output_format: markdown
  check_convergence: true  # Stop early when reviewers reach consensus

${reviewersSection}

# Analyzer configuration - runs before debate to provide context
analyzer:
  model: ${analyzerModel}
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
  model: ${analyzerModel}
  prompt: |
    You are a neutral technical reviewer.
    Based on the anonymous reviewer summaries, provide:
    - Points of consensus
    - Points of disagreement with analysis
    - Recommended action items
`

  return config
}

// Legacy default config for backwards compatibility
export const DEFAULT_CONFIG = generateConfig(['claude-code', 'codex-cli'])

export function initConfig(baseDir?: string, selectedReviewers?: string[]): string {
  const base = baseDir || homedir()
  const magpieDir = join(base, '.magpie')
  const configPath = join(magpieDir, 'config.yaml')

  if (existsSync(configPath)) {
    throw new Error(`Config already exists: ${configPath}`)
  }

  const config = selectedReviewers
    ? generateConfig(selectedReviewers)
    : DEFAULT_CONFIG

  mkdirSync(magpieDir, { recursive: true })
  writeFileSync(configPath, config, 'utf-8')

  return configPath
}
