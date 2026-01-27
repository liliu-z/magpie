import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import crypto from 'crypto'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/factory.js'
import { DebateOrchestrator } from '../orchestrator/orchestrator.js'
import type { Reviewer, DebateResult, ReviewerStatus } from '../orchestrator/types.js'
import { createInterface } from 'readline'
import { marked } from 'marked'
import TerminalRenderer from 'marked-terminal'
import { StateManager } from '../state/index.js'
import type { DiscussSession, DiscussRound } from '../state/types.js'
import { loadProjectContext } from '../utils/context-loader.js'

marked.setOptions({
  renderer: new TerminalRenderer({
    reflowText: true,
    width: 80,
  }) as any
})

const COLD_JOKES = [
  'Why do programmers confuse Halloween and Christmas? Because Oct 31 = Dec 25',
  'A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"',
  'There are only 10 types of people: those who understand binary and those who don\'t',
  'Why did the developer go broke? Because he used up all his cache.',
  '99 little bugs in the code, take one down, patch it around... 127 little bugs in the code.',
  'There\'s no place like 127.0.0.1',
  'I would tell you a UDP joke, but you might not get it.',
  'In order to understand recursion, you must first understand recursion.',
  'Debugging: Being the detective in a crime movie where you are also the murderer.',
  'Copy-paste is not a design pattern.',
]

function getRandomJoke(): string {
  return COLD_JOKES[Math.floor(Math.random() * COLD_JOKES.length)]
}

function resolveTopic(topic: string): string {
  if (existsSync(topic)) {
    return readFileSync(topic, 'utf-8')
  }
  return topic
}

function generateShortId(): string {
  return crypto.randomBytes(4).toString('hex')
}

function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

async function selectReviewers(availableIds: string[]): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

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

// Language rule appended to all discuss prompts
const LANGUAGE_RULE = `

Language rule: You MUST respond in the same language as the user's topic/question. If the user writes in Chinese, respond in Chinese. If in English, respond in English. You may think internally in any language, but your final output must match the user's language.`

// Discuss-specific system prompts (override config's review-oriented prompts)
const DISCUSS_REVIEWER_PROMPT = `You are a senior technical expert participating in a multi-perspective discussion.
Your role is to:
- Analyze the topic thoroughly from your unique perspective
- Identify key considerations, trade-offs, and risks
- Provide concrete, actionable recommendations
- Challenge weak arguments from other participants
- Support your points with evidence and reasoning

Important: This is a discussion/analysis session, NOT a code review. Do not look for PRs or diffs.
Focus on the topic at hand and provide substantive analysis.` + LANGUAGE_RULE

const DISCUSS_ANALYZER_PROMPT = `You are a senior engineer providing initial topic analysis.
Before the discussion begins, analyze the topic and provide:

1. **Context** - What is this about and why does it matter
2. **Key Dimensions** - The main aspects to consider
3. **Known Trade-offs** - Common trade-offs in this space
4. **Open Questions** - What needs to be resolved

Important: This is a discussion/analysis session, NOT a code review.
Do not look for PRs, diffs, or use gh commands. Focus on the topic directly.
Be concise but thorough.` + LANGUAGE_RULE

const DISCUSS_SUMMARIZER_PROMPT = `You are a neutral technical moderator.
Based on the anonymous participant summaries, provide:
- Points of consensus
- Points of disagreement with analysis
- Recommended action items and next steps

Important: This is a discussion summary, NOT a code review conclusion.` + LANGUAGE_RULE

const DEVIL_ADVOCATE_PROMPT = `You are a Devil's Advocate in a technical discussion.
Your role is to:
- Deliberately challenge the majority opinion and consensus
- Find holes, edge cases, and failure modes in arguments others accept
- Question assumptions that everyone takes for granted
- Present the strongest possible counter-arguments, even if you personally disagree
- Expose hidden risks, costs, or second-order effects others overlook

You are NOT being contrarian for fun — your goal is to stress-test ideas so the final conclusion is robust.
If you genuinely cannot find flaws, say so explicitly, but try hard first.

Important: This is a discussion/analysis session, NOT a code review. Do not look for PRs or diffs.` + LANGUAGE_RULE

