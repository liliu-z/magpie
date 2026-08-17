import { spawn } from 'child_process'
import type { AIProvider, Message, CliProviderOptions, ChatOptions } from './types.js'
import { CliSessionHelper } from './session-helper.js'
import { logger } from '../utils/logger.js'
import { preparePromptForCli } from '../utils/prompt-file.js'
import { withRetry } from '../utils/retry.js'

// opencode (https://opencode.ai) headless mode:
//  - `opencode run` with no positional message reads the prompt from stdin
//  - auto-approve ("danger mode") is `--auto`
//  - `--format json` emits an NDJSON event stream on stdout; the default format
//    is ANSI-decorated and prefixed with a `> agent · model` header, so we parse JSON
//  - `--model provider/model` selects the model, e.g. `opencode:anthropic/claude-sonnet-4-5`
//  - `--session <id>` resumes a session. Unlike the other CLI providers the session id is
//    minted by opencode, not by us, so we capture it off the event stream and only switch to
//    incremental prompts once we actually have one.

export interface OpencodeArgsOptions {
  cliModel?: string
  sessionId?: string
  cwd?: string
  disableTools?: boolean
}

/**
 * opencode keeps session state in a shared SQLite database, so concurrent runs (several
 * reviewers, or one reviewer sharded across files) can collide on it. The collision is
 * transient — a retry a second later succeeds — but it does not look like any of the
 * network errors the default retry predicate recognises.
 */
export function isOpencodeTransientError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
  return msg.includes('database is locked')
    || msg.includes('database table is locked')
    // Seen when its store had grown to gigabytes: contention surfaces as a generic statement
    // failure rather than a lock error, which used to bypass retry entirely and fail the shard
    || msg.includes('failed to execute statement')
    || msg.includes('sqlite_busy')
    || msg.includes('timeout')
    || msg.includes('econnreset')
    || msg.includes('rate limit')
    || msg.includes('429')
    || msg.includes('502')
    || msg.includes('503')
}

/** Build the argv for `opencode run`. The prompt is never a positional — it goes on stdin. */
export function buildOpencodeArgs(options: OpencodeArgsOptions = {}): string[] {
  // --auto: auto-approve permissions, so the reviewer can read files and run `gh` unattended
  const args = ['run', '--auto', '--format', 'json']
  if (options.cwd) {
    // opencode resolves its project directory from $PWD rather than the spawned process's
    // cwd, so a bare spawn({ cwd }) would review whatever directory magpie was launched
    // from. State the directory explicitly.
    args.push('--dir', options.cwd)
  }
  if (options.disableTools) {
    // opencode has no "no tools" switch; `plan` is its built-in non-editing agent, which is
    // what pure text extraction (e.g. JSON structurization) needs — no file mutations.
    args.push('--agent', 'plan')
  }
  if (options.cliModel) {
    args.push('--model', options.cliModel)
  }
  if (options.sessionId) {
    args.push('--session', options.sessionId)
  }
  return args
}

/**
 * Incremental parser for opencode's `--format json` NDJSON event stream.
 * Yields assistant text as it arrives and captures the session id.
 */
export class OpencodeEventParser {
  sessionId?: string
  /** First error reported on the event stream; opencode leaves stderr empty on failure */
  errorMessage?: string
  private buffer = ''
  private textByPartId = new Map<string, string>()

  /** Feed a stdout chunk; returns the assistant text produced by it (may be empty). */
  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.flatMap(line => this.parseLine(line))
  }

  /** Flush a trailing line that arrived without a newline (process exited mid-line). */
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    return this.parseLine(rest)
  }

  private parseLine(line: string): string[] {
    const trimmed = line.trim()
    if (!trimmed) return []

    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      // Not an event line (banner, stray log) — ignore
      return []
    }
    if (!event || typeof event !== 'object') return []

    if (!this.sessionId) {
      const id = event.sessionID ?? event.part?.sessionID
      if (typeof id === 'string' && id) {
        this.sessionId = id
      }
    }

    if (event.type === 'error' && !this.errorMessage) {
      const name = typeof event.error?.name === 'string' ? event.error.name : ''
      const message = typeof event.error?.data?.message === 'string' ? event.error.data.message : ''
      const combined = [name, message].filter(Boolean).join(': ')
      this.errorMessage = combined || 'unknown error'
      return []
    }

    if (event.type !== 'text') return []
    const text = event.part?.text
    if (typeof text !== 'string' || !text) return []

    // opencode emits a completed text part per event, but re-emit a growing part and we'd
    // otherwise duplicate the prefix — so only ever emit what's new for that part id.
    const partId = event.part?.id
    if (typeof partId !== 'string' || !partId) return [text]

    const seen = this.textByPartId.get(partId) ?? ''
    if (text === seen) return []
    this.textByPartId.set(partId, text)
    return [text.startsWith(seen) ? text.slice(seen.length) : text]
  }
}

