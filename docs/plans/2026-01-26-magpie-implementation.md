# Magpie Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-AI adversarial PR review CLI tool with VSCode extension.

**Architecture:** CLI as core (TypeScript/Node.js), orchestrates multiple AI reviewers in round-robin debate. Each AI has full tool access (can run `gh`, read files). VSCode extension is a thin UI shell calling CLI.

**Tech Stack:** TypeScript, Node.js, Commander.js (CLI), yaml (config), Anthropic/OpenAI/Google SDKs, Vitest (testing)

**Platform:** Mac and Linux only

---

## Phase 1: Project Setup

### Task 1: Initialize Node.js Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Initialize npm project**

Run:
```bash
cd /Users/liliu/Documents/Magpie && npm init -y
```

**Step 2: Install core dependencies**

Run:
```bash
npm install typescript commander yaml chalk ora readline
npm install -D @types/node vitest tsx
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
*.log
.env
.DS_Store
```

**Step 5: Update package.json scripts**

Add to package.json:
```json
{
  "type": "module",
  "bin": {
    "magpie": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

**Step 6: Create src directory structure**

Run:
```bash
mkdir -p src/{commands,config,providers,orchestrator,output}
mkdir -p tests
```

**Step 7: Initialize git and commit**

Run:
```bash
git init
git add .
git commit -m "chore: initialize project structure"
```

---

## Phase 2: Configuration System

### Task 2: Config Types

**Files:**
- Create: `src/config/types.ts`
- Create: `tests/config/types.test.ts`

**Step 1: Write the test**

```typescript
// tests/config/types.test.ts
import { describe, it, expect } from 'vitest'
import type { MagpieConfig, ReviewerConfig, ProviderConfig } from '../src/config/types'

