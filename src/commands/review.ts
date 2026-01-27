import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import crypto from 'crypto'
import { execSync } from 'child_process'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/factory.js'
import { DebateOrchestrator } from '../orchestrator/orchestrator.js'
import type { Reviewer, ReviewerStatus } from '../orchestrator/types.js'
import { createInterface } from 'readline'
import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'
import { RepoScanner } from '../repo-scanner/index.js'
import type { RepoStats } from '../repo-scanner/types.js'
import { RepoOrchestrator, type ReviewFocus } from '../orchestrator/repo-orchestrator.js'
import { MarkdownReporter } from '../reporter/index.js'
import { StateManager } from '../state/index.js'
import type { ReviewSession, FeatureAnalysis } from '../state/types.js'
import { FeatureAnalyzer } from '../feature-analyzer/index.js'
import { FeaturePlanner } from '../planner/feature-planner.js'

// Configure marked to render for terminal
marked.setOptions({
  renderer: new TerminalRenderer({
    reflowText: true,
    width: 80,
  }) as any
})

// Cold jokes to display while waiting
const COLD_JOKES = [
  'Why do programmers confuse Halloween and Christmas? Because Oct 31 = Dec 25',
  'A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"',
  'Why do programmers hate nature? It has too many bugs.',
  'There are only 10 types of people: those who understand binary and those who don\'t',
  'Why do Java developers wear glasses? Because they can\'t C#',
  'A programmer\'s wife: "Buy a loaf of bread. If they have eggs, buy a dozen." He returns with 12 loaves.',
  'Why did the developer go broke? Because he used up all his cache.',
  '99 little bugs in the code, take one down, patch it around... 127 little bugs in the code.',
  'There\'s no place like 127.0.0.1',
  'Why did the functions stop calling each other? They had too many arguments.',
  'I would tell you a UDP joke, but you might not get it.',
  'A TCP packet walks into a bar and says "I\'d like a beer." Bartender: "You want a beer?" "Yes, a beer."',
  'Why do backend devs wear glasses? Because they don\'t do C SS.',
  'How many programmers does it take to change a light bulb? None, that\'s a hardware problem.',
  'Programming is 10% writing code and 90% figuring out why it doesn\'t work.',
  'The best thing about a boolean is that even if you\'re wrong, you\'re only off by a bit.',
  'Why was the JavaScript developer sad? Because he didn\'t Node how to Express himself.',
  'In order to understand recursion, you must first understand recursion.',
  'I\'ve got a really good UDP joke to tell you but I don\'t know if you\'ll get it.',
  'A programmer puts two glasses on his bedside table before sleeping. One full of water in case he gets thirsty, one empty in case he doesn\'t.',
  'Why did the programmer quit his job? Because he didn\'t get arrays.',
  '!false - It\'s funny because it\'s true.',
  'There are two hard things in computer science: cache invalidation, naming things, and off-by-one errors.',
  'What\'s the object-oriented way to become wealthy? Inheritance.',
  'Why do C# and Java developers keep breaking their keyboards? Because they use a strongly typed language.',
  'A QA engineer walks into a bar. Orders 1 beer. Orders 0 beers. Orders -1 beers. Orders 999999 beers. Orders a lizard.',
  'Debugging: Being the detective in a crime movie where you are also the murderer.',
  'It works on my machine! Then we\'ll ship your machine.',
  'Software and cathedrals are much the same: first we build them, then we pray.',
  'The code that is the hardest to debug is the code you were sure would work.',
  'Copy-paste is not a design pattern.',
  'Why do Python programmers have low self-esteem? They\'re constantly comparing themselves to others.',
  'What\'s a pirate\'s favorite programming language? R... you\'d think it\'s R but it\'s actually the C.',
  'How does a computer get drunk? It takes screenshots.',
  'Real programmers count from 0.',
  'Git commit -m "fixed it for real this time"',
]

function getRandomJoke(): string {
  return COLD_JOKES[Math.floor(Math.random() * COLD_JOKES.length)]
}

