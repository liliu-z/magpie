// src/providers/types.ts
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIProvider {
  name: string
  chat(messages: Message[], systemPrompt?: string): Promise<string>
  chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown>
  setCwd?(cwd: string): void
}

export interface ProviderOptions {
  apiKey: string
  model: string
}
