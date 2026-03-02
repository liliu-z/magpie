// src/commands/review/repo-review.ts
import chalk from 'chalk'
import ora from 'ora'
import crypto from 'crypto'
import { createInterface } from 'readline'
import type { MagpieConfig } from '../../config/types.js'
import { createProvider } from '../../providers/factory.js'
import type { Reviewer } from '../../orchestrator/types.js'
import type { ReviewFocus } from '../../orchestrator/repo-orchestrator.js'
import { RepoOrchestrator } from '../../orchestrator/repo-orchestrator.js'
import type { RepoStats } from '../../repo-scanner/types.js'
import { RepoScanner } from '../../repo-scanner/index.js'
import { MarkdownReporter } from '../../reporter/index.js'
import { StateManager } from '../../state/index.js'
import type { ReviewSession, FeatureAnalysis, FeatureReviewResult } from '../../state/types.js'
import { FeatureAnalyzer } from '../../feature-analyzer/index.js'
import { FeaturePlanner } from '../../planner/feature-planner.js'
import { FOCUS_OPTIONS } from './utils.js'

export interface FeatureChoice {
  id: string
  name: string
  fileCount: number
  tokens: number
}

export async function askReviewFocus(): Promise<ReviewFocus[]> {
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

export async function askFeatureSelection(features: FeatureChoice[]): Promise<string[]> {
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

export async function askResume(session: ReviewSession): Promise<boolean> {
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

export async function handleRepoReview(options: { path?: string; ignore?: string[]; reanalyze?: boolean; reviewers?: string; all?: boolean; [key: string]: unknown }, config: MagpieConfig, spinner: ReturnType<typeof ora>): Promise<void> {
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
    const { computeCodebaseHash } = await import('../../feature-analyzer/hash.js')
    const currentHash = computeCodebaseHash(files)

    if (analysis && analysis.codebaseHash !== currentHash) {
      spinner.text = 'Codebase changed, re-analyzing...'
      analysis = null
    }
  }

  if (!analysis) {
    const analyzerProvider = createProvider(config.summarizer.model, config)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AIProvider.chat uses strict Message role, FeatureAnalyzerConfig uses string
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

export async function resumeReview(
  session: ReviewSession,
  stateManager: StateManager,
  config: MagpieConfig,
  spinner: ReturnType<typeof ora>
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

export async function executeFeatureReview(
  session: ReviewSession,
  analysis: FeatureAnalysis,
  stateManager: StateManager,
  config: MagpieConfig,
  stats: RepoStats,
  spinner: ReturnType<typeof ora>
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
  const reviewers = Object.entries(config.reviewers).map(([id, cfg]) => ({
    id,
    provider: createProvider(cfg.model, config),
    systemPrompt: cfg.prompt
  }))

  const summarizer = {
    id: 'summarizer',
    provider: createProvider(config.summarizer.model, config),
    systemPrompt: config.summarizer.prompt
  }

  // Graceful Ctrl+C handling: first press marks interrupted, second press force-exits
  let interrupted = false
  let lastSigint = 0
  const cleanup = () => {
    const now = Date.now()
    if (interrupted && now - lastSigint < 3000) {
      console.error('\nForce exit.')
      process.exit(130)
    }
    interrupted = true
    lastSigint = now
    console.log(chalk.yellow('\n\n⚠ Ctrl+C received. Finishing current step... (press again to force exit)'))
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  const orchestrator = new RepoOrchestrator(reviewers, summarizer, {
    focusAreas: session.config.focusAreas,
    onStepStart: (step, i, total) => {
      const globalIndex = session.progress.completedFeatures.length + i + 1
      const globalTotal = session.config.selectedFeatures.length
      console.log(chalk.cyan(`\n[${globalIndex}/${globalTotal}] Reviewing ${step.name}...`))
    },
    onFeatureComplete: async (featureId: string, result: FeatureReviewResult) => {
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