// Interactive reviewer selection
async function selectReviewers(availableIds: string[]): Promise<string[]> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  })

  console.log(chalk.cyan('\nAvailable reviewers:'))
  console.log(chalk.dim('  [0] All reviewers'))
  availableIds.forEach((id, i) => {
    console.log(chalk.dim(`  [${i + 1}] ${id}`))
  })

  return new Promise((resolve) => {
    rl.question(chalk.yellow('\nSelect reviewers (e.g., 1,2 or 0 for all): '), (answer) => {
      rl.close()
      const input = answer.trim()

      if (input === '0' || input.toLowerCase() === 'all' || input === '') {
        resolve(availableIds)
        return
      }

      const indices = input.split(',').map(s => parseInt(s.trim(), 10) - 1)
      const selected = indices
        .filter(i => i >= 0 && i < availableIds.length)
        .map(i => availableIds[i])

      if (selected.length === 0) {
        console.log(chalk.yellow('No valid selection, using all reviewers'))
        resolve(availableIds)
      } else {
        resolve(selected)
      }
    })
  })
}

const FOCUS_OPTIONS: { key: string; label: string; focus: ReviewFocus }[] = [
  { key: '1', label: 'Security', focus: 'security' },
  { key: '2', label: 'Performance', focus: 'performance' },
  { key: '3', label: 'Architecture', focus: 'architecture' },
  { key: '4', label: 'Code Quality', focus: 'code-quality' },
  { key: '5', label: 'Testing', focus: 'testing' },
  { key: '6', label: 'Documentation', focus: 'documentation' }
]

interface ReviewTarget {
  type: 'pr' | 'local' | 'branch' | 'files'
  label: string
  prompt: string  // The prompt telling AI what to review
}

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
  .action(async (pr: string | undefined, options) => {
    const spinner = ora('Loading configuration...').start()

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
          const diff = execSync('git diff HEAD', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
          if (!diff.trim()) {
            // No uncommitted changes, fall back to last commit
            spinner.text = 'No uncommitted changes, getting last commit...'
            const lastCommitDiff = execSync('git diff HEAD~1 HEAD', { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
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
        let prUrl: string
        let prNumber: string

        if (pr.startsWith('http')) {
          // Full URL provided
          prUrl = pr
          const match = pr.match(/\/pull\/(\d+)/)
          prNumber = match ? match[1] : pr
        } else {
          // Just PR number, try to detect repo from git
          prNumber = pr
          const gitRemote = options.gitRemote || 'origin'
          // Validate remote name to prevent command injection (alphanumeric, dash, underscore only)
          if (!/^[a-zA-Z0-9_-]+$/.test(gitRemote)) {
            throw new Error(`Invalid git remote name: ${gitRemote}`)
          }
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

        target = {
          type: 'pr',
          label: `PR #${prNumber}`,
          prompt: `Please review ${prUrl}. Get the PR details and diff using any method available to you, then analyze the changes.`
        }
      } else {
        spinner.fail('Error')
        console.error(chalk.red('Error: Please specify a PR number or use --local, --branch, --files, or --repo'))
        process.exit(1)
      }

      // Determine which reviewers to use
      const allReviewerIds = Object.keys(config.reviewers)
      let selectedIds: string[]

      if (options.reviewers) {
        // Use --reviewers flag
        selectedIds = options.reviewers.split(',').map((s: string) => s.trim())
        const invalid = selectedIds.filter(id => !allReviewerIds.includes(id))
        if (invalid.length > 0) {
          spinner.fail('Error')
          console.error(chalk.red(`Unknown reviewer(s): ${invalid.join(', ')}`))
          console.error(chalk.dim(`Available: ${allReviewerIds.join(', ')}`))
          process.exit(1)
        }
      } else if (options.all) {
        // Use all reviewers
        selectedIds = allReviewerIds
      } else {
        // Default: interactive selection
        selectedIds = await selectReviewers(allReviewerIds)
      }

      if (selectedIds.length < 2) {
        spinner.fail('Error')
        console.error(chalk.red('Need at least 2 reviewers for a debate'))
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

      const maxRounds = parseInt(options.rounds, 10)
      // Convergence: default from config, CLI can override with --no-converge
      const checkConvergence = options.converge !== false && (config.defaults.check_convergence !== false)

      console.log()
      console.log(chalk.bgBlue.white.bold(` ${target.label} Review `))
      console.log(chalk.dim(`├─ Reviewers: ${reviewers.map(r => chalk.cyan(r.id)).join(', ')}`))
      console.log(chalk.dim(`├─ Max rounds: ${maxRounds}`))
      console.log(chalk.dim(`└─ Convergence: ${checkConvergence ? 'enabled' : 'disabled'}`))

      // Setup interactive mode if enabled
      let rl: ReturnType<typeof createInterface> | null = null
      if (options.interactive) {
        rl = createInterface({
          input: process.stdin,
          output: process.stdout
        })
      }

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
          console.log(marked(messageBuffer))
          messageBuffer = ''
        }
      }

      const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
        maxRounds,
        interactive: options.interactive,
        checkConvergence,
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
          const baseLabel = reviewerId === 'analyzer' ? 'Analyzing changes' :
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
          spinnerRef.spinner = ora(`${baseLabel}...`).start()
          updateSpinner()
          // Update joke every 8 seconds
          spinnerRef.interval = setInterval(updateSpinner, 8000)
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
        onRoundComplete: (round, converged) => {
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
          return new Promise((resolve) => {
            rl!.question(chalk.yellow('\n💬 Press Enter to continue, type to interject, or q to end: '), (answer) => {
              resolve(answer || null)
            })
          })
        } : undefined,
        // Post-analysis Q&A: allow user to ask specific reviewers before debate
        onPostAnalysisQA: options.interactive ? async () => {
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
        } : undefined
      })

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
      console.log(marked(result.finalConclusion))

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

      console.log()

      rl?.close()
    } catch (error) {
      spinner.fail('Error')
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    }
  })

