import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { execSync } from 'child_process'
import { loadConfig } from '../config/loader.js'
import { createProvider, isCliModel } from '../providers/factory.js'
import { DebateOrchestrator } from '../orchestrator/orchestrator.js'
import type { Reviewer, ReviewerStatus } from '../orchestrator/types.js'
import { createInterface } from 'readline'
import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'
import { ContextGatherer } from '../context-gatherer/index.js'
import { formatCallChainForReviewer } from '../context-gatherer/collectors/reference-collector.js'
import type { ReviewTarget, ReviewerSessionState } from './review/types.js'
import { fixMarkdown, getRandomJoke, formatMarkdown } from './review/utils.js'
import { selectReviewers, interactiveFollowUpQA, interactiveCommentReview, interactivePostReviewDiscussion, interactiveGeneralDiscussion } from './review/interactive.js'
import { handleRepoReview } from './review/repo-review.js'
import { handleListSessions, handleResumeSession, handleExportSession } from './review/session-cmds.js'
import { runLedgerReview } from './review/ledger-run.js'
import { filterDiff } from '../utils/diff-filter.js'
import { fetchLargePRDiff } from '../utils/large-diff.js'

// Configure marked to render for terminal
marked.setOptions({
  renderer: new TerminalRenderer({
    reflowText: true,   // Reflow text to fit terminal width
    width: 120,         // Wider output for modern terminals
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TerminalRenderer type mismatch with marked
  }) as any
})

