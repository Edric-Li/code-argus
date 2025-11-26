# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

@argus/core 是一个自动化 AI 代码审查 CLI 工具，使用 Claude Agent SDK 和多智能体编排来分析 Git diff，识别安全、逻辑、性能和风格类问题。

## 常用命令

```bash
# 开发
npm run dev -- <command> <repoPath> <sourceBranch> <targetBranch> [options]
npm run exec src/path/to/file.ts    # 直接运行任意 TypeScript 文件

# 构建与类型检查
npm run build                        # 编译 TypeScript 到 dist/
npm run type-check                   # 仅类型检查，不输出文件

# 代码质量
npm run lint                         # ESLint 检查
npm run lint:fix                     # 自动修复 ESLint 问题
npm run format                       # Prettier 格式化
npm run format:check                 # 检查格式

# 测试
npm run test                         # 监听模式运行测试
npm run test:run                     # 运行一次测试
npm run test:coverage                # 带覆盖率运行
```

### CLI 使用

```bash
# 仅分析 diff（快速，不启动 agent）
npm run dev -- analyze /path/to/repo feature-branch main

# 完整 AI 代码审查
npm run dev -- review /path/to/repo feature-branch main --format=markdown --monitor

# 使用自定义规则
npm run dev -- review /path/to/repo feature-branch main --rules-dir=./team-rules
```

主要选项：`--format=json|markdown|summary|pr-comments`、`--language=zh|en`、`--skip-validation`、`--monitor`、`--verbose`

## 架构

### 多智能体审查流程

审查过程分为以下阶段：

1. **上下文构建** (`orchestrator.ts:buildContext`)
   - 获取远程 refs，执行三点式 diff（`git diff origin/target...origin/source`）
   - 通过 `git/parser.ts` 解析 diff 为 `DiffFile[]`
   - 运行 `LocalDiffAnalyzer` 进行快速本地分析（无 LLM）
   - 从 ESLint/TypeScript/Prettier 配置提取项目标准

2. **智能 Agent 选择** (`agent-selector.ts`)
   - 基于文件特征的规则过滤
   - 边缘情况使用 LLM 兜底（置信度 < 0.8 时）
   - 跳过不必要的 agent（如纯文档变更跳过 security-reviewer）

3. **并行 Agent 执行** (`orchestrator.ts:runAgentsWithStreamingValidation`)
   - 通过 Claude Agent SDK 并发运行 4 个专业 agent
   - 每个 agent 使用 `.claude/agents/*.md` 中的 prompt
   - Agent 可使用 Read、Grep、Glob 工具探索代码

4. **去重** (`deduplicator.ts`)
   - 验证前移除跨 agent 的重复问题
   - 使用 LLM 进行语义相似度判断

5. **验证** (`validator.ts`)
   - "挑战模式"通过多轮提问验证问题
   - 低置信度问题（< 0.5）自动拒绝
   - 严重问题始终进行验证

6. **聚合与报告** (`aggregator.ts`、`report.ts`)
   - 过滤和分组已验证的问题
   - 生成 markdown/JSON/summary 输出

### 关键模块

```
src/
├── index.ts              # CLI 入口，命令解析
├── review/
│   ├── orchestrator.ts   # 主审查协调器
│   ├── streaming-orchestrator.ts  # 流式模式
│   ├── agent-selector.ts # 智能 agent 选择
│   ├── validator.ts      # 问题验证（挑战模式）
│   ├── deduplicator.ts   # 跨 agent 去重
│   ├── aggregator.ts     # 问题聚合
│   ├── report.ts         # 报告生成
│   ├── prompts/          # Agent prompt 构建器
│   ├── standards/        # 项目标准提取
│   ├── rules/            # 自定义规则加载
│   └── types.ts          # 所有审查相关类型
├── git/
│   ├── diff.ts           # Git diff 操作、worktree 管理
│   ├── parser.ts         # Diff 解析与文件分类
│   └── commits.ts        # 提交历史提取
├── llm/
│   ├── factory.ts        # LLM 提供者工厂
│   └── providers/        # Claude、OpenAI 实现
├── analyzer/
│   ├── local-analyzer.ts # 快速本地 diff 分析（无 LLM）
│   └── diff-analyzer.ts  # LLM 语义分析
└── intent/               # 从提交分析 PR 意图
```

### Agent 系统

Agent 定义在 `.claude/agents/` 目录：

- `security-reviewer.md` - 注入攻击、认证、数据泄露
- `logic-reviewer.md` - 逻辑错误、空值检查、竞态条件
- `style-reviewer.md` - 代码风格、命名、复杂度
- `performance-reviewer.md` - N+1 查询、内存泄漏、算法复杂度

每个 agent 输出 JSON 格式的 `issues[]` 和 `checklist[]`。

### 自定义规则

团队可通过 `--rules-dir` 提供自定义审查规则：

- `global.md` - 应用于所有 agent 的规则
- `security.md`、`logic.md`、`style.md`、`performance.md` - 特定 agent 规则
- `checklist.yaml` - 自定义检查清单

### 配置

- **LLM 提供者**：设置 `LLM_PROVIDER=claude|openai` 及对应 API 密钥
- **Agent 模型**：`claude-sonnet-4-5-20250929`（可在 `constants.ts` 配置）
- **验证模式**：默认启用挑战模式（`DEFAULT_CHALLENGE_MODE=true`）

## 核心类型

```typescript
// 问题流转：RawIssue -> ValidatedIssue
interface RawIssue {
  id: string;
  file: string;
  line_start: number;
  line_end: number;
  category: 'security' | 'logic' | 'performance' | 'style' | 'maintainability';
  severity: 'critical' | 'error' | 'warning' | 'suggestion';
  title: string;
  description: string;
  suggestion?: string;
  confidence: number;
  source_agent: AgentType;
}

// 验证后
interface ValidatedIssue extends RawIssue {
  validation_status: 'pending' | 'confirmed' | 'rejected' | 'uncertain';
  grounding_evidence: GroundingEvidence;
  final_confidence: number;
}
```

## 提交规范

使用 Conventional Commits：`<type>: <subject>`

类型：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`
