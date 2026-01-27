// src/feature-analyzer/analyzer.ts
import type { FileInfo } from '../repo-scanner/types.js'
import type { Feature, FeatureAnalysis } from '../state/types.js'
import type { FeatureAnalyzerConfig, FeatureDetectionResult, AnalyzerOptions } from './types.js'
import { computeCodebaseHash } from './hash.js'

const DEFAULT_OPTIONS: Required<AnalyzerOptions> = {
  maxFeatures: 15,
  minConfidence: 0.5,
  sampleSize: 30
}

const SYSTEM_PROMPT = `You are a code analyzer that identifies functional modules in a codebase.
Given a list of files, identify the main functional areas/features of the codebase.

For each feature, provide:
- id: short identifier (lowercase, no spaces, e.g., "write", "query", "auth")
- name: human-readable name
- description: brief description of what this feature does
- entryPoints: main files that serve as entry points for this feature
- filePatterns: patterns (substrings) that identify files belonging to this feature
- confidence: 0-1 score of how confident you are about this categorization

Return JSON in this exact format:
{
  "features": [...],
  "reasoning": "brief explanation of your analysis"
}

Focus on identifying business logic features, not utility/infrastructure code.
Examples: "write operations", "query/search", "authentication", "rate limiting", "DDL operations", etc.`

export class FeatureAnalyzer {
  private provider: FeatureAnalyzerConfig['provider']
  private options: Required<AnalyzerOptions>

  constructor(config: FeatureAnalyzerConfig) {
    this.provider = config.provider
    this.options = { ...DEFAULT_OPTIONS, ...config.options }
  }

  async analyze(files: FileInfo[]): Promise<FeatureAnalysis> {
    const fileList = files.map(f => f.relativePath).join('\n')

    const prompt = `Analyze this codebase and identify the main functional modules.

Files:
${fileList}

Identify up to ${this.options.maxFeatures} distinct features with confidence >= ${this.options.minConfidence}.`

    const response = await this.provider.chat(
      [{ role: 'user', content: prompt }],
      SYSTEM_PROMPT
    )

    const detection = this.parseResponse(response)
    return this.buildAnalysis(files, detection)
  }

  private parseResponse(response: string): FeatureDetectionResult {
    // Try to extract JSON from markdown code blocks first
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    let jsonStr: string | null = null

    if (codeBlockMatch) {
      // Extract from code block
      const blockContent = codeBlockMatch[1].trim()
      const jsonInBlock = blockContent.match(/\{[\s\S]*\}/)
      if (jsonInBlock) {
        jsonStr = jsonInBlock[0]
      }
    }

    // Fall back to finding JSON directly in response
    if (!jsonStr) {
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        jsonStr = jsonMatch[0]
      }
    }

    if (!jsonStr) {
      throw new Error('Failed to parse AI response: no JSON found in response')
    }

    try {
      const parsed = JSON.parse(jsonStr)

      // Validate structure
      if (!parsed.features || !Array.isArray(parsed.features)) {
        throw new Error('Invalid response structure: missing features array')
      }

      // Validate each feature has required fields
      for (const feature of parsed.features) {
        if (!feature.id || typeof feature.id !== 'string') {
          throw new Error('Invalid feature: missing or invalid id')
        }
        if (!feature.filePatterns || !Array.isArray(feature.filePatterns)) {
          throw new Error(`Invalid feature "${feature.id}": missing filePatterns array`)
        }
      }

      return parsed as FeatureDetectionResult
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`Failed to parse AI response as JSON: ${e.message}`)
      }
      throw e
    }
  }

  private buildAnalysis(files: FileInfo[], detection: FeatureDetectionResult): FeatureAnalysis {
    const features: Feature[] = []
    const assignedFiles = new Set<string>()

    for (const detected of detection.features) {
      if (detected.confidence < this.options.minConfidence) continue

      const matchedFiles = files.filter(f => {
        const path = f.relativePath.toLowerCase()
        return detected.filePatterns.some(pattern =>
          path.includes(pattern.toLowerCase())
        )
      })

      matchedFiles.forEach(f => assignedFiles.add(f.relativePath))

      const estimatedTokens = matchedFiles.reduce((sum, f) => sum + Math.ceil(f.size / 4), 0)

      features.push({
        id: detected.id,
        name: detected.name,
        description: detected.description,
        entryPoints: detected.entryPoints,
        files: matchedFiles,
        estimatedTokens
      })
    }

    const uncategorized = files.filter(f => !assignedFiles.has(f.relativePath))

    return {
      features,
      uncategorized,
      analyzedAt: new Date(),
      codebaseHash: computeCodebaseHash(files)
    }
  }
}
