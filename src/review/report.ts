/**
 * Report Generator
 *
 * Generates review reports in various formats (JSON, Markdown).
 */

import type {
  ReviewReport,
  ReviewMetrics,
  ValidatedIssue,
  ChecklistItem,
  Severity,
  IssueCategory,
  RiskLevel,
  ReviewContext,
  RawIssue,
  AgentType,
} from './types.js';
import { groupBySeverity } from './aggregator.js';

/**
 * Chinese translations for report elements
 */
const TRANSLATIONS = {
  zh: {
    // Headers
    'Code Review Report': '代码审查报告',
    Summary: '总结',
    'Issues Introduced in This PR': '本次 PR 引入的问题',
    'Pre-existing Issues': '已存在的问题',
    Issues: '问题',
    Checklist: '检查清单',
    Metrics: '指标',
    Metadata: '元数据',

    // Severity levels
    Critical: '严重',
    Errors: '错误',
    Warnings: '警告',
    Suggestions: '建议',

    // Risk levels
    'Risk Level': '风险等级',
    high: '高',
    medium: '中',
    low: '低',
    HIGH: '高',
    MEDIUM: '中',
    LOW: '低',

    // Issue fields
    Field: '字段',
    Value: '值',
    ID: '编号',
    File: '文件',
    Location: '位置',
    Line: '行',
    Lines: '行',
    Severity: '严重程度',
    Category: '分类',
    Confidence: '置信度',
    Agent: '检测代理',
    'Description:': '描述：',
    'Code:': '代码：',
    'Suggestion:': '建议：',
    'Validation Evidence': '验证证据',
    'Checked Files': '已检查文件',
    Reasoning: '推理过程',

    // Categories
    security: '安全',
    logic: '逻辑',
    performance: '性能',
    style: '风格',
    maintainability: '可维护性',

    // Severity values for issue table
    error: '错误',
    warning: '警告',
    suggestion: '建议',

    // Summary parts
    'PR Goal': 'PR 目标',
    'No significant issues found in this review.': '本次审查未发现重大问题。',
    'Issues Found': '发现的问题',
    critical: '严重',
    'error(s)': '个错误',
    'warning(s)': '个警告',
    'suggestion(s)': '个建议',

    // Messages
    'No issues found.': '未发现问题。',
    'These issues exist in the code but were not introduced by this PR.':
      '这些问题存在于代码中,但不是由本次 PR 引入的。',

    // Metrics table
    Metric: '指标',
    'Total Scanned': '总扫描数',
    Confirmed: '已确认',
    Rejected: '已拒绝',
    Uncertain: '不确定',

    // Metadata
    'Review Time': '审查时间',
    'Tokens Used': '使用的令牌数',
    'Agents Used': '使用的代理',

    // Checklist results
    pass: '通过',
    fail: '失败',
    na: '不适用',
  },
} as const;

/**
 * Translate text based on language setting
 */
function translate(text: string, language: 'en' | 'zh'): string {
  if (language === 'en') {
    return text;
  }

  const translation = TRANSLATIONS.zh[text as keyof typeof TRANSLATIONS.zh];
  return translation || text;
}

/**
 * Options for report generation
 */
export interface ReportOptions {
  /** Output format */
  format?: 'json' | 'markdown' | 'summary' | 'pr-comments';
  /** Include checklist in report */
  includeChecklist?: boolean;
  /** Include metadata in report */
  includeMetadata?: boolean;
  /** Include detailed evidence */
  includeEvidence?: boolean;
  /** Output language */
  language?: 'en' | 'zh';
}

/**
 * Structure for PR comment data
 */
