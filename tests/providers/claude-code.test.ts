// tests/providers/claude-code.test.ts
import { describe, it, expect } from 'vitest'
import { buildClaudeArgs, ClaudeCodeProvider } from '../../src/providers/claude-code.js'

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
