/**
 * Previous Review Loader
 *
 * Loads and validates previous review JSON files for fix verification.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  PreviousReviewData,
  PreviousIssue,
  ValidatedIssue,
  IssueCategory,
  Severity,
  AgentType,
} from './types.js';

/**
 * Load previous review from JSON file
 *
 * @param filePath - Path to the previous review JSON file
 * @returns PreviousReviewData containing issues to verify
 * @throws Error if file cannot be read or has invalid format
 */
export function loadPreviousReview(filePath: string): PreviousReviewData {
  // Resolve to absolute path
  const absolutePath = resolve(filePath);

  // Check if file exists
  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  // Read file content
  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read file: ${message}`);
  }

  // Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON format: ${message}`);
  }

  // Validate structure
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid review format: expected an object');
  }

  const reviewData = data as Record<string, unknown>;

  // Check for issues array
  if (!reviewData.issues || !Array.isArray(reviewData.issues)) {
    throw new Error('Invalid review format: missing or invalid "issues" array');
  }

  // Extract previous issues (support both RawIssue and ValidatedIssue formats)
  const issues: PreviousIssue[] = [];

  for (const issue of reviewData.issues) {
    if (!isValidIssue(issue)) {
      // Skip invalid issues but log a warning
      console.warn(`Skipping invalid issue: ${JSON.stringify(issue).slice(0, 100)}...`);
      continue;
    }

    // Cast to record to access optional fields from ValidatedIssue
    const issueRecord = issue as unknown as Record<string, unknown>;
    const finalConfidence = issueRecord.final_confidence as number | undefined;

    issues.push({
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category as IssueCategory,
      severity: issue.severity as Severity,
      title: issue.title,
      description: issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence ?? finalConfidence ?? 0.5,
      source_agent: (issue.source_agent as AgentType) ?? 'validator',
    });
  }

  // Extract metadata if available
  const metadata = reviewData.metadata as Record<string, unknown> | undefined;

  return {
    issues,
    source: metadata?.source_ref as string | undefined,
    target: metadata?.target_ref as string | undefined,
  };
}

/**
 * Check if an object is a valid issue
 */
function isValidIssue(obj: unknown): obj is ValidatedIssue | PreviousIssue {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const issue = obj as Record<string, unknown>;

  // Required fields
  if (typeof issue.id !== 'string' || !issue.id) {
    return false;
  }
  if (typeof issue.file !== 'string' || !issue.file) {
    return false;
  }
  if (typeof issue.line_start !== 'number') {
    return false;
  }
  if (typeof issue.line_end !== 'number') {
    return false;
  }
  if (typeof issue.title !== 'string' || !issue.title) {
    return false;
  }
  if (typeof issue.description !== 'string') {
    return false;
  }

  // Validate category
  const validCategories = ['security', 'logic', 'performance', 'style', 'maintainability'];
  if (!validCategories.includes(issue.category as string)) {
    return false;
  }

  // Validate severity
  const validSeverities = ['critical', 'error', 'warning', 'suggestion'];
  if (!validSeverities.includes(issue.severity as string)) {
    return false;
  }

  return true;
}

/**
 * Validate previous review data
 *
 * @param data - Previous review data to validate
 * @throws Error if data is invalid
 */
export function validatePreviousReviewData(data: PreviousReviewData): void {
  if (!data.issues || data.issues.length === 0) {
    throw new Error('Previous review has no issues to verify');
  }

  // Validate each issue has required fields
  for (const issue of data.issues) {
    if (!issue.id) {
      throw new Error(`Issue missing required field 'id': ${JSON.stringify(issue).slice(0, 100)}`);
    }
    if (!issue.file) {
      throw new Error(
        `Issue ${issue.id} missing required field 'file': ${JSON.stringify(issue).slice(0, 100)}`
      );
    }
    if (!issue.title) {
      throw new Error(
        `Issue ${issue.id} missing required field 'title': ${JSON.stringify(issue).slice(0, 100)}`
      );
    }
  }
}

/**
 * Filter issues by severity for verification
 *
 * @param data - Previous review data
 * @param severities - Severity levels to include
 * @returns Filtered previous review data
 */
export function filterIssuesBySeverity(
  data: PreviousReviewData,
  severities: Severity[]
): PreviousReviewData {
  return {
    ...data,
    issues: data.issues.filter((issue) => severities.includes(issue.severity)),
  };
}

/**
 * Get summary of previous review issues
 *
 * @param data - Previous review data
 * @returns Summary object with counts
 */
export function getPreviousReviewSummary(data: PreviousReviewData): {
  total: number;
  bySeverity: Record<Severity, number>;
  byCategory: Record<IssueCategory, number>;
} {
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

  for (const issue of data.issues) {
    bySeverity[issue.severity]++;
    byCategory[issue.category]++;
  }

  return {
    total: data.issues.length,
    bySeverity,
    byCategory,
  };
}
