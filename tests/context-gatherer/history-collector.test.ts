// tests/context-gatherer/history-collector.test.ts
import { describe, it, expect } from 'vitest'
import { getDirectories } from '../../src/context-gatherer/collectors/history-collector.js'

describe('getDirectories', () => {
  it('should extract directories from file paths', () => {
    const files = [
      'src/services/order/create.ts',
      'src/services/order/update.ts',
      'src/api/routes.ts'
    ]
    const dirs = getDirectories(files)
    expect(dirs).toContain('src/services/order')
    expect(dirs).toContain('src/services')
    expect(dirs).toContain('src/api')
  })

  it('should handle root-level files', () => {
    const files = ['package.json', 'src/index.ts']
    const dirs = getDirectories(files)
    expect(dirs).toContain('src')
    expect(dirs).not.toContain('')
  })
})
