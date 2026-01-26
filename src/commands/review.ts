import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/factory.js'
import { DebateOrchestrator } from '../orchestrator/orchestrator.js'
import type { Reviewer } from '../orchestrator/types.js'
import { createInterface } from 'readline'

export const reviewCommand = new Command('review')
  .description('Review a PR with multiple AI reviewers')
  .argument('<pr>', 'PR number or URL')
  .option('-c, --config <path>', 'Path to config file')
  .option('-r, --rounds <number>', 'Maximum debate rounds', '3')
  .option('-i, --interactive', 'Interactive mode (pause between turns)')
  .option('-o, --output <file>', 'Output to file instead of stdout')
  .option('-f, --format <format>', 'Output format (markdown|json)', 'markdown')
  .option('--no-converge', 'Disable early stop when reviewers reach consensus')
  .action(async (pr: string, options) => {
    const spinner = ora('Loading configuration...').start()

    try {
      const config = loadConfig(options.config)
      spinner.succeed('Configuration loaded')

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
      console.log(chalk.bgBlue.white.bold(` PR #${pr} Review `))
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

      const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
        maxRounds,
        interactive: options.interactive,
        checkConvergence,
        onWaiting: (reviewerId) => {
          if (waitingSpinner) {
            waitingSpinner.stop()
          }
          const label = reviewerId === 'analyzer' ? 'Analyzing PR...' :
                       reviewerId === 'summarizer' ? 'Generating final summary...' :
                       reviewerId === 'convergence-check' ? 'Checking convergence...' :
                       `${reviewerId} is thinking...`
          waitingSpinner = ora(label).start()
        },
        onMessage: (reviewerId, chunk) => {
          if (waitingSpinner) {
            waitingSpinner.stop()
            waitingSpinner = null
          }
          if (reviewerId !== currentReviewer) {
            currentReviewer = reviewerId
            if (reviewerId === 'analyzer') {
              console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
              console.log(chalk.magenta.bold(`  📋 PR Analysis`))
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

      const initialPrompt = `Please review PR #${pr}. Get the PR details and diff using any method available to you, then analyze the changes.`

      const result = await orchestrator.runStreaming(pr, initialPrompt)

      // Final conclusion with nice formatting
      console.log(chalk.green.bold(`\n${'═'.repeat(50)}`))
      console.log(chalk.green.bold(`  🎯 Final Conclusion`))
      console.log(chalk.green.bold(`${'═'.repeat(50)}\n`))
      console.log(result.finalConclusion)

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
  let md = `# PR Review: #${result.prNumber}\n\n`
  md += `## PR Analysis\n\n${result.analysis}\n\n`
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
