// tests/orchestrator/issue-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseReviewerOutput, deduplicateIssues, parseFocusAreas } from '../../src/orchestrator/issue-parser'

describe('parseReviewerOutput', () => {
  it('should parse valid JSON block from response', () => {
    const response = `Here is my review analysis.

\`\`\`json
{
  "issues": [
    {
      "severity": "critical",
      "category": "security",
      "file": "src/auth.ts",
      "line": 42,
      "title": "SQL injection risk",
      "description": "User input concatenated into query"
    }
  ],
  "verdict": "request_changes",
  "summary": "Critical security issue found"
}
\`\`\``
    const result = parseReviewerOutput(response)
    expect(result).not.toBeNull()
    expect(result!.issues).toHaveLength(1)
    expect(result!.issues[0].severity).toBe('critical')
    expect(result!.verdict).toBe('request_changes')
  })

  it('should return null for response without JSON block', () => {
    const response = 'This is just a plain text review with no JSON.'
    const result = parseReviewerOutput(response)
    expect(result).toBeNull()
  })

  it('should return null for malformed JSON', () => {
    const response = '```json\n{ broken json }\n```'
    const result = parseReviewerOutput(response)
    expect(result).toBeNull()
  })

  it('should handle missing optional fields', () => {
    const response = '```json\n{"issues":[],"verdict":"approve","summary":"ok"}\n```'
    const result = parseReviewerOutput(response)
    expect(result).not.toBeNull()
    expect(result!.issues).toHaveLength(0)
  })

  it('should validate severity values', () => {
    const response = `\`\`\`json
{"issues":[{"severity":"invalid","category":"x","file":"a.ts","title":"t","description":"d"}],"verdict":"approve","summary":"ok"}
\`\`\``
    const result = parseReviewerOutput(response)
    expect(result).not.toBeNull()
    expect(result!.issues).toHaveLength(0) // invalid issue filtered out
  })
})

describe('deduplicateIssues', () => {
  it('should merge issues with same file and similar title', () => {
    const issuesByReviewer = new Map([
      ['claude', [
        { severity: 'high' as const, category: 'security', file: 'src/auth.ts', line: 42, title: 'SQL injection risk', description: 'From claude' }
      ]],
      ['gemini', [
        { severity: 'critical' as const, category: 'security', file: 'src/auth.ts', line: 42, title: 'SQL injection vulnerability', description: 'From gemini' }
      ]]
    ])
    const merged = deduplicateIssues(issuesByReviewer)
    expect(merged).toHaveLength(1)
    expect(merged[0].raisedBy).toContain('claude')
    expect(merged[0].raisedBy).toContain('gemini')
    expect(merged[0].severity).toBe('critical') // keeps highest
  })

  it('should keep distinct issues separate', () => {
    const issuesByReviewer = new Map([
      ['claude', [
        { severity: 'high' as const, category: 'security', file: 'src/auth.ts', line: 42, title: 'SQL injection', description: 'd1' }
      ]],
      ['gemini', [
        { severity: 'medium' as const, category: 'performance', file: 'src/db.ts', line: 10, title: 'Slow query', description: 'd2' }
      ]]
    ])
    const merged = deduplicateIssues(issuesByReviewer)
    expect(merged).toHaveLength(2)
  })

  it('should sort by severity', () => {
    const issuesByReviewer = new Map([
      ['claude', [
        { severity: 'low' as const, category: 'style', file: 'a.ts', title: 'Naming', description: 'd1' },
        { severity: 'critical' as const, category: 'security', file: 'b.ts', title: 'Injection', description: 'd2' }
      ]]
    ])
    const merged = deduplicateIssues(issuesByReviewer)
    expect(merged[0].severity).toBe('critical')
    expect(merged[1].severity).toBe('low')
  })
})

describe('parseFocusAreas', () => {
  it('should extract focus areas from English analysis', () => {
    const analysis = `## What this PR does
Some analysis here.

## Suggested Review Focus
- Security: authentication changes need careful review
- Performance: new database queries introduced
- Error handling: missing try/catch in async paths`

    const focus = parseFocusAreas(analysis)
    expect(focus).toHaveLength(3)
    expect(focus[0]).toContain('Security')
    expect(focus[1]).toContain('Performance')
    expect(focus[2]).toContain('Error handling')
  })

  it('should extract focus areas from Chinese analysis', () => {
    const analysis = `## 这个 PR 做了什么
一些分析内容。

## 建议的 review 重点
- 安全性：登录处理函数的输入校验
- 性能：新增的数据库查询
- 错误处理：异步路径缺少 try/catch`

    const focus = parseFocusAreas(analysis)
    expect(focus).toHaveLength(3)
    expect(focus[0]).toContain('安全性')
    expect(focus[1]).toContain('性能')
    expect(focus[2]).toContain('错误处理')
  })

  it('should support bold-heading variant with Chinese title', () => {
    const analysis = `**建议的 review 重点**
1. src/auth.ts 的鉴权改动
2. 新增的并发逻辑

其他段落...`

    const focus = parseFocusAreas(analysis)
    expect(focus).toHaveLength(2)
    expect(focus[0]).toContain('src/auth.ts')
    expect(focus[1]).toContain('并发')
  })

  it('should return empty array if no focus section', () => {
    const analysis = 'Just some analysis without focus section.'
    const focus = parseFocusAreas(analysis)
    expect(focus).toHaveLength(0)
  })
})
