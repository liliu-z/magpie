import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider, Message, ProviderOptions } from './types.js'
import { withRetry } from '../utils/retry.js'

export class AnthropicProvider implements AIProvider {
  name = 'anthropic'
  private client: Anthropic
  private model: string

  constructor(options: ProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL })
    this.model = options.model
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const response = await withRetry(() =>
      this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role === 'system' ? 'user' : m.role,
          content: m.content
        }))
      })
    )

    const textBlock = response.content.find(block => block.type === 'text')
    return textBlock?.type === 'text' ? textBlock.text : ''
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      }))
    })

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text
        }
      }
    } finally {
      stream.abort()
    }
  }
}
