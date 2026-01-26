import { GoogleGenerativeAI } from '@google/generative-ai'
import type { AIProvider, Message, ProviderOptions } from './types.js'

export class GeminiProvider implements AIProvider {
  name = 'gemini'
  private client: GoogleGenerativeAI
  private model: string

  constructor(options: ProviderOptions) {
    this.client = new GoogleGenerativeAI(options.apiKey)
    this.model = options.model
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const model = this.client.getGenerativeModel({ model: this.model })

    // Build conversation history
    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }))

    const chat = model.startChat({
      history,
      systemInstruction: systemPrompt
    })

    const lastMessage = messages[messages.length - 1]
    const result = await chat.sendMessage(lastMessage.content)
    return result.response.text()
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const model = this.client.getGenerativeModel({ model: this.model })

    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }))

    const chat = model.startChat({
      history,
      systemInstruction: systemPrompt
    })

    const lastMessage = messages[messages.length - 1]
    const result = await chat.sendMessageStream(lastMessage.content)

    for await (const chunk of result.stream) {
      const text = chunk.text()
      if (text) {
        yield text
      }
    }
  }
}
