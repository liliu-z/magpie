# Magpie

多 AI 对抗式 PR Review 工具。让不同的 AI 模型像 Linus Torvalds 一样审查你的代码，通过辩论产生更全面的 review 结果。

## 核心理念

- **同一视角，不同模型**：所有 reviewer 使用相同的 prompt（Linus 风格），但由不同的 AI 模型扮演
- **自然对抗**：模型之间的差异会自然产生分歧和辩论
- **去迎合化**：明确告知 AI 他们在与其他 AI 辩论，避免互相迎合

## 支持的 AI Provider

| Provider | 说明 |
|----------|------|
| `claude-code` | Claude Code CLI（需安装 `claude` 命令） |
| `codex-cli` | OpenAI Codex CLI（需安装 `codex` 命令） |
| `gemini-*` | Google Gemini API（需配置 API Key） |
| `anthropic` | Anthropic API（需配置 API Key） |
| `openai` | OpenAI API（需配置 API Key） |

## 安装

```bash
# 克隆项目
git clone <repo-url>
cd magpie

# 安装依赖
npm install

# 编译
npm run build

# 全局安装（可选）
npm link
```

## 快速开始

```bash
# 初始化配置文件
magpie init

# 编辑配置
vim ~/.magpie/config.yaml

# 进入要 review 的仓库目录
cd your-repo

# 开始 review
magpie review 12345
```

## 配置文件

配置文件位于 `~/.magpie/config.yaml`：

```yaml
# AI Providers 配置
providers:
  claude-code:
    enabled: true
  codex-cli:
    enabled: true
  google:
    api_key: YOUR_GEMINI_API_KEY

# 默认设置
defaults:
  max_rounds: 2
  output_format: markdown
  check_convergence: true  # 达成共识时提前结束

# Reviewers - 相同视角，不同模型
reviewers:
  claude:
    model: claude-code
    prompt: |
      You are a senior engineer reviewing this PR. Be direct and concise like Linus Torvalds,
      but constructive rather than harsh.

      Focus on:
      1. **Correctness** - Will this code work? Edge cases?
      2. **Security** - Any vulnerabilities? Input validation?
      3. **Architecture** - Does this fit the overall design? Any coupling issues?
      4. **Simplicity** - Is this the simplest solution? Over-engineering?

      输出使用中文。

  codex:
    model: codex-cli
    prompt: |
      # 同上...

# Analyzer - PR 分析（辩论前）
analyzer:
  model: claude-code
  prompt: |
    你是一位资深工程师，在 review 辩论开始前提供 PR 背景分析。
    请分析这个 PR 并提供：
    1. 这个 PR 做了什么
    2. 架构/设计决策
    3. 目的
    4. 权衡
    5. 注意事项

# Summarizer - 最终总结
summarizer:
  model: claude-code
  prompt: |
    你是一位中立的技术评审员。基于各位匿名 reviewer 的总结，请提供：
    1. 共识点
    2. 分歧点
    3. 建议的行动项
    4. 总体评估
```

## 命令行选项

```bash
magpie review <pr-number> [options]

选项:
  -c, --config <path>   指定配置文件路径
  -r, --rounds <number> 最大辩论轮数（默认: 3）
  -i, --interactive     交互模式（每轮暂停，可插入意见）
  -o, --output <file>   输出到文件
  -f, --format <format> 输出格式 (markdown|json)
  --no-converge         禁用收敛检测（默认启用）
```

## 工作流程

```
1. Analyzer 分析 PR
   ↓
2. 多轮辩论
   ├─ Reviewer 1 (Claude) 发表意见
   ├─ Reviewer 2 (Codex) 回应并补充
   ├─ Reviewer 1 反驳或认同
   └─ ... (重复直到达到最大轮数或收敛)
   ↓
3. 各 Reviewer 总结自己的观点
   ↓
4. Summarizer 汇总产出最终结论
```

## 功能特性

### 收敛检测

默认启用。当 reviewer 们在关键点上达成共识时，自动结束辩论，节省 token。

```bash
# 默认启用收敛检测
magpie review 12345

# 禁用收敛检测
magpie review 12345 --no-converge
```

可在配置文件中设置 `defaults.check_convergence: false` 来默认禁用。

### Token 使用统计

每次 review 结束后显示各 reviewer 的 token 使用量和估算成本：

```
=== Token Usage (Estimated) ===
  analyzer: 1,234 in / 567 out
  claude: 2,345 in / 890 out
  codex: 2,456 in / 912 out
  summarizer: 3,456 in / 234 out
  Total: 9,491 in / 2,603 out (~$0.1209)
```

### 交互模式

使用 `-i` 进入交互模式，可以在辩论过程中插入自己的意见：

```bash
magpie review 12345 -i
```

## 开发

```bash
# 开发模式运行
npm run dev -- review 12345

# 运行测试
npm test

# 编译
npm run build
```

## License

ISC
