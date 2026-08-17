// tests/providers/opencode.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildOpencodeArgs, OpencodeEventParser, isOpencodeTransientError } from '../../src/providers/opencode.js'

// Helper: build one NDJSON line the way `opencode run --format json` emits them
function evt(type: string, part: Record<string, unknown>, sessionID = 'ses_abc'): string {
  return JSON.stringify({ type, timestamp: 1, sessionID, part: { sessionID, ...part } }) + '\n'
}

describe('buildOpencodeArgs', () => {
  it('runs `run` in danger mode with json output', () => {
    const args = buildOpencodeArgs()
    expect(args[0]).toBe('run')
    expect(args).toContain('--auto')      // danger mode: auto-approve permissions
    expect(args).toContain('--format')
    expect(args[args.indexOf('--format') + 1]).toBe('json')
  })

  it('passes no positional message so the prompt is read from stdin', () => {
    const args = buildOpencodeArgs({ cliModel: 'anthropic/claude-sonnet-4-5', sessionId: 'ses_1', cwd: '/repo' })
    // Every arg is either a flag or the value of the flag before it
    const flagValues = new Set(['json', 'anthropic/claude-sonnet-4-5', 'ses_1', '/repo'])
    for (const arg of args.slice(1)) {
      expect(arg.startsWith('--') || flagValues.has(arg)).toBe(true)
    }
  })

  it('pins the working directory with --dir', () => {
    // opencode resolves its project dir from $PWD, not the spawned process cwd,
    // so the directory has to be stated explicitly
    const args = buildOpencodeArgs({ cwd: '/repo/worktree' })
    expect(args[args.indexOf('--dir') + 1]).toBe('/repo/worktree')
  })

  it('omits --dir when no cwd is given', () => {
    expect(buildOpencodeArgs()).not.toContain('--dir')
  })

  it('uses the non-editing plan agent when tools are disabled', () => {
    const args = buildOpencodeArgs({ disableTools: true })
    expect(args[args.indexOf('--agent') + 1]).toBe('plan')
  })

  it('omits --agent by default', () => {
    expect(buildOpencodeArgs()).not.toContain('--agent')
  })

  it('omits --model when no cliModel is given', () => {
    expect(buildOpencodeArgs()).not.toContain('--model')
  })

  it('passes cliModel through --model', () => {
    const args = buildOpencodeArgs({ cliModel: 'anthropic/claude-sonnet-4-5' })
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-5')
  })

  it('omits --session when no session id is given', () => {
    expect(buildOpencodeArgs()).not.toContain('--session')
  })

  it('passes session id through --session', () => {
    const args = buildOpencodeArgs({ sessionId: 'ses_xyz' })
    expect(args[args.indexOf('--session') + 1]).toBe('ses_xyz')
  })
})

describe('isOpencodeTransientError', () => {
  // Seen for real when two reviewers ran concurrently: opencode's shared SQLite state
  // collides, and the default transient-error predicate does not recognise it
  it('retries a locked database', () => {
    expect(isOpencodeTransientError(new Error('OpenCode CLI exited with code 1: database is locked'))).toBe(true)
    expect(isOpencodeTransientError(new Error('SQLITE_BUSY: database table is locked'))).toBe(true)
  })

  it('retries the usual transient network failures', () => {
    expect(isOpencodeTransientError(new Error('request timeout'))).toBe(true)
    expect(isOpencodeTransientError(new Error('rate limit exceeded'))).toBe(true)
    expect(isOpencodeTransientError(new Error('upstream returned 503'))).toBe(true)
  })

  it('does not retry a real failure', () => {
    expect(isOpencodeTransientError(new Error('OpenCode CLI produced no response'))).toBe(false)
    expect(isOpencodeTransientError(new Error('model not found'))).toBe(false)
    expect(isOpencodeTransientError(null)).toBe(false)
  })
})

