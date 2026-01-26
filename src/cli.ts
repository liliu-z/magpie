#!/usr/bin/env node
import { Command } from 'commander'
import { reviewCommand } from './commands/review.js'
import { initCommand } from './commands/init.js'

const program = new Command()

program
  .name('magpie')
  .description('Multi-AI adversarial PR review tool')
  .version('0.1.0')

program.addCommand(reviewCommand)
program.addCommand(initCommand)

program.parse()
