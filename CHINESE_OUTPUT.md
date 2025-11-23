# 中文输出功能说明

## 功能介绍

Code Argus 默认使用中文输出代码审查报告,同时也支持英文输出。

## 使用方法

### 命令行选项

默认情况下,报告将以中文输出。如需英文报告,可添加 `--language=en` 选项:

```bash
# 生成中文报告(默认)
tsx src/index.ts review /path/to/repo feature-branch main

# 显式指定中文
tsx src/index.ts review /path/to/repo feature-branch main --language=zh

# 生成英文报告
tsx src/index.ts review /path/to/repo feature-branch main --language=en

# 中文报告,完整格式
tsx src/index.ts review /path/to/repo feature-branch main --format=markdown
```

### 支持的语言

- `zh`: 中文 (默认)
- `en`: 英文

### 示例对比

#### 英文报告示例

```markdown
# Code Review Report

## Summary

**PR Goal**: Add user authentication feature

**Issues Found**: 2 error(s), 3 warning(s)

**Risk Level**: 🟡 MEDIUM

## Issues Introduced in This PR

### 🟠 Errors

#### SQL Injection Vulnerability

| Field        | Value         |
| ------------ | ------------- |
| **ID**       | `issue-001`   |
| **File**     | `src/auth.ts` |
| **Severity** | error         |
| **Category** | security      |
```

#### 中文报告示例

```markdown
# 代码审查报告

## 总结

**PR 目标**: Add user authentication feature

**发现的问题**: 2 个错误, 3 个警告

**风险等级**: 🟡 中

## 本次 PR 引入的问题

### 🟠 错误

#### SQL Injection Vulnerability

| 字段         | 值            |
| ------------ | ------------- |
| **编号**     | `issue-001`   |
| **文件**     | `src/auth.ts` |
| **严重程度** | 错误          |
| **分类**     | 安全          |
```

### 翻译的内容

以下内容会被翻译成中文:

- 报告结构
  - 代码审查报告
  - 总结
  - 问题
  - 检查清单
  - 指标
  - 元数据

- 严重程度
  - 严重 (Critical)
  - 错误 (Error)
  - 警告 (Warning)
  - 建议 (Suggestion)

- 风险等级
  - 高 (High)
  - 中 (Medium)
  - 低 (Low)

- 问题分类
  - 安全 (Security)
  - 逻辑 (Logic)
  - 性能 (Performance)
  - 风格 (Style)
  - 可维护性 (Maintainability)

- 其他字段
  - 文件、位置、行数等表格字段
  - 描述、代码、建议等内容标题

### 注意事项

1. **问题描述和建议内容不会被翻译**:代码审查产生的具体问题描述、代码片段和修复建议仍然保持原始语言(通常是英文),只有报告的结构性文本会被翻译。

2. **JSON 格式不受影响**:`--format=json` 输出的 JSON 格式报告不会被翻译,仍然使用英文字段名。

3. **仅支持 Markdown 格式**:语言选项主要用于 `--format=markdown` 和 `--format=summary` 格式的输出。

## 技术实现

翻译功能通过内置的翻译字典实现,不依赖任何外部翻译 API,因此:

- ✅ 完全离线可用
- ✅ 无需额外配置
- ✅ 响应速度快
- ✅ 无额外费用

## 示例命令

```bash
# 查看帮助
tsx src/index.ts review --help

# 完整的中文报告生成示例(默认就是中文)
tsx src/index.ts review . feature/user-auth develop \
  --format=markdown \
  --verbose

# 简短的中文摘要(默认)
tsx src/index.ts review . feature/user-auth develop \
  --format=summary

# 生成英文报告
tsx src/index.ts review . feature/user-auth develop \
  --format=markdown \
  --language=en \
  --verbose
```
