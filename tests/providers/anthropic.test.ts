import { describe, it, expect, vi } from 'vitest'
import { AnthropicProvider } from '../../src/providers/anthropic.js'

let lastConstructorOptions: Record<string, unknown> = {}

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Mock response' }]
      }),
      stream: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk1' } }
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk2' } }
        },
        abort: vi.fn()
      })
    }
    constructor(options: Record<string, unknown>) {
      lastConstructorOptions = options
    }
  }
}))

describe('AnthropicProvider', () => {
  it('should have correct name', () => {
    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' })
    expect(provider.name).toBe('anthropic')
  })

  it('should call chat and return response', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' })
    const result = await provider.chat([{ role: 'user', content: 'Hello' }])
    expect(result).toBe('Mock response')
  })

  it('should stream responses', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' })
    const chunks: string[] = []
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'Hello' }])) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual(['chunk1', 'chunk2'])
  })

  it('should pass baseURL to SDK when provided', () => {
    new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514', baseURL: 'https://my-proxy.example.com' })
    expect(lastConstructorOptions.baseURL).toBe('https://my-proxy.example.com')
  })

  it('should not set baseURL when not provided', () => {
    new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' })
    expect(lastConstructorOptions.baseURL).toBeUndefined()
  })
})
