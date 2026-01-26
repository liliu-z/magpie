import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { execSync } from 'child_process'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/factory.js'
import { DebateOrchestrator } from '../orchestrator/orchestrator.js'
import type { Reviewer } from '../orchestrator/types.js'
import { createInterface } from 'readline'
import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'

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

interface ReviewTarget {
  type: 'pr' | 'local' | 'branch' | 'files'
  label: string
  prompt: string  // The prompt telling AI what to review
}

export const reviewCommand = new Command('review')
  .description('Review code changes with multiple AI reviewers')
  .argument('[pr]', 'PR number or URL (optional if using --local, --branch, or --files)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-r, --rounds <number>', 'Maximum debate rounds', '3')
  .option('-i, --interactive', 'Interactive mode (pause between turns)')
  .option('-o, --output <file>', 'Output to file instead of stdout')
  .option('-f, --format <format>', 'Output format (markdown|json)', 'markdown')
  .option('--no-converge', 'Disable early stop when reviewers reach consensus')
  .option('-l, --local', 'Review local uncommitted changes (staged + unstaged)')
  .option('-b, --branch [base]', 'Review current branch vs base (default: main)')
  .option('--files <files...>', 'Review specific files')
  .action(async (pr: string | undefined, options) => {
    const spinner = ora('Loading configuration...').start()

    try {
      // Validate arguments
      if (!options.local && !options.branch && !options.files && !pr) {
        spinner.fail('Error')
        console.error(chalk.red('Error: Please specify a PR number or use --local, --branch, or --files'))
        process.exit(1)
      }

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

      const config = loadConfig(options.config)
      spinner.succeed('Configuration loaded')

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
          try {
            const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim()
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
        console.error(chalk.red('Error: Please specify a PR number or use --local, --branch, or --files'))
        process.exit(1)
      }

      // Create reviewers
      const reviewers: Reviewer[] = Object.entries(config.reviewers).map(([id, cfg]) => ({
        id,
        provider: createProvider(cfg.model, config),
        systemPrompt: cfg.prompt
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

      let waitingSpinner: ReturnType<typeof ora> | null = null
      let jokeInterval: ReturnType<typeof setInterval> | null = null

      const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
        maxRounds,
        interactive: options.interactive,
        checkConvergence,
        onWaiting: (reviewerId) => {
          if (waitingSpinner) {
            waitingSpinner.stop()
          }
          if (jokeInterval) {
            clearInterval(jokeInterval)
            jokeInterval = null
          }
          const baseLabel = reviewerId === 'analyzer' ? 'Analyzing changes' :
                       reviewerId === 'summarizer' ? 'Generating final summary' :
                       reviewerId === 'convergence-check' ? 'Checking convergence' :
                       `${reviewerId} is thinking`

          // Show spinner with a joke
          const updateSpinner = () => {
            const joke = getRandomJoke()
            if (waitingSpinner) {
              waitingSpinner.text = `${baseLabel}... ${chalk.dim(`| ${joke}`)}`
            }
          }

          waitingSpinner = ora(`${baseLabel}...`).start()
          updateSpinner()
          // Update joke every 8 seconds
          jokeInterval = setInterval(updateSpinner, 8000)
        },
        onMessage: (reviewerId, chunk) => {
          if (jokeInterval) {
            clearInterval(jokeInterval)
            jokeInterval = null
          }
          if (waitingSpinner) {
            waitingSpinner.stop()
            waitingSpinner = null
          }
          if (reviewerId !== currentReviewer) {
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
          process.stdout.write(chunk)
        },
        onRoundComplete: (round, converged) => {
          console.log()
          if (converged) {
            console.log(chalk.green.bold(`\n✅ Round ${round}/${maxRounds} - CONSENSUS REACHED`))
            console.log(chalk.green(`   Stopping early to save tokens.\n`))
          } else {
            console.log(chalk.dim(`── Round ${round}/${maxRounds} complete ──\n`))
          }
          currentRound = round + 1
        },
        onInteractive: options.interactive ? async () => {
          return new Promise((resolve) => {
            rl!.question(chalk.yellow('\n💬 Press Enter to continue, type to interject, or q to end: '), (answer) => {
              resolve(answer || null)
            })
          })
        } : undefined
      })

      const result = await orchestrator.runStreaming(target.label, target.prompt)

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
