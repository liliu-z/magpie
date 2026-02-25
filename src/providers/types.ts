// src/providers/types.ts
import { randomUUID } from 'crypto'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  /** Disable tool use for this call (e.g., for pure text extraction) */
  disableTools?: boolean
}

export interface AIProvider {
  name: string
  chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<string>
  chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown>
  setCwd?(cwd: string): void
  // Session management for multi-turn conversations
  sessionId?: string
  startSession?(name?: string): void  // Create a new session, optional name for identification
  endSession?(): void    // Clean up session
}

export interface ProviderOptions {
  apiKey: string
  model: string
  baseURL?: string
}

// Helper to generate session IDs
export function generateSessionId(): string {
  return randomUUID()
}
