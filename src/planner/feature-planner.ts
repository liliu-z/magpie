// src/planner/feature-planner.ts
import type { FeatureAnalysis, Feature } from '../state/types.js'
import type { ReviewPlan, ReviewStep } from './types.js'

export interface FeatureStep extends ReviewStep {
  featureId: string
}

export interface FeaturePlan extends ReviewPlan {
  steps: FeatureStep[]
}

export class FeaturePlanner {
  private analysis: FeatureAnalysis

  constructor(analysis: FeatureAnalysis) {
    this.analysis = analysis
  }

  createPlan(selectedFeatureIds: string[]): FeaturePlan {
    const features = selectedFeatureIds.length > 0
      ? this.analysis.features.filter(f => selectedFeatureIds.includes(f.id))
      : this.analysis.features

    const steps: FeatureStep[] = features.map(feature => ({
      featureId: feature.id,
      name: feature.name,
      description: feature.description,
      files: feature.files,
      estimatedTokens: feature.estimatedTokens
    }))

    const totalEstimatedTokens = steps.reduce((sum, s) => sum + s.estimatedTokens, 0)

    return {
      steps,
      totalEstimatedTokens,
      totalEstimatedCost: totalEstimatedTokens * 0.00001
    }
  }
}
