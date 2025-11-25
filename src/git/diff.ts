/**
 * Git diff operations using native child_process
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DiffOptions, DiffResult } from './type.js';
import { GitError } from './type.js';

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

  // Validate repository path
  const absolutePath = resolve(repoPath);
  if (!existsSync(absolutePath)) {
    throw new GitError(`Repository path does not exist: ${absolutePath}`, 'REPO_NOT_FOUND');
  }

  // Check if it's a git repository
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
