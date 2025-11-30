# code-argus

自动化 AI 代码审查 CLI 工具 - 基于多智能体架构的 Git Diff 分析与问题检测

[English](./README.en.md) | 中文

## 功能特性

- **多智能体并行审查** - 4 个专业 Agent 并发运行：安全、逻辑、性能、风格
- **智能 Agent 选择** - 根据文件特征自动选择需要运行的 Agent
- **问题验证** - 挑战模式多轮验证，显著降低误报率
- **实时去重** - 两层去重机制：快速规则检查 + LLM 语义验证
- **项目标准感知** - 自动提取 ESLint/TypeScript/Prettier 配置
- **自定义规则** - 支持团队级审查规则和检查清单
- **增量审查** - 只审查新增的提交，提升效率
- **服务集成** - JSON 事件流输出，便于 CI/CD 和外部服务集成

## 安装

### 全局安装（推荐）

```bash
npm install -g code-argus
```

### 使用 npx

```bash
npx code-argus review /path/to/repo feature-branch main
```

### 从源码安装

```bash
git clone https://github.com/anthropics/code-argus.git
cd code-argus/core
npm install
npm run build
npm link
```

## 配置

### API 密钥

设置 Anthropic API 密钥：

```bash
# 方式一：环境变量
export ANTHROPIC_API_KEY=your-api-key

# 方式二：.env 文件
echo "ANTHROPIC_API_KEY=your-api-key" > .env

# 方式三：使用 config 命令（推荐）
argus config set api-key sk-ant-xxx
```

### 配置管理

```bash
# 设置配置
argus config set api-key sk-ant-xxx      # API 密钥
argus config set base-url https://proxy  # 自定义代理 URL
argus config set model claude-sonnet-4-5-20250929  # 模型

# 查看配置
argus config list                         # 列出所有配置
argus config get api-key                  # 获取单个配置
argus config path                         # 显示配置文件路径

# 删除配置
argus config delete base-url
```

## 使用方法

### 命令格式

```bash
argus <command> <repoPath> <sourceBranch> <targetBranch> [options]
```

### 命令

| 命令      | 说明                                  |
| --------- | ------------------------------------- |
| `analyze` | 快速 Diff 分析（不启动 AI Agent）     |
| `review`  | 完整 AI 代码审查（多 Agent 并行审查） |
| `config`  | 配置管理                              |

### 参数

| 参数           | 说明                                               |
| -------------- | -------------------------------------------------- |
| `repoPath`     | Git 仓库路径                                       |
| `sourceBranch` | 源分支（PR 分支，使用 `origin/<sourceBranch>`）    |
| `targetBranch` | 目标分支（基础分支，使用 `origin/<targetBranch>`） |

---

## 选项详解

### `--json-logs`

**输出 JSON 事件流，用于服务集成**

启用后，所有进度和最终报告都以 JSON Lines (NDJSON) 格式输出到 stderr，便于外部程序解析。

```bash
argus review /repo feature main --json-logs
```

**输出示例：**

```jsonl
{"type":"review:start","data":{"repoPath":"/repo","sourceBranch":"feature","targetBranch":"main","agents":["security-reviewer","logic-reviewer"],"timestamp":"2025-01-15T10:00:00.000Z"}}
{"type":"phase:start","data":{"phase":1,"totalPhases":4,"name":"构建审查上下文...","timestamp":"..."}}
{"type":"agent:start","data":{"agent":"security-reviewer","timestamp":"..."}}
{"type":"agent:progress","data":{"agent":"security-reviewer","activity":"Reading file: src/auth.ts","timestamp":"..."}}
{"type":"agent:complete","data":{"agent":"security-reviewer","status":"completed","issuesFound":3,"elapsedMs":5000,"timestamp":"..."}}
{"type":"validation:issue","data":{"issueId":"sql-injection","title":"SQL Injection","status":"confirmed","timestamp":"..."}}
{"type":"review:complete","data":{"totalIssues":5,"elapsedMs":30000,"timestamp":"..."}}
{"type":"report","data":{"report":{"issues":[...],"metrics":{...},"metadata":{...}},"timestamp":"..."}}
```

**事件类型说明：**

