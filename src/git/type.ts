/**
 * Type definitions for Git operations
 */

/**
 * Git diff result
 */
export interface DiffResult {
  /** Original diff output from git command */
  diff: string;
  /** Source branch (contains new code) */
  sourceBranch: string;
  /** Target branch (merge destination, used as baseline) */
  targetBranch: string;
  /** Repository path where diff was executed */
  repoPath: string;
  /** Remote name used for diff (e.g., 'origin') */
  remote: string;
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
