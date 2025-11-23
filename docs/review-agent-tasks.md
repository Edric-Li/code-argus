# AI Code Review Agent 任务拆分

## 三阶段开发计划

```
Phase 1: 基础框架        Phase 2: Agent 实现       Phase 3: 验证与聚合
─────────────────────   ─────────────────────    ─────────────────────
• 类型定义              • 专业 Agent Prompt      • Validator Agent
• 规范提取              • Orchestrator 实现      • 结果聚合
• SDK 集成基础          • 子 Agent 调用          • 报告生成
                                                 • 端到端测试
```

---

## Phase 1: 基础框架

**目标**: 搭建 Review 模块骨架，实现规范自动提取，完成 SDK 集成基础

### 任务清单

#### 1.1 类型定义 (`src/review/types.ts`)

- [ ] 定义 `Severity` 类型
- [ ] 定义 `IssueCategory` 类型
- [ ] 定义 `ValidationStatus` 类型
- [ ] 定义 `RawIssue` 接口
- [ ] 定义 `GroundingEvidence` 接口
- [ ] 定义 `ValidatedIssue` 接口
- [ ] 定义 `ChecklistItem` 接口
- [ ] 定义 `ProjectStandards` 接口
- [ ] 定义 `ReviewContext` 接口
- [ ] 定义 `ReviewReport` 接口
- [ ] 定义 Agent 相关类型

#### 1.2 规范提取模块 (`src/review/standards/`)

- [ ] `types.ts` - 规范相关类型定义
  - ESLintStandards
  - TypeScriptStandards
  - PrettierStandards
  - NamingConventions

- [ ] `parsers/eslint.ts` - ESLint 配置解析
  - 支持 `eslint.config.{js,mjs,cjs}`
  - 支持 `.eslintrc.{js,json,yaml}`
  - 提取 rules, extends, plugins

- [ ] `parsers/typescript.ts` - TSConfig 解析
  - 解析 `tsconfig.json`
  - 提取 compilerOptions 中的规范相关配置
  - 处理 extends 继承

- [ ] `parsers/prettier.ts` - Prettier 配置解析
  - 支持 `.prettierrc.{js,json,yaml}`
  - 支持 `prettier.config.{js,mjs}`
  - 提取格式化规则

- [ ] `extractor.ts` - 规范提取主逻辑
  - 检测配置文件存在性
  - 调用各解析器
  - 合并为 ProjectStandards
  - 转换为 Prompt 文本

#### 1.3 SDK 集成基础 (`src/review/orchestrator.ts`)

- [ ] 安装 `@anthropic-ai/claude-agent-sdk`
- [ ] 创建 `ReviewOrchestrator` 类骨架
- [ ] 实现基础的 SDK Client 初始化
- [ ] 验证 SDK 连接和工具可用性

#### 1.4 Prompt 模板基础 (`src/review/prompts/`)

- [ ] `base.ts` - 通用 Prompt 片段
  - 输出格式定义
  - JSON Schema 定义
  - 通用指令

### Phase 1 交付物

```
src/review/
├── types.ts              ✓
├── orchestrator.ts       ✓ (骨架)
├── prompts/
│   └── base.ts           ✓
└── standards/
    ├── types.ts          ✓
    ├── extractor.ts      ✓
    └── parsers/
        ├── eslint.ts     ✓
        ├── typescript.ts ✓
        └── prettier.ts   ✓
```

### Phase 1 验收标准

1. 能从项目中提取规范配置
2. 能生成规范的 Prompt 文本
3. SDK 能正常初始化
4. 类型定义完整，无 any

---

## Phase 2: Agent 实现

**目标**: 实现所有专业审查 Agent 的 Prompt，完成 Orchestrator 的并行调度逻辑

### 任务清单

#### 2.1 Agent Prompt 定义 (`.claude/agents/`)

- [ ] `security-reviewer.md` - 安全审查 Agent
  - 注入攻击检测
  - 认证授权问题
  - 敏感信息泄露
  - 输入验证
  - Checklist 定义
  - 输出格式 (JSON)

- [ ] `logic-reviewer.md` - 逻辑审查 Agent
  - 空指针/未定义访问
  - 边界条件
  - 竞态条件
  - 错误处理
  - 资源泄漏
  - Checklist 定义

- [ ] `style-reviewer.md` - 风格审查 Agent
  - 命名规范检查
  - 代码风格一致性
  - 注释质量
  - 结合项目规范

- [ ] `performance-reviewer.md` - 性能审查 Agent
  - N+1 查询
  - 不必要的循环
  - 内存问题
  - 缓存使用

#### 2.2 Prompt 模板 (`src/review/prompts/`)

- [ ] `security.ts` - Security Agent 的 Prompt 构建
- [ ] `logic.ts` - Logic Agent 的 Prompt 构建
- [ ] `style.ts` - Style Agent 的 Prompt 构建
- [ ] `performance.ts` - Performance Agent 的 Prompt 构建
- [ ] `orchestrator.ts` - Orchestrator 的 Prompt 构建

#### 2.3 Orchestrator 实现 (`src/review/orchestrator.ts`)

- [ ] 实现 `review()` 方法主流程
- [ ] 实现子 Agent 并行调度 (使用 Task)
- [ ] 实现结果收集逻辑
- [ ] 实现 Prompt 注入 (context + standards)
- [ ] 错误处理和重试

