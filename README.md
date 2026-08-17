# Magpie

Multi-AI adversarial code review tool. Multiple AI models independently review your PR, debate their findings, then a code-aware verifier audits each issue against the actual codebase.

## Core Concepts

- **Code-Aware Review**: CLI-based reviewers (Claude Code, Codex, Gemini CLI) read the actual source files via tools — not just the diff text. They can grep for callers, read surrounding context, and verify their findings before reporting.
- **Multi-Dimensional Review**: Beyond correctness/security, reviewers check compatibility (rolling upgrade risks, breaking changes), feature interaction (shared state, cross-feature conflicts), and extensibility.
- **Natural Adversarial**: Different AI models naturally create disagreements and cross-validation through debate.
- **Integrated Verify+Audit**: After issues are extracted, a tool-equipped verifier reads the actual code to confirm each issue, filter false positives, and re-calibrate severity — all within magpie's pipeline.
- **Fair Debate Model**: All reviewers in the same round see identical information — no unfair advantage from execution order.
- **Parallel Execution**: Same-round reviewers run concurrently for faster reviews.

## Supported AI Providers

| Provider | Type | Description |
|----------|------|-------------|
| `claude-code` | CLI | Claude Code CLI (uses your subscription, no API key) |
| `codex-cli` | CLI | OpenAI Codex CLI (uses your subscription, no API key) |
| `gemini-cli` | CLI | Gemini CLI (uses Google account login, no API key) |
| `qwen-code` | CLI | Alibaba Qwen Code CLI (uses OAuth login, no API key) |
| `opencode` | CLI | opencode CLI (uses your opencode provider setup, no API key) |
| `claude-*` | API | Anthropic API (requires ANTHROPIC_API_KEY) |
| `gpt-*` | API | OpenAI API (requires OPENAI_API_KEY) |
| `gemini-*` | API | Google Gemini API (requires GOOGLE_API_KEY) |
| `minimax` | API | MiniMax API (requires MINIMAX_API_KEY) |
| `mock` | Debug | Mock provider for testing (no API key, see [Debug Mode](#debug-mode)) |

**Recommended**: Use CLI providers (claude-code, codex-cli, gemini-cli, qwen-code, opencode) - they're free with your subscriptions and don't require API keys.

Pick a specific model for a CLI provider with `provider:model`, e.g. `opencode:anthropic/claude-sonnet-4-5` or `gemini-cli:gemini-2.5-pro`.

### Custom API Endpoints

All API providers support custom `base_url` for connecting to compatible third-party services (Azure OpenAI, Ollama, vLLM, one-api, etc.):

```yaml
providers:
  openai:
    api_key: ${OPENAI_API_KEY}
    base_url: https://my-ollama-server:11434/v1
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
    base_url: https://my-proxy.example.com
```

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
# AI Providers
providers:
  minimax:
    api_key: your-minimax-api-key   # or set MINIMAX_API_KEY env var
    base_url: https://custom-endpoint.example.com/v1  # optional: custom API endpoint

# Default settings
defaults:
  max_rounds: 5           # Maximum debate rounds (overridden by -r/--rounds)
  output_format: markdown
  check_convergence: true  # Stop early when consensus reached
  language: en             # Output language (e.g., 'zh', 'en', 'ja')

# Reviewers - same perspective, different models
reviewers:
  claude:
    model: claude-code
    # Ledger flow only: where this finder digs deeper than the others. Added to the
    # review instruction, never substituted for it — every finder still sweeps its
    # whole scope. Optional; a per-finder default is used when unset.
    lens: |
      Go deeper on what breaks at runtime: nil and empty handling, error and
      cancellation paths, concurrency and lock scope, resource lifetime.
    prompt: |
      You are a senior engineer reviewing this PR. Be precise and evidence-based.
      Review dimensions: Correctness, Security, Compatibility (rolling upgrade,
      breaking changes), Feature Interaction (shared state, cross-feature conflicts),
      Extensibility, Architecture, Performance & Resources.
      Use Read/Grep tools to verify findings against actual code.

  codex:
    model: codex-cli
    prompt: |
      # Same dimensions as above

# Analyzer - PR analysis (before debate)
analyzer:
  model: claude-code
  prompt: |
    Analyze this PR and provide:
    1. What this PR does
    2. Architecture/design decisions
    3. Affected interfaces/APIs (flag breaking changes)
    4. Compatibility risks (rolling upgrade, serialization changes)
    5. Feature interaction risks (callers, shared state)
    6. Suggested review focus (specific files + line ranges)

# Summarizer - final conclusion + verify+audit
summarizer:
  model: claude-code
  prompt: |
    You are a neutral technical reviewer. Based on the full reviewer discussion, provide:
    1. Points of consensus
    2. Points of disagreement
    3. Recommended action items
    4. Overall assessment

# Audit - fact-checks each extracted issue against the code (optional).
# In the ledger flow this is the verifier: it may keep/rewrite/drop, never add.
audit:
  model: claude-code
  prompt: |
    Verify each issue against the actual code from first principles.
    Every verdict needs file:LINE, a verbatim quote, and how it bears on the claim.

# Judge - ledger flow only (optional). Groups the finders' raw findings into ledger
# entries, then decides after each round what the recorded positions add up to.
# Without it, findings are merged by text similarity and paraphrases stay separate.
judge:
  model: claude-code
  prompt: |
    You weigh evidence, not opinions. Quoted code beats assertion; counting positions
    is not judging.

# Gap finder - ledger flow only (optional). The one role allowed to raise what the
# finders missed; its additions go back through the verifier before they can ship.
# Use a different model family from the finders, or it shares their blind spots.
gapFinder:
  model: claude-code
  prompt: |
    Find only what the reviewers missed. Evidence or silence.

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
  -r, --rounds <number>     Maximum debate rounds (default: defaults.max_rounds from config)
  -i, --interactive         Interactive mode (pause between turns, Q&A)
  -o, --output <file>       Output to file
  -f, --format <format>     Output format (markdown|json)
  --no-converge             Disable convergence detection (enabled by default)
  --ledger                  Use the issue-ledger flow (see below)
  --shard-size <number>     Files per review shard in ledger mode (default: 8)
  -l, --local               Review local uncommitted changes
  -b, --branch [base]       Review current branch vs base (default: main)
  --files <files...>        Review specific files
  --reviewers <ids>         Comma-separated reviewer IDs (e.g., claude-code,gemini-cli)
  -a, --all                 Use all configured reviewers (skip selection)
  --git-remote <remote>     Git remote for PR URL detection (default: origin)
  --skip-context            Skip context gathering phase
  --no-post                 Skip post-processing (GitHub comment flow)
  --no-conclusion           Skip final conclusion generation (for bot/CI use)
  --fail-fast               Abort the entire review immediately if any reviewer fails
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
  --fail-fast               Abort the entire discussion immediately if any reviewer fails
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

### Ledger Flow (`--ledger`)

An alternative pipeline for the same review. The default flow carries findings as reviewer
prose and structures them once at the end; the ledger flow structures every finding the moment
it is raised and only ever changes its state. Output format is unchanged, so it drops into any
existing consumer.

```
plan shards
  → round 1: finders work independently, shard by shard   (no shared framing)
  → judge:   cluster the raw findings into the ledger     (may group, may not delete)
  → round 2: finders rule on entries in the code they read (evidence, or it is discarded)
  → judge:   weigh the positions, set each entry's state  (bounded by what was recorded)
  → round 3+: repeat on open entries until nothing moves
  → verifier: rules on every entry, may not add           (set-in = set-out)
  → gap finder: may add, may not publish                  (its additions go back to verify)
  → publish gate: three scores decide inline / summary / drop
```

What each role may and may not do is enforced in code, not requested in a prompt:

| Role | May | May not |
|------|-----|---------|
| Finder | raise findings, take positions on others' | vouch for its own finding; take a position without its own `file:LINE` + quote |
| Judge | group findings, pick canonical wording, set states | drop a finding, author finding text, state more than the recorded evidence supports |
| Verifier | keep / rewrite / drop | add a finding; leave one unanswered without it being marked unverified |
| Gap finder | raise what everyone missed | publish — its additions are re-verified |

Findings are scored on three independent axes — how sure we are it is real, how bad it is if
real, and whether the author can act on it — because collapsing them into one severity number
is what files small-but-certain bugs as nitpicks. Areas nobody reviewed are reported explicitly
rather than implied by silence.

Each finder is given its own angle (configurable via `lens:`) so that several finders on one
model don't retrace one path. The angle says where to dig deeper, never what to skip. Every run
reports what each finder found alone versus shared, and accounts for the gap finder separately,
so whether either is earning its cost is answerable from the run itself.

`judge` and `gapFinder` are optional config entries (see [Configuration](#configuration)).
Without a judge, findings are merged by text similarity, which misses paraphrases of the same
bug. Without a gap finder, nothing in the flow may add a missed finding — the verifier cannot.
Point the gap finder at a different model family from the finders, or it reproduces their blind
spots.

```bash
magpie review 12345 --ledger
magpie review 12345 --ledger --shard-size 4
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
   │  Supports: Go, C++, Python, Java, Scala, TS/JS, Rust, Proto
   ↓
2. Analyzer analyzes PR
   │  Outputs: summary, interface changes, compatibility risks,
   │           interaction risks, specific review focus areas
   ↓
3. [Interactive] Post-analysis Q&A (ask specific reviewers)
   ↓
4. Multi-round debate
   ├─ Round 1: All reviewers give INDEPENDENT opinions (parallel)
   │           CLI reviewers fetch diff + read code via tools
   │           ↓
   ├─ Convergence check: Did reviewers reach consensus?
   │           ↓
   ├─ Round 2+: Reviewers see ALL previous rounds (parallel)
   │            Cross-validate findings, challenge weak arguments
   │            ↓
   └─ ... (repeat until max rounds or convergence)
   ↓
5. Structurizer extracts issues into structured JSON
   ↓
6. Verify+Audit (tool-equipped)
   │  For each issue: Read/Grep actual code to verify
   │  Filters: false positives, by-design patterns, pre-existing issues
   │  Re-calibrates severity based on evidence
   ↓
7. [Optional] Summarizer produces final conclusion (--no-conclusion to skip)
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
- **Call Chain Analysis**: Traces how changed code connects to the rest of the system (supports Go, C++, Python, Java, Scala, TypeScript, Rust, Proto)

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
| `qwen-code` | Yes | Full session with explicit ID |
| `opencode` | Yes | Session ID is issued by opencode and captured from its event stream |
| `minimax` | Yes | Conversation history maintained |
| `gemini-cli` | No | Uses full context each round |
| Other API providers | No | Uses full context each round |

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

### Failure Handling

By default, Magpie is **resilient**: if a single reviewer fails (network error, rate limit, model unavailable), the round continues with the surviving reviewers and only aborts if *all* reviewers fail. The failed reviewer's slot shows `[Review failed: ...]` and is excluded from subsequent rounds.

Use `--fail-fast` to flip to strict mode — any single reviewer failure (or context-gathering failure) immediately terminates the entire flow with an error:

```bash
# Strict mode: abort the moment anything fails
magpie review 12345 --fail-fast
magpie discuss "Should we use microservices?" --fail-fast
```

Useful when you want to guarantee every configured reviewer participated, or when you're debugging provider/auth issues and don't want failures swallowed.

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

### Post-Review Discussion Phase (Interactive Mode)

In interactive mode (`-i`), after the debate concludes, you can enter a **discussion phase** to chat with any role (reviewers, analyzer, or summarizer) before the comment posting step:

- Pick any role by number to start a conversation
- Each role maintains a persistent session with full PR context and its original review analysis
- Use `/skip` to exit the entire discussion phase
- Useful for clarifying issues, asking follow-up questions, or getting deeper insights before deciding which comments to post

```
  Available roles:
    [1] claude-code
    [2] gemini-cli
    [3] analyzer
    [4] summarizer

  Pick a role by number (or Enter to exit discussion):
```

### Post-Processing (PR Review)

After the debate concludes, Magpie extracts structured issues and lets you review them one by one:

- **Comment style prompt**: Before the issue loop, you can provide style instructions (e.g., "be concise", "use Chinese") that apply to all generated comments
- **Progress tracking**: Shows running tally of posted/edited/discussed/skipped issues
- **Per-issue actions**:
  - **Post** (`p`) — Posts as an inline comment on the exact PR line
  - **Edit** (`e`) — Edit the comment before posting
  - **Discuss** (`d`) — Start a multi-turn discussion with any role (reviewer/analyzer/summarizer)
  - **Skip** (`s`) — Skip this issue
  - **Quit** (`q`) — Stop processing remaining issues
- **`/skip` and `/drop`**: During discussion, type `/skip` or `/drop` to abandon the current issue
- **Inline comments**: Each issue is posted as an individual inline comment on the specific line in the PR diff. Falls back to a regular PR comment if the line is not in the diff.
- **Auto-explain**: When you choose to discuss, the reviewer automatically explains the issue in detail first (where the problem is, why it's a problem, how to fix it) before you start asking questions.
- **Comment regeneration**: After discussion, the reviewer generates a revised comment. You can post it, post the original, edit, regenerate with new instructions, or skip.
- **`--no-post`**: Use this flag to skip the entire post-processing flow and just see the review output.

### Debug Mode

Use the mock provider to test Magpie workflows without real AI calls:

```bash
# Enable mock mode globally (all models become mock)
# In config: mock: true

# Or use mock as a model name
# reviewers:
#   test-reviewer:
#     model: mock
#     prompt: "test prompt"

# Environment variables
MAGPIE_MOCK_RESPONSE="fixed response text"   # Return fixed text
MAGPIE_MOCK_FILE=/path/to/response.txt       # Return content from file
MAGPIE_MOCK_DELAY=100                         # Delay between words in ms (default: 50)

# Example: test the discussion flow quickly
MAGPIE_MOCK_DELAY=50 magpie review 123 --reviewers test-reviewer
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