// ============================================================================
// Repo Review Functions
// ============================================================================

async function askReviewFocus(): Promise<ReviewFocus[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log(chalk.bgYellow.black.bold(' Review Focus '))
  console.log(chalk.dim('Select areas to focus on (comma-separated numbers, or Enter for all):'))
  for (const opt of FOCUS_OPTIONS) {
    console.log(chalk.dim(`  ${opt.key}. ${opt.label}`))
  }

  const answer = await new Promise<string>(resolve => {
    rl.question(chalk.yellow('Focus areas [1,2,3,4,5,6]: '), resolve)
  })
  rl.close()

  if (!answer.trim()) {
    // Default: all areas
    return FOCUS_OPTIONS.map(o => o.focus)
  }

  const selected = answer.split(',').map(s => s.trim())
  const focusAreas: ReviewFocus[] = []

  for (const key of selected) {
    const opt = FOCUS_OPTIONS.find(o => o.key === key)
    if (opt) {
      focusAreas.push(opt.focus)
    }
  }

  return focusAreas.length > 0 ? focusAreas : FOCUS_OPTIONS.map(o => o.focus)
}

interface FeatureChoice {
  id: string
  name: string
  fileCount: number
  tokens: number
}

async function askFeatureSelection(features: FeatureChoice[]): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log()
  console.log(chalk.bgCyan.black.bold(' Detected Features '))
  console.log(chalk.dim('─'.repeat(50)))

  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    const num = String(i + 1).padStart(2, ' ')
    const files = `${f.fileCount} files`.padEnd(10)
    const tokens = `~${f.tokens} tokens`
    console.log(chalk.dim(`  ${num}. [x] ${f.name.padEnd(25)} ${files} ${tokens}`))
  }

  console.log(chalk.dim('─'.repeat(50)))

  const answer = await new Promise<string>(resolve => {
    rl.question(chalk.yellow('Select features (comma-separated, Enter for all, 0 to deselect all): '), resolve)
  })
  rl.close()

  if (!answer.trim()) {
    return features.map(f => f.id)
  }

  if (answer.trim() === '0') {
    return []
  }

  const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1)
  return indices
    .filter(i => i >= 0 && i < features.length)
    .map(i => features[i].id)
}

