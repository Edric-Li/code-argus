# @argus/core

自动化 AI 代码审查 CLI 工具 - 基于多智能体架构的 Git Diff 分析与问题检测

## 功能特性

- **多智能体审查** - 4 个专业 Agent 并行审查：安全、逻辑、性能、风格
- **智能 Agent 选择** - 基于文件特征自动选择需要运行的 Agent
- **问题验证** - "挑战模式"多轮验证，减少误报
- **跨 Agent 去重** - LLM 语义去重，避免重复报告
- **项目标准感知** - 自动提取 ESLint/TypeScript/Prettier 配置
- **自定义规则** - 支持团队自定义审查规则和检查清单
- **多种输出格式** - JSON、Markdown、Summary、PR Comments
- **实时监控** - WebSocket 状态服务器，可视化审查进度

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，设置 ANTHROPIC_API_KEY
```

### 使用方法

#### 命令格式

```bash
npm run dev -- <command> <repoPath> <sourceBranch> <targetBranch> [options]
```

#### 命令

- `analyze` - 仅分析 diff（快速，不启动 AI Agent）
- `review` - 完整 AI 代码审查（多智能体并行审查）

#### 参数说明

- `repoPath` - Git 仓库路径
- `sourceBranch` - 源分支（PR 分支，使用 `origin/<sourceBranch>`）
- `targetBranch` - 目标分支（基准分支，使用 `origin/<targetBranch>`）

#### Review 命令选项

| 选项                   | 说明                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `--format=<format>`    | 输出格式：`json`、`markdown`（默认）、`summary`、`pr-comments` |
| `--language=<lang>`    | 输出语言：`zh`（默认）、`en`                                   |
| `--config-dir=<path>`  | 配置目录，自动加载 `rules/` 和 `agents/` 子目录（推荐）        |
| `--rules-dir=<path>`   | 自定义规则目录（可多次使用）                                   |
| `--agents-dir=<path>`  | 自定义 Agent 目录（可多次使用）                                |
| `--skip-validation`    | 跳过问题验证（更快但准确性降低）                               |
| `--monitor`            | 启用实时状态监控 UI                                            |
| `--monitor-port=<num>` | 监控端口（默认 3456）                                          |
| `--verbose`            | 详细输出                                                       |

#### 示例

```bash
# 仅分析 diff（快速预览）
npm run dev -- analyze /path/to/repo feature-branch main

# 完整 AI 代码审查
npm run dev -- review /path/to/repo feature-branch main

# 指定输出格式和语言
npm run dev -- review /path/to/repo feature-branch main --format=json --language=en

# 使用配置目录（自动加载 rules/ 和 agents/）
npm run dev -- review /path/to/repo feature-branch main --config-dir=./.ai-review --monitor

# 分别指定规则和 Agent 目录
npm run dev -- review /path/to/repo feature-branch main --rules-dir=./rules --agents-dir=./agents

# 快速审查（跳过验证）
npm run dev -- review /path/to/repo feature-branch main --skip-validation
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