describe('Config Types', () => {
  it('should allow valid config structure', () => {
    const config: MagpieConfig = {
      providers: {
        anthropic: { api_key: 'test-key' }
      },
      defaults: {
        max_rounds: 3,
        output_format: 'markdown'
      },
      reviewers: {
        'security-expert': {
          model: 'claude-sonnet-4-20250514',
          prompt: 'You are a security expert'
        }
      },
      summarizer: {
        model: 'claude-sonnet-4-20250514',
        prompt: 'You are a neutral summarizer'
      }
    }
    expect(config.defaults.max_rounds).toBe(3)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/config/types.test.ts`
Expected: FAIL (module not found)

**Step 3: Write the types**

```typescript
// src/config/types.ts
export interface ProviderConfig {
  api_key: string
}

export interface ReviewerConfig {
  model: string
  prompt: string
}

export interface DefaultsConfig {
  max_rounds: number
  output_format: 'markdown' | 'json'
}

export interface MagpieConfig {
  providers: {
    anthropic?: ProviderConfig
    openai?: ProviderConfig
    google?: ProviderConfig
  }
  defaults: DefaultsConfig
  reviewers: Record<string, ReviewerConfig>
  summarizer: ReviewerConfig
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/config/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config/types.ts tests/config/types.test.ts
git commit -m "feat: add config type definitions"
```

---

### Task 3: Config Loader

**Files:**
- Create: `src/config/loader.ts`
- Create: `tests/config/loader.test.ts`

**Step 1: Write the test**

```typescript
// tests/config/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig, expandEnvVars, getConfigPath } from '../src/config/loader'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Config Loader', () => {
  const testDir = join(tmpdir(), 'magpie-test-' + Date.now())

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe('expandEnvVars', () => {
    it('should expand environment variables', () => {
      process.env.TEST_API_KEY = 'secret123'
      const result = expandEnvVars('${TEST_API_KEY}')
      expect(result).toBe('secret123')
      delete process.env.TEST_API_KEY
    })

    it('should leave non-env strings unchanged', () => {
      const result = expandEnvVars('plain-string')
      expect(result).toBe('plain-string')
    })
  })

  describe('loadConfig', () => {
    it('should load and parse yaml config', () => {
      const configPath = join(testDir, 'config.yaml')
      writeFileSync(configPath, `
providers:
  anthropic:
    api_key: test-key
defaults:
  max_rounds: 3
  output_format: markdown
reviewers:
  test-reviewer:
    model: claude-sonnet-4-20250514
    prompt: Test prompt
summarizer:
  model: claude-sonnet-4-20250514
  prompt: Summarizer prompt
`)
      const config = loadConfig(configPath)
      expect(config.defaults.max_rounds).toBe(3)
      expect(config.reviewers['test-reviewer'].model).toBe('claude-sonnet-4-20250514')
    })
  })

  describe('getConfigPath', () => {
    it('should return custom path if provided', () => {
      const result = getConfigPath('/custom/path.yaml')
      expect(result).toBe('/custom/path.yaml')
    })

    it('should return default path if not provided', () => {
      const result = getConfigPath()
      expect(result).toContain('.magpie/config.yaml')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/config/loader.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/config/loader.ts
import { readFileSync, existsSync } from 'fs'
import { parse } from 'yaml'
import { homedir } from 'os'
import { join } from 'path'
import type { MagpieConfig } from './types.js'

export function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, envVar) => {
    return process.env[envVar] || ''
  })
}

function expandEnvVarsInObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return expandEnvVars(obj)
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVarsInObject)
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value)
    }
    return result
  }
  return obj
}

export function getConfigPath(customPath?: string): string {
  if (customPath) {
    return customPath
  }
  return join(homedir(), '.magpie', 'config.yaml')
}

export function loadConfig(configPath?: string): MagpieConfig {
  const path = getConfigPath(configPath)

  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`)
  }

  const content = readFileSync(path, 'utf-8')
  const parsed = parse(content)
  const expanded = expandEnvVarsInObject(parsed) as MagpieConfig

  return expanded
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/config/loader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config/loader.ts tests/config/loader.test.ts
git commit -m "feat: add config loader with env var expansion"
```

---

### Task 4: Config Init Command

**Files:**
- Create: `src/config/init.ts`
- Create: `tests/config/init.test.ts`

**Step 1: Write the test**

```typescript
// tests/config/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initConfig, DEFAULT_CONFIG } from '../src/config/init'
import { existsSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Config Init', () => {
  const testDir = join(tmpdir(), 'magpie-init-test-' + Date.now())

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('should create config file with default content', () => {
    const configPath = join(testDir, '.magpie', 'config.yaml')
    initConfig(testDir)

    expect(existsSync(configPath)).toBe(true)
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('providers:')
    expect(content).toContain('reviewers:')
  })

  it('should not overwrite existing config', () => {
    initConfig(testDir)
    expect(() => initConfig(testDir)).toThrow(/already exists/)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/config/init.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/config/init.ts
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const DEFAULT_CONFIG = `# Magpie Configuration

# AI Provider API Keys (use environment variables)
providers:
  anthropic:
    api_key: \${ANTHROPIC_API_KEY}
  openai:
    api_key: \${OPENAI_API_KEY}
  google:
    api_key: \${GOOGLE_API_KEY}

# Default settings
defaults:
  max_rounds: 3
  output_format: markdown

# Reviewer configurations
reviewers:
  security-expert:
    model: claude-sonnet-4-20250514
    prompt: |
      You are a security expert. Focus on:
      - Injection vulnerabilities (SQL, XSS, command injection)
      - Authentication and authorization issues
      - Sensitive data handling
      - Dependency security

  performance-expert:
    model: gpt-4o
    prompt: |
      You are a performance expert. Focus on:
      - Time complexity
      - Memory usage
      - Unnecessary computation or IO
      - Caching opportunities

  code-quality-expert:
    model: claude-sonnet-4-20250514
    prompt: |
      You are a code quality expert. Focus on:
      - Readability and maintainability
      - Design patterns
      - Test coverage
      - Documentation

# Summarizer configuration
summarizer:
  model: claude-sonnet-4-20250514
  prompt: |
    You are a neutral technical reviewer.
    Based on the anonymous reviewer summaries, provide:
    - Points of consensus
    - Points of disagreement with analysis
    - Recommended action items
`

export function initConfig(baseDir?: string): string {
  const base = baseDir || homedir()
  const magpieDir = join(base, '.magpie')
  const configPath = join(magpieDir, 'config.yaml')

  if (existsSync(configPath)) {
    throw new Error(`Config already exists: ${configPath}`)
  }

  mkdirSync(magpieDir, { recursive: true })
  writeFileSync(configPath, DEFAULT_CONFIG, 'utf-8')

  return configPath
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/config/init.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config/init.ts tests/config/init.test.ts
git commit -m "feat: add config init with default template"
```

---

## Phase 3: AI Providers

### Task 5: Provider Interface

**Files:**
- Create: `src/providers/types.ts`
- Create: `tests/providers/types.test.ts`

**Step 1: Write the test**

```typescript
// tests/providers/types.test.ts
import { describe, it, expect } from 'vitest'
import type { AIProvider, Message, StreamCallback } from '../src/providers/types'

describe('Provider Types', () => {
  it('should define correct message structure', () => {
    const message: Message = {
      role: 'user',
      content: 'Hello'
    }
    expect(message.role).toBe('user')
  })

  it('should define provider interface', () => {
    const mockProvider: AIProvider = {
      name: 'test',
      chat: async () => 'response',
      chatStream: async function* () { yield 'chunk' }
    }
    expect(mockProvider.name).toBe('test')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/providers/types.test.ts`
Expected: FAIL

**Step 3: Write the types**

```typescript
// src/providers/types.ts
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIProvider {
  name: string
  chat(messages: Message[], systemPrompt?: string): Promise<string>
  chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown>
}

export interface ProviderOptions {
  apiKey: string
  model: string
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/providers/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/types.ts tests/providers/types.test.ts
git commit -m "feat: add AI provider type definitions"
```

---

### Task 6: Anthropic Provider

**Files:**
- Create: `src/providers/anthropic.ts`
- Create: `tests/providers/anthropic.test.ts`

**Step 1: Install Anthropic SDK**

Run:
```bash
npm install @anthropic-ai/sdk
```

**Step 2: Write the test**

```typescript
// tests/providers/anthropic.test.ts
import { describe, it, expect, vi } from 'vitest'
import { AnthropicProvider } from '../src/providers/anthropic'

// Mock the SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Mock response' }]
      }),
      stream: vi.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk1' } }
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'chunk2' } }
        }
      })
    }
  }
}))

describe('AnthropicProvider', () => {
  it('should have correct name', () => {
    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' })
    expect(provider.name).toBe('anthropic')
  })

  it('should call chat and return response', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' })
    const result = await provider.chat([{ role: 'user', content: 'Hello' }])
    expect(result).toBe('Mock response')
  })

  it('should stream responses', async () => {
    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-20250514' })
    const chunks: string[] = []
    for await (const chunk of provider.chatStream([{ role: 'user', content: 'Hello' }])) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual(['chunk1', 'chunk2'])
  })
})
```

**Step 3: Run test to verify it fails**

Run: `npm run test:run -- tests/providers/anthropic.test.ts`
Expected: FAIL

**Step 4: Write the implementation**

```typescript
// src/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider, Message, ProviderOptions } from './types.js'

export class AnthropicProvider implements AIProvider {
  name = 'anthropic'
  private client: Anthropic
  private model: string

  constructor(options: ProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey })
    this.model = options.model
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      }))
    })

    const textBlock = response.content.find(block => block.type === 'text')
    return textBlock?.type === 'text' ? textBlock.text : ''
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content
      }))
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text
      }
    }
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm run test:run -- tests/providers/anthropic.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/providers/anthropic.ts tests/providers/anthropic.test.ts package.json package-lock.json
git commit -m "feat: add Anthropic provider with streaming"
```

---

### Task 7: OpenAI Provider

**Files:**
- Create: `src/providers/openai.ts`
- Create: `tests/providers/openai.test.ts`

**Step 1: Install OpenAI SDK**

Run:
```bash
npm install openai
```

**Step 2: Write the test**

```typescript
// tests/providers/openai.test.ts
import { describe, it, expect, vi } from 'vitest'
import { OpenAIProvider } from '../src/providers/openai'

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'Mock response' } }]
        })
      }
    }
  }
}))

describe('OpenAIProvider', () => {
  it('should have correct name', () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    expect(provider.name).toBe('openai')
  })

  it('should call chat and return response', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o' })
    const result = await provider.chat([{ role: 'user', content: 'Hello' }])
    expect(result).toBe('Mock response')
  })
})
```

**Step 3: Run test to verify it fails**

Run: `npm run test:run -- tests/providers/openai.test.ts`
Expected: FAIL

**Step 4: Write the implementation**

```typescript
// src/providers/openai.ts
import OpenAI from 'openai'
import type { AIProvider, Message, ProviderOptions } from './types.js'

export class OpenAIProvider implements AIProvider {
  name = 'openai'
  private client: OpenAI
  private model: string

  constructor(options: ProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey })
    this.model = options.model
  }

  async chat(messages: Message[], systemPrompt?: string): Promise<string> {
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      msgs.push({ role: 'system', content: systemPrompt })
    }

    msgs.push(...messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content
    })))

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: msgs
    })

    return response.choices[0]?.message?.content || ''
  }

  async *chatStream(messages: Message[], systemPrompt?: string): AsyncGenerator<string, void, unknown> {
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      msgs.push({ role: 'system', content: systemPrompt })
    }

    msgs.push(...messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content
    })))

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: msgs,
      stream: true
    })

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content
      if (content) {
        yield content
      }
    }
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npm run test:run -- tests/providers/openai.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/providers/openai.ts tests/providers/openai.test.ts package.json package-lock.json
git commit -m "feat: add OpenAI provider with streaming"
```

---

### Task 8: Provider Factory

**Files:**
- Create: `src/providers/factory.ts`
- Create: `tests/providers/factory.test.ts`

**Step 1: Write the test**

```typescript
// tests/providers/factory.test.ts
import { describe, it, expect } from 'vitest'
import { createProvider, getProviderForModel } from '../src/providers/factory'
import type { MagpieConfig } from '../src/config/types'

describe('Provider Factory', () => {
  const mockConfig: MagpieConfig = {
    providers: {
      anthropic: { api_key: 'ant-key' },
      openai: { api_key: 'oai-key' }
    },
    defaults: { max_rounds: 3, output_format: 'markdown' },
    reviewers: {},
    summarizer: { model: 'claude-sonnet-4-20250514', prompt: '' }
  }

  describe('getProviderForModel', () => {
    it('should return anthropic for claude models', () => {
      expect(getProviderForModel('claude-sonnet-4-20250514')).toBe('anthropic')
      expect(getProviderForModel('claude-3-opus-20240229')).toBe('anthropic')
    })

    it('should return openai for gpt models', () => {
      expect(getProviderForModel('gpt-4o')).toBe('openai')
      expect(getProviderForModel('gpt-4-turbo')).toBe('openai')
    })

    it('should return google for gemini models', () => {
      expect(getProviderForModel('gemini-pro')).toBe('google')
    })
  })

  describe('createProvider', () => {
    it('should create anthropic provider', () => {
      const provider = createProvider('claude-sonnet-4-20250514', mockConfig)
      expect(provider.name).toBe('anthropic')
    })

    it('should create openai provider', () => {
      const provider = createProvider('gpt-4o', mockConfig)
      expect(provider.name).toBe('openai')
    })

    it('should throw for missing provider config', () => {
      const configWithoutOpenAI = { ...mockConfig, providers: { anthropic: { api_key: 'key' } } }
      expect(() => createProvider('gpt-4o', configWithoutOpenAI)).toThrow()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/providers/factory.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/providers/factory.ts
import type { AIProvider } from './types.js'
import type { MagpieConfig } from '../config/types.js'
import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'

export function getProviderForModel(model: string): 'anthropic' | 'openai' | 'google' {
  if (model.startsWith('claude')) {
    return 'anthropic'
  }
  if (model.startsWith('gpt')) {
    return 'openai'
  }
  if (model.startsWith('gemini')) {
    return 'google'
  }
  throw new Error(`Unknown model: ${model}`)
}

export function createProvider(model: string, config: MagpieConfig): AIProvider {
  const providerName = getProviderForModel(model)
  const providerConfig = config.providers[providerName]

  if (!providerConfig) {
    throw new Error(`Provider ${providerName} not configured for model ${model}`)
  }

  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: providerConfig.api_key, model })
    case 'openai':
      return new OpenAIProvider({ apiKey: providerConfig.api_key, model })
    case 'google':
      throw new Error('Google provider not yet implemented')
    default:
      throw new Error(`Unknown provider: ${providerName}`)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/providers/factory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/factory.ts tests/providers/factory.test.ts
git commit -m "feat: add provider factory for model routing"
```

---

## Phase 4: Debate Orchestrator

### Task 9: Orchestrator Types

**Files:**
- Create: `src/orchestrator/types.ts`

**Step 1: Write the types**

```typescript
// src/orchestrator/types.ts
import type { AIProvider } from '../providers/types.js'

export interface Reviewer {
  id: string
  provider: AIProvider
  systemPrompt: string
}

export interface DebateMessage {
  reviewerId: string
  content: string
  timestamp: Date
}

export interface DebateSummary {
  reviewerId: string
  summary: string
}

export interface DebateResult {
  prNumber: string
  messages: DebateMessage[]
  summaries: DebateSummary[]
  finalConclusion: string
}

export interface OrchestratorOptions {
  maxRounds: number
  interactive: boolean
  onMessage?: (reviewerId: string, chunk: string) => void
  onRoundComplete?: (round: number) => void
  onInteractive?: () => Promise<string | null>
}
```

**Step 2: Commit**

```bash
git add src/orchestrator/types.ts
git commit -m "feat: add orchestrator type definitions"
```

---

### Task 10: Debate Orchestrator Core

**Files:**
- Create: `src/orchestrator/orchestrator.ts`
- Create: `tests/orchestrator/orchestrator.test.ts`

**Step 1: Write the test**

```typescript
// tests/orchestrator/orchestrator.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DebateOrchestrator } from '../src/orchestrator/orchestrator'
import type { AIProvider } from '../src/providers/types'
import type { Reviewer } from '../src/orchestrator/types'

const createMockProvider = (name: string, responses: string[]): AIProvider => {
  let callCount = 0
  return {
    name,
    chat: vi.fn().mockImplementation(async () => responses[callCount++] || 'default'),
    chatStream: vi.fn().mockImplementation(async function* () {
      yield responses[callCount++] || 'default'
    })
  }
}

describe('DebateOrchestrator', () => {
  it('should run debate for specified rounds', async () => {
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: createMockProvider('a', ['Round 1 from A', 'Round 2 from A', 'Summary A']),
      systemPrompt: 'You are reviewer A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: createMockProvider('b', ['Round 1 from B', 'Round 2 from B', 'Summary B']),
      systemPrompt: 'You are reviewer B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: createMockProvider('s', ['Final conclusion']),
      systemPrompt: 'You are a summarizer'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      { maxRounds: 2, interactive: false }
    )

    const result = await orchestrator.run('123', 'Review this PR')

    expect(result.prNumber).toBe('123')
    expect(result.messages.length).toBe(4) // 2 reviewers * 2 rounds
    expect(result.summaries.length).toBe(2)
    expect(result.finalConclusion).toBe('Final conclusion')
  })

  it('should pass conversation history to reviewers', async () => {
    const mockChat = vi.fn().mockResolvedValue('response')
    const reviewerA: Reviewer = {
      id: 'reviewer-1',
      provider: { name: 'a', chat: mockChat, chatStream: vi.fn() },
      systemPrompt: 'You are A'
    }
    const reviewerB: Reviewer = {
      id: 'reviewer-2',
      provider: { name: 'b', chat: vi.fn().mockResolvedValue('B response'), chatStream: vi.fn() },
      systemPrompt: 'You are B'
    }
    const summarizer: Reviewer = {
      id: 'summarizer',
      provider: { name: 's', chat: vi.fn().mockResolvedValue('summary'), chatStream: vi.fn() },
      systemPrompt: 'Summarize'
    }

    const orchestrator = new DebateOrchestrator(
      [reviewerA, reviewerB],
      summarizer,
      { maxRounds: 1, interactive: false }
    )

    await orchestrator.run('123', 'Review PR')

    // First call should have initial prompt
    expect(mockChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Review PR') })
      ]),
      'You are A'
    )
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/orchestrator/orchestrator.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/orchestrator/orchestrator.ts
import type { Message } from '../providers/types.js'
import type {
  Reviewer,
  DebateMessage,
  DebateSummary,
  DebateResult,
  OrchestratorOptions
} from './types.js'

export class DebateOrchestrator {
  private reviewers: Reviewer[]
  private summarizer: Reviewer
  private options: OrchestratorOptions
  private conversationHistory: DebateMessage[] = []

  constructor(
    reviewers: Reviewer[],
    summarizer: Reviewer,
    options: OrchestratorOptions
  ) {
    this.reviewers = reviewers
    this.summarizer = summarizer
    this.options = options
  }

  async run(prNumber: string, initialPrompt: string): Promise<DebateResult> {
    this.conversationHistory = []

    // Run debate rounds
    for (let round = 1; round <= this.options.maxRounds; round++) {
      for (const reviewer of this.reviewers) {
        // Check for user interruption in interactive mode
        if (this.options.interactive && this.options.onInteractive) {
          const userInput = await this.options.onInteractive()
          if (userInput === 'q') {
            break
          }
          if (userInput) {
            this.conversationHistory.push({
              reviewerId: 'user',
              content: userInput,
              timestamp: new Date()
            })
          }
        }

        const messages = this.buildMessages(initialPrompt, reviewer.id)
        const response = await reviewer.provider.chat(messages, reviewer.systemPrompt)

        this.conversationHistory.push({
          reviewerId: reviewer.id,
          content: response,
          timestamp: new Date()
        })

        this.options.onMessage?.(reviewer.id, response)
      }

      this.options.onRoundComplete?.(round)
    }

    // Collect summaries from each reviewer
    const summaries = await this.collectSummaries()

    // Get final conclusion from summarizer
    const finalConclusion = await this.getFinalConclusion(summaries)

    return {
      prNumber,
      messages: this.conversationHistory,
      summaries,
      finalConclusion
    }
  }

  private buildMessages(initialPrompt: string, currentReviewerId: string): Message[] {
    const messages: Message[] = [
      { role: 'user', content: initialPrompt }
    ]

    for (const msg of this.conversationHistory) {
      const role = msg.reviewerId === currentReviewerId ? 'assistant' : 'user'
      const prefix = msg.reviewerId === 'user' ? '[User]: ' : `[Reviewer]: `
      messages.push({
        role,
        content: role === 'user' ? prefix + msg.content : msg.content
      })
    }

    return messages
  }

  private async collectSummaries(): Promise<DebateSummary[]> {
    const summaries: DebateSummary[] = []
    const summaryPrompt = 'Please summarize your key points and conclusions. Do not reveal your identity or role.'

    for (const reviewer of this.reviewers) {
      const messages = this.buildMessages(summaryPrompt, reviewer.id)
      messages.push({ role: 'user', content: summaryPrompt })

      const summary = await reviewer.provider.chat(messages, reviewer.systemPrompt)
      summaries.push({
        reviewerId: reviewer.id,
        summary
      })
    }

    return summaries
  }

  private async getFinalConclusion(summaries: DebateSummary[]): Promise<string> {
    const summaryText = summaries
      .map((s, i) => `Reviewer ${i + 1}:\n${s.summary}`)
      .join('\n\n---\n\n')

    const prompt = `Based on the following anonymous reviewer summaries, provide a final conclusion including:
- Points of consensus
- Points of disagreement with analysis
- Recommended action items

${summaryText}`

    const messages: Message[] = [{ role: 'user', content: prompt }]
    return this.summarizer.provider.chat(messages, this.summarizer.systemPrompt)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/orchestrator/orchestrator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts tests/orchestrator/orchestrator.test.ts
git commit -m "feat: add debate orchestrator with round management"
```

---

## Phase 5: CLI Implementation

### Task 11: CLI Entry Point

**Files:**
- Create: `src/cli.ts`
- Create: `src/commands/review.ts`
- Create: `src/commands/init.ts`

**Step 1: Create CLI entry point**

```typescript
// src/cli.ts
#!/usr/bin/env node
import { Command } from 'commander'
import { reviewCommand } from './commands/review.js'
import { initCommand } from './commands/init.js'

const program = new Command()

program
  .name('magpie')
  .description('Multi-AI adversarial PR review tool')
  .version('0.1.0')

program.addCommand(reviewCommand)
program.addCommand(initCommand)

program.parse()
```

**Step 2: Create init command**

```typescript
// src/commands/init.ts
import { Command } from 'commander'
import { initConfig } from '../config/init.js'
import chalk from 'chalk'

export const initCommand = new Command('init')
  .description('Initialize Magpie configuration')
  .action(() => {
    try {
      const path = initConfig()
      console.log(chalk.green(`✓ Config created at: ${path}`))
      console.log(chalk.dim('Edit this file to configure your AI providers and reviewers.'))
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    }
  })
```

**Step 3: Create review command**

```typescript
// src/commands/review.ts
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { loadConfig } from '../config/loader.js'
import { createProvider } from '../providers/factory.js'
import { DebateOrchestrator } from '../orchestrator/orchestrator.js'
import type { Reviewer } from '../orchestrator/types.js'
import { createInterface } from 'readline'

export const reviewCommand = new Command('review')
  .description('Review a PR with multiple AI reviewers')
  .argument('<pr>', 'PR number or URL')
  .option('-c, --config <path>', 'Path to config file')
  .option('-r, --rounds <number>', 'Maximum debate rounds', '3')
  .option('-i, --interactive', 'Interactive mode (pause between turns)')
  .option('-o, --output <file>', 'Output to file instead of stdout')
  .option('-f, --format <format>', 'Output format (markdown|json)', 'markdown')
  .action(async (pr: string, options) => {
    const spinner = ora('Loading configuration...').start()

    try {
      const config = loadConfig(options.config)
      spinner.succeed('Configuration loaded')

      // Create reviewers
      const reviewers: Reviewer[] = Object.entries(config.reviewers).map(([id, cfg]) => ({
        id,
        provider: createProvider(cfg.model, config),
        systemPrompt: cfg.prompt
      }))

      // Create summarizer
      const summarizer: Reviewer = {
        id: 'summarizer',
        provider: createProvider(config.summarizer.model, config),
        systemPrompt: config.summarizer.prompt
      }

      console.log(chalk.blue(`\nStarting review of PR #${pr}`))
      console.log(chalk.dim(`Reviewers: ${reviewers.map(r => r.id).join(', ')}`))
      console.log(chalk.dim(`Max rounds: ${options.rounds}\n`))

      // Setup interactive mode if enabled
      let rl: ReturnType<typeof createInterface> | null = null
      if (options.interactive) {
        rl = createInterface({
          input: process.stdin,
          output: process.stdout
        })
      }

      const orchestrator = new DebateOrchestrator(reviewers, summarizer, {
        maxRounds: parseInt(options.rounds, 10),
        interactive: options.interactive,
        onMessage: (reviewerId, content) => {
          console.log(chalk.cyan(`\n[${reviewerId}]:`))
          console.log(content)
        },
        onRoundComplete: (round) => {
          console.log(chalk.dim(`\n--- Round ${round} complete ---\n`))
        },
        onInteractive: options.interactive ? async () => {
          return new Promise((resolve) => {
            rl!.question(chalk.yellow('\nPress Enter to continue, type to interject, or q to end: '), (answer) => {
              resolve(answer || null)
            })
          })
        } : undefined
      })

      const initialPrompt = `Please review PR #${pr}. Use 'gh pr view ${pr}' and 'gh pr diff ${pr}' to get the PR details, then analyze the changes.`

      spinner.start('Running debate...')
      spinner.stop()

      const result = await orchestrator.run(pr, initialPrompt)

      console.log(chalk.green('\n=== Final Conclusion ===\n'))
      console.log(result.finalConclusion)

      if (options.output) {
        const { writeFileSync } = await import('fs')
        if (options.format === 'json') {
          writeFileSync(options.output, JSON.stringify(result, null, 2))
        } else {
          writeFileSync(options.output, formatMarkdown(result))
        }
        console.log(chalk.green(`\n✓ Output saved to: ${options.output}`))
      }

      rl?.close()
    } catch (error) {
      spinner.fail('Error')
      if (error instanceof Error) {
        console.error(chalk.red(`Error: ${error.message}`))
      }
      process.exit(1)
    }
  })