export const reviewCommand = new Command('review')
  .description('Review code changes with multiple AI reviewers')
  .argument('[pr]', 'PR number or URL (optional if using --local, --branch, or --files)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-r, --rounds <number>', 'Maximum debate rounds (default: defaults.max_rounds from config)')
  .option('-i, --interactive', 'Interactive mode (pause between turns)')
  .option('-o, --output <file>', 'Output to file instead of stdout')
  .option('-f, --format <format>', 'Output format (markdown|json)', 'markdown')
  .option('--no-converge', 'Disable early stop when reviewers reach consensus')
  .option('--ledger', 'Use the issue-ledger flow: independent finders, cross-adjudication, verifier + gap finder')
  .option('--shard-size <number>', 'Files per review shard in ledger mode (default: 8)')
  .option('-l, --local', 'Review local uncommitted changes (staged + unstaged)')
  .option('-b, --branch [base]', 'Review current branch vs base (default: main)')
  .option('--files <files...>', 'Review specific files')
  .option('--git-remote <name>', 'Git remote to use for PR URL detection (default: origin)')
  .option('--reviewers <ids>', 'Comma-separated reviewer IDs to use (e.g., claude,gemini)')
  .option('-a, --all', 'Use all reviewers (skip selection)')
  // Repo review options
  .option('--repo', 'Review entire repository')
  .option('--path <path>', 'Subdirectory to review (with --repo)')
  .option('--ignore <patterns...>', 'Patterns to ignore (with --repo)')
  .option('--quick', 'Quick mode: only architecture overview')
  .option('--deep', 'Deep mode: full analysis without prompts')
  .option('--plan-only', 'Only generate review plan, do not execute')
  .option('--reanalyze', 'Force re-analyze features (ignore cache)')
  .option('--list-sessions', 'List all review sessions')
  .option('--session <id>', 'Resume specific session by ID')
  .option('--export <file>', 'Export completed review to markdown')
  .option('--skip-context', 'Skip context gathering phase')
  .option('--no-post', 'Skip post-processing (GitHub comment flow)')
  .option('--no-conclusion', 'Skip final conclusion generation (bot mode)')
  .option('--fail-fast', 'Abort the entire review immediately if any reviewer (or context gatherer) fails')
  .action(async (pr: string | undefined, options) => {
    const spinner = ora('Loading configuration...').start()

    // Graceful Ctrl+C handling: first press marks interrupted, second press force-exits
    const interruptState = { interrupted: false }
    let lastSigint = 0
    const sigintHandler = () => {
      const now = Date.now()
      if (interruptState.interrupted && now - lastSigint < 3000) {
        // Second Ctrl+C within 3s → force exit
        console.error('\nForce exit.')
        process.exit(130)
      }
      interruptState.interrupted = true
      lastSigint = now
      console.error(chalk.yellow('\n⚠ Ctrl+C received. Finishing current step... (press again to force exit)'))
    }
    process.on('SIGINT', sigintHandler)

    try {
      // Load config first (needed for --repo handling)
      const config = loadConfig(options.config)
      spinner.succeed('Configuration loaded')

      // Handle --list-sessions
      if (options.listSessions) {
        await handleListSessions(spinner)
        return
      }

      // Handle --session <id>
      if (options.session) {
        await handleResumeSession(options.session, config, spinner)
        return
      }

      // Handle --export <file>
      if (options.export) {
        await handleExportSession(options.export, spinner)
        return
      }

      // Handle --repo flag
      if (options.repo) {
        await handleRepoReview(options, config, spinner)
        return
      }

      // Validate arguments (for non-repo review)
      if (!options.local && !options.branch && !options.files && !pr) {
        spinner.fail('Error')
        console.error(chalk.red('Error: Please specify a PR number or use --local, --branch, --files, or --repo'))
        process.exit(1)
      }

      spinner.start('Preparing review...')

      // Get local diff if --local flag is used
      let localDiff: string | null = null
      let reviewingLastCommit = false
      if (options.local) {
        spinner.text = 'Getting local changes...'
        try {
          // Get both staged and unstaged changes
          const diff = filterDiff(execSync('git diff HEAD', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }), config.defaults.diff_exclude)
          if (!diff.trim()) {
            // No uncommitted changes, fall back to last commit
            spinner.text = 'No uncommitted changes, getting last commit...'
            const lastCommitDiff = filterDiff(execSync('git diff HEAD~1 HEAD', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }), config.defaults.diff_exclude)
            if (!lastCommitDiff.trim()) {
              spinner.fail('No changes found')
              console.error(chalk.yellow('Tip: Make some changes or commits first, then run again.'))
              process.exit(0)
            }
            localDiff = lastCommitDiff
            reviewingLastCommit = true
            const commitMsg = execSync('git log -1 --pretty=%s', { encoding: 'utf-8' }).trim()
            spinner.succeed(`Reviewing last commit: "${commitMsg}" (${lastCommitDiff.split('\n').length} lines)`)
          } else {
            localDiff = diff
            spinner.succeed(`Found local changes (${diff.split('\n').length} lines)`)
          }
        } catch (error) {
          spinner.fail('Failed to get git diff')
          console.error(chalk.red('Error: Not a git repository or git is not available'))
          process.exit(1)
        }
      }

      // Determine review target
      let target: ReviewTarget

      if (options.local) {
        target = {
          type: 'local',
          label: reviewingLastCommit ? 'Last Commit' : 'Local Changes',
          prompt: reviewingLastCommit
            ? `Please review the following code changes from the last commit:\n\n\`\`\`diff\n${localDiff}\n\`\`\`\n\nAnalyze these changes and provide your feedback.`
            : `Please review the following local code changes (uncommitted diff):\n\n\`\`\`diff\n${localDiff}\n\`\`\`\n\nAnalyze these changes and provide your feedback.`,
          // Also carried separately from `prompt`: the ledger flow plans shards off this and
          // refuses to run without it, so leaving it unset made `--ledger --local` fail outright
          diffText: localDiff || undefined
        }
      } else if (options.branch !== undefined) {
        const baseBranch = typeof options.branch === 'string' ? options.branch : 'main'
        const currentBranch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim()
        target = {
          type: 'branch',
          label: `Branch: ${currentBranch}`,
          prompt: `Review the changes in branch "${currentBranch}" compared to "${baseBranch}".`
        }
      } else if (options.files) {
        target = {
          type: 'files',
          label: `Files: ${options.files.join(', ')}`,
          prompt: `Review the following files: ${options.files.join(', ')}.`
        }
      } else if (pr) {
        // Support both PR number and full URL
        let prUrl = ''
        let prNumber: string

        let prRepo: string | undefined

        if (pr.startsWith('http')) {
          // Full URL provided
          prUrl = pr
          const match = pr.match(/\/pull\/(\d+)/)
          prNumber = match ? match[1] : pr
          // Extract repo from URL for cross-repo PR operations
          const repoFromUrl = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)
          if (repoFromUrl) prRepo = repoFromUrl[1]
        } else {
          // Just PR number, try to detect repo from git
          prNumber = pr
          const gitRemote = options.gitRemote || 'origin'
          // Validate remote name to prevent command injection (alphanumeric, dash, underscore only)
          if (!/^[a-zA-Z0-9_-]+$/.test(gitRemote)) {
            throw new Error(`Invalid git remote name: ${gitRemote}`)
          }

          // Use gh to resolve the actual PR URL (handles forks: finds PR on upstream repo)
          try {
            const resolvedUrl = execSync(
              `gh pr view ${prNumber} --json url --jq .url`,
              { encoding: 'utf-8', timeout: 30000 }
            ).trim()
            const repoFromPR = resolvedUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)
            if (repoFromPR) {
              prRepo = repoFromPR[1]
              prUrl = resolvedUrl
            }
          } catch {
            // gh pr view failed — fall back to git remote detection
          }

          if (!prRepo) {
            try {
              const remoteUrl = execSync(`git remote get-url ${gitRemote}`, { encoding: 'utf-8' }).trim()
              // Convert git@github.com:org/repo.git or https://github.com/org/repo.git to https://github.com/org/repo
              const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)
              if (repoMatch) {
                prUrl = `https://github.com/${repoMatch[1]}/pull/${prNumber}`
              } else {
                prUrl = `PR #${prNumber}`  // Fallback
              }
            } catch {
              prUrl = `PR #${prNumber}`  // Fallback if not in git repo
            }
          }
        }

        // Fetch PR metadata (title/body) — always needed
        let prTitle = ''
        let prBody = ''
        try {
          const prInfo = JSON.parse(execSync(`gh pr view ${prUrl} --json title,body`, { encoding: 'utf-8', timeout: 30000 }))
          prTitle = prInfo.title || ''
          prBody = prInfo.body || ''
        } catch {
          // Non-fatal: reviewers can still work without metadata
        }

        // Check if all reviewers (+ analyzer) are CLI-based.
        // CLI providers can fetch diff and read code themselves via tools.
        // API providers need the diff pre-fetched and embedded in the prompt.
        const allModels = [
          ...Object.values(config.reviewers).map(r => r.model),
          config.analyzer.model,
          config.summarizer.model,
        ]
        const allCli = allModels.every(m => isCliModel(m))

        let prPrompt: string
        let constraintDiff = ''
        if (allCli) {
          // CLI mode: reviewers fetch diff and read code themselves
          console.log(chalk.dim(`  CLI-only reviewers detected — reviewers will fetch diff and read code directly`))
          prPrompt = `Please review ${prUrl}.\n\nTitle: ${prTitle}\n\nDescription:\n${prBody}\n\nYou have full access to the repository. Use \`gh pr diff ${prUrl}\` to get the diff, then use Read/Grep tools to examine the actual source files for context. Review every changed file and function systematically.`
          // Fetch the diff anyway — NOT for the reviewers, but so the structurizer's
          // "only cite files/lines in the diff" constraint has something to work with.
          // Without it that guard is skipped entirely and we emit uncommentable line numbers.
          try {
            constraintDiff = execSync(`gh pr diff ${prUrl}`, { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
            constraintDiff = filterDiff(constraintDiff, config.defaults.diff_exclude)
          } catch {
            console.log(chalk.yellow(`  Could not fetch diff for line validation — issue line numbers will be unconstrained`))
          }
        } else {
          // API mode: pre-fetch diff and embed in prompt
          let prDiff = ''
          let diffTruncationNote = ''
          try {
            prDiff = execSync(`gh pr diff ${prUrl}`, { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
            const originalLines = prDiff.split('\n').length
            prDiff = filterDiff(prDiff, config.defaults.diff_exclude)
            const filteredLines = prDiff.split('\n').length
            if (filteredLines < originalLines) {
              console.log(chalk.dim(`  Diff filtered: ${originalLines} → ${filteredLines} lines (excluded generated files)`))
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e)
            // Fallback: for large PRs that exceed GitHub's 20k line limit,
            // reconstruct diff from the per-file patches API
            if (errMsg.includes('406') || errMsg.includes('too_large') || errMsg.includes('exceeded')) {
              console.log(chalk.yellow(`  PR diff too large for GitHub API, fetching via files API...`))
              try {
                const repo = prRepo || (() => {
                  const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim()
                  const m = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/)
                  return m ? m[1] : ''
                })()
                if (repo) {
                  const result = fetchLargePRDiff(repo, prNumber, {
                    maxLines: 15000,
                    excludePatterns: config.defaults.diff_exclude
                  })
                  prDiff = filterDiff(result.diff, config.defaults.diff_exclude)
                  if (result.truncated) {
                    diffTruncationNote = `\n\n⚠️ NOTE: This is a large PR. ${result.summary}`
                  }
                  console.log(chalk.dim(`  Reconstructed diff: ${result.includedFiles}/${result.totalFiles} files (~${prDiff.split('\n').length} lines)`))
                  if (result.truncated) {
                    console.log(chalk.yellow(`  ⚠ Diff truncated to fit context window. Some files excluded.`))
                  }
                }
              } catch (fallbackErr) {
                console.error(chalk.yellow(`Warning: Fallback diff fetch also failed: ${fallbackErr instanceof Error ? fallbackErr.message.slice(0, 100) : fallbackErr}`))
              }
            } else {
              console.error(chalk.yellow(`Warning: Could not pre-fetch PR diff: ${errMsg.slice(0, 100)}`))
            }
          }

          prPrompt = prDiff
            ? `Please review ${prUrl}.\n\nTitle: ${prTitle}\n\nDescription:\n${prBody}${diffTruncationNote}\n\nHere is the PR diff:\n\n\`\`\`diff\n${prDiff}\`\`\`\n\nAnalyze these changes and provide your feedback. You already have the complete diff above — do NOT attempt to fetch it again.`
            : `Please review ${prUrl}. Get the PR details and diff using any method available to you, then analyze the changes.`
        }

        target = {
          type: 'pr',
          label: `PR #${prNumber}`,
          prompt: prPrompt,
          repo: prRepo,
          diffText: constraintDiff || undefined
        }
      } else {
        spinner.fail('Error')
        console.error(chalk.red('Error: Please specify a PR number or use --local, --branch, --files, or --repo'))
        process.exit(1)
      }

      // Setup interactive mode readline early (before reviewer selection)
      // This ensures we use a single readline instance throughout
      let rl: ReturnType<typeof createInterface> | null = null
      if (options.interactive) {
        rl = createInterface({
          input: process.stdin,
          output: process.stdout
        })
      }

      // Determine which reviewers to use
      const allReviewerIds = Object.keys(config.reviewers)
      let selectedIds: string[]

      // Stop spinner before interactive selection
      spinner.stop()

      if (options.reviewers) {
        // Use --reviewers flag
        selectedIds = options.reviewers.split(',').map((s: string) => s.trim())
        const invalid = selectedIds.filter(id => !allReviewerIds.includes(id))
        if (invalid.length > 0) {
          spinner.fail('Error')
          console.error(chalk.red(`Unknown reviewer(s): ${invalid.join(', ')}`))
          console.error(chalk.dim(`Available: ${allReviewerIds.join(', ')}`))
          rl?.close()
          process.exit(1)
        }
      } else if (options.all || !process.stdin.isTTY) {
        // Use all reviewers (also auto-select in non-TTY mode to prevent hanging)
        if (!process.stdin.isTTY) {
          console.log(chalk.yellow('Non-interactive mode detected, using all reviewers.'))
        }
        selectedIds = allReviewerIds
      } else {
        // Default: interactive selection (pass rl to reuse it)
        selectedIds = await selectReviewers(allReviewerIds, rl || undefined)
      }

      if (selectedIds.length < 1) {
        spinner.fail('Error')
        console.error(chalk.red('Need at least 1 reviewer'))
        rl?.close()
        process.exit(1)
      }

      // Create reviewers
      const reviewers: Reviewer[] = selectedIds.map(id => ({
        id,
        provider: createProvider(config.reviewers[id].model, config, config.reviewers[id].effort),
        systemPrompt: config.reviewers[id].prompt,
        lens: config.reviewers[id].lens
      }))

      // Create summarizer
      const summarizer: Reviewer = {
        id: 'summarizer',
        provider: createProvider(config.summarizer.model, config, config.summarizer.effort),
        systemPrompt: config.summarizer.prompt
      }

      // Create analyzer
      const analyzer: Reviewer = {
        id: 'analyzer',
        provider: createProvider(config.analyzer.model, config, config.analyzer.effort),
        systemPrompt: config.analyzer.prompt
      }

      // Create auditor (final judge). Uses config.audit if present; else falls back
      // to summarizer (caller side just passes undefined so the orchestrator default kicks in).
      const auditor: Reviewer | undefined = config.audit
        ? {
            id: 'auditor',
            provider: createProvider(config.audit.model, config, config.audit.effort),
            systemPrompt: config.audit.prompt
          }
        : undefined

      // Create context gatherer (if enabled)
      let contextGatherer: ContextGatherer | undefined
      const contextEnabled = !options.skipContext && (config.contextGatherer?.enabled !== false)
      const contextModel = config.contextGatherer?.model || config.analyzer.model
      // Agent mode when the context model has tools AND there's no diff embedded in the
      // prompt: the diff-driven collectors would find nothing to work with, and the model
      // would fill the gap by inventing call chains. With tools it can just go look.
      const contextAgentMode = isCliModel(contextModel) && !target.prompt.includes('```diff')

      if (contextEnabled) {
        contextGatherer = new ContextGatherer({
          provider: createProvider(contextModel, config, config.contextGatherer?.effort),
          language: config.defaults.language,
          options: {
            callChain: config.contextGatherer?.callChain,
            history: config.contextGatherer?.history,
            docs: config.contextGatherer?.docs
          }
        })
      }

      const isSoloReview = reviewers.length === 1
      // --rounds wins if given; otherwise the config value actually applies. It used to be
      // shadowed by a hardcoded CLI default of 5, which made defaults.max_rounds dead config.
      const configuredRounds = options.rounds ? parseInt(options.rounds, 10) : config.defaults.max_rounds
      const maxRounds = isSoloReview ? 1 : configuredRounds
      const roundsSource = isSoloReview ? 'solo review' : (options.rounds ? '--rounds' : 'config')
      // Convergence: disable for solo review; otherwise default from config, CLI can override with --no-converge
      const checkConvergence = !isSoloReview && options.converge !== false && (config.defaults.check_convergence !== false)

      console.log()
      console.log(chalk.bgBlue.white.bold(` ${target.label} Review `))
      console.log(chalk.dim(`├─ Reviewers: ${selectedIds.map(id => {
        const r = config.reviewers[id]
        return `${chalk.cyan(id)} ${chalk.gray('(' + r.model + (r.effort ? '/' + r.effort : '') + ')')}`
      }).join(', ')}`))
      console.log(chalk.dim(`├─ Max rounds: ${maxRounds} (${roundsSource})`))
      console.log(chalk.dim(`├─ Convergence: ${checkConvergence ? 'enabled' : 'disabled'}`))
      // Log every stage's effective model — without this, results can't be attributed to a
      // model after the fact, which makes any before/after comparison unfalsifiable.
      const stageModel = (c?: { model: string; effort?: string }, fallback?: string) =>
        c ? `${c.model}${c.effort ? `/${c.effort}` : ''}` : `${fallback} (fallback)`
      const stages = [
        `analyzer=${stageModel(config.analyzer)}`,
        `summarizer=${stageModel(config.summarizer)}`,
        `audit=${stageModel(config.audit, config.summarizer.model)}`,
        ...(options.ledger ? [
          `judge=${config.judge ? stageModel(config.judge) : 'none (similarity merge)'}`,
          `gapFinder=${config.gapFinder ? stageModel(config.gapFinder) : 'none'}`,
        ] : []),
      ]
      console.log(chalk.dim(`├─ Stage models: ${stages.join(' ')}`))
      console.log(chalk.dim(`└─ Context gathering: ${contextEnabled ? (contextAgentMode ? 'agent mode' : 'diff mode') : 'disabled'}`))

      let currentReviewer = ''
      let currentRound = 1
      let messageBuffer = ''  // Buffer for current reviewer's message

      // Use object ref to avoid TypeScript control flow issues with closures
      const spinnerRef: {
        spinner: ReturnType<typeof ora> | null
        interval: ReturnType<typeof setInterval> | null
        parallelStatuses: ReviewerStatus[] | null
      } = {
        spinner: null,
        interval: null,
        parallelStatuses: null
      }

      // Format parallel status display
      const formatParallelStatus = (round: number, statuses: ReviewerStatus[]): string => {
        const statusParts = statuses.map(s => {
          if (s.status === 'done') {
            return chalk.green(`✓ ${s.reviewerId}`) + chalk.dim(` (${s.duration?.toFixed(1)}s)`)
          } else if (s.status === 'thinking') {
            return chalk.yellow(`⋯ ${s.reviewerId}`)
          } else {
            return chalk.dim(`○ ${s.reviewerId}`)
          }
        })
        return `Round ${round}: [${statusParts.join(' | ')}]`
      }

      // Render buffered message when reviewer changes
      const flushBuffer = () => {
        if (messageBuffer) {
          console.log(marked(fixMarkdown(messageBuffer)))
          messageBuffer = ''
        }
      }

      const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
        maxRounds,
        interactive: options.interactive,
        checkConvergence,
        diffText: target.diffText,
        contextAgentMode,
        language: config.defaults.language,
        interruptState,
        skipConclusion: options.conclusion === false,
        failFast: !!options.failFast,
        onWaiting: (reviewerId) => {
          // Flush previous reviewer's buffer before showing spinner
          flushBuffer()

          if (spinnerRef.spinner) {
            spinnerRef.spinner.stop()
          }
          if (spinnerRef.interval) {
            clearInterval(spinnerRef.interval)
            spinnerRef.interval = null
          }
          // Show separator for convergence check to make it stand out
          if (reviewerId === 'convergence-check') {
            console.log(chalk.yellow.bold(`\n┌─ 🔍 Convergence Judge ─────────────────────────`))
          }

          const isParallelRound = reviewerId.startsWith('round-')
          const baseLabel = reviewerId === 'context-gatherer' ? 'Gathering system context' :
                       reviewerId === 'analyzer' ? 'Analyzing changes' :
                       reviewerId === 'summarizer' ? 'Generating final summary' :
                       reviewerId === 'verifier' ? 'Verifying conclusion against code' :
                       reviewerId === 'convergence-check' ? 'Evaluating if reviewers reached consensus' :
                       isParallelRound ? `Round ${reviewerId.split('-')[1]}: Starting parallel review` :
                       `${reviewerId} is thinking`

          // Show spinner with a joke (and parallel status if available)
          const updateSpinner = () => {
            const joke = getRandomJoke()
            if (spinnerRef.spinner) {
              if (spinnerRef.parallelStatuses && isParallelRound) {
                const round = parseInt(reviewerId.split('-')[1])
                const statusLine = formatParallelStatus(round, spinnerRef.parallelStatuses)
                spinnerRef.spinner.text = `${statusLine} ${chalk.dim(`| ${joke}`)}`
              } else {
                spinnerRef.spinner.text = `${baseLabel}... ${chalk.dim(`| ${joke}`)}`
              }
            }
          }

          spinnerRef.parallelStatuses = null  // Reset for new waiting phase
          spinnerRef.spinner = ora({ text: `${baseLabel}...`, discardStdin: false }).start()
          updateSpinner()
          // Update joke every 15 seconds
          spinnerRef.interval = setInterval(updateSpinner, 15000)
        },
        onParallelStatus: (round, statuses) => {
          spinnerRef.parallelStatuses = statuses
          // Immediately update spinner to show new status
          if (spinnerRef.spinner) {
            const joke = getRandomJoke()
            const statusLine = formatParallelStatus(round, statuses)
            spinnerRef.spinner.text = `${statusLine} ${chalk.dim(`| ${joke}`)}`
          }
        },
        onMessage: (reviewerId, chunk) => {
          if (spinnerRef.interval) {
            clearInterval(spinnerRef.interval)
            spinnerRef.interval = null
          }
          if (spinnerRef.spinner) {
            spinnerRef.spinner.stop()
            spinnerRef.spinner = null
          }
          if (reviewerId !== currentReviewer) {
            // Flush previous reviewer's buffer
            flushBuffer()
            currentReviewer = reviewerId
            if (reviewerId === 'analyzer') {
              console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
              console.log(chalk.magenta.bold(`  📋 Analysis`))
              console.log(chalk.magenta.bold(`${'─'.repeat(50)}\n`))
            } else {
              console.log(chalk.cyan.bold(`\n┌─ ${reviewerId} `) + chalk.dim(`[Round ${currentRound}/${maxRounds}]`))
              console.log(chalk.cyan(`│`))
            }
          }
          // Buffer the chunk instead of writing directly
          messageBuffer += chunk
        },
        onConvergenceJudgment: (verdict, reasoning) => {
          // Display the judge's reasoning
          if (reasoning) {
            console.log(chalk.dim(`│`))
            console.log(chalk.dim(`│ ${reasoning.split('\n').join('\n│ ')}`))
          }
        },
        onRoundComplete: (round, converged) => {
          // Stop any running spinner (e.g., from convergence-check)
          if (spinnerRef.spinner) {
            spinnerRef.spinner.stop()
            spinnerRef.spinner = null
          }
          if (spinnerRef.interval) {
            clearInterval(spinnerRef.interval)
            spinnerRef.interval = null
          }
          console.log()
          if (converged) {
            console.log(chalk.yellow(`└─ Verdict: `) + chalk.green.bold(`CONVERGED`))
            console.log(chalk.green.bold(`\n✅ Round ${round}/${maxRounds} - CONSENSUS REACHED`))
            console.log(chalk.green(`   Stopping early to save tokens.\n`))
          } else {
            console.log(chalk.yellow(`└─ Verdict: `) + chalk.red.bold(`NOT CONVERGED`))
            console.log(chalk.dim(`\n── Round ${round}/${maxRounds} complete ──\n`))
          }
          currentRound = round + 1
        },
        onInteractive: options.interactive ? async () => {
          // Ensure stdin is flowing (ora spinner may have paused it)
          if (process.stdin.isPaused?.()) process.stdin.resume()
          return new Promise((resolve) => {
            rl!.question(chalk.yellow('\n💬 Press Enter to continue, type to interject, or q to end: '), (answer) => {
              resolve(answer || null)
            })
          })
        } : undefined,
        // Post-analysis Q&A: allow user to ask specific reviewers before debate
        onPostAnalysisQA: options.interactive ? async () => {
          // Flush analysis buffer before showing interactive prompt
          flushBuffer()
          // Ensure stdin is flowing (ora spinner may have paused it)
          if (process.stdin.isPaused?.()) process.stdin.resume()
          return new Promise((resolve) => {
            console.log(chalk.cyan(`\n💡 You can ask specific reviewers questions before the debate begins.`))
            console.log(chalk.dim(`   Format: @reviewer_id question (e.g., @claude What about security?)${reviewers.map(r => `\n   Available: @${r.id}`).join('')}`))
            rl!.question(chalk.yellow('❓ Ask a question or press Enter to start debate: '), (answer) => {
              if (!answer || answer.trim() === '') {
                resolve(null)  // Proceed to debate
                return
              }

              // Parse @target format
              const match = answer.match(/^@(\S+)\s+(.+)$/s)
              if (match) {
                resolve({ target: match[1], question: match[2] })
              } else {
                console.log(chalk.red('   Invalid format. Use: @reviewer_id question'))
                resolve(null)
              }
            })
          })
        } : undefined,
        onContextGathered: (context) => {
          // Flush analysis buffer before displaying context
          flushBuffer()
          // Display context gathering result
          console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
          console.log(chalk.magenta.bold(`  🔍 System Context`))
          console.log(chalk.magenta.bold(`${'─'.repeat(50)}\n`))

          if (context.affectedModules.length > 0) {
            console.log(chalk.dim(`Affected Modules:`))
            for (const mod of context.affectedModules) {
              const impact = mod.impactLevel === 'core' ? chalk.red('●') :
                             mod.impactLevel === 'moderate' ? chalk.yellow('●') :
                             chalk.green('●')
              console.log(chalk.dim(`  ${impact} ${mod.name} (${mod.affectedFiles.length} files)`))
            }
            console.log()
          }

          if (context.relatedPRs.length > 0) {
            console.log(chalk.dim(`Related PRs:`))
            for (const pr of context.relatedPRs.slice(0, 5)) {
              console.log(chalk.dim(`  • #${pr.number}: ${pr.title}`))
            }
            console.log()
          }

          if (context.summary) {
            console.log(marked(fixMarkdown(context.summary)))
          }
        }
      }, contextGatherer, auditor)

      let result: Awaited<ReturnType<typeof orchestrator.runStreaming>>

      if (options.ledger) {
        // Ledger flow: findings are structured from the moment they are raised, finders work
        // independently in round 1, and the verify/gap-find powers are held by separate calls.
        if (!target.diffText) {
          spinner.fail('Error')
          console.error(chalk.red('Ledger mode needs the diff to plan shards and could not fetch it.'))
          rl?.close()
          process.exit(1)
        }
        const gapFinderCfg = config.gapFinder
        if (!gapFinderCfg) {
          console.log(chalk.yellow('  No `gapFinder` configured — running without gap finding.'))
          console.log(chalk.dim('  Configure one on a different model family from the finders; the verifier cannot add findings.'))
        }
        const judgeCfg = config.judge
        if (!judgeCfg) {
          console.log(chalk.yellow('  No `judge` configured — findings will be merged by text similarity.'))
          console.log(chalk.dim('  A judge groups paraphrases of the same bug that word overlap misses.'))
        }

        // Facts only. The analyzer is deliberately NOT run here: its output says what the
        // change is for and where to look, and handing every finder the same framing is what
        // makes round-1 agreement meaningless. Call sites are facts, so they are safe to share.
        let sharedContext: string | undefined
        if (contextGatherer) {
          try {
            spinner.text = 'Gathering call sites...'
            const gathered = contextAgentMode
              ? await contextGatherer.gatherViaAgent(target.prompt, target.label, 'main', target.label)
              : await contextGatherer.gather(target.diffText, target.label, 'main')
            if (gathered.rawReferences?.length) {
              sharedContext = formatCallChainForReviewer(gathered.rawReferences)
            }
          } catch (err) {
            // Context is an accelerator, not a prerequisite — finders have tools of their own
            console.log(chalk.dim(`  Context gathering skipped: ${err instanceof Error ? err.message : String(err)}`))
          }
        }

        result = await runLedgerReview({
          finders: reviewers,
          verifier: auditor || summarizer,
          gapFinder: gapFinderCfg
            ? { id: 'gap-finder', provider: createProvider(gapFinderCfg.model, config, gapFinderCfg.effort), systemPrompt: gapFinderCfg.prompt }
            : undefined,
          judge: judgeCfg
            ? { id: 'judge', provider: createProvider(judgeCfg.model, config, judgeCfg.effort), systemPrompt: judgeCfg.prompt }
            : undefined,
          label: target.label,
          target: target.prompt.match(/https:\/\/github\.com\/\S+?\/pull\/\d+/)?.[0] || target.label,
          targetDescription: target.prompt.slice(0, 4000),
          diffText: target.diffText,
          maxRounds,
          maxFilesPerShard: options.shardSize ? parseInt(options.shardSize, 10) : undefined,
          language: config.defaults.language,
          sharedContext,
          interruptState,
        })
      } else {
        result = await orchestrator.runStreaming(target.label, target.prompt)
      }

      // Flush any remaining buffered content
      flushBuffer()

      // Stop any lingering spinner/interval (summarizer doesn't stream)
      if (spinnerRef.interval) {
        clearInterval(spinnerRef.interval)
        spinnerRef.interval = null
      }
      if (spinnerRef.spinner) {
        spinnerRef.spinner.stop()
        spinnerRef.spinner = null
      }

      // Final conclusion with nice formatting
      console.log(chalk.green.bold(`\n${'═'.repeat(50)}`))
      console.log(chalk.green.bold(`  🎯 Final Conclusion`))
      console.log(chalk.green.bold(`${'═'.repeat(50)}\n`))
      // Render markdown for terminal
      console.log(marked(fixMarkdown(result.finalConclusion)))

      // Verified conclusion
      if (result.verifiedConclusion) {
        console.log(chalk.blue.bold(`\n${'═'.repeat(50)}`))
        console.log(chalk.blue.bold(`  ✅ Verified Conclusion`))
        console.log(chalk.blue.bold(`${'═'.repeat(50)}\n`))
        console.log(marked(fixMarkdown(result.verifiedConclusion)))
      }

      // Display structured issues table (if available)
      if (result.parsedIssues && result.parsedIssues.length > 0) {
        const issues = result.parsedIssues
        const severityColors: Record<string, (s: string) => string> = {
          critical: chalk.red.bold,
          high: chalk.red,
          medium: chalk.yellow,
          low: chalk.blue,
          nitpick: chalk.dim
        }
        const totalRaw = issues.reduce((sum, i) => sum + i.raisedBy.length, 0)

        console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
        console.log(chalk.magenta.bold(`  📋 Issues Found (${issues.length} unique, ${totalRaw} total across reviewers)`))
        console.log(chalk.magenta.bold(`${'─'.repeat(50)}\n`))

        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i]
          const color = severityColors[issue.severity] || chalk.white
          const location = issue.line ? `${issue.file}:${issue.line}` : issue.file
          const reviewers = issue.raisedBy.map(r => chalk.cyan(r)).join(', ')

          console.log(color(`  ${String(i + 1).padStart(2)}. [${issue.severity.toUpperCase().padEnd(8)}] ${issue.title}`))
          console.log(chalk.dim(`      ${location}  [${reviewers}]`))
          if (issue.suggestedFix) {
            console.log(chalk.green(`      Fix: ${issue.suggestedFix.slice(0, 100)}`))
          }
          console.log()
        }
      }

      // Save and compare with previous review (if structured issues available)
      if (result.parsedIssues && result.parsedIssues.length > 0) {
        try {
          const { HistoryTracker } = await import('../history/tracker.js')
          const repoName = process.cwd().split('/').pop() || 'repo'
          const tracker = new HistoryTracker(process.cwd())
          await tracker.saveReview(repoName, target.label, result.parsedIssues)

          const diff = await tracker.diffLatest(repoName, target.label)
          if (diff) {
            console.log(chalk.cyan.bold(`\n  vs. previous review (${diff.previousTimestamp}):`))
            if (diff.fixed.length > 0) console.log(chalk.green(`    ✅ ${diff.fixed.length} fixed`))
            if (diff.stillOpen.length > 0) console.log(chalk.yellow(`    ⚠️  ${diff.stillOpen.length} still open`))
            if (diff.new.length > 0) console.log(chalk.red(`    🆕 ${diff.new.length} new`))
          }
        } catch {
          // History tracking is optional, don't fail the review
        }
      }

      // Build all available roles (reviewers + analyzer + summarizer)
      const allRoles = [
        ...orchestrator.getReviewers(),
        orchestrator.getAnalyzer(),
        orchestrator.getSummarizer()
      ]
      const reviewerSessions = new Map<string, ReviewerSessionState>()

      // PR reviews: General Discussion → Issue-by-issue loop
      if (options.post !== false && target.type === 'pr' && result.parsedIssues && result.parsedIssues.length > 0) {
        if (!rl) {
          rl = createInterface({ input: process.stdin, output: process.stdout })
        }

        // Optional general discussion phase (chat + resolve issues inline)
        const discussionResult = await interactiveGeneralDiscussion(
          rl, allRoles, result, target, result.parsedIssues, spinnerRef, reviewerSessions, config.defaults.language
        )

        // Filter out issues already resolved in general discussion
        const remainingIssues = result.parsedIssues.filter((_, i) => !discussionResult.resolvedIndices.has(i))

        if (remainingIssues.length > 0) {
          // Ensure stdin is flowing (ora spinner may have paused it)
          if (process.stdin.isPaused?.()) process.stdin.resume()
          const preApprovedCount = discussionResult.approvedComments.length
          const prompt = preApprovedCount > 0
            ? `\n  Review ${remainingIssues.length} remaining issues and post to GitHub? (${preApprovedCount} already queued) (y/n): `
            : `\n  Review and post individual comments to GitHub? (y/n): `
          const enterPostProcess = await new Promise<string>(resolve => {
            rl!.question(chalk.yellow(prompt), resolve)
          })
          if (enterPostProcess.trim().toLowerCase() === 'y') {
            const prNum = target.label.match(/\d+/)?.[0] || target.label
            await interactiveCommentReview(rl!, remainingIssues, allRoles, prNum, spinnerRef, result, target, interruptState, reviewerSessions, config.defaults.language, discussionResult.approvedComments)
          } else if (preApprovedCount > 0) {
            // User declined issue-by-issue but has pre-approved comments — post them directly
            const prNum = target.label.match(/\d+/)?.[0] || target.label
            await interactiveCommentReview(rl!, [], allRoles, prNum, spinnerRef, result, target, interruptState, reviewerSessions, config.defaults.language, discussionResult.approvedComments)
          }
        } else if (discussionResult.approvedComments.length > 0) {
          // All issues resolved in discussion — post approved ones
          const prNum = target.label.match(/\d+/)?.[0] || target.label
          await interactiveCommentReview(rl!, [], allRoles, prNum, spinnerRef, result, target, interruptState, reviewerSessions, config.defaults.language, discussionResult.approvedComments)
        } else if (discussionResult.resolvedIndices.size > 0) {
          console.log(chalk.dim('\n  All issues resolved in discussion. Nothing to post.'))
        }
      }

      // Post-review discussion for non-PR reviews (keep existing behavior)
      else if (result.parsedIssues && result.parsedIssues.length > 0 && options.interactive && rl) {
        await interactivePostReviewDiscussion(rl, allRoles, result, target, result.parsedIssues, spinnerRef, reviewerSessions, config.defaults.language)
      }

      // Display token usage
      console.log(chalk.dim(`\n${'─'.repeat(50)}`))
      console.log(chalk.dim(`  📊 Token Usage (Estimated)`))
      console.log(chalk.dim(`${'─'.repeat(50)}`))
      let totalInput = 0
      let totalOutput = 0
      let totalCost = 0
      for (const usage of result.tokenUsage) {
        totalInput += usage.inputTokens
        totalOutput += usage.outputTokens
        totalCost += usage.estimatedCost || 0
        const pad = 12 - usage.reviewerId.length
        console.log(chalk.dim(`  ${usage.reviewerId}${' '.repeat(Math.max(0, pad))} ${usage.inputTokens.toLocaleString().padStart(8)} in  ${usage.outputTokens.toLocaleString().padStart(8)} out`))
      }
      console.log(chalk.dim(`${'─'.repeat(50)}`))
      console.log(chalk.yellow(`  Total${' '.repeat(6)} ${totalInput.toLocaleString().padStart(8)} in  ${totalOutput.toLocaleString().padStart(8)} out  ~$${totalCost.toFixed(4)}`))

      if (result.convergedAtRound) {
        console.log(chalk.green(`\n  ✓ Converged at round ${result.convergedAtRound}`))
      }

      if (options.output) {
        const { writeFileSync } = await import('fs')
        if (options.format === 'json') {
          writeFileSync(options.output, JSON.stringify(result, null, 2))
        } else {
          writeFileSync(options.output, formatMarkdown(result))
        }
        console.log(chalk.green(`\n  ✓ Output saved to: ${options.output}`))
      }

      // Interactive follow-up Q&A after conclusion
      if (options.interactive && rl) {
        await interactiveFollowUpQA(rl, reviewers, result, spinnerRef)
      }

      console.log()

      rl?.close()
    } catch (error) {
      if ((error as Error)?.constructor?.name === 'InterruptedError') {
        spinner.stop()
        console.log(chalk.yellow('\n⚠ Review interrupted.'))
        process.exit(130)
      }
      spinner.fail('Error')
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    } finally {
      process.removeListener('SIGINT', sigintHandler)
    }
  })