function buildDiscussPrompt(topic: string, previousContext?: string): string {
  let prompt = ''
  if (previousContext) {
    prompt += `Previous discussion context:\n${previousContext}\n\n`
    prompt += `New question/topic to discuss:\n${topic}`
  } else {
    prompt += `Please discuss the following topic. Provide your independent analysis, identify key considerations, trade-offs, and give concrete recommendations.\n\n${topic}`
  }
  return prompt
}

function buildSystemPromptWithContext(basePrompt: string, model: string): string {
  const context = loadProjectContext(model)
  if (!context) return basePrompt
  return `${basePrompt}\n\n---\nProject context:\n${context}`
}

function buildPreviousContext(session: DiscussSession): string {
  return session.rounds.map((r, i) =>
    `## Round ${i + 1}: ${r.topic}\n\nConclusion: ${r.conclusion}`
  ).join('\n\n')
}

interface DiscussOptions {
  config?: string
  rounds: string
  interactive?: boolean
  output?: string
  format: string
  converge?: boolean
  reviewers?: string
  all?: boolean
  list?: boolean
  resume?: string
  devilAdvocate?: boolean
}

async function runDiscussion(
  topic: string,
  prompt: string,
  selectedIds: string[],
  config: any,
  options: DiscussOptions,
  spinner: ReturnType<typeof ora>
): Promise<{ result: DebateResult }> {
  const maxRounds = parseInt(options.rounds, 10)
  const checkConvergence = options.converge !== false && (config.defaults.check_convergence !== false)

  const reviewers: Reviewer[] = selectedIds.map(id => ({
    id,
    provider: createProvider(config.reviewers[id].model, config),
    systemPrompt: buildSystemPromptWithContext(DISCUSS_REVIEWER_PROMPT, config.reviewers[id].model)
  }))

  // Add Devil's Advocate if enabled
  if (options.devilAdvocate) {
    const daModel = config.summarizer.model
    reviewers.push({
      id: 'devil-advocate',
      provider: createProvider(daModel, config),
      systemPrompt: buildSystemPromptWithContext(DEVIL_ADVOCATE_PROMPT, daModel)
    })
  }

  const summarizer: Reviewer = {
    id: 'summarizer',
    provider: createProvider(config.summarizer.model, config),
    systemPrompt: buildSystemPromptWithContext(DISCUSS_SUMMARIZER_PROMPT, config.summarizer.model)
  }

  const analyzer: Reviewer = {
    id: 'analyzer',
    provider: createProvider(config.analyzer.model, config),
    systemPrompt: buildSystemPromptWithContext(DISCUSS_ANALYZER_PROMPT, config.analyzer.model)
  }

  // Show context loading status per reviewer
  const contextStatus = selectedIds.map(id => {
    const ctx = loadProjectContext(config.reviewers[id].model)
    return ctx ? chalk.green(`${id}:loaded`) : chalk.dim(`${id}:none`)
  }).join(', ')

  console.log()
  console.log(chalk.bgMagenta.white.bold(` Discussion `))
  console.log(chalk.dim(`├─ Topic: ${topic.slice(0, 80)}${topic.length > 80 ? '...' : ''}`))
  console.log(chalk.dim(`├─ Reviewers: ${reviewers.map(r => r.id === 'devil-advocate' ? chalk.red(r.id) : chalk.cyan(r.id)).join(', ')}`))
  console.log(chalk.dim(`├─ Context: ${contextStatus}`))
  console.log(chalk.dim(`├─ Max rounds: ${maxRounds}`))
  console.log(chalk.dim(`└─ Convergence: ${checkConvergence ? 'enabled' : 'disabled'}`))

  let rl: ReturnType<typeof createInterface> | null = null
  if (options.interactive) {
    rl = createInterface({ input: process.stdin, output: process.stdout })
  }

  let currentReviewer = ''
  let currentRound = 1
  let messageBuffer = ''

  const spinnerRef: {
    spinner: ReturnType<typeof ora> | null
    interval: ReturnType<typeof setInterval> | null
    parallelStatuses: ReviewerStatus[] | null
  } = { spinner: null, interval: null, parallelStatuses: null }

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

  const flushBuffer = () => {
    if (messageBuffer) {
      console.log(marked(messageBuffer))
      messageBuffer = ''
    }
  }

  const orchestrator = new DebateOrchestrator(reviewers, summarizer, analyzer, {
    maxRounds,
    interactive: !!options.interactive,
    checkConvergence,
    onWaiting: (reviewerId) => {
      flushBuffer()
      if (spinnerRef.spinner) spinnerRef.spinner.stop()
      if (spinnerRef.interval) { clearInterval(spinnerRef.interval); spinnerRef.interval = null }

      if (reviewerId === 'convergence-check') {
        console.log(chalk.yellow.bold(`\n┌─ Convergence Judge ─────────────────────────`))
      }

      const isParallelRound = reviewerId.startsWith('round-')
      const baseLabel = reviewerId === 'analyzer' ? 'Analyzing topic' :
                   reviewerId === 'summarizer' ? 'Generating final conclusion' :
                   reviewerId === 'convergence-check' ? 'Evaluating consensus' :
                   isParallelRound ? `Round ${reviewerId.split('-')[1]}: Starting parallel discussion` :
                   `${reviewerId} is thinking`

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

      spinnerRef.parallelStatuses = null
      spinnerRef.spinner = ora(`${baseLabel}...`).start()
      updateSpinner()
      spinnerRef.interval = setInterval(updateSpinner, 8000)
    },
    onParallelStatus: (round, statuses) => {
      spinnerRef.parallelStatuses = statuses
      if (spinnerRef.spinner) {
        const joke = getRandomJoke()
        const statusLine = formatParallelStatus(round, statuses)
        spinnerRef.spinner.text = `${statusLine} ${chalk.dim(`| ${joke}`)}`
      }
    },
    onMessage: (reviewerId, chunk) => {
      if (spinnerRef.interval) { clearInterval(spinnerRef.interval); spinnerRef.interval = null }
      if (spinnerRef.spinner) { spinnerRef.spinner.stop(); spinnerRef.spinner = null }
      if (reviewerId !== currentReviewer) {
        flushBuffer()
        currentReviewer = reviewerId
        if (reviewerId === 'analyzer') {
          console.log(chalk.magenta.bold(`\n${'─'.repeat(50)}`))
          console.log(chalk.magenta.bold(`  Analysis`))
          console.log(chalk.magenta.bold(`${'─'.repeat(50)}\n`))
        } else {
          console.log(chalk.cyan.bold(`\n┌─ ${reviewerId} `) + chalk.dim(`[Round ${currentRound}/${maxRounds}]`))
          console.log(chalk.cyan(`│`))
        }
      }
      messageBuffer += chunk
    },
    onRoundComplete: (round, converged) => {
      console.log()
      if (converged) {
        console.log(chalk.yellow(`└─ Verdict: `) + chalk.green.bold(`CONVERGED`))
        console.log(chalk.green.bold(`\n Round ${round}/${maxRounds} - CONSENSUS REACHED`))
        console.log(chalk.green(`   Stopping early to save tokens.\n`))
      } else {
        console.log(chalk.yellow(`└─ Verdict: `) + chalk.red.bold(`NOT CONVERGED`))
        console.log(chalk.dim(`\n── Round ${round}/${maxRounds} complete ──\n`))
      }
      currentRound = round + 1
    },
    onInteractive: options.interactive ? async () => {
      return new Promise((resolve) => {
        rl!.question(chalk.yellow('\nPress Enter to continue, type to interject, or q to end: '), (answer) => {
          resolve(answer || null)
        })
      })
    } : undefined
  })

  const result = await orchestrator.runStreaming('Discussion', prompt)

  flushBuffer()
  if (spinnerRef.interval) { clearInterval(spinnerRef.interval); spinnerRef.interval = null }
  if (spinnerRef.spinner) { spinnerRef.spinner.stop(); spinnerRef.spinner = null }

  // Final conclusion
  console.log(chalk.green.bold(`\n${'═'.repeat(50)}`))
  console.log(chalk.green.bold(`  Final Conclusion`))
  console.log(chalk.green.bold(`${'═'.repeat(50)}\n`))
  console.log(marked(result.finalConclusion))

  // Token usage
  console.log(chalk.dim(`\n${'─'.repeat(50)}`))
  console.log(chalk.dim(`  Token Usage (Estimated)`))
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
    console.log(chalk.green(`\n  Converged at round ${result.convergedAtRound}`))
  }

  rl?.close()

  return { result }
}

