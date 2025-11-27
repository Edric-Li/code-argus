# code-argus

AI-powered automated code review CLI tool using Claude Agent SDK with multi-agent orchestration.

自动化 AI 代码审查 CLI 工具 - 基于多智能体架构的 Git Diff 分析与问题检测

## Features / 功能特性

- **Multi-Agent Review** - 4 specialized agents review in parallel: security, logic, performance, style
- **Smart Agent Selection** - Automatically selects agents based on file characteristics
- **Issue Validation** - Challenge-mode multi-round validation reduces false positives
- **Cross-Agent Deduplication** - LLM semantic deduplication avoids duplicate reports
- **Project Standards Aware** - Auto-extracts ESLint/TypeScript/Prettier configs
- **Custom Rules** - Team-specific review rules and checklists
- **Multiple Output Formats** - JSON, Markdown, Summary, PR Comments
- **Real-time Monitoring** - WebSocket status server for visual progress

## Installation / 安装

### Global Install (Recommended)

```bash
npm install -g code-argus
```

### Using npx

```bash
npx code-argus review /path/to/repo feature-branch main
```

### From Source

```bash
git clone https://github.com/anthropics/code-argus.git
cd code-argus/core
npm install
npm run build
npm link
```

## Configuration / 配置

Set your Anthropic API key:

```bash
export ANTHROPIC_API_KEY=your-api-key
```

Or create a `.env` file in your working directory:

```bash
ANTHROPIC_API_KEY=your-api-key
```

## Usage / 使用方法

### Command Format

```bash
argus <command> <repoPath> <sourceBranch> <targetBranch> [options]
```

### Commands

- `analyze` - Quick diff analysis (no AI agents)
- `review` - Full AI code review (multi-agent parallel review)

### Arguments

- `repoPath` - Path to git repository
- `sourceBranch` - Source branch (PR branch, uses `origin/<sourceBranch>`)
- `targetBranch` - Target branch (base branch, uses `origin/<targetBranch>`)

### Options

| Option                 | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `--format=<format>`    | Output: `json`, `markdown` (default), `summary`, `pr-comments` |
| `--language=<lang>`    | Language: `zh` (default), `en`                                 |
| `--config-dir=<path>`  | Config dir (auto-loads `rules/` and `agents/`)                 |
| `--rules-dir=<path>`   | Custom rules directory (can use multiple times)                |
| `--agents-dir=<path>`  | Custom agents directory (can use multiple times)               |
| `--skip-validation`    | Skip validation (faster but less accurate)                     |
| `--monitor`            | Enable real-time status monitoring UI                          |
| `--monitor-port=<num>` | Monitor port (default: 3456)                                   |
| `--verbose`            | Verbose output                                                 |

### Examples

```bash
# Quick diff analysis
argus analyze /path/to/repo feature-branch main

# Full AI code review
argus review /path/to/repo feature-branch main

# Review with English output
argus review /path/to/repo feature-branch main --format=markdown --language=en

# Review with custom config directory
argus review /path/to/repo feature-branch main --config-dir=./.ai-review --monitor

# Review with separate rules and agents directories
argus review /path/to/repo feature-branch main --rules-dir=./rules --agents-dir=./agents

# Fast review (skip validation)
argus review /path/to/repo feature-branch main --skip-validation
```

## 项目结构

