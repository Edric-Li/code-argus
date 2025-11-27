# 自定义 Agent 示例

本目录包含自定义审查 Agent 的示例定义文件。

## 使用方式

```bash
# 使用示例 agents 目录运行审查
npm run dev -- review /path/to/repo feature-branch main --agents-dir=./examples/custom-agents

# 结合自定义规则一起使用
npm run dev -- review /path/to/repo feature-branch main \
  --agents-dir=./examples/custom-agents \
  --rules-dir=./team-rules
```

## 示例 Agent 说明

### typescript-migration.yaml

- **用途**: 检查 TypeScript 类型迁移的质量
- **触发方式**: 混合模式 (规则 + LLM)
- **触发条件**: `.ts/.tsx` 文件包含类型定义变更

### api-security.yaml

- **用途**: 检查 API 端点的安全性
- **触发方式**: 混合模式
- **触发条件**: API/路由相关文件变更

### react-hooks.yaml

- **用途**: 检查 React Hooks 的正确使用
- **触发方式**: 纯规则模式
- **触发条件**: React 组件文件包含 Hooks 调用

### database-query.yaml

- **用途**: 检查数据库查询的性能和安全性
- **触发方式**: 纯 LLM 模式
- **触发条件**: 由 LLM 根据代码语义判断

## Agent 定义格式

```yaml
# 基本信息
name: my-custom-agent # 唯一标识符
description: 描述此 Agent 的功能 # 人类可读描述

# 触发模式
trigger_mode: hybrid # rule | llm | hybrid

# 规则触发条件 (rule/hybrid 模式)
triggers:
  files: # Glob 文件匹配模式
    - '**/*.ts'
  exclude_files: # 排除模式
    - '**/*.test.ts'
  content_patterns: # 内容正则匹配
    - 'pattern'
  file_status: # 文件状态过滤
    - added
    - modified
  min_changes: 10 # 最小变更行数
  min_files: 1 # 最小匹配文件数
  match_mode: any # all | any

# LLM 触发判断 (llm/hybrid 模式)
trigger_prompt: |
  描述何时应该触发此 Agent...

# 混合模式策略
trigger_strategy:
  rule_confidence_threshold: 0.8 # 规则置信度阈值
  always_use_llm: false # 是否始终用 LLM 决策

# Agent 执行提示词
prompt: |
  详细的审查指南...

# 输出配置
output:
  category: maintainability # security | logic | performance | style | maintainability
  default_severity: warning # critical | error | warning | suggestion
  severity_weight: 1.0 # 0.0 - 2.0

# 启用/禁用
enabled: true

# 标签 (用于过滤)
tags:
  - tag1
  - tag2
```

## 触发模式说明

### rule 模式

- 仅使用规则匹配
- 快速，无 API 调用
- 适合简单明确的文件类型匹配

### llm 模式

- 仅使用 LLM 判断
- 灵活，能理解代码语义
- 需要 API 调用，有成本

### hybrid 模式 (推荐)

- 先尝试规则匹配
- 规则置信度不足时使用 LLM
- 平衡速度和准确性

## 最佳实践

1. **明确的触发条件**: 尽量使用规则匹配，减少不必要的 LLM 调用
2. **详细的 prompt**: 提供清晰的检查重点和不报告条件
3. **合理的严重程度**: 根据问题影响设置合适的 severity_weight
4. **使用标签**: 方便按标签过滤和组织 Agent
5. **排除测试文件**: 避免在测试代码中报告问题
