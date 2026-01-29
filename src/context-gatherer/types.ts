// src/context-gatherer/types.ts
import type { AIProvider } from '../providers/types.js'

/** 受影响的模块 */
export interface AffectedModule {
  name: string                    // 模块名称，如 "order-service"
  path: string                    // 模块路径，如 "src/services/order"
  description: string             // AI 生成的描述
  affectedFiles: string[]         // 本次 PR 改动的该模块文件
  totalFiles: number              // 该模块总文件数
  impactLevel: 'core' | 'moderate' | 'peripheral'  // 影响程度
}

/** 调用链关系 */
export interface CallChainItem {
  symbol: string                  // 函数/类名
  file: string                    // 定义位置
  callers: {                      // 谁调用它
    symbol: string
    file: string
    context: string               // 调用上下文，如 "API endpoint", "background job"
  }[]
}

/** 相关历史 PR */
export interface RelatedPR {
  number: number
  title: string
  author: string
  mergedAt: string
  overlappingFiles: string[]      // 重叠的文件
  relevance: 'direct' | 'same-module'  // 相关性类型
}

/** 设计模式/约定 */
export interface DesignPattern {
  pattern: string                 // 模式名称，如 "Repository Pattern"
  location: string                // 应用位置
  description: string             // 说明
  source: 'documentation' | 'inferred'  // 来源：文档还是推断
}

/** 完整的上下文 */
export interface GatheredContext {
  // 结构化数据
  affectedModules: AffectedModule[]
  callChain: CallChainItem[]
  relatedPRs: RelatedPR[]
  designPatterns: DesignPattern[]

  // 自然语言摘要（给 reviewer 阅读）
  summary: string

  // 元数据
  gatheredAt: Date
  prNumber: string
  baseBranch: string
}

/** 原始引用数据 */
export interface RawReference {
  symbol: string
  foundInFiles: { file: string; line: number; content: string }[]
}

/** 原始历史数据 */
export interface RawHistoryItem {
  commitHash: string
  message: string
  author: string
  date: string
  files: string[]
  prNumber?: number
}

/** 原始文档数据 */
export interface RawDoc {
  path: string
  content: string
}

/** Gatherer 配置 */
export interface ContextGathererConfig {
  provider: AIProvider
  options?: GathererOptions
}

export interface GathererOptions {
  callChain?: {
    maxDepth?: number           // 默认 2
    maxFilesToAnalyze?: number  // 默认 20
  }
  history?: {
    maxDays?: number            // 默认 30
    maxPRs?: number             // 默认 10
  }
  docs?: {
    patterns?: string[]         // 默认 ["docs/**/*.md", "*.md", "ARCHITECTURE*", "DESIGN*"]
    maxSize?: number            // 默认 50000 bytes
  }
}
