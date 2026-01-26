import { Command } from 'commander'
import { initConfig } from '../config/init.js'
import chalk from 'chalk'

export const initCommand = new Command('init')
  .description('Initialize Magpie configuration')
  .action(() => {
    try {
      const path = initConfig()
      console.log(chalk.green(`✓ Config created at: ${path}`))
      console.log(chalk.dim('Edit this file to configure your AI providers and reviewers.'))
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    }
  })