| 事件类型              | 说明                                              |
| --------------------- | ------------------------------------------------- |
| `review:start`        | 审查开始，包含仓库、分支、Agent 列表              |
| `review:complete`     | 审查完成，包含问题总数和耗时                      |
| `review:error`        | 审查失败，包含错误信息                            |
| `phase:start`         | 阶段开始（构建上下文、运行Agent、验证、生成报告） |
| `phase:complete`      | 阶段完成                                          |
| `agent:start`         | Agent 开始运行                                    |
| `agent:progress`      | Agent 活动（读取文件、搜索代码等）                |
| `agent:complete`      | Agent 完成，包含发现的问题数                      |
| `validation:start`    | 验证开始                                          |
| `validation:progress` | 验证进度                                          |
| `validation:issue`    | 问题验证结果（confirmed/rejected/uncertain）      |
| `validation:complete` | 验证完成统计                                      |
| `log`                 | 日志消息                                          |
| `report`              | **最终报告**（包含完整的审查结果）                |

**服务集成示例：**

```typescript
import { spawn } from 'child_process';

const child = spawn('argus', ['review', repo, source, target, '--json-logs']);

child.stderr.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n').filter(Boolean)) {
    const event = JSON.parse(line);

    switch (event.type) {
      case 'agent:start':
        updateUI(`Agent ${event.data.agent} 开始运行...`);
        break;
      case 'agent:complete':
        updateUI(`Agent ${event.data.agent} 完成，发现 ${event.data.issuesFound} 个问题`);
        break;
      case 'validation:issue':
        if (event.data.status === 'confirmed') {
          addIssue(event.data);
        }
        break;
      case 'report':
        // 最终报告 - 审查完成
        saveReport(event.data.report);
        break;
    }
  }
});
```

---

### `--language=<lang>`

**输出语言**

| 值   | 说明         |
| ---- | ------------ |
| `zh` | 中文（默认） |
| `en` | 英文         |

```bash
argus review /repo feature main --language=en
```

---

### `--incremental`

**增量审查模式**

只审查自上次审查以来新增的提交，大幅提升审查效率。

```bash
# 首次审查（完整审查）
argus review /repo feature main

# 后续审查（只审查新增提交）
argus review /repo feature main --incremental
```

**工作原理：**

1. 首次审查会记录当前源分支的 SHA
2. 后续 `--incremental` 审查只分析新增的提交
3. 如果没有新提交，会提示并跳过审查
4. 审查状态保存在 `~/.argus/reviews/` 目录

---

### `--reset-state`

**重置审查状态**

清除之前的审查记录，强制执行完整审查。

```bash
# 重置后执行完整审查
argus review /repo feature main --reset-state

# 重置后启用增量审查（首次会是完整审查）
argus review /repo feature main --reset-state --incremental
```

---

### `--skip-validation`

**跳过问题验证**

跳过挑战模式验证，加快审查速度，但可能增加误报。

```bash
argus review /repo feature main --skip-validation
```

**适用场景：**

- 快速预览审查结果
- CI/CD 中的快速检查
- 对误报容忍度较高的场景

**注意：** 不推荐在正式审查中使用，验证可以过滤约 30-50% 的误报。

---

### `--config-dir=<path>`

**配置目录**

指定配置目录，自动加载其中的 `rules/` 和 `agents/` 子目录。

```bash
argus review /repo feature main --config-dir=./.ai-review
```

**目录结构：**

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
    ├── component-plugin.yaml
    └── api-security.yaml
```

---

### `--rules-dir=<path>`

**自定义规则目录**

单独指定规则目录，可多次使用。

```bash
# 单个规则目录
argus review /repo feature main --rules-dir=./team-rules

# 多个规则目录（按顺序合并）
argus review /repo feature main --rules-dir=./base-rules --rules-dir=./team-rules
```

**规则文件格式（Markdown）：**

```markdown
# 安全审查规则

## 必须检查

- 所有用户输入必须进行验证和转义
- 禁止使用 eval() 和 new Function()
- SQL 查询必须使用参数化查询

## 推荐做法

- 使用 Content-Security-Policy 头
- 敏感数据使用加密存储
```

---

### `--agents-dir=<path>`

**自定义 Agent 目录**

指定自定义 Agent 定义目录，可多次使用。

```bash
argus review /repo feature main --agents-dir=./custom-agents
```

**Agent 定义文件格式（YAML）：**

```yaml
name: api-security
description: API 安全专项审查
trigger_mode: rule # rule | llm | hybrid
triggers:
  files:
    - '**/api/**/*.ts'
    - '**/routes/**/*.ts'
  exclude_files:
    - '**/*.test.ts'
    - '**/*.spec.ts'
prompt: |
  你是 API 安全审查专家，请检查以下问题：

  1. 认证和授权
     - 是否正确验证用户身份
     - 是否检查用户权限

  2. 输入验证
     - 请求参数是否进行类型和范围验证
     - 是否防止注入攻击

  3. 响应安全
     - 是否泄露敏感信息
     - 错误消息是否过于详细
output:
  category: security
  default_severity: error