function formatMarkdown(result: any): string {
  let md = `# PR Review: #${result.prNumber}\n\n`
  md += `## Debate\n\n`

  for (const msg of result.messages) {
    md += `### ${msg.reviewerId}\n\n${msg.content}\n\n`
  }

  md += `## Summaries\n\n`
  for (const summary of result.summaries) {
    md += `### ${summary.reviewerId}\n\n${summary.summary}\n\n`
  }

  md += `## Final Conclusion\n\n${result.finalConclusion}\n`

  return md
}
```

**Step 4: Update package.json bin path**

Ensure package.json has:
```json
{
  "bin": {
    "magpie": "./dist/cli.js"
  }
}
```

**Step 5: Build and test CLI**

Run:
```bash
npm run build
node dist/cli.js --help
```

Expected: Help text showing commands

**Step 6: Commit**

```bash
git add src/cli.ts src/commands/
git commit -m "feat: add CLI with review and init commands"
```

---

### Task 12: Add Index Exports

**Files:**
- Create: `src/index.ts`
- Create: `src/config/index.ts`
- Create: `src/providers/index.ts`
- Create: `src/orchestrator/index.ts`

**Step 1: Create barrel exports**

```typescript
// src/config/index.ts
export * from './types.js'
export * from './loader.js'
export * from './init.js'

