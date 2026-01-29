# Magpie

Multi-AI adversarial PR review tool. Let different AI models review your code like Linus Torvalds, generating more comprehensive reviews through debate.

## Core Concepts

- **Same Perspective, Different Models**: All reviewers use the same prompt (Linus-style), but are powered by different AI models
- **Natural Adversarial**: Differences between models naturally create disagreements and debates
- **Anti-Sycophancy**: Explicitly tells AI they're debating with other AIs, preventing mutual agreement bias
- **Fair Debate Model**: All reviewers in the same round see identical information - no unfair advantage from execution order
- **Parallel Execution**: Same-round reviewers run concurrently for faster reviews

## Supported AI Providers

| Provider | Type | Description |
|----------|------|-------------|
| `claude-code` | CLI | Claude Code CLI (uses your subscription, no API key) |
| `codex-cli` | CLI | OpenAI Codex CLI (uses your subscription, no API key) |
| `gemini-cli` | CLI | Gemini CLI (uses Google account login, no API key) |
| `claude-*` | API | Anthropic API (requires ANTHROPIC_API_KEY) |
| `gpt-*` | API | OpenAI API (requires OPENAI_API_KEY) |
| `gemini-*` | API | Google Gemini API (requires GOOGLE_API_KEY) |

**Recommended**: Use CLI providers (claude-code, codex-cli, gemini-cli) - they're free with your subscriptions and don't require API keys.

## Installation

```bash
# Clone the repo
git clone https://github.com/liliu-z/magpie.git
cd magpie

# Install dependencies
npm install

# Build
npm run build

# Global install (optional)
npm link
```

## Quick Start

```bash
# Initialize config file (interactive)
magpie init

# Or with defaults
magpie init -y

# Navigate to the repo you want to review
cd your-repo

# Start review (PR number)
magpie review 12345

# Or with full URL
magpie review https://github.com/owner/repo/pull/12345

# Start a discussion on any topic
magpie discuss "Should we use microservices or monolith?"
```

## Configuration

Config file is located at `~/.magpie/config.yaml`:

```yaml
# AI Providers (CLI tools don't need config)
providers: {}

# Default settings
defaults:
  max_rounds: 5           # Maximum debate rounds
  output_format: markdown
  check_convergence: true  # Stop early when consensus reached

# Reviewers - same perspective, different models
reviewers:
  claude:
    model: claude-code
    prompt: |
      You are a senior engineer reviewing this PR. Be direct and concise like Linus Torvalds,
      but constructive rather than harsh.

      Focus on:
      1. **Correctness** - Will this code work? Edge cases?
      2. **Security** - Any vulnerabilities? Input validation?
      3. **Architecture** - Does this fit the overall design? Any coupling issues?
      4. **Simplicity** - Is this the simplest solution? Over-engineering?

  gemini:
    model: gemini-cli
    prompt: |
      # Same as above...

# Analyzer - PR analysis (before debate)
analyzer:
  model: claude-code
  prompt: |
    You are a senior engineer providing PR context analysis.
    Analyze this PR and provide:
    1. What this PR does
    2. Architecture/design decisions
    3. Purpose
    4. Trade-offs
    5. Things to note

# Summarizer - final conclusion
summarizer:
  model: claude-code
  prompt: |
    You are a neutral technical reviewer. Based on the anonymous reviewer summaries, provide:
    1. Points of consensus
    2. Points of disagreement
    3. Recommended action items
    4. Overall assessment

# Context Gatherer - system context before review (optional)
contextGatherer:
  enabled: true              # Enable/disable context gathering
  model: claude-code         # Optional: defaults to analyzer model
  callChain:
    maxDepth: 2              # How deep to trace call chains
    maxFilesToAnalyze: 20    # Max files to analyze for call chains
  history:
    maxDays: 30              # Look back period for related PRs
    maxPRs: 10               # Max related PRs to include
  docs:
    patterns:                # Doc files to include for context
      - docs
      - README.md
      - ARCHITECTURE.md
      - DESIGN.md
    maxSize: 50000           # Max total size of doc content
```

## CLI Options

