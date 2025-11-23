/**
 * Intent Analysis Types
 * Types for commit-based intent recognition
 */

/**
 * Raw commit information from git log
 */
export interface RawCommit {
  /** Commit hash */
  hash: string;
  /** Full commit message */
  message: string;
  /** First line of commit message */
  subject: string;
  /** Rest of commit message (after first line) */
  body?: string;
  /** Author name */
  author: string;
  /** Commit date (ISO format) */
  date: string;
}

/**
 * Reason for excluding a commit
 */
export type ExcludeReason = 'revert' | 'vague' | 'merge' | 'empty';

/**
 * Commit after filtering
 */
export interface FilteredCommit extends RawCommit {
  /** Whether this commit was excluded */
  excluded: boolean;
  /** Reason for exclusion (if excluded) */
  excludeReason?: ExcludeReason;
}

/**
 * Result of commit filtering
 */
export interface CommitFilterResult {
  /** Valid commits for analysis */
  valid: RawCommit[];
  /** Excluded commits with reasons */
  excluded: FilteredCommit[];
  /** Statistics */
  stats: {
    total: number;
    valid: number;
    reverts: number;
    vague: number;
    merges: number;
    empty: number;
  };
}

/**
 * Change category detected from commits
 */
export type ChangeCategory =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'performance'
  | 'style'
  | 'docs'
  | 'test'
  | 'chore'
  | 'security';

/**
 * Confidence level of intent analysis
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Intent analysis result
 */
export interface IntentAnalysis {
  /** ~200 character summary of the intent */
  summary: string;
  /** One-line primary goal */
  primary_goal: string;
  /** Detected change categories */
  change_categories: ChangeCategory[];
  /** Confidence level of the analysis */
  confidence: ConfidenceLevel;
  /** Analysis metadata */
  metadata: {
    total_commits: number;
    valid_commits: number;
    excluded_commits: number;
    tokens_used: number;
  };
}

/**
 * LLM response format for intent analysis
 */
export interface LLMIntentResponse {
  summary: string;
  primary_goal: string;
  change_categories: ChangeCategory[];
  confidence: ConfidenceLevel;
}
