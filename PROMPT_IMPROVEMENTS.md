# AI Review 提示词改进

## 设计原则

- **提示词使用英文**: 给 AI 的指令全部用英文编写,保持专业性和准确性
- **输出使用中文**: AI 的分析结果、问题描述、建议等全部用中文,方便团队阅读

## 改进内容

### 1. 只评审修改的代码

**问题**: AI 可能会评审未修改的旧代码,导致报告中包含大量与本次 PR 无关的问题。

**解决方案**: 在提示词中明确强调只评审变更部分:

- ✅ 在系统提示词的开头添加 **CRITICAL REQUIREMENTS**
- ✅ 强调只评审带 `+` 或 `-` 标记的代码行
- ✅ 严禁评审未修改的旧代码(上下文行)
- ✅ 只报告由本次变更引入的问题

**关键提示词片段**(英文):

```
1. ONLY review changed code (lines marked with + or -)
2. NEVER review unchanged existing code (context lines)
```

**详细说明**:

- Lines starting with `+` are additions (REVIEW THESE)
- Lines starting with `-` are deletions (REVIEW THESE)
- Lines without prefix are context (DO NOT REVIEW THESE - they are unchanged old code)

**CRITICAL RULE**: Only report issues that are introduced BY THIS CHANGE. Do not report pre-existing issues in unchanged code.

### 2. 要求 AI 使用中文输出

**问题**: AI 默认使用英文描述问题,不便于中文团队阅读。

**解决方案**: 在多处提示词中强制要求使用中文输出:

- ✅ 系统提示词开头的 CRITICAL REQUIREMENTS
- ✅ OUTPUT_FORMAT_INSTRUCTIONS 中的语言要求
- ✅ Validator 提示词中要求 reasoning 使用中文

**关键提示词片段**(英文):

```
3. All descriptions and suggestions MUST be in Chinese

**IMPORTANT - Language Requirement**:
- All issue descriptions, suggestions, and explanations MUST be written in Chinese.
- Use clear, professional Chinese to describe problems and provide suggestions.
```

**设计理念**:

- 提示词本身用英文编写,保持 AI 指令的准确性
- 要求 AI 的输出(描述、建议)用中文,方便团队阅读

## 修改的文件

### 1. `src/review/prompts/base.ts`

**修改内容**:

- `buildBaseSystemPrompt()`: 添加 CRITICAL REQUIREMENTS 部分
- `OUTPUT_FORMAT_INSTRUCTIONS`: 添加语言要求说明
- `DIFF_ANALYSIS_INSTRUCTIONS`: 强化只评审修改代码的规则

### 2. `src/review/prompts/specialist.ts`

**修改内容**:

- `buildValidatorPrompt()`: 要求 validator 的 reasoning 使用中文

### 3. `src/review/orchestrator.ts`

**修改内容**:

- Validator 系统提示词: 添加中文要求

## 效果对比

### 修改前

```
Issues:
- Line 45: Variable 'userId' is not validated (这是老代码中已存在的问题)
- Line 52: Missing error handling (这是老代码中已存在的问题)
- Line 78: New function lacks input validation (这是本次新增代码的问题) ✓

Description: The function does not validate input parameters...
```

### 修改后

```
Issues:
- Line 78: New function lacks input validation (只报告本次新增代码的问题) ✓

Description: 该函数未验证输入参数,可能导致安全问题...
Suggestion: 建议在函数开头添加参数验证逻辑...
```

## 预期效果

1. **减少噪音**: 不再报告与本次 PR 无关的旧代码问题
2. **提高相关性**: 只关注本次变更引入的问题
3. **提升可读性**: 使用中文描述,便于团队理解
4. **提高效率**: 减少无关问题的处理时间

## 注意事项

1. **上下文理解**: 虽然不评审旧代码,但 AI 仍会读取上下文以理解变更的影响
2. **依赖分析**: 如果修改影响了其他未修改的代码,AI 会报告这种影响
3. **向后兼容**: 如果本次修改破坏了现有功能,AI 会报告
4. **边界情况**: 对于重构等大范围修改,AI 会适当考虑整体影响

## 测试建议

运行以下命令测试改进效果:

```bash
# 运行 review
npm run dev review /path/to/repo feature-branch main --verbose

# 检查输出:
# 1. 是否只报告了修改行的问题
# 2. 描述和建议是否使用中文
# 3. 是否过滤了旧代码问题
```

## 后续优化方向

1. **增强过滤逻辑**: 在 aggregator 层面进一步过滤旧代码问题
2. **改进 introduced_in_pr 检测**: 更准确地标记问题是否由本次 PR 引入
3. **添加统计指标**: 报告中显示过滤掉了多少旧代码问题
