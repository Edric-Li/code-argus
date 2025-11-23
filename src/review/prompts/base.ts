/**
 * Base Prompt Components
 *
 * Common prompt fragments used across all review agents.
 */

import type { Severity, IssueCategory, RawIssue, ChecklistItem } from '../types.js';

// ============================================================================
// JSON Schemas for Agent Output
// ============================================================================

/**
 * JSON Schema for RawIssue output
 */
export const RAW_ISSUE_SCHEMA = `{
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
}`;

/**
 * JSON Schema for ChecklistItem output
 */
export const CHECKLIST_ITEM_SCHEMA = `{
  "id": "string",
  "category": "security | logic | performance | style | maintainability",
  "question": "string",
  "result": "pass | fail | na",
  "details": "string (optional)",
  "related_issues": ["string (issue ids)"]
}`;

/**
 * JSON Schema for complete agent output (string template for prompts)
 */
export const AGENT_OUTPUT_SCHEMA = `{
  "issues": [${RAW_ISSUE_SCHEMA}],
  "checklist": [${CHECKLIST_ITEM_SCHEMA}]
}`;

/**
 * Proper JSON Schema object for SDK structured output
 */
export const AGENT_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique identifier, e.g., sec-001' },
          file: { type: 'string', description: 'File path' },
          line_start: { type: 'number', description: 'Starting line number' },
          line_end: { type: 'number', description: 'Ending line number' },
          category: {
            type: 'string',
            enum: ['security', 'logic', 'performance', 'style', 'maintainability'],
          },
          severity: {
            type: 'string',
            enum: ['critical', 'error', 'warning', 'suggestion'],
          },
          title: { type: 'string', description: 'Short title, max 80 chars' },
          description: { type: 'string', description: 'Detailed description' },
          suggestion: { type: 'string', description: 'Fix suggestion' },
          code_snippet: { type: 'string', description: 'Relevant code' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: [
          'id',
          'file',
          'line_start',
          'line_end',
          'category',
          'severity',
          'title',
          'description',
          'confidence',
        ],
      },
    },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: {
            type: 'string',
            enum: ['security', 'logic', 'performance', 'style', 'maintainability'],
          },
          question: { type: 'string' },
          result: {
            type: 'string',
            enum: ['pass', 'fail', 'na'],
          },
          details: { type: 'string' },
          related_issues: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['id', 'category', 'question', 'result'],
      },
    },
  },
  required: ['issues', 'checklist'],
};

// ============================================================================
// Common Instructions
// ============================================================================

/**
 * Instructions for using tools effectively
 */
export const TOOL_USAGE_INSTRUCTIONS = `
## Tool Usage Guidelines

You have access to the following tools:
- **Read**: Read file contents. Use this to understand the full context, not just the diff.
- **Grep**: Search for patterns in the codebase. Use this to find related code.
- **Glob**: Find files matching a pattern. Use this to locate relevant files.
- **Bash**: Run shell commands. Use this sparingly, mainly for running lint tools.

**Important**:
1. Always use Read to get full file context before making judgments about issues.
2. Don't assume - verify by reading the actual code.
3. Search for related code (implementations, tests, usages) when needed.
`;

/**
 * Instructions for output format
 */
export const OUTPUT_FORMAT_INSTRUCTIONS = `
## Output Format

**IMPORTANT - Language Requirement**:
- All issue descriptions, suggestions, and explanations MUST be written in Chinese.
- Use clear, professional Chinese to describe problems and provide suggestions.

You must output your findings as valid JSON with this structure:

\`\`\`json
${AGENT_OUTPUT_SCHEMA}
\`\`\`

**Guidelines**:
- Each issue must have a unique ID (e.g., "sec-001", "logic-002")
- Confidence should reflect how sure you are: 0.9+ for certain, 0.7-0.9 for likely, below 0.7 for uncertain
- Severity levels:
  - \`critical\`: Security vulnerabilities, data loss risks, crashes
  - \`error\`: Bugs that will cause incorrect behavior
  - \`warning\`: Potential issues, code smells, minor bugs
  - \`suggestion\`: Improvements, style issues, best practices
- Always provide actionable suggestions for fixes in Chinese
- Write all descriptions and suggestions in Chinese
`;

/**
 * Instructions for handling diffs
 */
export const DIFF_ANALYSIS_INSTRUCTIONS = `
## Analyzing Diffs

When reviewing code changes:

1. **Focus ONLY on Changed Code**: Review ONLY the lines that were added (marked with \`+\`) or modified. Do NOT review unchanged/existing code.
2. **Consider Context**: Changes might affect surrounding unchanged code - only report issues if the CHANGE itself introduces the problem.
3. **Check Dependencies**: Modified functions may impact their callers - but only report if the modification breaks existing functionality.
4. **Verify Assumptions**: Use Read tool to see the full file, not just the diff.

**Diff Format**:
- Lines starting with \`+\` are additions (REVIEW THESE)
- Lines starting with \`-\` are deletions (REVIEW THESE)
- Lines without prefix are context (DO NOT REVIEW THESE - they are unchanged old code)

**CRITICAL RULE**: Only report issues that are introduced BY THIS CHANGE. Do not report pre-existing issues in unchanged code.
`;