```
src/
├── index.ts              # CLI 入口，命令解析
├── review/
│   ├── orchestrator.ts   # 主审查协调器
│   ├── streaming-orchestrator.ts  # 流式审查模式
│   ├── agent-selector.ts # 智能 Agent 选择
│   ├── validator.ts      # 问题验证（挑战模式）
│   ├── deduplicator.ts   # 跨 Agent 去重
│   ├── aggregator.ts     # 问题聚合
│   ├── report.ts         # 报告生成
│   ├── prompts/          # Agent Prompt 构建
│   ├── standards/        # 项目标准提取
│   ├── rules/            # 自定义规则加载
│   └── types.ts          # 类型定义
├── git/
│   ├── diff.ts           # Git Diff 操作
│   ├── parser.ts         # Diff 解析
│   └── commits.ts        # 提交历史
├── llm/
│   ├── factory.ts        # LLM 提供者工厂
│   └── providers/        # Claude/OpenAI 实现
├── analyzer/
│   ├── local-analyzer.ts # 本地快速分析
│   └── diff-analyzer.ts  # LLM 语义分析
├── intent/               # PR 意图分析
└── monitor/              # 状态监控服务器

.claude/agents/           # Agent Prompt 定义
├── security-reviewer.md  # 安全审查
├── logic-reviewer.md     # 逻辑审查
├── style-reviewer.md     # 风格审查
├── performance-reviewer.md # 性能审查
└── validator.md          # 问题验证
```

## 技术栈

- **TypeScript 5.7** - 类型安全，严格模式
- **Claude Agent SDK** - 多智能体编排框架
- **Anthropic SDK** - Claude API 调用
- **ES Modules** - 现代模块系统
- **tsx** - 快速执行 TypeScript
- **Node.js 22+** - 最新 Node.js 特性

## 自定义配置

推荐使用 `--config-dir` 指定配置目录，自动加载 `rules/` 和 `agents/` 子目录：

```
.ai-review/
├── rules/              # 补充内置 Agent 的规则
│   ├── global.md       # 全局规则（应用于所有 Agent）
│   ├── security.md     # 安全审查规则
│   ├── logic.md        # 逻辑审查规则
│   ├── style.md        # 风格审查规则
│   ├── performance.md  # 性能审查规则
│   └── checklist.yaml  # 自定义检查清单
└── agents/             # 自定义 Agent（领域专项审查）
    ├── component-plugin.yaml   # 组件插件审查
    └── api-security.yaml       # API 安全审查
```

### Rules（规则）

补充内置 4 个 Agent 的规则，使用 Markdown 格式。

### Agents（自定义 Agent）

独立的领域审查 Agent，使用 YAML 定义，支持自定义触发条件：

```yaml
name: my-custom-agent
description: 描述功能
trigger_mode: rule # rule | llm | hybrid
triggers:
  files: ['**/*.ts']
  exclude_files: ['**/*.test.ts']
prompt: |
  审查指南...
output:
  category: logic
  default_severity: error
```

多个配置目录会按顺序合并，后面的覆盖前面的。

## 开发命令

```bash
# 开发
npm run dev -- <command> ...   # 运行 CLI
npm run exec src/file.ts       # 运行任意 TS 文件

# 构建
npm run build                  # 编译到 dist/
npm run type-check             # 类型检查

# 代码质量
npm run lint                   # ESLint 检查
npm run lint:fix               # 自动修复
npm run format                 # Prettier 格式化
npm run format:check           # 检查格式

# 测试
npm run test                   # 监听模式
npm run test:run               # 运行一次
npm run test:coverage          # 覆盖率报告
```

## 工作原理

### 审查流程

1. **上下文构建** - 获取三点式 Diff，解析文件，提取项目标准
2. **智能选择** - 根据文件特征选择需要的 Agent
3. **并行审查** - 4 个专业 Agent 并发执行
4. **去重** - LLM 语义去重，合并相似问题
5. **验证** - 挑战模式多轮验证，过滤误报
6. **报告** - 生成结构化审查报告

### 三点式 Diff

使用 `git diff origin/target...origin/source`：

```
main:     A --- B --- C
                \
feature:         D --- E
```

- 只显示 D 和 E 的变更（源分支实际改动）
- 排除 target 分支上的其他提交

## Commit 规范

使用 Conventional Commits：

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update documentation"
```

类型：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`

## 后续规划

- [ ] GitHub/GitLab PR 集成
- [ ] 增量审查（只审查新增变更）
- [ ] 审查结果缓存
- [ ] 更多 LLM 提供者支持（Gemini、DeepSeek）
- [ ] Web UI 界面

## License

MIT
