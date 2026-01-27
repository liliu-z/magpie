import { spawn } from 'child_process'
import type { AIProvider, Message, ProviderOptions } from './types.js'

export class CodexCliProvider implements AIProvider {
  name = 'codex-cli'
  private cwd: string
  private timeout: number  // ms, 0 = no timeout

  constructor(_options?: ProviderOptions) {
    // No API key needed for Codex CLI (uses subscription)
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
  }

  setCwd(cwd: string) {
    this.cwd = cwd
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
      // Use 'codex exec -' to read from stdin (avoids command line length limits)
      // --dangerously-bypass-approvals-and-sandbox allows full access without prompts
      const child = spawn('codex', ['exec', '-', '--dangerously-bypass-approvals-and-sandbox'], {
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
          reject(new Error(`Codex CLI exited with code ${code}: ${error}`))
        } else {
          resolve(output.trim())
        }
      })

      child.on('error', (err) => {
        reject(new Error(`Failed to run codex CLI: ${err.message}`))
      })

      // Write prompt to stdin and close
      child.stdin.write(prompt)
      child.stdin.end()
    })
  }

  private async *runCodexStream(prompt: string): AsyncGenerator<string, void, unknown> {
    // Use 'codex exec -' to read from stdin (avoids command line length limits)
    // --dangerously-bypass-approvals-and-sandbox allows full access without prompts
    const child = spawn('codex', ['exec', '-', '--dangerously-bypass-approvals-and-sandbox'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const chunks: string[] = []
    let resolveNext: ((value: IteratorResult<string, void>) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()

    // Timeout checker - kill if no activity for too long
    const timeoutChecker = this.timeout > 0 ? setInterval(() => {
      if (Date.now() - lastActivity > this.timeout) {
        child.kill('SIGTERM')
        done = true
        error = new Error(`Codex CLI timed out after ${this.timeout / 1000}s of inactivity`)
        if (resolveNext) {
          resolveNext({ value: undefined as any, done: true })
        }
      }
    }, 10000) : null  // Check every 10s

    child.stdout.on('data', (data) => {
      lastActivity = Date.now()
      const chunk = data.toString()
      if (resolveNext) {
        resolveNext({ value: chunk, done: false })
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
        error = new Error(`Codex CLI exited with code ${code}`)
      }
      if (resolveNext) {
        resolveNext({ value: undefined as any, done: true })
      }
    })

    child.on('error', (err) => {
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      error = new Error(`Failed to run codex CLI: ${err.message}`)
      if (resolveNext) {
        resolveNext({ value: undefined as any, done: true })
      }
    })

    // Write prompt to stdin and close
    child.stdin.write(prompt)
    child.stdin.end()

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
