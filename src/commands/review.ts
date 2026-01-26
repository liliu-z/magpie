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

      console.log(chalk.blue(`\nStarting review of PR #${pr}`))
      console.log(chalk.dim(`Reviewers: ${reviewers.map(r => r.id).join(', ')}`))
      console.log(chalk.dim(`Max rounds: ${options.rounds}\n`))

      // Setup interactive mode if enabled
      let rl: ReturnType<typeof createInterface> | null = null
      if (options.interactive) {
        rl = createInterface({
          input: process.stdin,
          output: process.stdout
        })
      }

      const orchestrator = new DebateOrchestrator(reviewers, summarizer, {
        maxRounds: parseInt(options.rounds, 10),
        interactive: options.interactive,
        onMessage: (reviewerId, content) => {
          console.log(chalk.cyan(`\n[${reviewerId}]:`))
          console.log(content)
        },
        onRoundComplete: (round) => {
          console.log(chalk.dim(`\n--- Round ${round} complete ---\n`))
        },
        onInteractive: options.interactive ? async () => {
          return new Promise((resolve) => {
            rl!.question(chalk.yellow('\nPress Enter to continue, type to interject, or q to end: '), (answer) => {
              resolve(answer || null)
            })
          })
        } : undefined
      })

      const initialPrompt = `Please review PR #${pr}. Use 'gh pr view ${pr}' and 'gh pr diff ${pr}' to get the PR details, then analyze the changes.`

      spinner.start('Running debate...')
      spinner.stop()

      const result = await orchestrator.run(pr, initialPrompt)

      console.log(chalk.green('\n=== Final Conclusion ===\n'))
      console.log(result.finalConclusion)

      if (options.output) {
        const { writeFileSync } = await import('fs')
        if (options.format === 'json') {
          writeFileSync(options.output, JSON.stringify(result, null, 2))
        } else {
          writeFileSync(options.output, formatMarkdown(result))
        }
        console.log(chalk.green(`\n✓ Output saved to: ${options.output}`))
      }

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