export const discussCommand = new Command('discuss')
  .description('Discuss any topic with multiple AI reviewers through adversarial debate')
  .argument('[topic]', 'Topic to discuss (text or file path)')
  .option('-c, --config <path>', 'Path to config file')
  .option('-r, --rounds <number>', 'Maximum debate rounds', '5')
  .option('-i, --interactive', 'Interactive mode')
  .option('-o, --output <file>', 'Output to file')
  .option('-f, --format <format>', 'Output format (markdown|json)', 'markdown')
  .option('--no-converge', 'Disable convergence detection')
  .option('--reviewers <ids>', 'Comma-separated reviewer IDs')
  .option('-a, --all', 'Use all reviewers')
  .option('-d, --devil-advocate', "Add a Devil's Advocate to challenge consensus")
  .option('--list', 'List all discuss sessions')
  .option('--resume <id>', 'Resume a discuss session')
  .action(async (topic: string | undefined, options: DiscussOptions) => {
    const spinner = ora('Loading configuration...').start()

    try {
      const config = loadConfig(options.config)
      spinner.succeed('Configuration loaded')

      const stateManager = new StateManager(process.cwd())
      await stateManager.initDiscussions()

      // Handle --list
      if (options.list) {
        await handleListSessions(stateManager, spinner)
        return
      }

      // Handle --resume
      if (options.resume) {
        const resumeId = options.resume
        const newTopic = topic ? resolveTopic(topic) : undefined
        await handleResume(resumeId, newTopic, stateManager, config, options, spinner)
        return
      }

      // New discussion
      if (!topic) {
        spinner.fail('Error')
        console.error(chalk.red('Error: Please provide a topic to discuss'))
        console.error(chalk.dim('  Usage: magpie discuss "your topic here"'))
        console.error(chalk.dim('  Usage: magpie discuss /path/to/topic.md'))
        process.exit(1)
      }

      const resolvedTopic = resolveTopic(topic)

      // Select reviewers
      const allReviewerIds = Object.keys(config.reviewers)
      let selectedIds: string[]

      if (options.reviewers) {
        selectedIds = options.reviewers.split(',').map((s: string) => s.trim())
        const invalid = selectedIds.filter(id => !allReviewerIds.includes(id))
        if (invalid.length > 0) {
          spinner.fail('Error')
          console.error(chalk.red(`Unknown reviewer(s): ${invalid.join(', ')}`))
          console.error(chalk.dim(`Available: ${allReviewerIds.join(', ')}`))
          process.exit(1)
        }
      } else if (options.all) {
        selectedIds = allReviewerIds
      } else {
        selectedIds = await selectReviewers(allReviewerIds)
      }

      if (selectedIds.length < 2) {
        spinner.fail('Error')
        console.error(chalk.red('Need at least 2 reviewers for a discussion'))
        process.exit(1)
      }

      // Create session
      const session: DiscussSession = {
        id: generateShortId(),
        title: resolvedTopic.slice(0, 50),
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'active',
        reviewerIds: selectedIds,
        rounds: []
      }

      const prompt = buildDiscussPrompt(resolvedTopic)
      const { result } = await runDiscussion(resolvedTopic, prompt, selectedIds, config, options, spinner)

      // Save round to session
      const round: DiscussRound = {
        roundNumber: 1,
        topic: resolvedTopic,
        analysis: result.analysis,
        messages: result.messages.map(m => ({ reviewerId: m.reviewerId, content: m.content, timestamp: m.timestamp })),
        summaries: result.summaries.map(s => ({ reviewerId: s.reviewerId, summary: s.summary })),
        conclusion: result.finalConclusion,
        convergedAtRound: result.convergedAtRound,
        tokenUsage: result.tokenUsage,
        timestamp: new Date()
      }
      session.rounds.push(round)
      session.updatedAt = new Date()
      await stateManager.saveDiscussSession(session)

      console.log(chalk.dim(`\n  Session saved: ${session.id}`))
      console.log(chalk.dim(`  Resume with: magpie discuss --resume ${session.id} "follow-up question"`))

      // Handle output file
      if (options.output) {
        if (options.format === 'json') {
          writeFileSync(options.output, JSON.stringify(result, null, 2))
        } else {
          writeFileSync(options.output, formatDiscussMarkdown(session))
        }
        console.log(chalk.green(`\n  Output saved to: ${options.output}`))
      }

      // Interactive: ask for follow-up
      if (options.interactive) {
        await interactiveFollowUp(session, selectedIds, config, options, stateManager, spinner)
      }

      console.log()
    } catch (error) {
      spinner.fail('Error')
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    }
  })