// src/providers/index.ts
export * from './types.js'
export * from './anthropic.js'
export * from './openai.js'
export * from './factory.js'

// src/orchestrator/index.ts
export * from './types.js'
export * from './orchestrator.js'

// src/index.ts
export * from './config/index.js'
export * from './providers/index.js'
export * from './orchestrator/index.js'
```

**Step 2: Commit**

```bash
git add src/index.ts src/config/index.ts src/providers/index.ts src/orchestrator/index.ts
git commit -m "chore: add barrel exports"
```

---

## Phase 6: Streaming Output

### Task 13: Streaming Orchestrator

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`
- Update: `src/commands/review.ts`

**Step 1: Update orchestrator for streaming**

Add streaming support to `DebateOrchestrator`:

```typescript
// Add to orchestrator.ts - new method
async runStreaming(prNumber: string, initialPrompt: string): Promise<DebateResult> {
  this.conversationHistory = []

  for (let round = 1; round <= this.options.maxRounds; round++) {
    for (const reviewer of this.reviewers) {
      if (this.options.interactive && this.options.onInteractive) {
        const userInput = await this.options.onInteractive()
        if (userInput === 'q') break
        if (userInput) {
          this.conversationHistory.push({
            reviewerId: 'user',
            content: userInput,
            timestamp: new Date()
          })
        }
      }

      const messages = this.buildMessages(initialPrompt, reviewer.id)
      let fullResponse = ''

      // Stream the response
      for await (const chunk of reviewer.provider.chatStream(messages, reviewer.systemPrompt)) {
        fullResponse += chunk
        this.options.onMessage?.(reviewer.id, chunk)
      }

      this.conversationHistory.push({
        reviewerId: reviewer.id,
        content: fullResponse,
        timestamp: new Date()
      })
    }

    this.options.onRoundComplete?.(round)
  }

  const summaries = await this.collectSummaries()
  const finalConclusion = await this.getFinalConclusion(summaries)

  return {
    prNumber,
    messages: this.conversationHistory,
    summaries,
    finalConclusion
  }
}
```