```bash
magpie review [pr-number|url] [options]

Options:
  -c, --config <path>       Path to config file
  -r, --rounds <number>     Maximum debate rounds (default: 5)
  -i, --interactive         Interactive mode (pause between turns, Q&A)
  -o, --output <file>       Output to file
  -f, --format <format>     Output format (markdown|json)
  --no-converge             Disable convergence detection (enabled by default)
  -l, --local               Review local uncommitted changes
  -b, --branch [base]       Review current branch vs base (default: main)
  --files <files...>        Review specific files
  --reviewers <ids>         Comma-separated reviewer IDs (e.g., claude-code,gemini-cli)
  -a, --all                 Use all configured reviewers (skip selection)
  --git-remote <remote>     Git remote for PR URL detection (default: origin)
  --skip-context            Skip context gathering phase
  --plan-only               Generate review plan without executing
  --reanalyze               Force re-analyze features (ignore cache)

  # Repository Review Options
  --repo                    Review entire repository
  --path <path>             Subdirectory to review (with --repo)
  --ignore <patterns...>    Patterns to ignore (with --repo)
  --quick                   Quick mode: only architecture overview
  --deep                    Deep mode: full analysis without prompts
  --list-sessions           List all review sessions
  --session <id>            Resume specific session by ID
  --export <file>           Export completed review to markdown
```

### Discuss Command

```bash
magpie discuss [topic] [options]

Options:
  -c, --config <path>       Path to config file
  -r, --rounds <number>     Maximum debate rounds (default: 5)
  -i, --interactive         Interactive mode (follow-up Q&A after conclusion)
  -o, --output <file>       Output to file
  -f, --format <format>     Output format (markdown|json)
  --no-converge             Disable convergence detection
  --reviewers <ids>         Comma-separated reviewer IDs
  -a, --all                 Use all configured reviewers
  -d, --devil-advocate      Add a Devil's Advocate to challenge consensus
  --list                    List all discuss sessions
  --resume <id>             Resume a discuss session with follow-up question
```

### Reviewer Selection

By default, Magpie prompts you to select reviewers interactively:

```bash
# Interactive selection (default)
magpie review 12345

# Select reviewers from config:
#   1. claude-code
#   2. codex-cli
#   3. gemini-cli
# Enter numbers separated by commas (e.g., 1,2): 1,3
```

You can also specify reviewers directly:

```bash
# Use all configured reviewers
magpie review 12345 --all
magpie review 12345 -a

# Specify reviewers by ID
magpie review 12345 --reviewers claude-code,gemini-cli
```

### Review Modes

```bash
# Review a GitHub PR (number or URL)
magpie review 12345
magpie review https://github.com/owner/repo/pull/12345

# Review local uncommitted changes (staged + unstaged)
magpie review --local

# Review current branch vs main
magpie review --branch

# Review current branch vs specific base
magpie review --branch develop

# Review specific files
magpie review --files src/foo.ts src/bar.ts
```

### Repository Review

Review an entire repository with feature-based analysis:

```bash
# Full repository review (interactive)
magpie review --repo

# Quick stats only
magpie review --repo --quick

# Deep analysis (no prompts)
magpie review --repo --deep

# Review specific subdirectory
magpie review --repo --path src/api

# List/resume sessions
magpie review --list-sessions
magpie review --session abc123

# Export completed review
magpie review --export review-report.md
```

Repository review includes:
- AI-powered feature detection (identifies logical modules)
- Session persistence (pause/resume reviews)
- Focus area selection (security, performance, architecture, etc.)
- Progress saving between runs

### Topic Discussion

Discuss any technical topic with multiple AI reviewers through adversarial debate:

```bash
# Basic discussion
magpie discuss "Should we use microservices or monolith for our new project?"

# From a file (supports markdown)
magpie discuss /path/to/architecture-proposal.md

# With Devil's Advocate to challenge consensus
magpie discuss "Is Kubernetes overkill for our scale?" -d

# Interactive mode for follow-up Q&A
magpie discuss "How should we handle database migrations?" -i

# List all discuss sessions
magpie discuss --list

# Resume a previous discussion with follow-up
magpie discuss --resume abc123 "What about rollback strategies?"
```

Discussion features:
- **Multi-perspective analysis**: Different AI models debate the topic from their unique viewpoints
- **Devil's Advocate mode** (`-d`): Adds a dedicated contrarian to stress-test ideas
- **Session persistence**: Save/resume discussions for multi-session deep dives
- **Language matching**: Automatically responds in the same language as your topic (Chinese/English)
- **Interactive follow-up**: Continue the discussion with additional questions
- **Project context**: Optionally loads project-specific context for relevant discussions

## Workflow