export class OpenCodeProvider implements AIProvider {
  name = 'opencode'
  private cwd: string
  private timeout: number  // ms, 0 = no timeout
  private cliModel?: string
  private session = new CliSessionHelper()
  // Session id minted by opencode; undefined until the first run reports one
  private opencodeSessionId?: string
  // Escape hatch for anyone who wants to inspect a review's session afterwards, at the cost
  // of growing opencode's store without bound — see endSession
  private keepSessions = process.env.MAGPIE_KEEP_OPENCODE_SESSIONS === '1'

  get sessionId() { return this.opencodeSessionId }

  constructor(options?: CliProviderOptions) {
    // No API key needed — opencode uses its own configured provider credentials
    this.cwd = process.cwd()
    this.timeout = 15 * 60 * 1000  // 15 minutes default
    this.cliModel = options?.cliModel
  }

  setCwd(cwd: string) {
    this.cwd = cwd
  }

  startSession(name?: string): void {
    this.session.start(name)
    this.opencodeSessionId = undefined
  }

  /**
   * End the session and delete it from opencode's store.
   *
   * opencode records a `message.updated` event on every growth of an assistant message, and
   * each event carries the whole message so far — so one long agentic session costs roughly
   * the square of its final size on disk. A review is exactly that shape, and measured here
   * it cost about 900MB of event log per PR. Nothing in opencode expires it (there is no
   * retention setting), so a few reviews are enough to push its SQLite store into the
   * gigabytes, at which point every writer starts losing to lock contention and reviews fail
   * with "database is locked" or "Failed to execute statement".
   *
   * magpie's sessions are single-use, so it owns the cleanup. Best-effort and detached: a
   * failed cleanup must never fail the review, but skipping it degrades the next run.
   */
  endSession(): void {
    const id = this.opencodeSessionId
    this.session.end()
    this.opencodeSessionId = undefined
    if (!id || this.keepSessions) return

    try {
      const child = spawn('opencode', ['session', 'delete', id], {
        cwd: this.cwd,
        env: { ...process.env, PWD: this.cwd },
        stdio: 'ignore',
        detached: true,
      })
      child.on('error', () => {})
      child.unref()
    } catch {
      // Cleanup is opportunistic; the review has already produced its result
    }
  }

  /** Resume only when a session is active AND opencode has given us an id to resume */
  private resumeId(): string | undefined {
    return this.session.shouldSendFullHistory() ? undefined : this.opencodeSessionId
  }

  async chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<string> {
    const resume = this.resumeId()
    const prompt = resume
      ? this.session.buildPromptLastOnly(messages)
      : this.session.buildPrompt(messages, systemPrompt)
    try {
      const result = await withRetry(
        () => this.runOpencode(prompt, resume, options),
        { maxAttempts: 4, backoffMs: [1000, 3000, 6000], shouldRetry: isOpencodeTransientError },
      )
      this.markSent()
      return result
    } catch (err) {
      this.resetSession()
      throw err
    }
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const resume = this.resumeId()
    const prompt = resume
      ? this.session.buildPromptLastOnly(messages)
      : this.session.buildPrompt(messages, systemPrompt)
    try {
      yield* this.spawnOpencode(prompt, resume)
      this.markSent()
    } catch (err) {
      this.resetSession()
      throw err
    }
  }

  /**
   * Only advance past the first message once opencode has handed us a session id —
   * without one the next call cannot resume and must re-send the full history.
   */
  private markSent(): void {
    if (this.session.sessionId && this.opencodeSessionId) {
      this.session.markMessageSent()
    }
  }

  /** Drop the resume id so the next round starts a clean opencode session */
  private resetSession(): void {
    this.opencodeSessionId = undefined
    if (this.session.sessionId) {
      this.session.start(this.session.sessionName)
    }
  }