async function askResume(session: ReviewSession): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const completed = session.progress.completedFeatures.length
  const total = session.config.selectedFeatures.length
  const remaining = session.config.selectedFeatures.filter(
    id => !session.progress.completedFeatures.includes(id)
  )

  console.log()
  console.log(chalk.bgYellow.black.bold(' Found Incomplete Review '))
  console.log(chalk.dim(`  Started: ${session.startedAt.toLocaleString()}`))
  console.log(chalk.dim(`  Progress: ${completed}/${total} features complete`))
  console.log(chalk.dim(`  Remaining: ${remaining.join(', ')}`))
  console.log()
  console.log(chalk.dim('  1. Continue previous review'))
  console.log(chalk.dim('  2. Start new review'))
  console.log()

  const answer = await new Promise<string>(resolve => {
    rl.question(chalk.yellow('Choice [1]: '), resolve)
  })
  rl.close()

  return answer.trim() !== '2'
}

async function handleRepoReview(options: any, config: any, spinner: any): Promise<void> {
  const cwd = process.cwd()
  const stateManager = new StateManager(cwd)
  await stateManager.init()

  // Check for incomplete sessions
  if (!options.reanalyze) {
    const incompleteSessions = await stateManager.findIncompleteSessions()
    if (incompleteSessions.length > 0) {
      const shouldResume = await askResume(incompleteSessions[0])
      if (shouldResume) {
        await resumeReview(incompleteSessions[0], stateManager, config, spinner)
        return
      }
    }
  }

  // Phase 1: Pre-scan
  spinner.text = 'Scanning repository...'
  const scanner = new RepoScanner(cwd, {
    path: options.path,
    ignore: options.ignore
  })

  const files = await scanner.scanFiles()
  const stats = scanner.getStats()
  spinner.succeed('Repository scanned')

  // Show stats
  console.log()
  console.log(chalk.bgBlue.white.bold(' Repository Stats '))
  console.log(chalk.dim(`├─ Files: ${stats.totalFiles}`))
  console.log(chalk.dim(`├─ Lines: ${stats.totalLines.toLocaleString()}`))
  console.log(chalk.dim(`├─ Languages: ${Object.entries(stats.languages).map(([k, v]) => `${k}(${v})`).join(', ')}`))
  console.log(chalk.dim(`├─ Est. tokens: ${stats.estimatedTokens.toLocaleString()}`))
  console.log(chalk.dim(`└─ Est. cost: ~$${stats.estimatedCost.toFixed(4)}`))

  if (options.quick) {
    console.log(chalk.yellow('\nQuick mode: showing stats only. Use --deep for full analysis.'))
    return
  }

  // Phase 2: Feature analysis
  spinner.start('Analyzing codebase features...')

  let analysis: FeatureAnalysis | null = null

  if (!options.reanalyze) {
    analysis = await stateManager.loadFeatureAnalysis()
    const { computeCodebaseHash } = await import('../feature-analyzer/hash.js')
    const currentHash = computeCodebaseHash(files)

    if (analysis && analysis.codebaseHash !== currentHash) {
      spinner.text = 'Codebase changed, re-analyzing...'
      analysis = null
    }
  }

  if (!analysis) {
    const analyzerProvider = createProvider(config.summarizer.model, config)
    const analyzer = new FeatureAnalyzer({ provider: analyzerProvider as any })
    analysis = await analyzer.analyze(files)
    await stateManager.saveFeatureAnalysis(analysis)
  }

  spinner.succeed(`Feature analysis complete (${analysis.features.length} features detected)`)

  // Phase 3: Feature selection
  const featureChoices = analysis.features.map(f => ({
    id: f.id,
    name: f.name,
    fileCount: f.files.length,
    tokens: f.estimatedTokens
  }))

  let selectedFeatureIds: string[]
  if (options.deep) {
    selectedFeatureIds = analysis.features.map(f => f.id)
  } else {
    selectedFeatureIds = await askFeatureSelection(featureChoices)
    if (selectedFeatureIds.length === 0) {
      console.log(chalk.dim('\nNo features selected. Exiting.'))
      return
    }
  }

  // Show selection summary
  const selectedFeatures = analysis.features.filter(f => selectedFeatureIds.includes(f.id))
  const totalFiles = selectedFeatures.reduce((sum, f) => sum + f.files.length, 0)
  const totalTokens = selectedFeatures.reduce((sum, f) => sum + f.estimatedTokens, 0)

  console.log()
  console.log(chalk.dim(`Selected: ${selectedFeatures.map(f => f.name).join(', ')}`))
  console.log(chalk.dim(`Total: ${totalFiles} files, ~${totalTokens} tokens (~$${(totalTokens * 0.00001).toFixed(4)})`))

  // Ask for focus areas
  let focusAreas: ReviewFocus[]
  if (options.deep) {
    focusAreas = FOCUS_OPTIONS.map(o => o.focus)
  } else {
    focusAreas = await askReviewFocus()
    console.log(chalk.dim(`\nFocusing on: ${focusAreas.join(', ')}`))
  }

  // Confirm
  if (!options.deep) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolve => {
      rl.question(chalk.yellow('\nProceed with review? (y/n) '), resolve)
    })
    rl.close()

    if (answer.toLowerCase() !== 'y') {
      console.log(chalk.dim('Review cancelled.'))
      return
    }
  }

  // Create session
  const session: ReviewSession = {
    id: crypto.randomUUID(),
    startedAt: new Date(),
    updatedAt: new Date(),
    status: 'in_progress',
    config: {
      focusAreas,
      selectedFeatures: selectedFeatureIds
    },
    plan: {
      features: analysis.features,
      totalFeatures: analysis.features.length,
      selectedCount: selectedFeatureIds.length
    },
    progress: {
      currentFeatureIndex: 0,
      completedFeatures: [],
      featureResults: {}
    }
  }

  await stateManager.saveSession(session)

  // Execute review
  await executeFeatureReview(session, analysis, stateManager, config, stats, spinner)
}