```
1. Context Gathering (if enabled)
   │  Collects: affected modules, related PRs, call chains
   ↓
2. Analyzer analyzes PR
   ↓
3. [Interactive] Post-analysis Q&A (ask specific reviewers)
   ↓
4. Multi-round debate
   ├─ Round 1: All reviewers give INDEPENDENT opinions (parallel)
   │           No reviewer sees others' responses yet
   │           ↓
   ├─ Convergence check: Did reviewers reach consensus?
   │           ↓
   ├─ Round 2+: Reviewers see ALL previous rounds (parallel)
   │            Each reviewer responds to others' points
   │            Same-round reviewers see identical information
   │            ↓
   └─ ... (repeat until max rounds or convergence)
   ↓
5. Each Reviewer summarizes their points
   ↓
6. Summarizer produces final conclusion
```

### Fair Debate Model

Magpie uses a fair debate model where:

- **Round 1**: Each reviewer gives their independent opinion without seeing others
- **Round 2+**: Each reviewer sees ALL previous rounds' messages
- **Same-round fairness**: All reviewers in the same round see identical information
- **Parallel execution**: Same-round reviewers run concurrently (faster reviews)

This ensures no reviewer has an unfair advantage from execution order.

## Features

### Context Gathering

Before the review begins, Magpie automatically gathers system-level context to help reviewers understand the broader impact of changes:

- **Affected Modules**: Identifies which parts of the system are impacted (core, moderate, low)
- **Related PRs**: Finds relevant past PRs from project history
- **Call Chain Analysis**: Traces how changed code connects to the rest of the system

```
┌─ System Context ─────────────────────────────────────────┐
│ Affected Modules:                                        │
│   • [core] src/orchestrator - Main review orchestration  │
│   • [moderate] src/config - Configuration handling       │
│                                                          │
│ Related PRs:                                             │
│   • #42 - Added streaming support                        │
│   • #38 - Refactored provider interface                  │
└──────────────────────────────────────────────────────────┘
```

Use `--skip-context` to disable, or configure in `contextGatherer` section of config.

### Session Persistence

Reviewers that support sessions maintain context across debate rounds, reducing token usage.

| Provider | Session Support | Notes |
|----------|-----------------|-------|
| `claude-code` | Yes | Full session with explicit ID |
| `codex-cli` | Yes | Full session with explicit ID |
| `gemini-cli` | No | Uses full context each round |
| API providers | No | Uses full context each round |

### Parallel Execution

All reviewers in the same round execute concurrently. Results are collected and displayed after all reviewers complete:

```
⠋ Round 1: All reviewers thinking (parallel)...
   ↓ (all reviewers running simultaneously)
[claude-code]: First review...
[gemini-cli]: First review...
   ↓
⠋ Checking convergence...
   ↓
⠋ Round 2: All reviewers thinking (parallel)...
```

### Post-Analysis Q&A (Interactive Mode)

In interactive mode (`-i`), after analysis you can ask specific reviewers questions before the debate begins:

```bash
magpie review 12345 -i

# After analysis...
💡 You can ask specific reviewers questions before the debate begins.
   Format: @reviewer_id question (e.g., @claude What about security?)
   Available: @claude
   Available: @gemini
❓ Ask a question or press Enter to start debate: @claude What about the error handling?
```

### Convergence Detection

Enabled by default. Automatically ends debate when reviewers reach consensus on key points, saving tokens.

```bash
# Convergence detection enabled by default
magpie review 12345

# Disable convergence detection
magpie review 12345 --no-converge
```

Set `defaults.check_convergence: false` in config to disable by default.

### Markdown Rendering

All outputs (analysis, reviewer comments, final conclusion) are rendered with proper markdown formatting in terminal - headers, bold, tables, code blocks all display correctly.

### Token Usage Tracking

Displays token usage and estimated cost after each review:

```
── Token Usage (Estimated) ──
  analyzer       88 in     438 out
  claude      4,776 in   1,423 out
  gemini      6,069 in     664 out
  summarizer    505 in     322 out
──────────────────────────────────
  Total      11,438 in   2,847 out  ~$0.1429
```

### Cold Jokes

While waiting for AI reviewers, enjoy programmer jokes:

```
⠋ claude is thinking... | Why do programmers confuse Halloween and Christmas? Because Oct 31 = Dec 25
```

## Development

```bash
# Run in dev mode
npm run dev -- review 12345

# Run tests
npm test

# Build
npm run build
```

## License

ISC