  private async runOpencode(prompt: string, resumeSessionId?: string, options?: ChatOptions): Promise<string> {
    let output = ''
    for await (const chunk of this.spawnOpencode(prompt, resumeSessionId, options)) {
      output += chunk
    }
    return output.trim()
  }

  private async *spawnOpencode(prompt: string, resumeSessionId?: string, options?: ChatOptions): AsyncGenerator<string, void, unknown> {
    const { prompt: stdinPrompt, cleanup } = preparePromptForCli(prompt)

    const args = buildOpencodeArgs({
      cliModel: this.cliModel,
      sessionId: resumeSessionId,
      cwd: this.cwd,
      disableTools: options?.disableTools,
    })
    const child = spawn('opencode', args, {
      cwd: this.cwd,
      // opencode reads $PWD to locate the project; spawn's cwd alone leaves the parent's
      // stale PWD in place, which would point the reviewer at the wrong repo
      env: { ...process.env, PWD: this.cwd },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const parser = new OpencodeEventParser()
    const chunks: string[] = []
    let resolveNext: ((value: { chunk: string | null }) => void) | null = null
    let done = false
    let error: Error | null = null
    let lastActivity = Date.now()
    let stderrBuf = ''

    // Timeout checker - kill if no activity for too long.
    // Tool activity also produces events, so a busy reviewer keeps resetting this.
    const timeoutChecker = this.timeout > 0 ? setInterval(() => {
      if (Date.now() - lastActivity > this.timeout) {
        child.kill('SIGTERM')
        // Force kill if SIGTERM is ignored
        const forceKill = setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
        }, 5000)
        forceKill.unref()
        done = true
        const detail = parser.errorMessage || stderrBuf.trim()
        error = new Error(`OpenCode CLI timed out after ${this.timeout / 1000}s of inactivity${detail ? ': ' + detail.slice(-500) : ''}`)
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

    child.stdout.on('data', (data) => {
      lastActivity = Date.now()
      for (const text of parser.push(data.toString())) {
        pushChunk(text)
      }
    })

    child.stderr.on('data', (data) => {
      lastActivity = Date.now()  // Activity on stderr also counts
      stderrBuf += data.toString()
      if (stderrBuf.length > 10000) stderrBuf = stderrBuf.slice(-10000)
    })

    child.on('close', (code) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      for (const text of parser.flush()) {
        chunks.push(text)
      }
      done = true
      if (code !== 0 && !error) {
        // Failures arrive as an `error` event on stdout; stderr is usually empty
        const detail = parser.errorMessage || stderrBuf.trim()
        logger.debug(`[opencode] exit=${code} detail=${detail.slice(0, 500)}`)
        error = new Error(`OpenCode CLI exited with code ${code}${detail ? ': ' + detail.slice(-500) : ''}`)
      }
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    child.on('error', (err) => {
      cleanup()
      if (timeoutChecker) clearInterval(timeoutChecker)
      done = true
      error = new Error(`Failed to run opencode CLI: ${err.message}`)
      if (resolveNext) {
        resolveNext({ chunk: null })
      }
    })

    // Write prompt to stdin and close
    // Suppress EPIPE: if child exits early, close handler reports the real error
    child.stdin.on('error', () => {})
    child.stdin.write(stdinPrompt)
    child.stdin.end()

    let emittedText = false
    while (!done || chunks.length > 0) {
      let chunk: string | null = null
      if (chunks.length > 0) {
        chunk = chunks.shift()!
      } else if (!done) {
        const result = await new Promise<{ chunk: string | null }>((resolve) => {
          resolveNext = resolve
        })
        chunk = result.chunk
      }
      if (chunk !== null) {
        emittedText ||= chunk.trim().length > 0
        yield chunk
      }
    }

    if (error) {
      throw error
    }

    if (!emittedText) {
      // Exit code 0 with no assistant text means opencode failed quietly
      // (unusable model, missing credentials, …) — surface it instead of returning ''
      const detail = parser.errorMessage || stderrBuf.trim()
      throw new Error(`OpenCode CLI produced no response${detail ? ': ' + detail.slice(-500) : ''}`)
    }

    // Remember the session opencode created so the next round can resume it
    if (parser.sessionId) {
      this.opencodeSessionId = parser.sessionId
    }
  }
}