async function interactiveFollowUp(
  session: DiscussSession,
  selectedIds: string[],
  config: any,
  options: DiscussOptions,
  stateManager: StateManager,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  while (true) {
    const answer = await new Promise<string>((resolve) => {
      rl.question(chalk.yellow('\nAsk a follow-up question (or Enter to end): '), resolve)
    })

    if (!answer.trim()) {
      rl.close()
      session.status = 'completed'
      session.updatedAt = new Date()
      await stateManager.saveDiscussSession(session)
      break
    }

    const previousContext = buildPreviousContext(session)
    const prompt = buildDiscussPrompt(answer, previousContext)
    const { result } = await runDiscussion(answer, prompt, selectedIds, config, options, spinner)

    const round: DiscussRound = {
      roundNumber: session.rounds.length + 1,
      topic: answer,
      analysis: result.analysis,
      messages: result.messages.map(m => ({ reviewerId: m.reviewerId, content: m.content, timestamp: m.timestamp })),
      summaries: result.summaries.map(s => ({ reviewerId: s.reviewerId, summary: s.summary })),
      conclusion: result.finalConclusion,
      convergedAtRound: result.convergedAtRound,
      tokenUsage: result.tokenUsage,
      timestamp: new Date()
    }
    session.rounds.push(round)
    session.updatedAt = new Date()
    await stateManager.saveDiscussSession(session)
  }
}

