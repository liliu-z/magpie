// tests/orchestrator/ledger-prompts-access.test.ts
import { describe, it, expect } from 'vitest'
import { buildFinderPrompt } from '../../src/orchestrator/prompts/ledger-prompts.js'

describe('finder prompt: reaching the change', () => {
  // A finder that cannot reach the diff reviews whatever fragment of it landed in the
  // prompt and never opens a source file — which is invisible in the output, because the
  // findings it does produce look perfectly reasonable.
  it('embeds the command for the target actually under review', () => {
    const local = buildFinderPrompt({ target: 'Last Commit', changeAccess: 'Run `git show HEAD` for the diff' })
    expect(local).toContain('Run `git show HEAD` for the diff')
    expect(local).not.toContain('gh pr diff')

    const prTarget = buildFinderPrompt({ target: 'https://github.com/o/r/pull/1', changeAccess: 'Run `gh pr diff` for the diff' })
    expect(prTarget).toContain('Run `gh pr diff` for the diff')
  })

  it('still says to read the source around every change', () => {
    const p = buildFinderPrompt({ target: 'Last Commit', changeAccess: 'Run `git show HEAD` for the diff' })
    expect(p).toMatch(/read the actual source around every change/)
  })

  it('falls back to a target-neutral instruction when none is given', () => {
    const p = buildFinderPrompt({ target: 'Last Commit' })
    expect(p).toContain('Get the diff')
    expect(p).not.toContain('gh pr diff')
  })
})
