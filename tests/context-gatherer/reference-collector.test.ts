// tests/context-gatherer/reference-collector.test.ts
import { describe, it, expect } from 'vitest'
import { extractSymbolsFromDiff } from '../../src/context-gatherer/collectors/reference-collector.js'

describe('extractSymbolsFromDiff', () => {
  it('should extract function names', () => {
    const diff = `
+function createOrder(data) {
+  return data
+}
`
    const symbols = extractSymbolsFromDiff(diff)
    expect(symbols).toContain('createOrder')
  })

  it('should extract class names', () => {
    const diff = `
+class OrderService {
+  constructor() {}
+}
`
    const symbols = extractSymbolsFromDiff(diff)
    expect(symbols).toContain('OrderService')
  })

  it('should extract arrow functions', () => {
    const diff = `
+const processOrder = async (order) => {
+  return order
+}
`
    const symbols = extractSymbolsFromDiff(diff)
    expect(symbols).toContain('processOrder')
  })

  it('should filter out short names and keywords', () => {
    const diff = `
+function do() {}
+const x = 1
`
    const symbols = extractSymbolsFromDiff(diff)
    expect(symbols).not.toContain('do')
    expect(symbols).not.toContain('x')
  })
})
