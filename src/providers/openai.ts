import OpenAI from 'openai'
import type { AIProvider, Message, ProviderOptions } from './types.js'
import { withRetry } from '../utils/retry.js'

export class OpenAIProvider implements AIProvider {
  name = 'openai'
  private client: OpenAI
  private model: string

  constructor(options: ProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL })
    this.model = options.model
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      msgs.push({ role: 'system', content: systemPrompt })
    }

    msgs.push(...messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content
    })))

    const response = await withRetry(() =>
      this.client.chat.completions.create({
        model: this.model,
        messages: msgs
      })
    )

    return response.choices[0]?.message?.content || ''
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      msgs.push({ role: 'system', content: systemPrompt })
    }

    msgs.push(...messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content
    })))

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: msgs,
      stream: true
    })

    try {
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content
        if (content) {
          yield content
        }
      }
    } finally {
      stream.controller.abort()
    }
  }
}
