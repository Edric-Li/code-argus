/**
 * MCP Tool: report_issue
 *
 * Allows agents to report discovered code issues in real-time.
 * Each issue is immediately processed for deduplication and queued for validation.
 */

import type { IssueCollector, IssueReport, ReportResult } from '../issue-collector.js';
import type { AgentType } from '../types.js';

/**
 * MCP Tool definition for report_issue
 */
export const REPORT_ISSUE_TOOL_DEFINITION = {
  name: 'report_issue',
  description: `Report a discovered code issue. Call this tool for EACH issue you find during code review.

The issue will be:
1. Checked for duplicates against previously reported issues
2. Queued for validation if not a duplicate
3. Added to the final review report

IMPORTANT:
- Call this tool immediately when you find an issue, don't wait
- Provide accurate file path and line numbers
- Be specific in title and description
- Set confidence based on how certain you are (0.0-1.0)`,
  input_schema: {
    type: 'object' as const,
    properties: {
      file: {
        type: 'string',
        description: 'File path where the issue is located (relative to repo root)',
      },
      line_start: {
        type: 'number',
        description: 'Starting line number of the issue',
      },
      line_end: {
        type: 'number',
        description: 'Ending line number of the issue',
      },
      severity: {
        type: 'string',
        enum: ['critical', 'error', 'warning', 'suggestion'],
        description:
          'Severity level: critical (security/data loss), error (bugs), warning (potential issues), suggestion (improvements)',
      },
      category: {
        type: 'string',
        enum: ['security', 'logic', 'performance', 'style', 'maintainability'],
        description: 'Issue category',
      },
      title: {
        type: 'string',
        description: 'Short title describing the issue (Chinese)',
      },
      description: {
        type: 'string',
        description: 'Detailed description of the issue and why it matters (Chinese)',
      },
      suggestion: {
        type: 'string',
        description: 'Suggested fix or improvement (Chinese, optional)',
      },
      code_snippet: {
        type: 'string',
        description: 'Relevant code snippet (optional)',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence level (0.0-1.0) that this is a real issue',
      },
    },
    required: [
      'file',
      'line_start',
      'line_end',
      'severity',
      'category',
      'title',
      'description',
      'confidence',
    ],
  },
};

/**
 * Input type for report_issue tool
 */
export interface ReportIssueInput {
  file: string;
  line_start: number;
  line_end: number;
  severity: 'critical' | 'error' | 'warning' | 'suggestion';
  category: 'security' | 'logic' | 'performance' | 'style' | 'maintainability';
  title: string;
  description: string;
  suggestion?: string;
  code_snippet?: string;
  confidence: number;
}

/**
 * Create a handler function for the report_issue tool
 *
 * @param collector - The issue collector instance
 * @param agentType - The type of agent calling this tool
 * @returns Handler function that processes tool calls
 */
export function createReportIssueHandler(
  collector: IssueCollector,
  agentType: AgentType
): (input: ReportIssueInput) => Promise<ReportResult> {
  return async (input: ReportIssueInput): Promise<ReportResult> => {
    const report: IssueReport = {
      file: input.file,
      line_start: input.line_start,
      line_end: input.line_end,
      severity: input.severity,
      category: input.category,
      title: input.title,
      description: input.description,
      suggestion: input.suggestion,
      code_snippet: input.code_snippet,
      confidence: input.confidence,
    };

    return collector.reportIssue(report, agentType);
  };
}

/**
 * Format tool result for MCP response
 */
export function formatToolResult(result: ReportResult): string {
  return result.status === 'accepted'
    ? `✓ 问题已接收 (ID: ${result.issue_id})\n正在后台验证...`
    : `✗ 报告失败: ${result.message}`;
}