**Step 2: Update review command to use streaming**

Update `src/commands/review.ts` to track current reviewer and handle streaming:

```typescript
// Replace the orchestrator callback section:
let currentReviewer = ''

const orchestrator = new DebateOrchestrator(reviewers, summarizer, {
  maxRounds: parseInt(options.rounds, 10),
  interactive: options.interactive,
  onMessage: (reviewerId, chunk) => {
    if (reviewerId !== currentReviewer) {
      currentReviewer = reviewerId
      console.log(chalk.cyan(`\n[${reviewerId}]:`))
    }
    process.stdout.write(chunk)
  },
  // ... rest unchanged
})

// Use runStreaming instead of run
const result = await orchestrator.runStreaming(pr, initialPrompt)
```

**Step 3: Test streaming**

Run:
```bash
npm run build
node dist/cli.js review 1 --config ~/.magpie/config.yaml
```

**Step 4: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/commands/review.ts
git commit -m "feat: add streaming output support"
```

---

## Phase 7: Final Integration

### Task 14: End-to-End Testing

**Files:**
- Create: `tests/e2e/review.test.ts`

**Step 1: Write E2E test**

```typescript
// tests/e2e/review.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('E2E: magpie review', () => {
  const testDir = join(tmpdir(), 'magpie-e2e-' + Date.now())
  const configPath = join(testDir, '.magpie', 'config.yaml')

  beforeAll(() => {
    mkdirSync(join(testDir, '.magpie'), { recursive: true })
    // Create minimal test config (will need mock or real API keys for actual test)
    writeFileSync(configPath, `
providers:
  anthropic:
    api_key: \${ANTHROPIC_API_KEY}
defaults:
  max_rounds: 1
  output_format: markdown
reviewers:
  test-reviewer:
    model: claude-sonnet-4-20250514
    prompt: You are a test reviewer
summarizer:
  model: claude-sonnet-4-20250514
  prompt: Summarize the review
`)
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('should show help', () => {
    const output = execSync('node dist/cli.js --help').toString()
    expect(output).toContain('magpie')
    expect(output).toContain('review')
    expect(output).toContain('init')
  })

  it('should show review help', () => {
    const output = execSync('node dist/cli.js review --help').toString()
    expect(output).toContain('PR number or URL')
    expect(output).toContain('--interactive')
  })
})
```

**Step 2: Run E2E tests**

Run: `npm run test:run -- tests/e2e/`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/e2e/
git commit -m "test: add E2E tests for CLI"
```

