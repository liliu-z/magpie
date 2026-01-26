// tests/providers/types.test.ts
import { describe, it, expect } from 'vitest'
import type { AIProvider, Message, ProviderOptions } from '../../src/providers/types'

describe('Provider Types', () => {
  it('should define correct message structure', () => {
    const message: Message = {
      role: 'user',
      content: 'Hello'
    }
    expect(message.role).toBe('user')
  })

  it('should define provider interface', () => {
    const mockProvider: AIProvider = {
      name: 'test',
      chat: async () => 'response',
      chatStream: async function* () { yield 'chunk' }
    }
    expect(mockProvider.name).toBe('test')
  })
})
