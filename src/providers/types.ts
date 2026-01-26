// src/providers/types.ts
import { randomUUID } from 'crypto'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIProvider {
  name: string
  chat(messages: Message[], systemPrompt?: string): Promise<string>
  chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown>
  setCwd?(cwd: string): void
  // Session management for multi-turn conversations
  sessionId?: string
  startSession?(): void  // Create a new session
  endSession?(): void    // Clean up session
}

export interface ProviderOptions {
  apiKey: string
  model: string
}

// Helper to generate session IDs
export function generateSessionId(): string {
  return randomUUID()
}
