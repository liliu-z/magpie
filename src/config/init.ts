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
    You are a neutral technical reviewer synthesizing the debate.
    Based on all reviewer feedback, generate a structured final conclusion in this EXACT format:

    # [PR identifier] 代码审查最终结论

    ## 共识点

    List issues where reviewers agree. For each issue:

    ### [N]. **[Severity]: [Issue Title]**
    - **位置**：\`file:line\` or component name
    - **问题**：What the issue is
    - **风险**：Impact if not fixed
    - **共识等级**：How strongly reviewers agree

    ## 分歧点

    List any disagreements between reviewers with analysis. If none, state "无明显分歧".

    ## 建议的行动项

    | 优先级 | 行动项 | 状态 |
    |--------|--------|------|
    | **P0 阻断** | Critical items that block merge | 必须修复 |
    | **P1 高风险** | High risk items | 需确认/需修复 |
    | **P2 改进** | Nice-to-have improvements | 可后续处理 |

    ## 总体评估

    **当前状态**：可合并 / 不可合并

    **合并条件**：
    1. List conditions that must be met

    **预计工作量**：Brief assessment of fix complexity
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