```

---

### `--verbose`

**详细输出模式**

输出更多调试信息，包括 Agent 选择原因、工具调用详情等。

```bash
argus review /repo feature main --verbose
```

---

## 使用示例

### 基础用法

```bash
# 快速 Diff 分析（无 AI）
argus analyze /path/to/repo feature-branch main

# 完整 AI 代码审查
argus review /path/to/repo feature-branch main

# 英文输出
argus review /path/to/repo feature-branch main --language=en
```

### 增量审查

```bash
# 首次审查
argus review /repo feature main

# 推送新代码后，只审查新增部分
argus review /repo feature main --incremental

# 强制完整审查
argus review /repo feature main --reset-state
```

### 自定义配置

```bash
# 使用配置目录
argus review /repo feature main --config-dir=./.ai-review

# 分别指定规则和 Agent
argus review /repo feature main \
  --rules-dir=./company-rules \
  --agents-dir=./domain-agents

# 多层配置合并
argus review /repo feature main \
  --config-dir=./base-config \
  --rules-dir=./team-overrides
```

### CI/CD 集成

```bash
# JSON 事件流输出
argus review /repo feature main --json-logs 2>events.jsonl

# 快速检查（跳过验证）
argus review /repo feature main --skip-validation --json-logs

# 增量 CI 检查
argus review /repo feature main --incremental --json-logs
```

---

## 项目结构

```
src/
├── index.ts              # CLI 入口，命令解析
├── cli/
│   ├── progress.ts       # 交互式进度输出
│   ├── events.ts         # 事件类型定义
│   └── structured-progress.ts  # JSON 事件流输出
├── review/
│   ├── orchestrator.ts   # 主审查协调器
│   ├── streaming-orchestrator.ts  # 流式审查模式
│   ├── agent-selector.ts # 智能 Agent 选择
│   ├── validator.ts      # 问题验证（挑战模式）
│   ├── realtime-deduplicator.ts  # 实时去重
│   ├── deduplicator.ts   # 批量语义去重
│   ├── aggregator.ts     # 问题聚合
│   ├── report.ts         # 报告生成
│   ├── state-manager.ts  # 增量审查状态管理
│   ├── prompts/          # Agent Prompt 构建
│   ├── standards/        # 项目标准提取
│   ├── rules/            # 自定义规则加载
│   ├── custom-agents/    # 自定义 Agent 加载
│   └── types.ts          # 类型定义
├── git/
│   ├── diff.ts           # Git Diff 操作
│   ├── parser.ts         # Diff 解析
│   └── commits.ts        # 提交历史
├── llm/
│   ├── factory.ts        # LLM 提供者工厂
│   └── providers/        # Claude/OpenAI 实现
└── analyzer/
    ├── local-analyzer.ts # 本地快速分析
    └── diff-analyzer.ts  # LLM 语义分析

.claude/agents/           # 内置 Agent Prompt 定义
├── security-reviewer.md  # 安全审查
├── logic-reviewer.md     # 逻辑审查
├── style-reviewer.md     # 风格审查
├── performance-reviewer.md # 性能审查
└── validator.md          # 问题验证
```

## 工作原理

### 审查流程

```
┌─────────────────┐
│  1. 上下文构建   │  获取 Diff → 解析文件 → 提取项目标准
└────────┬────────┘
         ▼
┌─────────────────┐
│  2. 智能选择    │  根据文件特征选择需要的 Agent
└────────┬────────┘
         ▼
┌─────────────────┐
│  3. 并行审查    │  4 个 Agent 并发执行 + 实时去重
└────────┬────────┘
         ▼
┌─────────────────┐
│  4. 问题验证    │  挑战模式多轮验证，过滤误报
└────────┬────────┘
         ▼
┌─────────────────┐
│  5. 生成报告    │  聚合问题，生成结构化报告
└─────────────────┘
```

### 三点式 Diff

使用 `git diff origin/target...origin/source`：

```
main:     A --- B --- C
                \
feature:         D --- E
```

- 只显示 D 和 E 的变更（源分支实际改动）
- 排除 target 分支上的其他提交

### 实时去重

两层去重机制：

1. **规则层** - 同文件 + 行号重叠 → 快速判断
2. **LLM 层** - 语义相似度 → 精确去重

### 问题验证

挑战模式：验证 Agent 尝试"挑战"发现的问题

- 验证代码位置是否正确
- 验证问题描述是否准确
- 验证是否为真实问题而非误报

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

## Commit 规范

使用 Conventional Commits：

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug"
git commit -m "docs: update documentation"
```

类型：`feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`chore`

## License

MIT
