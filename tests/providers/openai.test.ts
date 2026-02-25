import { describe, it, expect, vi } from 'vitest'
import { OpenAIProvider } from '../../src/providers/openai'

let lastConstructorOptions: Record<string, unknown> = {}

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'Mock response' } }]
        })
      }
    }
    constructor(options: Record<string, unknown>) {
      lastConstructorOptions = options
    }
  }
}))

describe('OpenAIProvider', () => {
  it('should have correct name', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    expect(provider.name).toBe('openai')
  })

  it('should call chat and return response', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    const result = await provider.chat([{ role: 'user', content: 'Hello' }])
    expect(result).toBe('Mock response')
  })

  it('should pass baseURL to SDK when provided', () => {
    new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o', baseURL: 'https://my-proxy.example.com/v1' })
    expect(lastConstructorOptions.baseURL).toBe('https://my-proxy.example.com/v1')
  })

  it('should not set baseURL when not provided', () => {
    new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    expect(lastConstructorOptions.baseURL).toBeUndefined()
  })
})
