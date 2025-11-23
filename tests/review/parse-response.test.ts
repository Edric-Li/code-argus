import { describe, it, expect } from 'vitest';
import { parseAgentResponse } from '../../src/review/prompts/base.js';

describe('parseAgentResponse', () => {
  it('should parse valid JSON response', () => {
    const response = JSON.stringify({
      issues: [
        {
          id: 'sec-001',
          file: 'src/test.ts',
          line_start: 10,
          line_end: 15,
          category: 'security',
          severity: 'warning',
          title: 'Test Issue',
          description: 'Test description',
          confidence: 0.8,
        },
      ],
      checklist: [
        {
          id: 'check-001',
          category: 'security',
          question: 'Is input validated?',
          result: 'pass',
          details: 'Input is validated',
          related_issues: [],
        },
      ],
    });

    const result = parseAgentResponse(response);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe('sec-001');
    expect(result.checklist).toHaveLength(1);
    expect(result.checklist[0].id).toBe('check-001');
  });

  it('should extract JSON from markdown code blocks', () => {
    const response = `Here is my analysis:

\`\`\`json
{
  "issues": [
    {
      "id": "perf-001",
      "file": "src/app.ts",
      "line_start": 20,
      "line_end": 25,
      "category": "performance",
      "severity": "warning",
      "title": "Performance issue",
      "description": "This is slow",
      "confidence": 0.7
    }
  ],
  "checklist": []
}
\`\`\``;

    const result = parseAgentResponse(response);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe('perf-001');
  });

  it('should handle truncated JSON with unterminated string', () => {
    // Simulate a truncated response where a string is cut off mid-sentence
    // Using regular string concatenation to avoid template literal issues with backticks
    const truncatedResponse =
      '```json\n' +
      '{\n' +
      '  "issues": [\n' +
      '    {\n' +
      '      "id": "perf-001",\n' +
      '      "file": "src/test.ts",\n' +
      '      "line_start": 10,\n' +
      '      "line_end": 15,\n' +
      '      "category": "performance",\n' +
      '      "severity": "warning",\n' +
      '      "title": "使用扩展运算符效率低",\n' +
      '      "description": "在函数中使用Math.max会导致性能问题，当数据量大时会导致堆栈溢出';
    // Note: intentionally truncated - no closing quote, no closing brackets

    // The function should either repair the JSON or extract partial data
    const result = parseAgentResponse(truncatedResponse);

    // At minimum, should not throw and return a valid structure
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('checklist');
  });

  it('should extract complete issues from partially truncated JSON', () => {
    // JSON with one complete issue and one truncated
    const partialResponse = `{
  "issues": [
    {
      "id": "sec-001",
      "file": "src/auth.ts",
      "line_start": 5,
      "line_end": 10,
      "category": "security",
      "severity": "error",
      "title": "SQL Injection",
      "description": "User input is not sanitized",
      "confidence": 0.95
    },
    {
      "id": "sec-002",
      "file": "src/api.ts",
      "line_start": 20,
      "line_end": 25,
      "category": "security",
      "severity": "warning",
      "title": "Incomplete issue",
      "description": "This description is cut off mid-sentence and will cause parsing to`;

    const result = parseAgentResponse(partialResponse);

    // Should extract the first complete issue
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    expect(result.issues[0].id).toBe('sec-001');
    expect(result.issues[0].title).toBe('SQL Injection');
  });

  it('should extract complete checklist items from partial response', () => {
    const partialResponse = `{
  "issues": [],
  "checklist": [
    {
      "id": "check-001",
      "category": "security",
      "question": "Is authentication implemented?",
      "result": "pass",
      "details": "Auth is properly implemented",
      "related_issues": []
    },
    {
      "id": "check-002",
      "category": "logic",
      "question": "Are edge cases handled?",
      "result": "fail",
      "details": "This response got truncated mid`;

    const result = parseAgentResponse(partialResponse);

    expect(result.checklist.length).toBeGreaterThanOrEqual(1);
    expect(result.checklist[0].id).toBe('check-001');
    expect(result.checklist[0].result).toBe('pass');
  });

  it('should handle empty arrays', () => {
    const response = JSON.stringify({
      issues: [],
      checklist: [],
    });

    const result = parseAgentResponse(response);

    expect(result.issues).toHaveLength(0);
    expect(result.checklist).toHaveLength(0);
  });

  it('should handle response without checklist', () => {
    const response = JSON.stringify({
      issues: [
        {
          id: 'log-001',
          file: 'src/test.ts',
          line_start: 1,
          line_end: 5,
          category: 'logic',
          severity: 'error',
          title: 'Logic Error',
          description: 'Bug found',
          confidence: 0.9,
        },
      ],
    });

    const result = parseAgentResponse(response);

    expect(result.issues).toHaveLength(1);
    expect(result.checklist).toHaveLength(0);
  });

  it('should return empty results for completely invalid response', () => {
    const invalidResponse = 'This is not JSON at all, just plain text.';

    const result = parseAgentResponse(invalidResponse);

    expect(result.issues).toHaveLength(0);
    expect(result.checklist).toHaveLength(0);
  });

  it('should handle Chinese text in truncated descriptions', () => {
    // This simulates the actual error case from the bug report
    // Using string concatenation to properly represent a truncated string
    const truncatedChinese =
      '{\n' +
      '  "issues": [\n' +
      '    {\n' +
      '      "id": "perf-001",\n' +
      '      "file": "plugins/component/ant-design/src/components/slider/design-time/AddSliderMarkAction.tsx",\n' +
      '      "line_start": 68,\n' +
      '      "line_end": 68,\n' +
      '      "category": "performance",\n' +
      '      "severity": "warning",\n' +
      '      "title": "使用扩展运算符将 Set 转换为数组效率低下",\n' +
      '      "description": "在 getDefaultValue 函数中，使用 Math.max(...Array.from(occupiedValues)) 将 Set 展开为参数列表可能导致性能问题。当 occupiedValues 中包含大量元素时，对于大型数据集，';
    // Note: intentionally truncated - no closing quote or brackets

    const result = parseAgentResponse(truncatedChinese);

    // Should handle gracefully and not crash
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('checklist');
    expect(Array.isArray(result.issues)).toBe(true);
    expect(Array.isArray(result.checklist)).toBe(true);
  });
});
