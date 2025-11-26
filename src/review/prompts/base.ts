/**
 * Base Prompt Components
 *
 * Common prompt fragments used across all review agents.
 */

import type { Severity, IssueCategory, RawIssue, ChecklistItem } from '../types.js';
import {
  loadToolUsageTemplate,
  loadOutputFormatTemplate,
  loadDiffAnalysisTemplate,
} from './template-loader.js';

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
// Common Instructions (loaded from templates)
// ============================================================================

/**
 * Instructions for using tools effectively
 * @returns Tool usage instructions from template
 */
export function getToolUsageInstructions(): string {
  return loadToolUsageTemplate();
}

/**
 * Instructions for output format
 * @returns Output format instructions from template
 */
export function getOutputFormatInstructions(): string {
  return loadOutputFormatTemplate();
}

/**
 * Instructions for handling diffs
 * @returns Diff analysis instructions from template
 */
export function getDiffAnalysisInstructions(): string {
  return loadDiffAnalysisTemplate();
}

// Legacy exports for backward compatibility
export const TOOL_USAGE_INSTRUCTIONS = loadToolUsageTemplate();
export const OUTPUT_FORMAT_INSTRUCTIONS = loadOutputFormatTemplate();
export const DIFF_ANALYSIS_INSTRUCTIONS = loadDiffAnalysisTemplate();

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
4. Be efficient - directly analyze the diff and output findings

${getToolUsageInstructions()}

${getDiffAnalysisInstructions()}

${getOutputFormatInstructions()}
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
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects
 */
function repairTruncatedJson(jsonStr: string): string {
  let repaired = jsonStr.trim();

  // Track open brackets and braces
  let inString = false;
  let escapeNext = false;
  const stack: string[] = [];

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') {
          stack.pop();
        }
      } else if (char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') {
          stack.pop();
        }
      }
    }
  }

  // If we're in a string, close it
  if (inString) {
    // Find the last complete value before truncation
    // Try to truncate at the last complete field
    const lastCompleteComma = repaired.lastIndexOf('",');
    const lastCompleteColon = repaired.lastIndexOf('": ');

    if (lastCompleteComma > lastCompleteColon && lastCompleteComma > 0) {
      // Truncate after the last complete field
      repaired = repaired.substring(0, lastCompleteComma + 1);
      // Recalculate stack after truncation
      inString = false;
      stack.length = 0;
      for (let i = 0; i < repaired.length; i++) {
        const char = repaired[i];
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\' && inString) {
          escapeNext = true;
          continue;
        }
        if (char === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{' || char === '[') {
            stack.push(char);
          } else if (char === '}' && stack.length > 0 && stack[stack.length - 1] === '{') {
            stack.pop();
          } else if (char === ']' && stack.length > 0 && stack[stack.length - 1] === '[') {
            stack.pop();
          }
        }
      }
    } else {
      // Just close the string with a placeholder
      repaired += '..."';
    }
  }

  // Close any remaining open brackets/braces in reverse order
  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') {
      repaired += '}';
    } else if (open === '[') {
      repaired += ']';
    }
  }

  return repaired;
}

/**
 * Extract individual issue objects from a potentially truncated JSON array
 */
function extractPartialIssues(jsonStr: string): RawIssue[] {
  const issues: RawIssue[] = [];

  // Find the issues array
  const issuesMatch = jsonStr.match(/"issues"\s*:\s*\[/);
  if (!issuesMatch || issuesMatch.index === undefined) {
    return issues;
  }

  const startIdx = issuesMatch.index + issuesMatch[0].length;

  // Try to extract individual issue objects
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (depth === 0) {
          objectStart = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && objectStart !== -1) {
          // Found a complete object
          const objectStr = jsonStr.substring(objectStart, i + 1);
          try {
            const issue = JSON.parse(objectStr) as RawIssue;
            if (issue.id && issue.file && issue.category) {
              issues.push(issue);
            }
          } catch {
            // Skip malformed objects
          }
          objectStart = -1;
        }
      } else if (char === ']' && depth === 0) {
        // End of issues array
        break;
      }
    }
  }

  return issues;
}

/**
 * Extract individual checklist items from a potentially truncated JSON array
 */
function extractPartialChecklist(jsonStr: string): ChecklistItem[] {
  const checklist: ChecklistItem[] = [];

  // Find the checklist array
  const checklistMatch = jsonStr.match(/"checklist"\s*:\s*\[/);
  if (!checklistMatch || checklistMatch.index === undefined) {
    return checklist;
  }

  const startIdx = checklistMatch.index + checklistMatch[0].length;

  // Try to extract individual checklist objects
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (depth === 0) {
          objectStart = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && objectStart !== -1) {
          // Found a complete object
          const objectStr = jsonStr.substring(objectStart, i + 1);
          try {
            const item = JSON.parse(objectStr) as ChecklistItem;
            if (item.id && item.category && item.question && item.result) {
              checklist.push(item);
            }
          } catch {
            // Skip malformed objects
          }
          objectStart = -1;
        }
      } else if (char === ']' && depth === 0) {
        // End of checklist array
        break;
      }
    }
  }

  return checklist;
}

/**
 * Parse agent JSON response with support for truncated responses
 */
export function parseAgentResponse(response: string): {
  issues: RawIssue[];
  checklist: ChecklistItem[];
} {
  // Extract JSON from response (might be wrapped in markdown code blocks)
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch?.[1] ?? response;

  // First, try to parse as-is
  try {
    const parsed = JSON.parse(jsonStr.trim()) as {
      issues?: RawIssue[];
      checklist?: ChecklistItem[];
    };

    return {
      issues: parsed.issues ?? [],
      checklist: parsed.checklist ?? [],
    };
  } catch (firstError) {
    // Try to repair truncated JSON
    const repaired = repairTruncatedJson(jsonStr);

    try {
      const parsed = JSON.parse(repaired) as {
        issues?: RawIssue[];
        checklist?: ChecklistItem[];
      };

      console.warn('Successfully parsed repaired JSON (response was truncated)');
      return {
        issues: parsed.issues ?? [],
        checklist: parsed.checklist ?? [],
      };
    } catch {
      // Fall back to extracting partial data
      console.warn('JSON repair failed, extracting partial data from truncated response');
      console.warn(
        'Original error:',
        firstError instanceof Error ? firstError.message : String(firstError)
      );

      const issues = extractPartialIssues(jsonStr);
      const checklist = extractPartialChecklist(jsonStr);

      if (issues.length > 0 || checklist.length > 0) {
        console.warn(`Extracted ${issues.length} issues and ${checklist.length} checklist items`);
        return { issues, checklist };
      }

      // Complete failure
      console.error('Failed to parse agent response as JSON');
      console.error(
        'Error details:',
        firstError instanceof Error ? firstError.message : String(firstError)
      );
      console.error('Response length:', response.length);
      console.error('First 500 chars of response:', response.substring(0, 500));
      console.error(
        'Last 500 chars of response:',
        response.substring(Math.max(0, response.length - 500))
      );
      return { issues: [], checklist: [] };
    }
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
