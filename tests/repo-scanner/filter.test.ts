// tests/repo-scanner/filter.test.ts
import { describe, it, expect } from 'vitest'
import { shouldIgnore, detectLanguage } from '../../src/repo-scanner/filter.js'

describe('filter', () => {
  describe('shouldIgnore', () => {
    it('should ignore node_modules', () => {
      expect(shouldIgnore('node_modules/lodash/index.js', [])).toBe(true)
    })

    it('should ignore .git', () => {
      expect(shouldIgnore('.git/config', [])).toBe(true)
    })

    it('should ignore custom patterns', () => {
      expect(shouldIgnore('vendor/lib.js', ['vendor'])).toBe(true)
    })

    it('should not ignore regular source files', () => {
      expect(shouldIgnore('src/index.ts', [])).toBe(false)
    })

    it('should ignore binary files', () => {
      expect(shouldIgnore('assets/logo.png', [])).toBe(true)
    })

    it('should ignore minified files', () => {
      expect(shouldIgnore('dist/bundle.min.js', [])).toBe(true)
    })
  })

  describe('detectLanguage', () => {
    it('should detect TypeScript', () => {
      expect(detectLanguage('src/index.ts')).toBe('typescript')
    })

    it('should detect JavaScript', () => {
      expect(detectLanguage('src/index.js')).toBe('javascript')
    })

    it('should detect Python', () => {
      expect(detectLanguage('main.py')).toBe('python')
    })

    it('should return unknown for unrecognized extensions', () => {
      expect(detectLanguage('file.xyz')).toBe('unknown')
    })
  })
})
