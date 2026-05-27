import { spawn } from 'child_process'
import type { AIProvider, Message, CliProviderOptions } from './types.js'
import { CliSessionHelper } from './session-helper.js'
import { preparePromptForCli } from '../utils/prompt-file.js'
import { withRetry } from '../utils/retry.js'

// Antigravity (`agy`) is Google's rebrand of the Gemini CLI. Compared to `gemini`:
//  - auto-approve is `--dangerously-skip-permissions` (was `-y`)
//  - print mode emits plain text on stdout (no `-o json` / `-o stream-json`)
//  - there is no `--model` flag; agy pins its own model, so cliModel is ignored
//
// Unlike gemini-cli, this provider is stateless: agy's `--conversation` resume
// re-prints the *entire* assistant transcript on every turn, which would duplicate
// prior responses. Instead each call runs a fresh conversation with the full
// message history in the prompt (the same approach the API providers use), so each
// run returns exactly one response. We therefore expose no session id.
export class AntigravityCliProvider implements AIProvider {
  name = 'antigravity'
  private cwd: string
  private timeout: number  // ms, 0 = no timeout
  private formatter = new CliSessionHelper()

  constructor(_options?: CliProviderOptions) {
    // No API key needed (uses Google account). agy has no --model flag, so cliModel is ignored.
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
  }

  setCwd(cwd: string) {
    this.cwd = cwd
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const prompt = this.formatter.buildPrompt(messages, systemPrompt)
    return withRetry(() => this.runAgy(prompt))
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const prompt = this.formatter.buildPrompt(messages, systemPrompt)
    yield* this.runAgyStream(prompt)
  }

  private buildArgs(): string[] {
    const args = ['--dangerously-skip-permissions']
    if (this.timeout > 0) {
      args.push('--print-timeout', `${Math.max(1, Math.ceil(this.timeout / 60000))}m`)
    }
    // Prompt is read from stdin via the `-` sentinel
    args.push('--print', '-')
    return args
  }

  private runAgy(prompt: string): Promise<string> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    return new Promise((resolve, reject) => {
      const child = spawn('agy', this.buildArgs(), {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      // Suppress EPIPE: if child exits early, close handler reports the real error
      child.stdin.on('error', () => {})
      child.stdin.write(stdinPrompt)
      child.stdin.end()

      let output = ''
      let error = ''

      child.stdout.on('data', (data) => {
        output += data.toString()
      })

      child.stderr.on('data', (data) => {
        error += data.toString()
      })

      child.on('close', (code) => {
        cleanup()
        if (code !== 0) {
          reject(new Error(`Antigravity CLI exited with code ${code}: ${error}`))
        } else {
          resolve(output.trim())
        }
      })

      child.on('error', (err) => {
        cleanup()
        reject(new Error(`Failed to run agy CLI: ${err.message}`))
      })
    })
  }

  private async *runAgyStream(prompt: string): AsyncGenerator<string, void, unknown> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    const child = spawn('agy', this.buildArgs(), {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const chunks: string[] = []
    let resolveNext: ((value: { chunk: string | null }) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()
    let stderrBuf = ''

    // Timeout checker - kill if no activity for too long
    const timeoutChecker = this.timeout > 0 ? setInterval(() => {
      if (Date.now() - lastActivity > this.timeout) {
        child.kill('SIGTERM')
        // Force kill if SIGTERM is ignored
        const forceKill = setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
        }, 5000)
        forceKill.unref()
        done = true
        const stderr = stderrBuf.trim()
        error = new Error(`Antigravity CLI timed out after ${this.timeout / 1000}s of inactivity${stderr ? ': ' + stderr.slice(-500) : ''}`)
        if (resolveNext) {
          resolveNext({ chunk: null })
        }
      }
    }, 10000) : null  // Check every 10s

    const pushChunk = (chunk: string) => {
      if (resolveNext) {
        resolveNext({ chunk })
        resolveNext = null
      } else {
        chunks.push(chunk)
      }
    }

    // Print mode streams the plain-text response on stdout — yield chunks as-is
    child.stdout.on('data', (data) => {
      lastActivity = Date.now()
      pushChunk(data.toString())
    })

    child.stderr.on('data', (data) => {
      lastActivity = Date.now()  // Activity on stderr also counts
      stderrBuf += data.toString()
      if (stderrBuf.length > 10000) stderrBuf = stderrBuf.slice(-10000)
    })

    child.on('close', (code) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      if (code !== 0 && !error) {
        const stderr = stderrBuf.trim()
        error = new Error(`Antigravity CLI exited with code ${code}${stderr ? ': ' + stderr.slice(-500) : ''}`)
      }
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    child.on('error', (err) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      error = new Error(`Failed to run agy CLI: ${err.message}`)
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    // Write prompt to stdin and close
    // Suppress EPIPE: if child exits early, close handler reports the real error
    child.stdin.on('error', () => {})
    child.stdin.write(stdinPrompt)
    child.stdin.end()

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