// ============================================================================
// Checklist Definitions
// ============================================================================

/**
 * Common checklist items that all agents should consider
 */
export const COMMON_CHECKLIST: Array<{ id: string; category: IssueCategory; question: string }> = [
  { id: 'common-01', category: 'logic', question: 'Are there unhandled errors or exceptions?' },
  {
    id: 'common-02',
    category: 'security',
    question: 'Is there any hardcoded sensitive information?',
  },
  {
    id: 'common-03',
    category: 'logic',
    question: 'Are there potential null/undefined access issues?',
  },
  {
    id: 'common-04',
    category: 'logic',
    question: 'Are resources properly released (connections, file handles)?',
  },
  {
    id: 'common-05',
    category: 'maintainability',
    question: 'Is the code backward compatible with existing APIs?',
  },
  { id: 'common-06', category: 'security', question: 'Is input validation sufficient?' },
  { id: 'common-07', category: 'maintainability', question: 'Is logging/monitoring adequate?' },
];

// ============================================================================
// Prompt Builders
// ============================================================================

/**
 * Build the base system prompt for all agents
 */
export function buildBaseSystemPrompt(agentRole: string): string {
  return `You are an expert code reviewer specializing in ${agentRole}.

Your task is to analyze code changes and identify issues within your specialty area.

**CRITICAL REQUIREMENTS**:
1. ONLY review changed code (lines marked with + or -)
2. NEVER review unchanged existing code (context lines)
3. All descriptions and suggestions MUST be in Chinese

${TOOL_USAGE_INSTRUCTIONS}

${DIFF_ANALYSIS_INSTRUCTIONS}

${OUTPUT_FORMAT_INSTRUCTIONS}
`;
}

/**
 * Build the context section of the prompt
 */
export function buildContextSection(params: {
  diff: string;
  intent?: string;
  standards?: string;
  fileAnalyses?: string;
}): string {
  const sections: string[] = [];

  if (params.intent) {
    sections.push('## PR Intent\n');
    sections.push(params.intent);
    sections.push('');
  }

  if (params.standards) {
    sections.push(params.standards);
    sections.push('');
  }

  if (params.fileAnalyses) {
    sections.push('## File Change Analysis\n');
    sections.push(params.fileAnalyses);
    sections.push('');
  }

  sections.push('## Code Changes (Diff)\n');
  sections.push('```diff');
  sections.push(params.diff);
  sections.push('```');

  return sections.join('\n');
}

/**
 * Build checklist prompt section
 */
export function buildChecklistSection(items: Array<{ id: string; question: string }>): string {
  const lines = ['## Required Checklist\n'];
  lines.push('You must evaluate each of these items and include results in your output:\n');

  for (const item of items) {
    lines.push(`- [ ] ${item.id}: ${item.question}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse agent JSON response
 */
export function parseAgentResponse(response: string): {
  issues: RawIssue[];
  checklist: ChecklistItem[];
} {
  // Extract JSON from response (might be wrapped in markdown code blocks)
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch?.[1] ?? response;

  try {
    const parsed = JSON.parse(jsonStr.trim()) as {
      issues?: RawIssue[];
      checklist?: ChecklistItem[];
    };

    return {
      issues: parsed.issues ?? [],
      checklist: parsed.checklist ?? [],
    };
  } catch (error) {
    // Try to extract partial data
    console.error('Failed to parse agent response as JSON');
    console.error('Error details:', error instanceof Error ? error.message : String(error));
    console.error('Response length:', response.length);
    console.error('First 500 chars of response:', response.substring(0, 500));
    console.error(
      'Last 500 chars of response:',
      response.substring(Math.max(0, response.length - 500))
    );
    return { issues: [], checklist: [] };
  }
}

/**
 * Validate severity value
 */
export function isValidSeverity(value: string): value is Severity {
  return ['critical', 'error', 'warning', 'suggestion'].includes(value);
}

/**
 * Validate category value
 */
export function isValidCategory(value: string): value is IssueCategory {
  return ['security', 'logic', 'performance', 'style', 'maintainability'].includes(value);
}

/**
 * Generate unique issue ID
 */
export function generateIssueId(category: IssueCategory, index: number): string {
  const prefix = {
    security: 'sec',
    logic: 'log',
    performance: 'perf',
    style: 'sty',
    maintainability: 'maint',
  }[category];

  return `${prefix}-${String(index).padStart(3, '0')}`;
}