async function handleListSessions(stateManager: StateManager, spinner: ReturnType<typeof ora>): Promise<void> {
  const sessions = await stateManager.listDiscussSessions()

  if (sessions.length === 0) {
    spinner.info('No discuss sessions found.')
    return
  }

  console.log()
  console.log(chalk.bgMagenta.white.bold(' Discuss Sessions '))
  console.log(chalk.dim('─'.repeat(80)))
  console.log(chalk.dim(`  ${'ID'.padEnd(10)} ${'Title'.padEnd(40)} ${'Rounds'.padEnd(8)} Updated`))
  console.log(chalk.dim('─'.repeat(80)))

  for (const session of sessions) {
    const title = session.title.length > 38 ? session.title.slice(0, 36) + '...' : session.title
    const statusIcon = session.status === 'completed' ? chalk.green('✓') : chalk.cyan('▶')
    console.log(`  ${statusIcon} ${chalk.cyan(session.id.padEnd(8))} ${title.padEnd(40)} ${String(session.rounds.length).padEnd(8)} ${formatTimeSince(session.updatedAt)}`)
  }

  console.log(chalk.dim('─'.repeat(80)))
  console.log(chalk.dim(`  Resume with: magpie discuss --resume <id> "follow-up question"`))
  console.log()
}

async function handleResume(
  sessionId: string,
  newTopic: string | undefined,
  stateManager: StateManager,
  config: any,
  options: DiscussOptions,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  // Support partial ID match
  const allSessions = await stateManager.listDiscussSessions()
  const matching = allSessions.filter(s => s.id.startsWith(sessionId) || s.id === sessionId)

  if (matching.length === 0) {
    spinner.fail(`No session found matching "${sessionId}"`)
    console.log(chalk.dim('  Use magpie discuss --list to see available sessions'))
    return
  }

  if (matching.length > 1) {
    spinner.fail(`Multiple sessions match "${sessionId}"`)
    for (const s of matching) {
      console.log(chalk.dim(`  - ${s.id} ${s.title}`))
    }
    return
  }

  const session = matching[0]

  // Show previous rounds summary
  console.log()
  console.log(chalk.bgMagenta.white.bold(` Resuming Discussion: ${session.id} `))
  console.log(chalk.dim(`├─ Title: ${session.title}`))
  console.log(chalk.dim(`├─ Rounds: ${session.rounds.length}`))
  console.log(chalk.dim(`└─ Reviewers: ${session.reviewerIds.join(', ')}`))

  for (const round of session.rounds) {
    console.log()
    console.log(chalk.dim(`  Round ${round.roundNumber}: ${round.topic.slice(0, 60)}${round.topic.length > 60 ? '...' : ''}`))
    console.log(chalk.dim(`  Conclusion: ${round.conclusion.slice(0, 100)}...`))
  }

  const selectedIds = session.reviewerIds
  // Validate reviewers still exist in config
  const allReviewerIds = Object.keys(config.reviewers)
  const validIds = selectedIds.filter(id => allReviewerIds.includes(id))
  if (validIds.length < 2) {
    spinner.fail('Not enough configured reviewers match this session')
    return
  }

  if (newTopic) {
    // Direct follow-up with provided topic
    const previousContext = buildPreviousContext(session)
    const prompt = buildDiscussPrompt(newTopic, previousContext)
    const { result } = await runDiscussion(newTopic, prompt, validIds, config, options, spinner)

    const round: DiscussRound = {
      roundNumber: session.rounds.length + 1,
      topic: newTopic,
      analysis: result.analysis,
      messages: result.messages.map(m => ({ reviewerId: m.reviewerId, content: m.content, timestamp: m.timestamp })),
      summaries: result.summaries.map(s => ({ reviewerId: s.reviewerId, summary: s.summary })),
      conclusion: result.finalConclusion,
      convergedAtRound: result.convergedAtRound,
      tokenUsage: result.tokenUsage,
      timestamp: new Date()
    }
    session.rounds.push(round)
    session.updatedAt = new Date()
    await stateManager.saveDiscussSession(session)

    console.log(chalk.dim(`\n  Session updated: ${session.id}`))

    if (options.output) {
      if (options.format === 'json') {
        writeFileSync(options.output, JSON.stringify(session, null, 2))
      } else {
        writeFileSync(options.output, formatDiscussMarkdown(session))
      }
      console.log(chalk.green(`\n  Output saved to: ${options.output}`))
    }
  } else {
    // Interactive mode: ask for follow-up
    await interactiveFollowUp(session, validIds, config, options, stateManager, spinner)
  }

  console.log()
}

function formatDiscussMarkdown(session: DiscussSession): string {
  let md = `# Discussion: ${session.title}\n\n`
  md += `**Session:** ${session.id}\n`
  md += `**Created:** ${session.createdAt.toISOString()}\n`
  md += `**Reviewers:** ${session.reviewerIds.join(', ')}\n\n`
  md += `---\n\n`

  for (const round of session.rounds) {
    md += `## Round ${round.roundNumber}: ${round.topic}\n\n`

    md += `### Analysis\n\n${round.analysis}\n\n`

    md += `### Debate\n\n`
    for (const msg of round.messages) {
      md += `#### ${msg.reviewerId}\n\n${msg.content}\n\n`
    }

    md += `### Summaries\n\n`
    for (const summary of round.summaries) {
      md += `#### ${summary.reviewerId}\n\n${summary.summary}\n\n`
    }

    md += `### Conclusion\n\n${round.conclusion}\n\n`
    md += `---\n\n`
  }

  return md
}
