import { Command } from 'commander'
import { initConfig, AVAILABLE_REVIEWERS } from '../config/init.js'
import chalk from 'chalk'
import { createInterface } from 'readline'

async function selectReviewers(): Promise<string[]> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, resolve)
    })
  }

  console.log(chalk.cyan('\nSelect your reviewers (at least 2 recommended for debate):\n'))

  // Display options
  AVAILABLE_REVIEWERS.forEach((reviewer, index) => {
    const apiNote = reviewer.needsApiKey
      ? chalk.yellow(' [requires API key]')
      : chalk.green(' [free]')
    console.log(`  ${chalk.bold(index + 1)}. ${reviewer.name}${apiNote}`)
    console.log(`     ${chalk.dim(reviewer.description)}`)
  })

  console.log()
  const answer = await question(
    chalk.white('Enter reviewer numbers separated by comma (e.g., 1,2): ')
  )

  rl.close()

  // Parse selection
  const selections = answer
    .split(',')
    .map(s => s.trim())
    .filter(s => s)
    .map(s => parseInt(s, 10))
    .filter(n => !isNaN(n) && n >= 1 && n <= AVAILABLE_REVIEWERS.length)
    .map(n => AVAILABLE_REVIEWERS[n - 1].id)

  // Remove duplicates
  return [...new Set(selections)]
}

export const initCommand = new Command('init')
  .description('Initialize Magpie configuration')
  .option('-y, --yes', 'Use default reviewers (claude-code + codex-cli)')
  .action(async (options) => {
    try {
      let selectedReviewers: string[] | undefined

      if (!options.yes) {
        selectedReviewers = await selectReviewers()

        if (selectedReviewers.length === 0) {
          console.log(chalk.yellow('\nNo reviewers selected. Using defaults (Claude Code + Codex CLI)'))
          selectedReviewers = ['claude-code', 'codex-cli']
        } else if (selectedReviewers.length === 1) {
          console.log(chalk.yellow('\nOnly 1 reviewer selected. Debate works best with 2+ reviewers.'))
        }

        // Show selected reviewers
        const selected = AVAILABLE_REVIEWERS.filter(r => selectedReviewers!.includes(r.id))
        console.log(chalk.cyan('\nSelected reviewers:'))
        selected.forEach(r => {
          console.log(`  - ${r.name} (${r.model})`)
        })

        // Warn about API keys if needed
        const needsKeys = selected.filter(r => r.needsApiKey)
        if (needsKeys.length > 0) {
          console.log(chalk.yellow('\nNote: You will need to set these environment variables:'))
          const envVars = new Set<string>()
          needsKeys.forEach(r => {
            if (r.provider === 'anthropic') envVars.add('ANTHROPIC_API_KEY')
            if (r.provider === 'openai') envVars.add('OPENAI_API_KEY')
            if (r.provider === 'google') envVars.add('GOOGLE_API_KEY')
          })
          envVars.forEach(v => console.log(`  - ${v}`))
        }
      }

      const path = initConfig(undefined, selectedReviewers)
      console.log(chalk.green(`\n✓ Config created at: ${path}`))
      console.log(chalk.dim('Edit this file to customize your reviewers and prompts.'))
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    }
  })
