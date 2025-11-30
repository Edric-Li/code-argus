/**
 * Review State Manager
 *
 * Manages incremental review state, storing the last reviewed commit SHA
 * and issue fingerprints for each branch.
 *
 * State is stored at: ~/.argus/reviews/{repo-hash}/{branch}.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

// ============================================================================
// Types
// ============================================================================

/**
 * Fingerprint of a reviewed issue for tracking across reviews
 */
export interface IssueFingerprint {
  /** SHA256 hash of file + line_range + category + title */
  fingerprint: string;
  /** File path */
  file: string;
  /** Issue category */
  category: string;
  /** Issue title */
  title: string;
  /** Issue status from last review */
  status: 'open' | 'resolved' | 'wontfix';
  /** First seen timestamp */
  firstSeenAt: string;
  /** Last seen timestamp */
  lastSeenAt: string;
}

/**
 * Persistent state for a branch's review history
 */
export interface ReviewState {
  /** Repository path (for verification) */
  repoPath: string;
  /** Source branch name */
  branch: string;
  /** Target branch name */
  targetBranch: string;
  /** Last reviewed commit SHA on source branch */
  lastReviewedSha: string;
  /** Timestamp of last review */
  lastReviewedAt: string;
  /** Issues found in last review (for tracking) */
  issues: IssueFingerprint[];
  /** Review metadata */
  metadata: {
    /** Total issues found in last review */
    totalIssues: number;
    /** Review duration in ms */
    reviewTimeMs: number;
    /** Agents used */
    agentsUsed: string[];
  };
}

/**
 * Result when checking for incremental review possibility
 */