describe('OpencodeEventParser', () => {
  let parser: OpencodeEventParser

  beforeEach(() => {
    parser = new OpencodeEventParser()
  })

  it('extracts text from text events', () => {
    const out = parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'PONG' }))
    expect(out).toEqual(['PONG'])
  })

  it('ignores step and tool events', () => {
    let out = parser.push(evt('step_start', { id: 'prt_0', type: 'step-start' }))
    expect(out).toEqual([])
    out = parser.push(evt('tool_use', { id: 'prt_1', type: 'tool', tool: 'read' }))
    expect(out).toEqual([])
    out = parser.push(evt('step_finish', { id: 'prt_2', type: 'step-finish' }))
    expect(out).toEqual([])
  })

  it('captures the session id from any event', () => {
    expect(parser.sessionId).toBeUndefined()
    parser.push(evt('step_start', { id: 'prt_0', type: 'step-start' }, 'ses_captured'))
    expect(parser.sessionId).toBe('ses_captured')
  })

  it('keeps the first session id even if later events differ', () => {
    parser.push(evt('step_start', { id: 'prt_0', type: 'step-start' }, 'ses_first'))
    parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'hi' }, 'ses_other'))
    expect(parser.sessionId).toBe('ses_first')
  })

  it('reassembles a line split across chunks', () => {
    const line = evt('text', { id: 'prt_1', type: 'text', text: 'hello world' })
    const cut = Math.floor(line.length / 2)
    expect(parser.push(line.slice(0, cut))).toEqual([])
    expect(parser.push(line.slice(cut))).toEqual(['hello world'])
  })

  it('handles multiple events arriving in one chunk', () => {
    const chunk =
      evt('text', { id: 'prt_1', type: 'text', text: 'one' }) +
      evt('step_finish', { id: 'prt_2', type: 'step-finish' }) +
      evt('text', { id: 'prt_3', type: 'text', text: 'two' })
    expect(parser.push(chunk)).toEqual(['one', 'two'])
  })

  it('emits only the delta when a part is re-emitted with grown text', () => {
    expect(parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'Hello' }))).toEqual(['Hello'])
    expect(parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'Hello world' }))).toEqual([' world'])
    expect(parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'Hello world' }))).toEqual([])
  })

  it('emits the full text when a re-emitted part is not an extension', () => {
    parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'first' }))
    expect(parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'unrelated' }))).toEqual(['unrelated'])
  })

  it('treats distinct part ids independently', () => {
    parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'abc' }))
    expect(parser.push(evt('text', { id: 'prt_2', type: 'text', text: 'abc' }))).toEqual(['abc'])
  })

  it('ignores non-JSON noise and empty lines', () => {
    const chunk = '\nnot json at all\n' + evt('text', { id: 'prt_1', type: 'text', text: 'ok' })
    expect(parser.push(chunk)).toEqual(['ok'])
  })

  it('ignores text events with empty or missing text', () => {
    expect(parser.push(evt('text', { id: 'prt_1', type: 'text', text: '' }))).toEqual([])
    expect(parser.push(evt('text', { id: 'prt_2', type: 'text' }))).toEqual([])
  })

  it('flush emits a trailing line that had no newline', () => {
    const line = evt('text', { id: 'prt_1', type: 'text', text: 'tail' }).trimEnd()
    expect(parser.push(line)).toEqual([])
    expect(parser.flush()).toEqual(['tail'])
  })

  it('captures the message from an error event', () => {
    // opencode reports failures as an event on stdout and leaves stderr empty
    const line = JSON.stringify({
      type: 'error',
      sessionID: 'ses_abc',
      error: { name: 'UnknownError', data: { message: 'Unexpected server error.' } }
    }) + '\n'
    expect(parser.push(line)).toEqual([])
    expect(parser.errorMessage).toBe('UnknownError: Unexpected server error.')
  })

  it('falls back to the error name when it carries no message', () => {
    const line = JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError' } }) + '\n'
    parser.push(line)
    expect(parser.errorMessage).toBe('ProviderAuthError')
  })

  it('keeps the first error message', () => {
    parser.push(JSON.stringify({ type: 'error', error: { name: 'First' } }) + '\n')
    parser.push(JSON.stringify({ type: 'error', error: { name: 'Second' } }) + '\n')
    expect(parser.errorMessage).toBe('First')
  })

  it('leaves errorMessage unset on a clean stream', () => {
    parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'fine' }))
    expect(parser.errorMessage).toBeUndefined()
  })

  it('flush is a no-op when the buffer is empty', () => {
    parser.push(evt('text', { id: 'prt_1', type: 'text', text: 'done' }))
    expect(parser.flush()).toEqual([])
  })
})
