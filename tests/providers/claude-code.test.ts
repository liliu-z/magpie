// tests/providers/claude-code.test.ts
import { describe, it, expect } from 'vitest'
import { buildClaudeArgs, ClaudeCodeProvider, isClaudeTransientError } from '../../src/providers/claude-code.js'

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('buildClaudeArgs', () => {
  it('runs headless in danger mode, reading the prompt from stdin', () => {
    const args = buildClaudeArgs({ effort: 'max' })
    expect(args.slice(0, 2)).toEqual(['-p', '-'])
    expect(args).toContain('--dangerously-skip-permissions')
  })

  it('passes the effort level through', () => {
    expect(after(buildClaudeArgs({ effort: 'xhigh' }), '--effort')).toBe('xhigh')
    expect(after(buildClaudeArgs({ effort: 'low' }), '--effort')).toBe('low')
  })

  it('passes the model through', () => {
    const args = buildClaudeArgs({ effort: 'max', cliModel: 'claude-opus-5' })
    expect(after(args, '--model')).toBe('claude-opus-5')
  })

  it('omits --model when none is pinned', () => {
    expect(buildClaudeArgs({ effort: 'max' })).not.toContain('--model')
  })

  it('adds streaming flags only when streaming', () => {
    expect(buildClaudeArgs({ effort: 'max' })).not.toContain('--output-format')
    const args = buildClaudeArgs({ effort: 'max', stream: true })
    expect(after(args, '--output-format')).toBe('stream-json')
    expect(args).toContain('--verbose')
  })

  it('empties the toolset when tools are disabled', () => {
    // Pure text extraction: with tools available Claude may edit files instead of answering
    expect(after(buildClaudeArgs({ effort: 'max', disableTools: true }), '--tools')).toBe('')
    expect(buildClaudeArgs({ effort: 'max' })).not.toContain('--tools')
  })

  it('opens a session with an id and system prompt on the first message', () => {
    const args = buildClaudeArgs({ effort: 'max', sessionId: 'abc', isFirstMessage: true, systemPrompt: 'be terse' })
    expect(after(args, '--session-id')).toBe('abc')
    expect(after(args, '--system-prompt')).toBe('be terse')
    expect(args).not.toContain('--resume')
  })

  it('resumes rather than re-opening on later messages', () => {
    const args = buildClaudeArgs({ effort: 'max', sessionId: 'abc', isFirstMessage: false, systemPrompt: 'be terse' })
    expect(after(args, '--resume')).toBe('abc')
    expect(args).not.toContain('--session-id')
    // The system prompt belongs to the session; re-sending it would duplicate it
    expect(args).not.toContain('--system-prompt')
  })

  it('sends no session flags when no session is active', () => {
    const args = buildClaudeArgs({ effort: 'max' })
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain('--resume')
  })
})

describe('ClaudeCodeProvider effort', () => {
  // A per-role setting that stops reaching the CLI looks exactly like one that works,
  // so the default and the override are both pinned here
  it('defaults to max when config says nothing', () => {
    const p = new ClaudeCodeProvider() as unknown as { effort: string }
    expect(p.effort).toBe('max')
  })

  it('takes the configured effort', () => {
    const p = new ClaudeCodeProvider({ effort: 'xhigh' }) as unknown as { effort: string }
    expect(p.effort).toBe('xhigh')
  })

  it('falls back to max on an empty value rather than passing nothing', () => {
    const p = new ClaudeCodeProvider({ effort: '' }) as unknown as { effort: string }
    expect(p.effort).toBe('max')
  })
})

describe('chatStream retry', () => {
  // Same hole opencode had: only `chat` went through withRetry, so a blip on the streaming
  // path killed the reviewer outright. The debate flow streams every reviewer call.
  class FlakyStream extends ClaudeCodeProvider {
    attempts = 0
    constructor(private failures: number, private failWith: string, private emitBeforeFail = false) {
      super()
      this.streamBackoffMs = [1, 1, 1]     // keep the retry schedule, drop the waiting
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected async *runClaudeStream(): any {
      this.attempts++
      if (this.attempts <= this.failures) {
        if (this.emitBeforeFail) yield 'partial output'
        throw new Error(this.failWith)
      }
      yield 'ok'
    }
  }

  const drain = async (p: ClaudeCodeProvider) => {
    const out: string[] = []
    for await (const c of p.chatStream([{ role: 'user', content: 'hi' }])) out.push(c)
    return out.join('')
  }

  it('retries a transient failure that happened before any output', async () => {
    const p = new FlakyStream(2, 'Claude CLI exited with code 1: API Error 529 overloaded_error')
    expect(await drain(p)).toBe('ok')
    expect(p.attempts).toBe(3)
  })

  it('does not retry once output has been handed to the caller', async () => {
    // Retrying here would print the partial output twice
    const p = new FlakyStream(1, 'overloaded', true)
    await expect(drain(p)).rejects.toThrow('overloaded')
    expect(p.attempts).toBe(1)
  })

  it('does not retry a non-transient failure', async () => {
    const p = new FlakyStream(1, 'Claude CLI exited with code 1: invalid model')
    await expect(drain(p)).rejects.toThrow('invalid model')
    expect(p.attempts).toBe(1)
  })

  it('gives up after the backoff schedule is exhausted', async () => {
    const p = new FlakyStream(99, 'rate limit')
    await expect(drain(p)).rejects.toThrow('rate limit')
    expect(p.attempts).toBe(4)
  })

  // A retry runs against a fresh session id, so it must re-send the whole conversation
  // rather than the last message alone
  it('starts a fresh session before retrying', async () => {
    const p = new FlakyStream(1, 'overloaded')
    const before = p.sessionId
    await drain(p)
    expect(p.sessionId).not.toBe(before)
  })
})

describe('isClaudeTransientError', () => {
  it('catches what the CLI prints when the API is briefly unavailable', () => {
    for (const m of ['API Error 529', 'Overloaded', 'Connection error', 'rate limit exceeded', 'Internal Server Error', 'request timeout']) {
      expect(isClaudeTransientError(new Error(m))).toBe(true)
    }
  })

  it('leaves real failures alone', () => {
    for (const m of ['invalid model', 'permission denied', 'no such file']) {
      expect(isClaudeTransientError(new Error(m))).toBe(false)
    }
  })
})
