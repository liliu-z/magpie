// src/commands/review/types.ts
import type { Message } from '../../providers/types.js'

export interface ReviewTarget {
  type: 'pr' | 'local' | 'branch' | 'files'
  label: string
  prompt: string  // The prompt telling AI what to review
  repo?: string   // GitHub repo (owner/name) for cross-repo PR reviews
  // Unified diff, kept out of `prompt` on purpose. Used only to constrain and validate
  // which files/lines the structurizer may cite. In CLI mode the prompt is just a PR link,
  // so without this the line-range guard silently does nothing.
  diffText?: string
}

export interface ReviewerSessionState {
  conversationHistory: Message[]
  sessionStarted: boolean
}
