import { spawn } from 'child_process'
import type { AIProvider, Message, CliProviderOptions, ChatOptions } from './types.js'
import { CliSessionHelper } from './session-helper.js'
import { preparePromptForCli } from '../utils/prompt-file.js'
import { withRetry, isTransientError } from '../utils/retry.js'
import { logger } from '../utils/logger.js'

/**
 * Transient for the claude CLI specifically.
 *
 * The shared check covers timeouts, connection resets and 429/5xx. These extras are the
 * shapes the CLI actually prints: the failure reaches us as a non-zero exit plus a line of
 * stderr, never as a structured status, so 529 (Anthropic's "overloaded") and the CLI's own
 * connection wording have to be matched as text.
 */
export function isClaudeTransientError(error: unknown): boolean {
  if (isTransientError(error)) return true
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
  return msg.includes('overloaded')
    || msg.includes('529')
    || msg.includes('connection error')
    || msg.includes('internal server error')
}

export interface ClaudeArgsOptions {
  effort: string
  cliModel?: string
  /** Set on the first message of a session; resumes it afterwards */
  sessionId?: string
  isFirstMessage?: boolean
  systemPrompt?: string
  disableTools?: boolean
  stream?: boolean
}

/**
 * Build the argv for `claude -p`. Extracted so the flags can be asserted directly — a
 * per-role setting that silently stops reaching the CLI looks exactly like one that works.
 */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  // --dangerously-skip-permissions so the reviewer can read files and run `gh` unattended
  const args = ['-p', '-', '--dangerously-skip-permissions', '--effort', options.effort]
  if (options.stream) {
    // stream-json + verbose so tool activity produces stdout events, which keeps the
    // inactivity timeout from killing Claude while it is busy investigating code
    args.push('--output-format', 'stream-json', '--verbose')
  }
  if (options.cliModel) {
    args.push('--model', options.cliModel)
  }
  // Disable all tools for pure text extraction (e.g. JSON structurization); without this
  // Claude may reach for Edit/Write to modify files instead of just answering
  if (options.disableTools) {
    args.push('--tools', '')
  }
  if (options.sessionId) {
    if (options.isFirstMessage) {
      args.push('--session-id', options.sessionId)
      if (options.systemPrompt) {
        args.push('--system-prompt', options.systemPrompt)
      }
    } else {
      args.push('--resume', options.sessionId)
    }
  }
  return args
}

export class ClaudeCodeProvider implements AIProvider {
  name = 'claude-code'
  private cwd: string
  private timeout: number  // ms, 0 = no timeout
  private cliModel?: string
  // Review is the kind of work that rewards thinking, so the default stays at the top of the
  // scale; config lowers it per role when a stage does not need to pay for that.
  private effort: string
  private session = new CliSessionHelper()
  /** Protected so tests can collapse the real waits; see chatStream */
  protected streamBackoffMs = [1000, 3000, 6000]

  get sessionId() { return this.session.sessionId }

  constructor(options?: CliProviderOptions) {
    // No API key needed for Claude Code CLI
    // Use current working directory so claude can access the repo
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
    this.cliModel = options?.cliModel
    this.effort = options?.effort || 'max'
  }

  setCwd(cwd: string) {
    this.cwd = cwd
  }

  startSession(name?: string): void {
    this.session.start(name)
  }

  endSession(): void {
    this.session.end()
  }

  async chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<string> {
    const prompt = this.session.shouldSendFullHistory()
      ? this.session.buildPrompt(messages, systemPrompt)
      : this.session.buildPromptLastOnly(messages)
    try {
      const result = await withRetry(() => this.runClaude(prompt, systemPrompt, options))
      this.session.markMessageSent()
      return result
    } catch (err) {
      this.session.start(this.session.sessionName)
      throw err
    }
  }