export interface IncrementalCheckResult {
  /** Whether incremental review is possible */
  canIncrement: boolean;
  /** Previous state if exists */
  previousState?: ReviewState;
  /** Last reviewed SHA */
  lastReviewedSha?: string;
  /** Current HEAD SHA */
  currentSha: string;
  /** Reason if incremental is not possible */
  reason?: string;
  /** Number of new commits since last review */
  newCommitCount?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the reviews directory path
 */
function getReviewsDir(): string {
  return join(homedir(), '.argus', 'reviews');
}

/**
 * Generate a stable hash for a repository path
 */
function hashRepoPath(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
}

/**
 * Sanitize branch name for use in filename
 */
function sanitizeBranchName(branch: string): string {
  return branch.replace(/[/\\:*?"<>|]/g, '_');
}

/**
 * Get the state file path for a specific repo and branch
 */
function getStateFilePath(repoPath: string, branch: string): string {
  const repoHash = hashRepoPath(repoPath);
  const safeBranch = sanitizeBranchName(branch);
  return join(getReviewsDir(), repoHash, `${safeBranch}.json`);
}

/**
 * Get the repo state directory path
 */
function getRepoStateDir(repoPath: string): string {
  const repoHash = hashRepoPath(repoPath);
  return join(getReviewsDir(), repoHash);
}

/**
 * Ensure the state directory exists
 */
function ensureStateDir(repoPath: string): void {
  const dir = getRepoStateDir(repoPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get current HEAD SHA for a remote branch
 */
function getCurrentSha(repoPath: string, branch: string, remote: string = 'origin'): string {
  try {
    const sha = execSync(`git rev-parse ${remote}/${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return sha;
  } catch {
    throw new Error(`Failed to get SHA for ${remote}/${branch}`);
  }
}

/**
 * Count commits between two SHAs
 * Returns 0 if counting fails (e.g., invalid SHAs)
 */
function countCommitsBetween(repoPath: string, fromSha: string, toSha: string): number {
  try {
    const count = execSync(`git rev-list --count ${fromSha}..${toSha}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return parseInt(count, 10);
  } catch (error) {
    console.warn(
      `[StateManager] Failed to count commits between ${fromSha.slice(0, 7)}..${toSha.slice(0, 7)}:`,
      error instanceof Error ? error.message : error
    );
    return 0;
  }
}

/**
 * Check if a SHA exists in the repository
 */
function shaExists(repoPath: string, sha: string): boolean {
  try {
    execSync(`git cat-file -e ${sha}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate fingerprint for an issue
 */
export function generateIssueFingerprint(
  file: string,
  lineStart: number,
  lineEnd: number,
  category: string,
  title: string
): string {
  const content = `${file}:${lineStart}-${lineEnd}:${category}:${title}`;
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ============================================================================
// ReviewStateManager Class
// ============================================================================

/**
 * Manager for review state persistence
 */
export class ReviewStateManager {
  private repoPath: string;
  private verbose: boolean;

  constructor(repoPath: string, verbose: boolean = false) {
    this.repoPath = repoPath;
    this.verbose = verbose;
  }

  /**
   * Load state for a branch
   */
  load(branch: string): ReviewState | null {
    const statePath = getStateFilePath(this.repoPath, branch);

    if (!existsSync(statePath)) {
      if (this.verbose) {
        console.log(`[StateManager] No state file found for ${branch}`);
      }
      return null;
    }

    try {
      const content = readFileSync(statePath, 'utf-8');
      const state = JSON.parse(content) as ReviewState;

      if (this.verbose) {
        console.log(
          `[StateManager] Loaded state for ${branch}: last reviewed at ${state.lastReviewedAt}`
        );
      }

      return state;
    } catch (error) {
      console.error(`[StateManager] Failed to parse state file: ${statePath}`, error);
      return null;
    }
  }

  /**
   * Save state for a branch
   */
  save(state: ReviewState): void {
    ensureStateDir(this.repoPath);
    const statePath = getStateFilePath(this.repoPath, state.branch);

    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');

      if (this.verbose) {
        console.log(`[StateManager] Saved state for ${state.branch} at ${statePath}`);
      }
    } catch (error) {
      console.error(`[StateManager] Failed to save state: ${statePath}`, error);
      throw error;
    }
  }

  /**
   * Clear state for a branch
   */
  clear(branch: string): void {
    const statePath = getStateFilePath(this.repoPath, branch);

    if (existsSync(statePath)) {
      try {
        rmSync(statePath);
        if (this.verbose) {
          console.log(`[StateManager] Cleared state for ${branch}`);
        }
      } catch (error) {
        console.warn(
          `[StateManager] Failed to clear state for ${branch}:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  /**
   * Clear all states for this repository
   */
  clearAll(): void {
    const repoDir = getRepoStateDir(this.repoPath);

    if (existsSync(repoDir)) {
      try {
        rmSync(repoDir, { recursive: true });
        if (this.verbose) {
          console.log(`[StateManager] Cleared all states for ${this.repoPath}`);
        }
      } catch (error) {
        console.warn(
          `[StateManager] Failed to clear all states:`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  /**
   * Check if incremental review is possible
   */
  checkIncremental(
    branch: string,
    targetBranch: string,
    remote: string = 'origin'
  ): IncrementalCheckResult {
    // Get current SHA
    let currentSha: string;
    try {
      currentSha = getCurrentSha(this.repoPath, branch, remote);
    } catch {
      return {
        canIncrement: false,
        currentSha: '',
        reason: `Cannot get current SHA for ${remote}/${branch}`,
      };
    }

    // Load previous state
    const previousState = this.load(branch);

    if (!previousState) {
      return {
        canIncrement: false,
        previousState: undefined,
        currentSha,
        reason: 'No previous review state found',
      };
    }

    // Verify target branch matches
    if (previousState.targetBranch !== targetBranch) {
      return {
        canIncrement: false,
        previousState,
        currentSha,
        reason: `Target branch changed: ${previousState.targetBranch} → ${targetBranch}`,
      };
    }

    // Check if last reviewed SHA still exists (not rebased)
    if (!shaExists(this.repoPath, previousState.lastReviewedSha)) {
      return {
        canIncrement: false,
        previousState,
        lastReviewedSha: previousState.lastReviewedSha,
        currentSha,
        reason: 'Previous commit no longer exists (branch was rebased)',
      };
    }

    // Check if there are new commits
    if (previousState.lastReviewedSha === currentSha) {
      return {
        canIncrement: false,
        previousState,
        lastReviewedSha: previousState.lastReviewedSha,
        currentSha,
        reason: 'No new commits since last review',
      };
    }

    // Count new commits
    const newCommitCount = countCommitsBetween(
      this.repoPath,
      previousState.lastReviewedSha,
      currentSha
    );

    return {
      canIncrement: true,
      previousState,
      lastReviewedSha: previousState.lastReviewedSha,
      currentSha,
      newCommitCount,
    };
  }

  /**
   * Create a new state after completing a review
   */
  createState(params: {
    branch: string;
    targetBranch: string;
    currentSha: string;
    issues: Array<{
      file: string;
      line_start: number;
      line_end: number;
      category: string;
      title: string;
    }>;
    metadata: {
      totalIssues: number;
      reviewTimeMs: number;
      agentsUsed: string[];
    };
  }): ReviewState {
    const now = new Date().toISOString();

    // Load previous state to preserve issue history
    const previousState = this.load(params.branch);
    const previousIssues = previousState?.issues || [];

    // Create fingerprints for current issues
    const currentFingerprints = new Map<string, IssueFingerprint>();

    for (const issue of params.issues) {
      const fingerprint = generateIssueFingerprint(
        issue.file,
        issue.line_start,
        issue.line_end,
        issue.category,
        issue.title
      );

      // Check if issue existed before
      const existingIssue = previousIssues.find((i) => i.fingerprint === fingerprint);

      currentFingerprints.set(fingerprint, {
        fingerprint,
        file: issue.file,
        category: issue.category,
        title: issue.title,
        status: 'open',
        firstSeenAt: existingIssue?.firstSeenAt || now,
        lastSeenAt: now,
      });
    }

    // Handle issues from previous reviews that are not in current review
    for (const prev of previousIssues) {
      if (!currentFingerprints.has(prev.fingerprint)) {
        // Issue not found in current review
        if (prev.status === 'open') {
          // Previously open issue is now resolved
          currentFingerprints.set(prev.fingerprint, {
            ...prev,
            status: 'resolved',
            lastSeenAt: now,
          });
        }
        // Note: resolved/wontfix issues that don't reappear are not carried forward
        // to avoid accumulating stale history indefinitely
      }
    }

    return {
      repoPath: this.repoPath,
      branch: params.branch,
      targetBranch: params.targetBranch,
      lastReviewedSha: params.currentSha,
      lastReviewedAt: now,
      issues: Array.from(currentFingerprints.values()),
      metadata: params.metadata,
    };
  }

  /**
   * Get state file location (for display purposes)
   */
  getStateLocation(branch: string): string {
    return getStateFilePath(this.repoPath, branch);
  }

  /**
   * Get reviews directory location
   */
  static getReviewsDir(): string {
    return getReviewsDir();
  }
}

/**
 * Create a review state manager
 */
export function createStateManager(repoPath: string, verbose?: boolean): ReviewStateManager {
  return new ReviewStateManager(repoPath, verbose);
}
