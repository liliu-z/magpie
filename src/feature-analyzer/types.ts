// src/feature-analyzer/types.ts
import type { FileInfo } from '../repo-scanner/types.js'

export interface DetectedFeature {
  id: string
  name: string
  description: string
  entryPoints: string[]
  filePatterns: string[]
  confidence: number
}

export interface FeatureDetectionResult {
  features: DetectedFeature[]
  reasoning: string
}

export interface AnalyzerOptions {
  maxFeatures?: number
  minConfidence?: number
  sampleSize?: number
}

export interface FeatureAnalyzerConfig {
  provider: {
    chat: (messages: Array<{ role: string; content: string }>, systemPrompt?: string) => Promise<string>
  }
  options?: AnalyzerOptions
}
