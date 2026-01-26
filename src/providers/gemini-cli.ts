import { spawn } from 'child_process'
import type { AIProvider, Message, ProviderOptions } from './types.js'

export class GeminiCliProvider implements AIProvider {
  name = 'gemini-cli'
  private cwd: string
  private timeout: number  // ms, 0 = no timeout
  sessionId?: string  // For interface compatibility
  private hasSession: boolean = false
  private isFirstMessage: boolean = true

  constructor(_options?: ProviderOptions) {
    // No API key needed for Gemini CLI (uses Google account)
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
  }

  setCwd(cwd: string) {
    this.cwd = cwd
  }

  startSession(): void {
    this.hasSession = true
    this.isFirstMessage = true
    this.sessionId = 'gemini-session'  // Mark as having session for orchestrator
  }

  endSession(): void {
    this.hasSession = false
    this.isFirstMessage = true
    this.sessionId = undefined
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const prompt = this.hasSession && !this.isFirstMessage
      ? this.buildPromptLastOnly(messages)
      : this.buildPrompt(messages, systemPrompt)
    const result = await this.runGemini(prompt)
    this.isFirstMessage = false
    return result
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const prompt = this.hasSession && !this.isFirstMessage
      ? this.buildPromptLastOnly(messages)
      : this.buildPrompt(messages, systemPrompt)
    yield* this.runGeminiStream(prompt)
    this.isFirstMessage = false
  }

  private buildPrompt(messages: Message[], systemPrompt?: string): string {
    let prompt = ''
    if (systemPrompt) {
      prompt += `System: ${systemPrompt}\n\n`
    }
    for (const msg of messages) {
      prompt += `${msg.role}: ${msg.content}\n\n`
    }
    return prompt
  }

  private buildPromptLastOnly(messages: Message[]): string {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    return lastUserMsg?.content || ''
  }

  private runGemini(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Gemini CLI uses positional prompt and -y for auto-approve
      // Use --output-format text for clean output
      const args = ['-y', '-o', 'text']

      // Resume session if not first message
      if (this.hasSession && !this.isFirstMessage) {
        args.push('-r', 'latest')
      }

      // Add the prompt as positional argument
      args.push(prompt)

      const child = spawn('gemini', args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      let output = ''
      let error = ''

      child.stdout.on('data', (data) => {
        output += data.toString()
      })

      child.stderr.on('data', (data) => {
        error += data.toString()
      })

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Gemini CLI exited with code ${code}: ${error}`))
        } else {
          resolve(output.trim())
        }
      })

      child.on('error', (err) => {
        reject(new Error(`Failed to run gemini CLI: ${err.message}`))
      })
    })
  }

  private async *runGeminiStream(prompt: string): AsyncGenerator<string, void, unknown> {
    // Gemini CLI with text output for streaming
    const args = ['-y', '-o', 'text']

    // Resume session if not first message
    if (this.hasSession && !this.isFirstMessage) {
      args.push('-r', 'latest')
    }

    // Add the prompt as positional argument
    args.push(prompt)

    const child = spawn('gemini', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const chunks: string[] = []
    let resolveNext: ((value: { chunk: string | null }) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()

    // Timeout checker - kill if no activity for too long
    const timeoutChecker = this.timeout > 0 ? setInterval(() => {
      if (Date.now() - lastActivity > this.timeout) {
        child.kill('SIGTERM')
        done = true
        error = new Error(`Gemini CLI timed out after ${this.timeout / 1000}s of inactivity`)
        if (resolveNext) {
          resolveNext({ chunk: null })
        }
      }
    }, 10000) : null  // Check every 10s

    child.stdout.on('data', (data) => {
      lastActivity = Date.now()
      const chunk = data.toString()
      if (resolveNext) {
        resolveNext({ chunk })
        resolveNext = null
      } else {
        chunks.push(chunk)
      }
    })

    child.stderr.on('data', (_data) => {
      lastActivity = Date.now()  // Activity on stderr also counts
    })

    child.on('close', (code) => {
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      if (code !== 0 && !error) {
        error = new Error(`Gemini CLI exited with code ${code}`)
      }
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    child.on('error', (err) => {
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      error = new Error(`Failed to run gemini CLI: ${err.message}`)
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    while (!done || chunks.length > 0) {
      if (chunks.length > 0) {
        yield chunks.shift()!
      } else if (!done) {
        const result = await new Promise<{ chunk: string | null }>((resolve) => {
          resolveNext = resolve
        })
        if (result.chunk !== null) {
          yield result.chunk
        }
      }
    }

    if (error) {
      throw error
    }
  }
}