  /**
   * Retry before the first chunk only. Once a chunk is out it has been printed to the user,
   * and re-running the prompt would duplicate visible output — so a mid-stream failure is
   * terminal by design, not by oversight.
   *
   * `chat` has had this via `withRetry` all along; the streaming path had nothing, so a
   * blip killed the whole reviewer. Which flows survived a transient error came down to
   * which method they happened to call.
   */
  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const backoffMs = this.streamBackoffMs
    for (let attempt = 0; ; attempt++) {
      // Built inside the loop: a retry starts a fresh session, and the prompt has to match
      // that — a resumed-session prompt carries only the last message
      const prompt = this.session.shouldSendFullHistory()
        ? this.session.buildPrompt(messages, systemPrompt)
        : this.session.buildPromptLastOnly(messages)
      let emitted = false
      try {
        for await (const chunk of this.runClaudeStream(prompt, systemPrompt)) {
          emitted = true
          yield chunk
        }
        this.session.markMessageSent()
        return
      } catch (err) {
        // Reset to a fresh session ID either way, so neither the retry nor the next round
        // tries to --resume a dead or stuck session
        this.session.start(this.session.sessionName)
        if (emitted || attempt >= backoffMs.length || !isClaudeTransientError(err)) throw err
        logger.warn(`claude stream failed before output (attempt ${attempt + 1}/${backoffMs.length + 1}), retrying: ${err instanceof Error ? err.message : String(err)}`)
        await new Promise(r => setTimeout(r, backoffMs[attempt]))
      }
    }
  }

  // Spawn env: clear CLAUDECODE to avoid nested session detection when run from Claude Code
  private spawnEnv() {
    const env = { ...process.env }
    delete env.CLAUDECODE
    return env
  }

  private runClaude(prompt: string, systemPrompt?: string, options?: ChatOptions): Promise<string> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    return new Promise((resolve, reject) => {
      const args = buildClaudeArgs({
        effort: this.effort,
        cliModel: this.cliModel,
        sessionId: this.session.sessionId,
        isFirstMessage: this.session.isFirstMessage,
        systemPrompt,
        disableTools: options?.disableTools,
      })

      const child = spawn('claude', args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.spawnEnv()
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
        cleanup()
        if (code !== 0) {
          reject(new Error(`Claude CLI exited with code ${code}: ${error}`))
        } else {
          resolve(output.trim())
        }
      })

      child.on('error', (err) => {
        cleanup()
        reject(new Error(`Failed to run claude CLI: ${err.message}`))
      })

      // Write prompt to stdin and close
      // Suppress EPIPE: if child exits early, close handler reports the real error
      child.stdin.on('error', () => {})
      child.stdin.write(stdinPrompt)
      child.stdin.end()
    })
  }

  protected async *runClaudeStream(prompt: string, systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    const args = buildClaudeArgs({
      effort: this.effort,
      cliModel: this.cliModel,
      sessionId: this.session.sessionId,
      isFirstMessage: this.session.isFirstMessage,
      systemPrompt,
      stream: true,
    })

    const child = spawn('claude', args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.spawnEnv()
    })

    const chunks: string[] = []
    let resolveNext: ((value: { chunk: string | null }) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()
    let lineBuf = ''

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
        error = new Error(`Claude CLI timed out after ${this.timeout / 1000}s of inactivity`)
        if (resolveNext) {
          resolveNext({ chunk: null })
        }
      }
    }, 10000) : null  // Check every 10s

    child.stdout.on('data', (data) => {
      lastActivity = Date.now()
      // Parse stream-json: each line is a JSON event.
      // Every event (tool_use, tool_result, assistant, etc.) updates lastActivity.
      // We only yield the final result text to the caller.
      lineBuf += data.toString()
      let idx
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, idx).trim()
        lineBuf = lineBuf.slice(idx + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'result' && typeof event.result === 'string') {
            const chunk = event.result
            if (resolveNext) {
              resolveNext({ chunk })
              resolveNext = null
            } else {
              chunks.push(chunk)
            }
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    })

    let stderrOutput = ''
    child.stderr.on('data', (data) => {
      lastActivity = Date.now()  // Activity on stderr also counts
      stderrOutput += data.toString()
    })

    child.on('close', (code) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      if (code !== 0 && !error) {
        error = new Error(`Claude CLI exited with code ${code}${stderrOutput ? ': ' + stderrOutput.slice(0, 500) : ''}`)
      }
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    child.on('error', (err) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      error = new Error(`Failed to run claude CLI: ${err.message}`)
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
