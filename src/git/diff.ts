/**
 * Git diff operations using native child_process
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DiffOptions, DiffResult } from './type.js';
import { GitError } from './type.js';

// ============================================================================
// Common Utilities
// ============================================================================

/**
 * Validate that a path is a valid git repository
 *
 * @param repoPath - Path to validate
 * @returns Resolved absolute path
 * @throws {GitError} If path doesn't exist or isn't a git repository
 */
function validateGitRepository(repoPath: string): string {
  const absolutePath = resolve(repoPath);

  if (!existsSync(absolutePath)) {
    throw new GitError(`Repository path does not exist: ${absolutePath}`, 'REPO_NOT_FOUND');
  }

  try {
    execSync('git rev-parse --git-dir', {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (error) {
    throw new GitError(
      `Not a git repository: ${absolutePath}`,
      'NOT_GIT_REPO',
      error instanceof Error ? error.message : String(error)
    );
  }

  return absolutePath;
}

/**
 * Fetch remote refs
 *
 * @param repoPath - Path to the git repository
 * @param remote - Remote name (default: 'origin')
 * @returns true if fetch succeeded, false otherwise
 */
export function fetchRemote(repoPath: string, remote: string = 'origin'): boolean {
  try {
    execSync(`git fetch ${remote}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    console.warn(`Warning: Failed to fetch from ${remote}, using existing refs`);
    return false;
  }
}

/**
 * Get git diff between two remote branches using three-dot syntax
 *
 * Uses `git diff origin/targetBranch...origin/sourceBranch` to find the merge base
 * and show changes introduced in the source branch.
 *
 * @param repoPath - Path to the git repository
 * @param sourceBranch - Source branch name (will be prefixed with remote/)
 * @param targetBranch - Target branch name (will be prefixed with remote/)
 * @param remote - Remote name (defaults to 'origin')
 * @returns Diff string from git command
 * @throws {GitError} If git command fails or repository is invalid
 */
export function getDiff(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  remote: string = 'origin'
): string {
  const options: DiffOptions = {
    repoPath,
    sourceBranch,
    targetBranch,
    remote,
  };

  return getDiffWithOptions(options).diff;
}

/**
 * Get git diff with detailed result information
 *
 * @param options - Diff options
 * @returns Detailed diff result
 * @throws {GitError} If git command fails or repository is invalid
 */
export function getDiffWithOptions(options: DiffOptions): DiffResult {
  const { repoPath, sourceBranch, targetBranch, remote = 'origin', skipFetch = false } = options;

  const absolutePath = validateGitRepository(repoPath);

  // Fetch latest remote refs (unless skipped)
  if (!skipFetch) {
    fetchRemote(absolutePath, remote);
  }

  // Build remote branch references
  const remoteSourceBranch = `${remote}/${sourceBranch}`;
  const remoteTargetBranch = `${remote}/${targetBranch}`;

  // Execute three-dot diff: remote/targetBranch...remote/sourceBranch
  // This finds the merge base and shows only changes from sourceBranch
  try {
    const diff = execSync(`git diff ${remoteTargetBranch}...${remoteSourceBranch}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });

    return {
      diff,
      sourceBranch,
      targetBranch,
      repoPath: absolutePath,
      remote,
    };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to get diff between ${remoteTargetBranch}...${remoteSourceBranch}`,
      'DIFF_FAILED',
      err.stderr || err.message
    );
  }
}

// ============================================================================
// Git Worktree Operations
// ============================================================================

/**
 * Worktree info returned when creating a worktree
 */
export interface WorktreeInfo {
  /** Path to the worktree directory */
  worktreePath: string;
  /** Original repository path */
  originalRepoPath: string;
  /** Branch/ref checked out in the worktree */
  checkedOutRef: string;
}

/**
 * Create a temporary worktree for reviewing a branch
 *
 * This creates a new worktree in a temp directory, allowing code review
 * without affecting the main working directory.
 *
 * @param repoPath - Path to the git repository
 * @param sourceBranch - Source branch to checkout in worktree
 * @param remote - Remote name (default: 'origin')
 * @returns Info about the created worktree
 * @throws {GitError} If worktree creation fails
 */
export function createWorktreeForReview(
  repoPath: string,
  sourceBranch: string,
  remote: string = 'origin'
): WorktreeInfo {
  const absolutePath = resolve(repoPath);

  // Create temp directory for worktree
  const worktreePath = mkdtempSync(join(tmpdir(), 'code-argus-review-'));

  // The ref to checkout (remote branch)
  const remoteRef = `${remote}/${sourceBranch}`;

  try {
    // Create worktree with detached HEAD at the remote ref
    execSync(`git worktree add --detach "${worktreePath}" ${remoteRef}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    return {
      worktreePath,
      originalRepoPath: absolutePath,
      checkedOutRef: remoteRef,
    };
  } catch (error: unknown) {
    // Clean up temp directory on failure
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to create worktree for ${remoteRef}`,
      'WORKTREE_CREATE_FAILED',
      err.stderr || err.message
    );
  }
}

/**
 * Remove a worktree after review is complete
 *
 * @param worktreeInfo - Info from createWorktreeForReview
 */
export function removeWorktree(worktreeInfo: WorktreeInfo): void {
  try {
    // Remove the worktree from git's tracking
    execSync(`git worktree remove --force "${worktreeInfo.worktreePath}"`, {
      cwd: worktreeInfo.originalRepoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch {
    // If git worktree remove fails, try manual cleanup
    try {
      rmSync(worktreeInfo.worktreePath, { recursive: true, force: true });
      // Prune worktree references
      execSync('git worktree prune', {
        cwd: worktreeInfo.originalRepoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch {
      console.warn(`Warning: Failed to clean up worktree at ${worktreeInfo.worktreePath}`);
    }
  }
}

// ============================================================================
// Incremental Diff Operations
// ============================================================================

/**
 * Options for incremental diff
 */
export interface IncrementalDiffOptions {
  /** Path to the git repository */
  repoPath: string;
  /** Source branch name */
  sourceBranch: string;
  /** Target branch name */
  targetBranch: string;
  /** Last reviewed commit SHA (for incremental diff) */
  lastReviewedSha: string;
  /** Remote name (default: 'origin') */
  remote?: string;
  /** Skip fetching remote (default: false) */
  skipFetch?: boolean;
}

/**
 * Result of incremental diff operation
 */
export interface IncrementalDiffResult extends DiffResult {
  /** Whether this is an incremental diff */
  isIncremental: boolean;
  /** Start SHA (last reviewed) */
  fromSha: string;
  /** End SHA (current) */
  toSha: string;
  /** Number of new commits */
  newCommitCount: number;
}

/**
 * Get current HEAD SHA for a remote branch
 */
export function getRemoteBranchSha(
  repoPath: string,
  branch: string,
  remote: string = 'origin'
): string {
  const absolutePath = resolve(repoPath);
  try {
    const sha = execSync(`git rev-parse ${remote}/${branch}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return sha;
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to get SHA for ${remote}/${branch}`,
      'REF_NOT_FOUND',
      err.stderr || err.message
    );
  }
}

/**
 * Get incremental diff between last reviewed commit and current HEAD
 *
 * Uses `git diff lastReviewedSha...origin/sourceBranch` to get only changes
 * since the last review.
 *
 * @param options - Incremental diff options
 * @returns Incremental diff result
 * @throws {GitError} If git command fails
 */
export function getIncrementalDiff(options: IncrementalDiffOptions): IncrementalDiffResult {
  const {
    repoPath,
    sourceBranch,
    targetBranch,
    lastReviewedSha,
    remote = 'origin',
    skipFetch = false,
  } = options;

  const absolutePath = resolve(repoPath);

  // Validate repository path
  if (!existsSync(absolutePath)) {
    throw new GitError(`Repository path does not exist: ${absolutePath}`, 'REPO_NOT_FOUND');
  }

  // Fetch latest remote refs (unless skipped)
  if (!skipFetch) {
    fetchRemote(absolutePath, remote);
  }

  // Get current SHA
  const currentSha = getRemoteBranchSha(absolutePath, sourceBranch, remote);

  // Count new commits
  let newCommitCount = 0;
  try {
    const count = execSync(`git rev-list --count ${lastReviewedSha}..${currentSha}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    newCommitCount = parseInt(count, 10);
  } catch {
    // Log warning but continue - commit count is informational only
    console.warn(
      `[git/diff] Failed to count commits between ${lastReviewedSha.slice(0, 7)}..${currentSha.slice(0, 7)}`
    );
    newCommitCount = 0;
  }

  // Execute incremental diff: lastReviewedSha...origin/sourceBranch
  // This shows changes from lastReviewedSha to current HEAD of sourceBranch
  const remoteSourceBranch = `${remote}/${sourceBranch}`;

  try {
    const diff = execSync(`git diff ${lastReviewedSha}...${remoteSourceBranch}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    return {
      diff,
      sourceBranch,
      targetBranch,
      repoPath: absolutePath,
      remote,
      isIncremental: true,
      fromSha: lastReviewedSha,
      toSha: currentSha,
      newCommitCount,
    };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to get incremental diff from ${lastReviewedSha} to ${remoteSourceBranch}`,
      'DIFF_FAILED',
      err.stderr || err.message
    );
  }
}

// ============================================================================
// Local Diff Operations (for pre-commit review)
// ============================================================================

/**
 * Result of local diff operation
 */
export interface LocalDiffResult {
  /** The diff content */
  diff: string;
  /** Repository path */
  repoPath: string;
  /** Whether this includes staged changes only or all local changes */
  stagedOnly: boolean;
}

/**
 * Get local diff (all uncommitted changes)
 *
 * Uses `git diff HEAD` to get all local changes (both staged and unstaged)
 * relative to the last commit.
 *
 * @param repoPath - Path to the git repository (defaults to current directory)
 * @returns Local diff result
 * @throws {GitError} If git command fails or repository is invalid
 */
export function getLocalDiff(repoPath: string = process.cwd()): LocalDiffResult {
  const absolutePath = validateGitRepository(repoPath);

  // Execute diff: git diff HEAD (all local changes)
  try {
    const diff = execSync('git diff HEAD', {
      cwd: absolutePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });

    return {
      diff,
      repoPath: absolutePath,
      stagedOnly: false,
    };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError('Failed to get local diff', 'DIFF_FAILED', err.stderr || err.message);
  }
}

/**
 * Get current HEAD commit SHA
 *
 * @param repoPath - Path to the git repository
 * @returns Current HEAD SHA
 */
export function getHeadSha(repoPath: string = process.cwd()): string {
  const absolutePath = validateGitRepository(repoPath);

  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return sha;
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError('Failed to get HEAD SHA', 'REF_NOT_FOUND', err.stderr || err.message);
  }
}

/**
 * Get merge base between two branches
 */
export function getMergeBase(
  repoPath: string,
  branch1: string,
  branch2: string,
  remote: string = 'origin'
): string {
  const absolutePath = resolve(repoPath);
  const ref1 = `${remote}/${branch1}`;
  const ref2 = `${remote}/${branch2}`;

  try {
    const mergeBase = execSync(`git merge-base ${ref1} ${ref2}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return mergeBase;
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to find merge base between ${ref1} and ${ref2}`,
      'MERGE_BASE_FAILED',
      err.stderr || err.message
    );
  }
}
