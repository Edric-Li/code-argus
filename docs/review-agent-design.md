# AI Code Review Agent 设计文档

## 概述

基于 Claude Agent SDK 构建的智能代码审查系统，通过多 Agent 协作和验证机制，解决 AI 代码审查中的三个核心问题：

| 问题     | 解决方案                                                  |
| -------- | --------------------------------------------------------- |
| **幻觉** | Validator Agent + Grounding（必须使用工具获取真实上下文） |
| **漏检** | 多 Agent 并行扫描 + Checklist 强制覆盖                    |
| **规范** | 自动从配置文件提取规范注入 Prompt                         |

## 架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  Code Review Agent System                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐    ┌──────────────────────────────────────────────┐   │
│  │   已有模块   │    │              新增模块                        │   │
│  │             │    │                                              │   │
│  │ • Git Diff  │    │  ┌────────────────────────────────────────┐  │   │
│  │ • Analyzer  │───▶│  │         Review Orchestrator           │  │   │
│  │ • Intent    │    │  │                                        │  │   │
│  │             │    │  │  协调多个子 Agent，聚合结果，生成报告    │  │   │
│  └─────────────┘    │  └───────────────────┬────────────────────┘  │   │
│                     │                      │                       │   │
│                     │                      │ Task (并行)           │   │
│                     │                      ▼                       │   │
│                     │  ┌────────────────────────────────────────┐  │   │
│                     │  │         Specialist Agents              │  │   │
│                     │  │                                        │  │   │
│                     │  │  ┌──────────┐ ┌──────────┐ ┌────────┐ │  │   │
│                     │  │  │ Security │ │  Logic   │ │ Style  │ │  │   │
│                     │  │  └──────────┘ └──────────┘ └────────┘ │  │   │
│                     │  │                                        │  │   │
│                     │  └───────────────────┬────────────────────┘  │   │
│                     │                      │                       │   │
│                     │                      ▼ RawIssue[]            │   │
│                     │  ┌────────────────────────────────────────┐  │   │
│                     │  │         Validator Agent                │  │   │
│                     │  │                                        │  │   │
│                     │  │  使用 Read/Grep/Glob 验证每个问题       │  │   │
│                     │  │  消除幻觉，输出 ValidatedIssue[]        │  │   │
│                     │  └───────────────────┬────────────────────┘  │   │
│                     │                      │                       │   │
│                     │                      ▼                       │   │
│                     │  ┌────────────────────────────────────────┐  │   │
│                     │  │    Aggregator + Report Generator       │  │   │
│                     │  └────────────────────────────────────────┘  │   │
│                     │                                              │   │
│                     └──────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 技术选型

- **Agent 框架**: `@anthropic-ai/claude-agent-sdk`
- **内置工具**: Read, Grep, Glob, Bash, Task
- **子 Agent 定义**: Markdown 文件 (`.claude/agents/*.md`)

### 为什么选择 Claude Agent SDK

| 方面       | 自己实现          | 使用 SDK                 |
| ---------- | ----------------- | ------------------------ |
| MCP Tools  | 需实现 5+ 工具    | 内置 Read/Grep/Glob/Bash |
| Agent 执行 | 需管理对话循环    | SDK 自动处理             |
| 并发控制   | 需自己实现        | Task 原生支持            |
| 上下文管理 | 需处理 token 限制 | SDK 自动压缩             |
| 代码量     | ~2000+ 行         | ~500 行                  |

## 模块设计

### 目录结构

```
src/
├── review/
│   ├── types.ts              # Review 类型定义
│   ├── orchestrator.ts       # 主控逻辑
│   ├── prompts/              # Prompt 模板
│   │   ├── base.ts
│   │   ├── security.ts
│   │   ├── logic.ts
│   │   ├── style.ts
│   │   └── validator.ts
│   ├── standards/            # 规范提取
│   │   ├── types.ts
│   │   ├── extractor.ts
│   │   └── parsers/
│   │       ├── eslint.ts
│   │       ├── typescript.ts
│   │       └── prettier.ts
│   ├── aggregator.ts         # 结果聚合
│   └── index.ts

.claude/
└── agents/                   # Agent 定义
    ├── security-reviewer.md
    ├── logic-reviewer.md
    ├── style-reviewer.md
    ├── performance-reviewer.md
    └── validator.md
```

### 核心类型

