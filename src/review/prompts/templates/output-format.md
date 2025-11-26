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
      "description": "string (detailed description)",
      "suggestion": "string (optional, fix suggestion)",
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
