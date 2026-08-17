// src/context-gatherer/gatherer.ts
import type {
  ContextGathererConfig,
  GatheredContext,
  GathererOptions,
  RawReference,
  RawDoc,
  RelatedPR,
  AffectedModule,
  CallChainItem,
  DesignPattern
} from './types.js'
import { collectReferences, extractSymbolsFromDiff } from './collectors/reference-collector.js'
import { collectHistory } from './collectors/history-collector.js'
import { collectDocs } from './collectors/docs-collector.js'
import { buildAnalysisPrompt } from './prompts/analysis-prompt.js'
import { buildAgentContextPrompt } from './prompts/agent-prompt.js'

const DEFAULT_OPTIONS: Required<GathererOptions> = {
  callChain: {
    maxDepth: 2,
    maxFilesToAnalyze: 20
  },
  history: {
    maxDays: 30,
    maxPRs: 10
  },
  docs: {
    patterns: ['docs', 'README.md', 'ARCHITECTURE.md', 'DESIGN.md'],
    maxSize: 50000
  }
}

export class ContextGatherer {
  private provider: ContextGathererConfig['provider']
  private options: Required<GathererOptions>
  private language?: string

  constructor(config: ContextGathererConfig) {
    this.provider = config.provider
    this.language = config.language
    this.options = {
      callChain: { ...DEFAULT_OPTIONS.callChain, ...config.options?.callChain },
      history: { ...DEFAULT_OPTIONS.history, ...config.options?.history },
      docs: { ...DEFAULT_OPTIONS.docs, ...config.options?.docs }
    }
  }

  /**
   * Extract changed files from PR diff
   */
  private extractChangedFiles(diff: string): string[] {
    const files: string[] = []
    const pattern = /^(?:diff --git a\/(.+?) b\/|--- a\/(.+?)|\+\+\+ b\/(.+?))$/gm
    let match

    while ((match = pattern.exec(diff)) !== null) {
      const file = match[1] || match[2] || match[3]
      if (file && !files.includes(file) && !file.startsWith('/dev/null')) {
        files.push(file)
      }
    }

    return files
  }

  /**
   * Agent-mode gathering: hand a tool-capable model the review target and let it go find
   * the context itself.
   *
   * This exists because the deterministic path below is driven entirely by the changed-file
   * list parsed out of a diff. In CLI mode there is no diff — reviewers fetch it themselves
   * — so that path collects nothing while still stuffing every repo doc into the prompt, and
   * the model fills the resulting void with invented call chains. An agent can just go look.
   */
  async gatherViaAgent(
    target: string,
    prNumber: string,
    baseBranch: string = 'main',
    targetDescription?: string
  ): Promise<GatheredContext> {
    const prompt = buildAgentContextPrompt({
      target,
      targetDescription,
      maxFilesToRead: this.options.callChain.maxFilesToAnalyze ?? DEFAULT_OPTIONS.callChain.maxFilesToAnalyze!,
      maxRelatedPRs: this.options.history.maxPRs ?? DEFAULT_OPTIONS.history.maxPRs!,
      historyDays: this.options.history.maxDays ?? DEFAULT_OPTIONS.history.maxDays!,
    }, this.language)

    const response = await this.provider.chat(
      [{ role: 'user', content: prompt }],
      'You are a senior software architect gathering review context. You investigate with tools and report only what you verified. Respond in JSON format only.'
    )

    const parsed = this.parseAIResponse(response)

    return {
      affectedModules: parsed.affectedModules,
      callChain: parsed.callChain,
      relatedPRs: [],          // agent mode reports history inside the summary, not as structured PRs
      designPatterns: parsed.designPatterns,
      summary: parsed.summary,
      gatheredAt: new Date(),
      prNumber,
      baseBranch,
      rawReferences: [],
    }
  }

  /**
   * Gather context for a PR
   */
  async gather(
    prDiff: string,
    prNumber: string,
    baseBranch: string = 'main',
    cwd: string = process.cwd()
  ): Promise<GatheredContext> {
    const changedFiles = this.extractChangedFiles(prDiff)

    // Step 1: Collect raw data in parallel
    const [references, { history, relatedPRs }, docs] = await Promise.all([
      Promise.resolve(collectReferences(prDiff, cwd)),
      Promise.resolve(collectHistory(changedFiles, {
        maxDays: this.options.history.maxDays,
        maxPRs: this.options.history.maxPRs,
        cwd
      })),
      Promise.resolve(collectDocs({
        patterns: this.options.docs.patterns,
        maxSize: this.options.docs.maxSize,
        cwd
      }))
    ])

    // Step 2: AI analysis
    const prompt = buildAnalysisPrompt({
      prDiff,
      changedFiles,
      references,
      history,
      relatedPRs,
      docs
    }, this.language)

    const langPrefix = this.language ? `[LANGUAGE REQUIREMENT] You MUST write all descriptions and summaries in ${this.language}. Only code snippets and JSON keys should remain in English.\n\n` : ''
    const response = await this.provider.chat(
      [{ role: 'user', content: prompt }],
      `${langPrefix}You are a senior software architect. Analyze the PR context and respond in JSON format only.`
    )

    // Parse AI response
    const parsed = this.parseAIResponse(response)

    return {
      affectedModules: parsed.affectedModules,
      callChain: parsed.callChain,
      relatedPRs,
      designPatterns: parsed.designPatterns,
      summary: parsed.summary,
      gatheredAt: new Date(),
      prNumber,
      baseBranch,
      rawReferences: references
    }
  }

  private parseAIResponse(response: string): {
    affectedModules: AffectedModule[]
    callChain: CallChainItem[]
    designPatterns: DesignPattern[]
    summary: string
  } {
    // Try to extract JSON from response
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
                      response.match(/\{[\s\S]*\}/)

    if (!jsonMatch) {
      // Return empty context if parsing fails
      return {
        affectedModules: [],
        callChain: [],
        designPatterns: [],
        summary: response.slice(0, 1000) // Use response as summary fallback
      }
    }

    try {
      const jsonStr = jsonMatch[1] || jsonMatch[0]
      const parsed = JSON.parse(jsonStr)

      return {
        affectedModules: Array.isArray(parsed.affectedModules) ? parsed.affectedModules : [],
        callChain: Array.isArray(parsed.callChain) ? parsed.callChain : [],
        designPatterns: Array.isArray(parsed.designPatterns) ? parsed.designPatterns : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : ''
      }
    } catch {
      return {
        affectedModules: [],
        callChain: [],
        designPatterns: [],
        summary: response.slice(0, 1000)
      }
    }
  }
}
