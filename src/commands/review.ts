import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { execSync } from 'child_process'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/factory.js'
import { DebateOrchestrator } from '../orchestrator/orchestrator.js'
import type { Reviewer, ReviewerStatus } from '../orchestrator/types.js'
import { createInterface } from 'readline'
import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'
import { ContextGatherer } from '../context-gatherer/index.js'
import type { ReviewTarget, ReviewerSessionState } from './review/types.js'
import { fixMarkdown, getRandomJoke, formatMarkdown } from './review/utils.js'
import { selectReviewers, interactiveFollowUpQA, interactiveCommentReview, interactivePostReviewDiscussion } from './review/interactive.js'
import { handleRepoReview } from './review/repo-review.js'
import { handleListSessions, handleResumeSession, handleExportSession } from './review/session-cmds.js'
import { filterDiff } from '../utils/diff-filter.js'

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
  .option('-r, --rounds <number>', 'Maximum debate rounds', '5')
  .option('-i, --interactive', 'Interactive mode (pause between turns)')
  .option('-o, --output <file>', 'Output to file instead of stdout')
  .option('-f, --format <format>', 'Output format (markdown|json)', 'markdown')
  .option('--no-converge', 'Disable early stop when reviewers reach consensus')
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
            : `Please review the following local code changes (uncommitted diff):\n\n\`\`\`diff\n${localDiff}\n\`\`\`\n\nAnalyze these changes and provide your feedback.`
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

        // Pre-fetch PR diff and info so all reviewers (including API-only models) get the code
        let prDiff = ''
        let prTitle = ''
        let prBody = ''
        try {
          prDiff = execSync(`gh pr diff ${prUrl}`, { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
          const originalLines = prDiff.split('\n').length
          prDiff = filterDiff(prDiff, config.defaults.diff_exclude)
          const filteredLines = prDiff.split('\n').length
          if (filteredLines < originalLines) {
            console.log(chalk.dim(`  Diff filtered: ${originalLines} → ${filteredLines} lines (excluded generated files)`))
          }
        } catch (e) {
          console.error(chalk.yellow(`Warning: Could not pre-fetch PR diff: ${e instanceof Error ? e.message.slice(0, 100) : e}`))
        }
        try {
          const prInfo = JSON.parse(execSync(`gh pr view ${prUrl} --json title,body`, { encoding: 'utf-8', timeout: 30000 }))
          prTitle = prInfo.title || ''
          prBody = prInfo.body || ''
        } catch {
          // Non-fatal: reviewers can still work with just the diff
        }

        const prPrompt = prDiff
          ? `Please review ${prUrl}.\n\nTitle: ${prTitle}\n\nDescription:\n${prBody}\n\nHere is the full PR diff:\n\n\`\`\`diff\n${prDiff}\`\`\`\n\nAnalyze these changes and provide your feedback. You already have the complete diff above — do NOT attempt to fetch it again.`
          : `Please review ${prUrl}. Get the PR details and diff using any method available to you, then analyze the changes.`

        target = {
          type: 'pr',
          label: `PR #${prNumber}`,
          prompt: prPrompt,
          repo: prRepo
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
      } else if (options.all) {
        // Use all reviewers
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
        provider: createProvider(config.reviewers[id].model, config),
        systemPrompt: config.reviewers[id].prompt
      }))

      // Create summarizer
      const summarizer: Reviewer = {
        id: 'summarizer',
        provider: createProvider(config.summarizer.model, config),
        systemPrompt: config.summarizer.prompt
      }

      // Create analyzer
      const analyzer: Reviewer = {
        id: 'analyzer',
        provider: createProvider(config.analyzer.model, config),
        systemPrompt: config.analyzer.prompt
      }

      // Create context gatherer (if enabled)
      let contextGatherer: ContextGatherer | undefined
      const contextEnabled = !options.skipContext && (config.contextGatherer?.enabled !== false)

      if (contextEnabled) {
        const contextModel = config.contextGatherer?.model || config.analyzer.model
        contextGatherer = new ContextGatherer({
          provider: createProvider(contextModel, config),
          language: config.defaults.language,
          options: {
            callChain: config.contextGatherer?.callChain,
            history: config.contextGatherer?.history,
            docs: config.contextGatherer?.docs
          }
        })
      }

      const isSoloReview = reviewers.length === 1
      const maxRounds = isSoloReview ? 1 : parseInt(options.rounds, 10)
      // Convergence: disable for solo review; otherwise default from config, CLI can override with --no-converge
      const checkConvergence = !isSoloReview && options.converge !== false && (config.defaults.check_convergence !== false)

      console.log()
      console.log(chalk.bgBlue.white.bold(` ${target.label} Review `))
      console.log(chalk.dim(`├─ Reviewers: ${reviewers.map(r => chalk.cyan(r.id)).join(', ')}`))
      console.log(chalk.dim(`├─ Max rounds: ${maxRounds}`))
      console.log(chalk.dim(`├─ Convergence: ${checkConvergence ? 'enabled' : 'disabled'}`))
      console.log(chalk.dim(`└─ Context gathering: ${contextEnabled ? 'enabled' : 'disabled'}`))

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
        language: config.defaults.language,
        interruptState,
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
      }, contextGatherer)

      const result = await orchestrator.runStreaming(target.label, target.prompt)

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

      // Post-review discussion phase (all review types)
      if (result.parsedIssues && result.parsedIssues.length > 0 && options.interactive && rl) {
        await interactivePostReviewDiscussion(rl, allRoles, result, target, result.parsedIssues, spinnerRef, reviewerSessions, config.defaults.language)
      }

      // Post-processing: comment flow for PR reviews
      if (options.post !== false && target.type === 'pr' && result.parsedIssues && result.parsedIssues.length > 0) {
        if (!rl) {
          rl = createInterface({ input: process.stdin, output: process.stdout })
        }
        // Ensure stdin is flowing (ora spinner may have paused it)
        if (process.stdin.isPaused?.()) process.stdin.resume()
        const enterPostProcess = await new Promise<string>(resolve => {
          rl!.question(chalk.yellow('\n  Review and post individual comments to GitHub? (y/n): '), resolve)
        })
        if (enterPostProcess.trim().toLowerCase() === 'y') {
          const prNum = target.label.match(/\d+/)?.[0] || target.label
          await interactiveCommentReview(rl!, result.parsedIssues, allRoles, prNum, spinnerRef, result, target, interruptState, reviewerSessions, config.defaults.language)
        }
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