export interface PRComment {
  /** Unique issue ID */
  id: string;
  /** File path (relative to repo root) */
  file: string;
  /** Start line number */
  line_start: number;
  /** End line number */
  line_end: number;
  /** Issue severity */
  severity: string;
  /** Issue category */
  category: string;
  /** Short title */
  title: string;
  /** Full description */
  description: string;
  /** Suggestion for fix */
  suggestion?: string;
  /** Code snippet */
  code_snippet?: string;
  /** Confidence score (0-100) */
  confidence: number;
  /** Source agent */
  source_agent: string;
  /** Formatted comment body for PR */
  comment_body: string;
}

const DEFAULT_OPTIONS: Required<ReportOptions> = {
  format: 'markdown',
  includeChecklist: true,
  includeMetadata: true,
  includeEvidence: false,
  language: 'zh',
};

/**
 * Calculate review metrics
 */
export function calculateMetrics(
  rawIssues: RawIssue[],
  validatedIssues: ValidatedIssue[]
): ReviewMetrics {
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    error: 0,
    warning: 0,
    suggestion: 0,
  };

  const byCategory: Record<IssueCategory, number> = {
    security: 0,
    logic: 0,
    performance: 0,
    style: 0,
    maintainability: 0,
  };

  for (const issue of validatedIssues) {
    bySeverity[issue.severity]++;
    byCategory[issue.category]++;
  }

  return {
    total_scanned: rawIssues.length,
    confirmed: validatedIssues.filter((i) => i.validation_status === 'confirmed').length,
    rejected: rawIssues.length - validatedIssues.length,
    uncertain: validatedIssues.filter((i) => i.validation_status === 'uncertain').length,
    by_severity: bySeverity,
    by_category: byCategory,
  };
}

/**
 * Determine overall risk level based on issues
 */
export function determineRiskLevel(issues: ValidatedIssue[]): RiskLevel {
  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const securityCount = issues.filter((i) => i.category === 'security').length;

  // Critical issues or security issues = high risk
  if (criticalCount > 0) return 'high';
  if (securityCount > 0 && errorCount > 0) return 'high';

  // Multiple errors = high risk
  if (errorCount > 2) return 'high';

  // Any errors = medium risk
  if (errorCount > 0) return 'medium';

  // Many warnings = medium risk
  if (issues.length > 5) return 'medium';

  return 'low';
}

/**
 * Generate a text summary of the review
 */
export function generateSummary(
  issues: ValidatedIssue[],
  context?: ReviewContext,
  language: 'en' | 'zh' = 'zh'
): string {
  const bySeverity = groupBySeverity(issues);
  const parts: string[] = [];

  // Intent summary
  if (context?.intent.primary_goal) {
    parts.push(`**${translate('PR Goal', language)}**: ${context.intent.primary_goal}`);
  }

  // Issue count summary
  if (issues.length === 0) {
    parts.push(translate('No significant issues found in this review.', language));
  } else {
    const counts: string[] = [];
    if (bySeverity.critical.length > 0) {
      counts.push(`${bySeverity.critical.length} ${translate('critical', language)}`);
    }
    if (bySeverity.error.length > 0) {
      counts.push(`${bySeverity.error.length} ${translate('error(s)', language)}`);
    }
    if (bySeverity.warning.length > 0) {
      counts.push(`${bySeverity.warning.length} ${translate('warning(s)', language)}`);
    }
    if (bySeverity.suggestion.length > 0) {
      counts.push(`${bySeverity.suggestion.length} ${translate('suggestion(s)', language)}`);
    }

    parts.push(`**${translate('Issues Found', language)}**: ${counts.join(', ')}`);
  }

  // Risk assessment
  const riskLevel = determineRiskLevel(issues);
  const riskEmoji = riskLevel === 'high' ? '🔴' : riskLevel === 'medium' ? '🟡' : '🟢';
  parts.push(
    `**${translate('Risk Level', language)}**: ${riskEmoji} ${translate(riskLevel.toUpperCase(), language)}`
  );

  return parts.join('\n\n');
}

/**
 * Generate the complete review report
 */