```typescript
/** 问题严重级别 */
type Severity = 'critical' | 'error' | 'warning' | 'suggestion';

/** 问题类别 */
type IssueCategory = 'security' | 'logic' | 'performance' | 'style' | 'maintainability';

/** 验证状态 */
type ValidationStatus = 'pending' | 'confirmed' | 'rejected' | 'uncertain';

/** 原始问题 (Agent 初次扫描输出) */
interface RawIssue {
  id: string;
  file: string;
  line_start: number;
  line_end: number;
  category: IssueCategory;
  severity: Severity;
  title: string;
  description: string;
  suggestion?: string;
  code_snippet?: string;
  confidence: number; // 0-1
  source_agent: string;
}

/** 验证证据 */
interface GroundingEvidence {
  checked_files: string[];
  checked_symbols: {
    name: string;
    type: 'definition' | 'reference';
    locations: string[];
  }[];
  related_context: string;
  reasoning: string;
}

/** 已验证的问题 */
interface ValidatedIssue extends RawIssue {
  validation_status: ValidationStatus;
  grounding_evidence: GroundingEvidence;
  final_confidence: number;
  rejection_reason?: string;
}

/** 项目规范 */
interface ProjectStandards {
  source: string[];
  eslint?: ESLintStandards;
  typescript?: TypeScriptStandards;
  prettier?: PrettierStandards;
  naming?: NamingConventions;
}

/** Review 上下文 */
interface ReviewContext {
  repoPath: string;
  diff: DiffResult;
  intent: IntentAnalysis;
  fileAnalyses: ChangeAnalysis[];
  standards: ProjectStandards;
}

/** 最终报告 */
interface ReviewReport {
  summary: string;
  risk_level: 'high' | 'medium' | 'low';
  issues: ValidatedIssue[];
  checklist: ChecklistItem[];
  metrics: {
    total_scanned: number;
    confirmed: number;
    rejected: number;
    uncertain: number;
    by_severity: Record<Severity, number>;
    by_category: Record<IssueCategory, number>;
  };
  metadata: {
    review_time_ms: number;
    tokens_used: number;
    agents_used: string[];
  };
}
```

## Agent 设计

### 1. Orchestrator Agent (主控)

**职责**：

- 接收 ReviewContext
- 分发任务给子 Agent (并行)
- 收集原始问题
- 调用 Validator 验证
- 聚合结果生成报告

**工具**: `Task`

### 2. Specialist Agents (专业审查)

| Agent       | 专注领域 | 检查项                                         |
| ----------- | -------- | ---------------------------------------------- |
| Security    | 安全漏洞 | 注入攻击、认证问题、敏感信息、输入验证         |
| Logic       | 逻辑错误 | 空指针、边界条件、竞态条件、错误处理、资源泄漏 |
| Style       | 代码风格 | 命名规范、代码风格、注释质量、一致性           |
| Performance | 性能问题 | N+1查询、内存泄漏、不必要循环、缓存问题        |

**工具**: `Read`, `Grep`, `Glob`

### 3. Validator Agent (验证)

**职责**: 验证所有发现的问题，消除幻觉

**核心原则**:

1. **必须获取真实上下文** - 不仅凭 diff 片段判断
2. **果断拒绝虚假问题** - 如果问题在完整上下文中不成立
3. **详细记录推理过程** - 每个决策都有清晰推理

**验证流程**:

```
1. 读取完整文件 (Read)
2. 查找相关上下文 (Grep)
3. 检查是否已处理
4. 做出判断: confirmed / rejected / uncertain
```

**常见幻觉模式**:

- 只看 diff 片段，忽略完整函数上下文
- 忽略类型系统保护
- 不了解项目约定
- 忽略框架保护 (如 ORM 防注入)

**工具**: `Read`, `Grep`, `Glob`, `Bash`

## 规范提取

自动从项目配置文件提取编码规范：

```
配置文件                    提取内容
─────────────────────────────────────────
eslint.config.{js,mjs}  →  规则配置
.eslintrc.*             →  extends, plugins
tsconfig.json           →  严格模式、类型检查选项
.prettierrc.*           →  格式化规则
.editorconfig           →  基础编辑器配置
```

提取后转换为 Prompt 文本：

```
## 项目编码规范 (自动提取)

### TypeScript 规范
- 启用严格模式 (strict: true)
- 禁止使用 any 类型
- 禁止未使用的变量和参数

### 代码风格
- 缩进: 2 空格
- 不使用分号
- 使用单引号
- 最大行宽: 100

### 命名规范
- 文件: kebab-case.ts
- 函数/变量: camelCase
- 类/接口: PascalCase
```

## 数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Complete Data Flow                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Input: PR/Branch + Repo Path                                           │
│                │                                                        │
│                ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  已有模块                                                        │   │
│  │  Git Diff → Analyzer → Intent                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                │                                                        │
│                ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Standards Extractor                                             │   │
│  │  eslint + tsconfig + prettier → ProjectStandards                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                │                                                        │
│                ▼                                                        │
│       ReviewContext 组装完成                                            │
│                │                                                        │
│                ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Claude Agent SDK                                                │   │
│  │                                                                  │   │
│  │  Orchestrator                                                    │   │
│  │       │                                                          │   │
│  │       │ Task (并行)                                              │   │
│  │       ▼                                                          │   │
│  │  Security + Logic + Style + Perf Agents                         │   │
│  │       │                                                          │   │
│  │       ▼ RawIssue[]                                               │   │
│  │  Validator Agent                                                 │   │
│  │       │                                                          │   │
│  │       ▼ ValidatedIssue[]                                         │   │
│  │                                                                  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                │                                                        │
│                ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Aggregator                                                      │   │
│  │  去重 + 过滤 rejected + 排序                                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                │                                                        │
│                ▼                                                        │
│           ReviewReport                                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 设计决策

| 决策点     | 选择                | 理由                   |
| ---------- | ------------------- | ---------------------- |
| Agent 数量 | 4 个专业 + 1 个验证 | 专业化更好，预算充足   |
| 验证策略   | 全量验证            | 确保质量，预算充足     |
| 规范来源   | 自动提取配置文件    | 减少手动维护，保持一致 |
| 人工介入   | 无                  | 全自动化               |
| 静态分析   | 通过 Bash 调用      | 复用现有工具           |
