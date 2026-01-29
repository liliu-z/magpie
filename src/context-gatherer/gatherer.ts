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

  constructor(config: ContextGathererConfig) {
    this.provider = config.provider
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
    })

    const response = await this.provider.chat(
      [{ role: 'user', content: prompt }],
      'You are a senior software architect. Analyze the PR context and respond in JSON format only.'
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
      baseBranch
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