export function generateReport(
  issues: ValidatedIssue[],
  checklist: ChecklistItem[],
  metrics: ReviewMetrics,
  context?: ReviewContext,
  metadata?: { review_time_ms: number; tokens_used: number; agents_used: AgentType[] },
  language: 'en' | 'zh' = 'zh'
): ReviewReport {
  return {
    summary: generateSummary(issues, context, language),
    risk_level: determineRiskLevel(issues),
    issues,
    checklist,
    metrics,
    metadata: metadata || {
      review_time_ms: 0,
      tokens_used: 0,
      agents_used: [] as AgentType[],
    },
  };
}

/**
 * Format report as JSON string
 */
export function formatAsJson(report: ReviewReport, options?: ReportOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const output: Partial<ReviewReport> = {
    summary: report.summary,
    risk_level: report.risk_level,
    issues: report.issues,
    metrics: report.metrics,
  };

  if (opts.includeChecklist) {
    output.checklist = report.checklist;
  }

  if (opts.includeMetadata) {
    output.metadata = report.metadata;
  }

  // Remove evidence if not needed
  if (!opts.includeEvidence && output.issues) {
    output.issues = output.issues.map((issue) => {
      const { grounding_evidence: _evidence, ...rest } = issue;
      return rest as ValidatedIssue;
    });
  }

  return JSON.stringify(output, null, 2);
}

/**
 * Format report as Markdown
 */