---

### Task 15: Documentation

**Files:**
- Create: `README.md`

**Step 1: Create README**

```markdown
# Magpie

Multi-AI adversarial PR review tool. Multiple AI reviewers debate your PR from different perspectives.

## Installation

```bash
npm install -g magpie
```

## Quick Start

1. Initialize configuration:
```bash
magpie init
```

2. Edit `~/.magpie/config.yaml` with your API keys

3. Review a PR:
```bash
cd your-repo
magpie review 123
```

## Usage

```bash
# Basic review
magpie review <pr-number>

# Interactive mode (pause between turns)
magpie review 123 --interactive

# Custom rounds
magpie review 123 --rounds 5

# Output to file
magpie review 123 --output review.md
```

## Configuration

Edit `~/.magpie/config.yaml`:

```yaml
providers:
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
  openai:
    api_key: ${OPENAI_API_KEY}

defaults:
  max_rounds: 3

reviewers:
  security-expert:
    model: claude-sonnet-4-20250514
    prompt: |
      You are a security expert...

  performance-expert:
    model: gpt-4o
    prompt: |
      You are a performance expert...

summarizer:
  model: claude-sonnet-4-20250514
  prompt: |
    You are a neutral summarizer...
```

## License

MIT
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

### Task 16: Final Build and Test

**Step 1: Run all tests**

Run:
```bash
npm run test:run
```
Expected: All tests pass

**Step 2: Build**

Run:
```bash
npm run build
```
Expected: Clean build

**Step 3: Link for local testing**

Run:
```bash
npm link
magpie --help
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: finalize v0.1.0"
```

---

## Summary

**Phase 1:** Project setup (Task 1)
**Phase 2:** Configuration system (Tasks 2-4)
**Phase 3:** AI providers (Tasks 5-8)
**Phase 4:** Debate orchestrator (Tasks 9-10)
**Phase 5:** CLI implementation (Tasks 11-12)
**Phase 6:** Streaming output (Task 13)
**Phase 7:** Final integration (Tasks 14-16)

Total: 16 tasks, approximately 16 commits
