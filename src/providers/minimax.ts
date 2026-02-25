import type { AIProvider, Message, ProviderOptions, ChatOptions } from './types.js'

/**
 * MiniMax provider using their OpenAI-compatible API.
 *
 * Uses the MiniMax-M2.5 model via https://api.minimax.io/v1
 * Strips <think>...</think> reasoning tags from output.
 */
export class MiniMaxProvider implements AIProvider {
  name = 'minimax'
  private apiKey: string
  private model: string
  private baseUrl: string
  sessionId?: string
  private conversationHistory: Message[] = []
  private sessionEnabled = false
  private isFirstMessage = true
  private sessionName?: string

  constructor(options?: ProviderOptions) {
    this.apiKey = options?.apiKey || process.env.MINIMAX_API_KEY || ''
    this.model = options?.model || 'MiniMax-M2.5'
    this.baseUrl = options?.baseURL || 'https://api.minimax.io/v1'
    if (!this.apiKey) {
      throw new Error('MiniMax API key is required. Set MINIMAX_API_KEY env var or pass apiKey in options.')
    }
  }

  startSession(name?: string): void {
    this.sessionEnabled = true
    this.isFirstMessage = true
    this.conversationHistory = []
    this.sessionName = name
  }

  endSession(): void {
    this.sessionEnabled = false
    this.isFirstMessage = true
    this.conversationHistory = []
    this.sessionName = undefined
  }

  async chat(messages: Message[], systemPrompt?: string, _options?: ChatOptions): Promise<string> {
    // Build API messages
    const apiMessages: Array<{ role: string; content: string }> = []

    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt })
    }

    if (this.sessionEnabled && !this.isFirstMessage) {
      // In session mode, include conversation history + new message
      for (const msg of this.conversationHistory) {
        apiMessages.push({ role: msg.role, content: msg.content })
      }
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
      if (lastUserMsg) {
        apiMessages.push({ role: 'user', content: lastUserMsg.content })
      }
    } else {
      // First message or no session: include all messages
      if (this.sessionName && this.isFirstMessage) {
        const firstMsg = messages[0]
        if (firstMsg) {
          apiMessages.push({
            role: firstMsg.role,
            content: `[${this.sessionName}]\n\n${firstMsg.content}`
          })
          for (let i = 1; i < messages.length; i++) {
            apiMessages.push({ role: messages[i].role, content: messages[i].content })
          }
        }
      } else {
        for (const msg of messages) {
          apiMessages.push({ role: msg.role, content: msg.content })
        }
      }
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: apiMessages,
        max_tokens: 16000,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`MiniMax API error ${response.status}: ${text}`)
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>
    }

    let content = data.choices?.[0]?.message?.content || ''
    // Strip <think>...</think> reasoning tags
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    // Strip <minimax:tool_call>...</minimax:tool_call> hallucinations (MiniMax is API-only, no tools)
    content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>\s*/g, '')

    // Update session history
    if (this.sessionEnabled) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
      if (lastUserMsg) {
        this.conversationHistory.push(lastUserMsg)
      }
      this.conversationHistory.push({ role: 'assistant', content })
      this.isFirstMessage = false
    }

    return content.trim()
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    // MiniMax supports streaming but for simplicity, use non-streaming and yield result
    const result = await this.chat(messages, systemPrompt)
    yield result
  }
}