export function formatAsMarkdown(report: ReviewReport, options?: ReportOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lang = opts.language;
  const lines: string[] = [];

  // Header
  lines.push(`# ${translate('Code Review Report', lang)}`);
  lines.push('');

  // Summary
  lines.push(`## ${translate('Summary', lang)}`);
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  // Issues by severity
  if (report.issues.length > 0) {
    lines.push(`## ${translate('Issues', lang)}`);
    lines.push('');

    const bySeverity = groupBySeverity(report.issues);

    // Critical issues
    if (bySeverity.critical.length > 0) {
      lines.push(`### 🔴 ${translate('Critical', lang)}`);
      lines.push('');
      for (const issue of bySeverity.critical) {
        lines.push(formatIssueMarkdown(issue, opts.includeEvidence, lang));
      }
      lines.push('');
    }

    // Errors
    if (bySeverity.error.length > 0) {
      lines.push(`### 🟠 ${translate('Errors', lang)}`);
      lines.push('');
      for (const issue of bySeverity.error) {
        lines.push(formatIssueMarkdown(issue, opts.includeEvidence, lang));
      }
      lines.push('');
    }

    // Warnings
    if (bySeverity.warning.length > 0) {
      lines.push(`### 🟡 ${translate('Warnings', lang)}`);
      lines.push('');
      for (const issue of bySeverity.warning) {
        lines.push(formatIssueMarkdown(issue, opts.includeEvidence, lang));
      }
      lines.push('');
    }

    // Suggestions
    if (bySeverity.suggestion.length > 0) {
      lines.push(`### 💡 ${translate('Suggestions', lang)}`);
      lines.push('');
      for (const issue of bySeverity.suggestion) {
        lines.push(formatIssueMarkdown(issue, opts.includeEvidence, lang));
      }
      lines.push('');
    }
  } else {
    lines.push(`## ${translate('Issues', lang)}`);
    lines.push('');
    lines.push(translate('No issues found.', lang));
    lines.push('');
  }

  // Checklist
  if (opts.includeChecklist && report.checklist.length > 0) {
    lines.push(`## ${translate('Checklist', lang)}`);
    lines.push('');

    const byCategory = new Map<string, ChecklistItem[]>();
    for (const item of report.checklist) {
      const existing = byCategory.get(item.category) || [];
      existing.push(item);
      byCategory.set(item.category, existing);
    }

    for (const [category, items] of byCategory) {
      lines.push(`### ${capitalizeFirst(translate(category, lang))}`);
      lines.push('');
      for (const item of items) {
        const icon = item.result === 'pass' ? '✅' : item.result === 'fail' ? '❌' : '➖';
        lines.push(`- ${icon} ${item.question}`);
        if (item.details) {
          lines.push(`  - ${item.details}`);
        }
      }
      lines.push('');
    }
  }

  // Metrics
  lines.push(`## ${translate('Metrics', lang)}`);
  lines.push('');
  lines.push(`| ${translate('Metric', lang)} | ${translate('Value', lang)} |`);
  lines.push(`|--------|-------|`);
  lines.push(`| ${translate('Total Scanned', lang)} | ${report.metrics.total_scanned} |`);
  lines.push(`| ${translate('Confirmed', lang)} | ${report.metrics.confirmed} |`);
  lines.push(`| ${translate('Rejected', lang)} | ${report.metrics.rejected} |`);
  lines.push(`| ${translate('Uncertain', lang)} | ${report.metrics.uncertain} |`);
  lines.push('');

  // Metadata
  if (opts.includeMetadata && report.metadata) {
    lines.push(`## ${translate('Metadata', lang)}`);
    lines.push('');
    lines.push(`- **${translate('Review Time', lang)}**: ${report.metadata.review_time_ms}ms`);
    lines.push(`- **${translate('Tokens Used', lang)}**: ${report.metadata.tokens_used}`);
    lines.push(
      `- **${translate('Agents Used', lang)}**: ${report.metadata.agents_used.join(', ')}`
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a single issue as Markdown
 */
function formatIssueMarkdown(
  issue: ValidatedIssue,
  includeEvidence?: boolean,
  language: 'en' | 'zh' = 'zh'
): string {
  const lines: string[] = [];

  // Title with ID
  lines.push(`#### ${issue.title}`);
  lines.push('');

  // Location info (detailed for PR comments)
  const lineRange =
    issue.line_start === issue.line_end
      ? `${translate('Line', language)} ${issue.line_start}`
      : `${translate('Lines', language)} ${issue.line_start}-${issue.line_end}`;
  lines.push(`| ${translate('Field', language)} | ${translate('Value', language)} |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **${translate('ID', language)}** | \`${issue.id}\` |`);
  lines.push(`| **${translate('File', language)}** | \`${issue.file}\` |`);
  lines.push(`| **${translate('Location', language)}** | ${lineRange} |`);
  lines.push(`| **${translate('Severity', language)}** | ${translate(issue.severity, language)} |`);
  lines.push(`| **${translate('Category', language)}** | ${translate(issue.category, language)} |`);
  lines.push(
    `| **${translate('Confidence', language)}** | ${Math.round(issue.final_confidence * 100)}% |`
  );
  lines.push(`| **${translate('Agent', language)}** | ${issue.source_agent} |`);
  lines.push('');

  // Description
  lines.push(`**${translate('Description:', language)}**`);
  lines.push('');
  lines.push(issue.description);
  lines.push('');

  // Code snippet
  if (issue.code_snippet) {
    lines.push(`**${translate('Code:', language)}**`);
    lines.push('```');
    lines.push(issue.code_snippet);
    lines.push('```');
    lines.push('');
  }

  // Suggestion
  if (issue.suggestion) {
    lines.push(`**${translate('Suggestion:', language)}**`);
    lines.push('');
    lines.push(issue.suggestion);
    lines.push('');
  }

  // Evidence
  if (includeEvidence && issue.grounding_evidence) {
    lines.push('<details>');
    lines.push(`<summary>${translate('Validation Evidence', language)}</summary>`);
    lines.push('');
    lines.push(
      `**${translate('Checked Files', language)}**: ${issue.grounding_evidence.checked_files.join(', ')}`
    );
    lines.push('');
    lines.push(`**${translate('Reasoning', language)}**: ${issue.grounding_evidence.reasoning}`);
    lines.push('</details>');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a short summary (for CLI output)
 */
export function formatAsSummary(report: ReviewReport): string {
  const lines: string[] = [];

  // Risk level banner
  const riskEmoji =
    report.risk_level === 'high' ? '🔴' : report.risk_level === 'medium' ? '🟡' : '🟢';
  lines.push(`${riskEmoji} Risk Level: ${report.risk_level.toUpperCase()}`);
  lines.push('');

  // Issue counts
  const bySeverity = groupBySeverity(report.issues);
  lines.push('Issues:');
  lines.push(`  Critical: ${bySeverity.critical.length}`);
  lines.push(`  Errors:   ${bySeverity.error.length}`);
  lines.push(`  Warnings: ${bySeverity.warning.length}`);
  lines.push(`  Suggest:  ${bySeverity.suggestion.length}`);
  lines.push('');

  // Top issues (if any)
  const topIssues = report.issues.slice(0, 3);
  if (topIssues.length > 0) {
    lines.push('Top Issues:');
    for (const issue of topIssues) {
      const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'error' ? '🟠' : '🟡';
      lines.push(`  ${icon} ${issue.file}:${issue.line_start} - ${issue.title}`);
    }
    lines.push('');
  }

  // Metrics
  lines.push(
    `Scanned: ${report.metrics.total_scanned} | Confirmed: ${report.metrics.confirmed} | Rejected: ${report.metrics.rejected}`
  );

  return lines.join('\n');
}

/**
 * Format issues as PR comments data
 * Returns a JSON array of PRComment objects ready for PR integration
 */
export function formatAsPRComments(report: ReviewReport): string {
  const comments: PRComment[] = report.issues.map((issue) => {
    // Build comment body in markdown format
    const severityIcon =
      issue.severity === 'critical'
        ? '🔴'
        : issue.severity === 'error'
          ? '🟠'
          : issue.severity === 'warning'
            ? '🟡'
            : '💡';

    const bodyLines: string[] = [];
    bodyLines.push(`## ${severityIcon} ${issue.title}`);
    bodyLines.push('');
    bodyLines.push(
      `**Severity:** ${issue.severity} | **Category:** ${issue.category} | **Confidence:** ${Math.round(issue.final_confidence * 100)}%`
    );
    bodyLines.push('');
    bodyLines.push(issue.description);

    if (issue.code_snippet) {
      bodyLines.push('');
      bodyLines.push('```');
      bodyLines.push(issue.code_snippet);
      bodyLines.push('```');
    }

    if (issue.suggestion) {
      bodyLines.push('');
      bodyLines.push('**Suggestion:**');
      bodyLines.push(issue.suggestion);
    }

    bodyLines.push('');
    bodyLines.push(`---`);
    bodyLines.push(`*Issue ID: ${issue.id} | Agent: ${issue.source_agent}*`);

    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      severity: issue.severity,
      category: issue.category,
      title: issue.title,
      description: issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: Math.round(issue.final_confidence * 100),
      source_agent: issue.source_agent,
      comment_body: bodyLines.join('\n'),
    };
  });

  return JSON.stringify(
    {
      summary: {
        risk_level: report.risk_level,
        total_issues: report.issues.length,
        by_severity: {
          critical: report.issues.filter((i) => i.severity === 'critical').length,
          error: report.issues.filter((i) => i.severity === 'error').length,
          warning: report.issues.filter((i) => i.severity === 'warning').length,
          suggestion: report.issues.filter((i) => i.severity === 'suggestion').length,
        },
      },
      comments,
    },
    null,
    2
  );
}

/**
 * Format report based on options
 */
export function formatReport(report: ReviewReport, options?: ReportOptions): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  switch (opts.format) {
    case 'json':
      return formatAsJson(report, opts);
    case 'markdown':
      return formatAsMarkdown(report, opts);
    case 'summary':
      return formatAsSummary(report);
    case 'pr-comments':
      return formatAsPRComments(report);
    default:
      return formatAsMarkdown(report, opts);
  }
}

/**
 * Helper: capitalize first letter
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