async function resumeReview(
  session: ReviewSession,
  stateManager: StateManager,
  config: any,
  spinner: any
): Promise<void> {
  const analysis = await stateManager.loadFeatureAnalysis()
  if (!analysis) {
    console.log(chalk.red('Error: Feature analysis not found. Please start a new review.'))
    return
  }

  const cwd = process.cwd()
  const scanner = new RepoScanner(cwd, {})
  await scanner.scanFiles()
  const stats = scanner.getStats()

  console.log(chalk.cyan(`\nResuming review from feature ${session.progress.currentFeatureIndex + 1}...`))

  await executeFeatureReview(session, analysis, stateManager, config, stats, spinner)
}

async function executeFeatureReview(
  session: ReviewSession,
  analysis: FeatureAnalysis,
  stateManager: StateManager,
  config: any,
  stats: RepoStats,
  spinner: any
): Promise<void> {
  const cwd = process.cwd()

  // Create planner and plan
  const planner = new FeaturePlanner(analysis)
  const plan = planner.createPlan(session.config.selectedFeatures)

  // Filter out already completed features
  const remainingSteps = plan.steps.filter(
    step => !session.progress.completedFeatures.includes(step.featureId)
  )

  if (remainingSteps.length === 0) {
    console.log(chalk.green('\nAll features already reviewed!'))
    return
  }

  // Create reviewers
  const reviewers = Object.entries(config.reviewers).map(([id, cfg]: [string, any]) => ({
    id,
    provider: createProvider(cfg.model, config),
    systemPrompt: cfg.prompt
  }))

  const summarizer = {
    id: 'summarizer',
    provider: createProvider(config.summarizer.model, config),
    systemPrompt: config.summarizer.prompt
  }

  // Setup signal handlers for graceful shutdown
  let interrupted = false
  const cleanup = () => {
    interrupted = true
    console.log(chalk.yellow('\n\nInterrupted. Saving progress...'))
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  const orchestrator = new RepoOrchestrator(reviewers, summarizer, {
    focusAreas: session.config.focusAreas,
    onStepStart: (step: any, i: number, total: number) => {
      const globalIndex = session.progress.completedFeatures.length + i + 1
      const globalTotal = session.config.selectedFeatures.length
      console.log(chalk.cyan(`\n[${globalIndex}/${globalTotal}] Reviewing ${step.name}...`))
    },
    onFeatureComplete: async (featureId: string, result: any) => {
      // Reload session from disk to avoid race conditions and ensure atomic updates
      const currentSession = await stateManager.loadSession(session.id)
      if (currentSession) {
        // Only add if not already completed (idempotent)
        if (!currentSession.progress.completedFeatures.includes(featureId)) {
          currentSession.progress.completedFeatures.push(featureId)
        }
        currentSession.progress.featureResults[featureId] = result
        currentSession.progress.currentFeatureIndex = currentSession.progress.completedFeatures.length
        currentSession.updatedAt = new Date()

        await stateManager.saveSession(currentSession)

        // Update in-memory reference
        Object.assign(session, currentSession)
      } else {
        // Fallback: save current state if reload failed
        session.progress.completedFeatures.push(featureId)
        session.progress.featureResults[featureId] = result
        session.progress.currentFeatureIndex++
        session.updatedAt = new Date()
        await stateManager.saveSession(session)
      }
      console.log(chalk.green(`  ✓ ${featureId} complete (${result.issues.length} issues) - Progress saved`))
    },
    onMessage: (reviewerId: string, chunk: string) => {
      process.stdout.write(chunk)
    }
  })

  // Execute remaining steps
  const remainingPlan = {
    steps: remainingSteps,
    totalEstimatedTokens: remainingSteps.reduce((sum, s) => sum + s.estimatedTokens, 0),
    totalEstimatedCost: remainingSteps.reduce((sum, s) => sum + s.estimatedTokens, 0) * 0.00001
  }

  spinner.start('Running review...')

  try {
    const result = await orchestrator.executeFeaturePlan(remainingPlan, cwd.split('/').pop() || 'repo', stats)

    // Mark session complete
    session.status = 'completed'
    session.updatedAt = new Date()
    await stateManager.saveSession(session)

    spinner.succeed('Review complete')

    // Generate report
    const reporter = new MarkdownReporter()
    const report = reporter.generate(result)

    console.log()
    console.log(report)

  } catch (error) {
    if (interrupted) {
      session.status = 'paused'
      await stateManager.saveSession(session)
      console.log(chalk.yellow('Review paused. Run `magpie review --repo` to resume.'))
    } else {
      throw error
    }
  } finally {
    process.off('SIGINT', cleanup)
    process.off('SIGTERM', cleanup)
  }
}

async function handleListSessions(spinner: any): Promise<void> {
  const cwd = process.cwd()
  const stateManager = new StateManager(cwd)
  await stateManager.init()

  const sessions = await stateManager.findIncompleteSessions()
  // Also get completed sessions by listing all session files
  const allSessions = await stateManager.listAllSessions()

  if (allSessions.length === 0) {
    spinner.info('No review sessions found.')
    return
  }

  console.log()
  console.log(chalk.bgBlue.white.bold(' Review Sessions '))
  console.log(chalk.dim('─'.repeat(70)))

  for (const session of allSessions) {
    const statusColor = session.status === 'completed' ? chalk.green :
                        session.status === 'paused' ? chalk.yellow :
                        session.status === 'in_progress' ? chalk.cyan :
                        chalk.dim
    const statusIcon = session.status === 'completed' ? '✓' :
                       session.status === 'paused' ? '⏸' :
                       session.status === 'in_progress' ? '▶' : '○'

    const completed = session.progress.completedFeatures.length
    const total = session.config.selectedFeatures.length
    const progress = `${completed}/${total} features`

    console.log(statusColor(`  ${statusIcon} ${session.id.slice(0, 8)}  ${session.status.padEnd(12)} ${progress.padEnd(15)} ${new Date(session.startedAt).toLocaleDateString()}`))
  }

  console.log(chalk.dim('─'.repeat(70)))
  console.log(chalk.dim(`  Use --session <id> to resume a session`))
  console.log(chalk.dim(`  Use --export <file> to export a completed session`))
  console.log()
}

async function handleResumeSession(
  sessionId: string,
  config: any,
  spinner: any
): Promise<void> {
  const cwd = process.cwd()
  const stateManager = new StateManager(cwd)
  await stateManager.init()

  // Support partial ID match
  const allSessions = await stateManager.listAllSessions()
  const matchingSessions = allSessions.filter(s =>
    s.id.startsWith(sessionId) || s.id === sessionId
  )

  if (matchingSessions.length === 0) {
    spinner.fail(`No session found matching "${sessionId}"`)
    console.log(chalk.dim('  Use --list-sessions to see available sessions'))
    return
  }

  if (matchingSessions.length > 1) {
    spinner.fail(`Multiple sessions match "${sessionId}"`)
    for (const s of matchingSessions) {
      console.log(chalk.dim(`  - ${s.id}`))
    }
    console.log(chalk.dim('  Please provide a more specific ID'))
    return
  }

  const session = matchingSessions[0]

  if (session.status === 'completed') {
    console.log(chalk.green('\nThis session is already completed.'))
    console.log(chalk.dim(`  Use --export <file> to export the results`))
    return
  }

  console.log(chalk.cyan(`\nResuming session ${session.id.slice(0, 8)}...`))
  await resumeReview(session, stateManager, config, spinner)
}

async function handleExportSession(
  outputPath: string,
  spinner: any
): Promise<void> {
  const cwd = process.cwd()
  const stateManager = new StateManager(cwd)
  await stateManager.init()

  const allSessions = await stateManager.listAllSessions()
  const completedSessions = allSessions.filter(s => s.status === 'completed')

  if (completedSessions.length === 0) {
    spinner.fail('No completed sessions to export')
    return
  }

  // Use the most recent completed session
  const session = completedSessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )[0]

  spinner.text = 'Generating export...'

  const { writeFileSync } = await import('fs')

  let markdown = `# Code Review Report\n\n`
  markdown += `**Session:** ${session.id}\n`
  markdown += `**Date:** ${new Date(session.startedAt).toLocaleDateString()}\n`
  markdown += `**Status:** ${session.status}\n`
  markdown += `**Features Reviewed:** ${session.progress.completedFeatures.length}/${session.config.selectedFeatures.length}\n\n`
  markdown += `---\n\n`

  for (const featureId of session.progress.completedFeatures) {
    const result = session.progress.featureResults[featureId]
    if (!result) continue

    markdown += `## ${featureId}\n\n`
    markdown += `**Summary:** ${result.summary}\n\n`

    if (result.issues.length > 0) {
      markdown += `### Issues (${result.issues.length})\n\n`
      for (const issue of result.issues) {
        const severity = issue.severity === 'high' ? '🔴' :
                        issue.severity === 'medium' ? '🟠' : '🟡'
        markdown += `${severity} **[${issue.severity.toUpperCase()}]** ${issue.description}\n`
        if (issue.location) {
          markdown += `   📍 ${issue.location}\n`
        }
        if (issue.suggestedFix) {
          markdown += `   💡 ${issue.suggestedFix}\n`
        }
        markdown += `\n`
      }
    } else {
      markdown += `*No issues found.*\n\n`
    }

    markdown += `---\n\n`
  }

  writeFileSync(outputPath, markdown)
  spinner.succeed(`Exported to ${outputPath}`)
}

function formatMarkdown(result: any): string {
  const isLocal = result.prNumber === 'Local Changes' || result.prNumber === 'Last Commit'
  let md = isLocal
    ? `# ${result.prNumber} Review\n\n`
    : `# Code Review: ${result.prNumber}\n\n`
  md += `## Analysis\n\n${result.analysis}\n\n`
  md += `## Debate\n\n`

  for (const msg of result.messages) {
    md += `### ${msg.reviewerId}\n\n${msg.content}\n\n`
  }

  md += `## Summaries\n\n`
  for (const summary of result.summaries) {
    md += `### ${summary.reviewerId}\n\n${summary.summary}\n\n`
  }

  md += `## Final Conclusion\n\n${result.finalConclusion}\n`

  return md
}