#### 2.4 模块导出 (`src/review/index.ts`)

- [ ] 导出 ReviewOrchestrator
- [ ] 导出类型定义
- [ ] 导出规范提取函数

### Phase 2 交付物

```
src/review/
├── prompts/
│   ├── base.ts           ✓
│   ├── security.ts       ✓
│   ├── logic.ts          ✓
│   ├── style.ts          ✓
│   ├── performance.ts    ✓
│   └── orchestrator.ts   ✓
├── orchestrator.ts       ✓ (完整)
└── index.ts              ✓

.claude/agents/
├── security-reviewer.md  ✓
├── logic-reviewer.md     ✓
├── style-reviewer.md     ✓
└── performance-reviewer.md ✓
```

### Phase 2 验收标准

1. 4 个专业 Agent 能独立运行
2. Orchestrator 能并行调度子 Agent
3. 能收集所有 Agent 的 RawIssue
4. 输出格式符合类型定义

---

## Phase 3: 验证与聚合

**目标**: 实现 Validator Agent 消除幻觉，完成结果聚合和报告生成，端到端测试

### 任务清单

#### 3.1 Validator Agent

- [ ] `.claude/agents/validator.md` - Validator Agent 定义
  - 验证原则 (必须用工具获取上下文)
  - 常见幻觉模式识别
  - 验证流程定义
  - 输出格式

- [ ] `src/review/prompts/validator.ts` - Validator Prompt 构建
  - 构建待验证问题的 Prompt
  - 注入上下文信息

- [ ] Orchestrator 集成
  - 在收集 RawIssue 后调用 Validator
  - 处理验证结果

#### 3.2 结果聚合 (`src/review/aggregator.ts`)

- [ ] 去重逻辑
  - 相同文件 + 相同行号
  - 相似描述合并

- [ ] 过滤逻辑
  - 移除 rejected 的问题
  - 处理 uncertain 的问题

- [ ] 排序逻辑
  - 按 severity 排序
  - 按 confidence 排序
  - 组合排序 (severity × confidence)

- [ ] Checklist 聚合
  - 合并各 Agent 的 checklist 结果

#### 3.3 报告生成 (`src/review/report.ts`)

- [ ] 生成 ReviewReport 结构
- [ ] 计算 metrics
- [ ] 生成 summary (可调用 LLM)
- [ ] 确定 risk_level
- [ ] 输出格式化 (JSON / Markdown)

#### 3.4 主入口集成 (`src/index.ts`)

- [ ] 添加 review 命令
- [ ] 集成完整流程:
  ```
  getDiff → analyze → analyzeIntent → review
  ```
- [ ] CLI 参数处理
- [ ] 输出格式选项

#### 3.5 测试

- [ ] 单元测试
  - 规范提取测试
  - 聚合逻辑测试
  - 报告生成测试

- [ ] 集成测试
  - 单个 Agent 测试
  - Validator 测试
  - 完整流程测试

- [ ] 端到端测试
  - 使用真实 PR 测试
  - 验证幻觉率
  - 验证漏检率

### Phase 3 交付物

```
src/review/
├── prompts/
│   └── validator.ts      ✓
├── aggregator.ts         ✓
├── report.ts             ✓
├── orchestrator.ts       ✓ (完整)
└── index.ts              ✓

.claude/agents/
└── validator.md          ✓

src/index.ts              ✓ (集成 review)

tests/
├── review/
│   ├── standards.test.ts ✓
│   ├── aggregator.test.ts ✓
│   └── e2e.test.ts       ✓
```

### Phase 3 验收标准

1. Validator 能有效识别和拒绝幻觉问题
2. 聚合逻辑正确去重和排序
3. 报告格式完整、可读
4. 端到端流程能正常运行
5. 幻觉率 < 10% (confirmed 的问题中)

---

## 依赖关系

```
Phase 1                 Phase 2                 Phase 3
────────────────────────────────────────────────────────────────────
types.ts ──────────────▶ prompts/*.ts ─────────▶ validator.ts
                              │                      │
standards/ ────────────▶ orchestrator.ts ─────▶ aggregator.ts
                              │                      │
SDK 基础 ──────────────▶ Agent 调度 ───────────▶ report.ts
                              │                      │
                        agents/*.md ───────────▶ validator.md
```

---

## 时间估算 (仅供参考)

| Phase   | 预估工作量 | 主要复杂度             |
| ------- | ---------- | ---------------------- |
| Phase 1 | 中等       | 规范解析器的兼容性     |
| Phase 2 | 较高       | Prompt 工程 + SDK 集成 |
| Phase 3 | 较高       | Validator 的准确性调优 |

---

## 风险点

| 风险            | 影响             | 缓解措施                  |
| --------------- | ---------------- | ------------------------- |
| SDK API 变化    | 需要调整集成代码 | 关注 SDK 更新，版本锁定   |
| Prompt 效果不佳 | 幻觉率高或漏检   | 迭代优化 Prompt，增加示例 |
| 规范解析不完整  | 规范提取遗漏     | 支持手动补充规范          |
| Token 消耗过大  | 成本增加         | 预算充足，不是问题        |

---

## 开始建议

1. **Phase 1 优先**: 类型定义是基础，规范提取可独立测试
2. **Prompt 迭代**: Agent Prompt 需要多次调优，建议边开发边测试
3. **Validator 是关键**: 这是消除幻觉的核心，需要重点投入
