/**
 * Type definitions for Git operations
 */

import type { GitRef, ReviewMode } from './ref.js';

/**
 * Git diff result
 */
export interface DiffResult {
  /** Original diff output from git command */
  diff: string;
  /** Source branch (contains new code) - for backward compatibility */
  sourceBranch: string;
  /** Target branch (merge destination, used as baseline) - for backward compatibility */
  targetBranch: string;
  /** Repository path where diff was executed */
  repoPath: string;
  /** Remote name used for diff (e.g., 'origin') */
  remote: string;
  /** Source reference (branch or commit) */
  sourceRef?: GitRef;
  /** Target reference (branch or commit) */
  targetRef?: GitRef;
  /** Review mode: 'branch' for branch comparison, 'incremental' for commit comparison */
  mode?: ReviewMode;
}

/**
 * Git diff options
 */
export interface DiffOptions {
  /** Repository path */
  repoPath: string;
  /** Source branch (contains new code) */
  sourceBranch: string;
  /** Target branch (merge destination, used as baseline) */
  targetBranch: string;
  /** Remote name to use (defaults to 'origin') */
  remote?: string;
  /** Skip git fetch (useful when fetch was already done) */
  skipFetch?: boolean;
}

/**
 * Git diff options with reference support
 */
export interface DiffByRefsOptions {
  /** Repository path */
  repoPath: string;
  /** Source reference (branch name or commit SHA) */
  sourceRef: string;
  /** Target reference (branch name or commit SHA) */
  targetRef: string;
  /** Remote name to use (defaults to 'origin', only used for branches) */
  remote?: string;
  /** Skip git fetch (useful when fetch was already done, only affects branches) */
  skipFetch?: boolean;
  /**
   * Enable smart merge filtering for incremental mode (default: true)
   * When true, filters out changes introduced by merge commits,
   * only showing actual development changes.
   */
  smartMergeFilter?: boolean;
}

/**
 * Commit information for incremental diff
 */
export interface CommitInfo {
  /** Commit SHA */
  sha: string;
  /** Parent commit SHAs (merge commits have multiple parents) */
  parents: string[];
  /** Whether this is a merge commit */
  isMerge: boolean;
}

/**
 * Result of smart incremental diff
 */
export interface IncrementalDiffResult {
  /** Combined diff content */
  diff: string;
  /** Commits included in the diff */
  commits: CommitInfo[];
  /** Number of merge commits that had conflict resolutions */
  mergeCommitsWithChanges: number;
  /** Total non-merge commits */
  regularCommits: number;
}

/**
 * Error thrown during git operations
 */
export class GitError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly stderr?: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}
