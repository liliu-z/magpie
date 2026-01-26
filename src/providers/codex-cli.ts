import { spawn } from 'child_process'
import type { AIProvider, Message, ProviderOptions } from './types.js'

export class CodexCliProvider implements AIProvider {
  name = 'codex-cli'

  constructor(_options?: ProviderOptions) {
    // No API key needed for Codex CLI (uses subscription)
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const prompt = this.buildPrompt(messages, systemPrompt)
    return this.runCodex(prompt)
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const prompt = this.buildPrompt(messages, systemPrompt)
    yield* this.runCodexStream(prompt)
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

  private runCodex(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('codex', ['-p', prompt], {
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
          reject(new Error(`Codex CLI exited with code ${code}: ${error}`))
        } else {
          resolve(output.trim())
        }
      })

      child.on('error', (err) => {
        reject(new Error(`Failed to run codex CLI: ${err.message}`))
      })
    })
  }

  private async *runCodexStream(prompt: string): AsyncGenerator<string, void, unknown> {
    const child = spawn('codex', ['-p', prompt], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const chunks: string[] = []
    let resolveNext: ((value: IteratorResult<string, void>) => void) | null = null
    let done = false
    let error: Error | null = null

    child.stdout.on('data', (data) => {
      const chunk = data.toString()
      if (resolveNext) {
        resolveNext({ value: chunk, done: false })
        resolveNext = null
      } else {
        chunks.push(chunk)
      }
    })

    child.stderr.on('data', (_data) => {
      // Ignore stderr
    })

    child.on('close', (code) => {
      done = true
      if (code !== 0) {
        error = new Error(`Codex CLI exited with code ${code}`)
      }
      if (resolveNext) {
        resolveNext({ value: undefined as any, done: true })
      }
    })

    child.on('error', (err) => {
      done = true
      error = new Error(`Failed to run codex CLI: ${err.message}`)
      if (resolveNext) {
        resolveNext({ value: undefined as any, done: true })
      }
    })

    while (!done || chunks.length > 0) {
      if (chunks.length > 0) {
        yield chunks.shift()!
      } else if (!done) {
        const chunk = await new Promise<IteratorResult<string, void>>((resolve) => {
          resolveNext = resolve
        })
        if (!chunk.done) {
          yield chunk.value
        }
      }
    }

    if (error) {
      throw error
    }
  }
}
