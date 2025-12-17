## Output Format

**IMPORTANT - Language Requirement**:

- All issue descriptions, suggestions, and explanations MUST be written in Chinese.
- Use clear, professional Chinese to describe problems and provide suggestions.

You must output your findings as valid JSON with this structure:

```json
{
  "issues": [
    {
      "id": "string (unique identifier, e.g., 'sec-001')",
      "file": "string (file path)",
      "line_start": "number",
      "line_end": "number",
      "category": "security | logic | performance | style | maintainability",
      "severity": "critical | error | warning | suggestion",
      "title": "string (short title, max 80 chars)",
      "description": "string (detailed description, see format below)",
      "suggestion": "string (optional, fix suggestion with code example)",
      "code_snippet": "string (optional, relevant code)",
      "confidence": "number (0-1, how confident you are)"
    }
  ],
  "checklist": [
    {
      "id": "string",
      "category": "security | logic | performance | style | maintainability",
      "question": "string",
      "result": "pass | fail | na",
      "details": "string (optional)",
      "related_issues": ["string (issue ids)"]
    }
  ]
}
```

**Description 写作要求（非常重要）**:

你的 description 必须让开发者一看就懂，遵循以下结构：

1. **问题是什么**（第一句）：简明扼要说明代码哪里有问题
2. **为什么是问题**（第二句）：解释技术原因，为什么这样写不对
3. **会造成什么后果**（第三句）：说明如果不修复会有什么影响

示例（好的 description）：

```
"description": "`user` 对象在使用前没有进行空值检查。当 `findUser()` 返回 null 时，访问 `user.name` 会抛出 TypeError 导致程序崩溃。这会影响所有查询不存在用户的场景，用户会看到 500 错误页面。"
```

示例（不好的 description）：

```
"description": "可能存在空指针异常。"  // 太简略，没说清楚什么情况下会出问题
```

**Suggestion 写作要求**:

- 必须具体可操作，不要泛泛而谈
- 尽量给出修复后的代码示例
- 如果有多种修复方式，说明推荐哪种及原因

示例（好的 suggestion）：

```
"suggestion": "在访问 user 属性前添加空值检查。推荐使用可选链操作符：`const name = user?.name ?? '未知用户';` 或者提前返回：`if (!user) return null;`"
```

示例（不好的 suggestion）：

```
"suggestion": "添加空值检查"  // 太模糊，开发者不知道具体怎么改
```

**Guidelines**:

- Each issue must have a unique ID (e.g., "sec-001", "logic-002")
- Confidence should reflect how sure you are: 0.9+ for certain, 0.7-0.9 for likely, below 0.7 for uncertain
- Severity levels:
  - `critical`: Security vulnerabilities, data loss risks, crashes
  - `error`: Bugs that will cause incorrect behavior
  - `warning`: Potential issues, code smells, minor bugs
  - `suggestion`: Improvements, style issues, best practices
- Always provide actionable suggestions for fixes in Chinese
- Write all descriptions and suggestions in Chinese
