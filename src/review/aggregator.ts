/**
 * Issue Aggregator
 *
 * Handles filtering and sorting of validated issues.
 * Note: Deduplication is now handled by the LLM-based deduplicator.
 */

import type {
  ValidatedIssue,
  ChecklistItem,
  Severity,
  IssueCategory,
  ChecklistResult,
} from './types.js';

/**
 * Options for aggregation
 */
export interface AggregationOptions {
  /** Include rejected issues in output (default: false) */
  includeRejected?: boolean;
  /** Include uncertain issues in output (default: true) */
  includeUncertain?: boolean;
  /** Minimum confidence threshold (0-1, default: 0) */
  minConfidence?: number;
  /** Sort order (default: severity-first) */
  sortBy?: 'severity' | 'confidence' | 'file' | 'category';
}

/**
 * Result of aggregation
 */
export interface AggregationResult {
  /** Aggregated issues */
  issues: ValidatedIssue[];
  /** Aggregated checklist */
  checklist: ChecklistItem[];
  /** Statistics about the aggregation */
  stats: {
    /** Total issues before aggregation */
    total_input: number;
    /** Issues after filtering */
    after_filter: number;
    /** Rejected issues filtered */
    rejected_filtered: number;
  };
}

const DEFAULT_OPTIONS: Required<AggregationOptions> = {
  includeRejected: false,
  includeUncertain: true,
  minConfidence: 0,
  sortBy: 'severity',
};

/**
 * Severity order for sorting (lower = more severe)
 */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  suggestion: 3,
};

/**
 * Aggregate and process validated issues
 * Note: Issues are already deduplicated by the LLM-based deduplicator
 */
export function aggregateIssues(
  issues: ValidatedIssue[],
  options?: AggregationOptions
): ValidatedIssue[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Step 1: Filter by validation status
  let filtered = issues.filter((issue) => {
    if (issue.validation_status === 'rejected' && !opts.includeRejected) {
      return false;
    }
    if (issue.validation_status === 'uncertain' && !opts.includeUncertain) {
      return false;
    }
    return true;
  });

  // Step 2: Filter by confidence
  if (opts.minConfidence > 0) {
    filtered = filtered.filter((issue) => issue.final_confidence >= opts.minConfidence);
  }

  // Step 3: Sort
  return sortIssues(filtered, opts.sortBy);
}

/**
 * Full aggregation with statistics
 * Note: Issues are already deduplicated by the LLM-based deduplicator
 */
export function aggregate(
  issues: ValidatedIssue[],
  checklists: ChecklistItem[],
  options?: AggregationOptions
): AggregationResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const totalInput = issues.length;

  // Step 1: Filter by validation status
  const rejectedCount = issues.filter((i) => i.validation_status === 'rejected').length;

  let filtered = issues.filter((issue) => {
    if (issue.validation_status === 'rejected' && !opts.includeRejected) {
      return false;
    }
    if (issue.validation_status === 'uncertain' && !opts.includeUncertain) {
      return false;
    }
    return true;
  });

  // Step 2: Filter by confidence
  if (opts.minConfidence > 0) {
    filtered = filtered.filter((issue) => issue.final_confidence >= opts.minConfidence);
  }

  const afterFilter = filtered.length;

  // Step 3: Sort
  const sorted = sortIssues(filtered, opts.sortBy);

  // Step 4: Aggregate checklists
  const aggregatedChecklist = aggregateChecklists(checklists);

  return {
    issues: sorted,
    checklist: aggregatedChecklist,
    stats: {
      total_input: totalInput,
      after_filter: afterFilter,
      rejected_filtered: opts.includeRejected ? 0 : rejectedCount,
    },
  };
}

/**
 * Sort issues by specified criteria
 */
function sortIssues(
  issues: ValidatedIssue[],
  sortBy: AggregationOptions['sortBy']
): ValidatedIssue[] {
  return [...issues].sort((a, b) => {
    switch (sortBy) {
      case 'severity': {
        // Primary: severity, Secondary: confidence (desc)
        const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (severityDiff !== 0) return severityDiff;
        return b.final_confidence - a.final_confidence;
      }

      case 'confidence': {
        // Primary: confidence (desc), Secondary: severity
        const confDiff = b.final_confidence - a.final_confidence;
        if (confDiff !== 0) return confDiff;
        return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      }

      case 'file': {
        // Primary: file path, Secondary: line number
        const fileDiff = a.file.localeCompare(b.file);
        if (fileDiff !== 0) return fileDiff;
        return a.line_start - b.line_start;
      }

      case 'category': {
        // Primary: category, Secondary: severity
        const catDiff = a.category.localeCompare(b.category);
        if (catDiff !== 0) return catDiff;
        return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      }

      default:
        return 0;
    }
  });
}

/**
 * Aggregate checklists from multiple agents
 */
function aggregateChecklists(checklists: ChecklistItem[]): ChecklistItem[] {
  // Deduplicate by ID, keeping the most informative result
  const seen = new Map<string, ChecklistItem>();

  for (const item of checklists) {
    const existing = seen.get(item.id);

    if (!existing) {
      seen.set(item.id, item);
      continue;
    }

    // Priority: fail > pass > na
    const resultPriority: Record<ChecklistResult, number> = {
      fail: 0,
      pass: 1,
      na: 2,
    };

    if (resultPriority[item.result] < resultPriority[existing.result]) {
      // Merge related issues
      const mergedIssues = new Set([
        ...(existing.related_issues || []),
        ...(item.related_issues || []),
      ]);

      seen.set(item.id, {
        ...item,
        related_issues: mergedIssues.size > 0 ? Array.from(mergedIssues) : undefined,
        details: item.details || existing.details,
      });
    }
  }

  // Sort by category, then by ID
  return Array.from(seen.values()).sort((a, b) => {
    const catDiff = a.category.localeCompare(b.category);
    if (catDiff !== 0) return catDiff;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Group issues by category
 */
export function groupByCategory(issues: ValidatedIssue[]): Record<IssueCategory, ValidatedIssue[]> {
  const groups: Record<IssueCategory, ValidatedIssue[]> = {
    security: [],
    logic: [],
    performance: [],
    style: [],
    maintainability: [],
  };

  for (const issue of issues) {
    groups[issue.category].push(issue);
  }

  return groups;
}

/**
 * Group issues by file
 */
export function groupByFile(issues: ValidatedIssue[]): Map<string, ValidatedIssue[]> {
  const groups = new Map<string, ValidatedIssue[]>();

  for (const issue of issues) {
    const existing = groups.get(issue.file) || [];
    existing.push(issue);
    groups.set(issue.file, existing);
  }

  return groups;
}

/**
 * Group issues by severity
 */
export function groupBySeverity(issues: ValidatedIssue[]): Record<Severity, ValidatedIssue[]> {
  const groups: Record<Severity, ValidatedIssue[]> = {
    critical: [],
    error: [],
    warning: [],
    suggestion: [],
  };

  for (const issue of issues) {
    groups[issue.severity].push(issue);
  }

  return groups;
}
