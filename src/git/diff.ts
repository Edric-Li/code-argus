/**
 * Git diff operations using native child_process
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DiffOptions, DiffResult, DiffByRefsOptions } from './type.js';
import { GitError } from './type.js';
import { fetchWithLockSync } from './fetch-lock.js';
import { detectRefType, resolveRef, determineReviewMode, type GitRef } from './ref.js';
import {
  getOrCreateWorktree as managedGetOrCreateWorktree,
  getOrCreateWorktreeForRef as managedGetOrCreateWorktreeForRef,
  type ManagedWorktreeInfo,
} from './worktree-manager.js';

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
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Not a git repository: ${absolutePath}`,
      'NOT_GIT_REPO',
      err.stderr || err.message
    );
  }

  return absolutePath;
}

/**
 * Fetch remote refs with locking to prevent concurrent fetch conflicts
 *
 * When multiple argus processes run against the same repository,
 * this function uses file locking and caching to:
 * - Prevent concurrent git fetch operations (which would fail due to git locks)
 * - Skip redundant fetches within a time window (30 seconds by default)
 * - Clean up stale locks from crashed processes
 *
 * @param repoPath - Path to the git repository
 * @param remote - Remote name (default: 'origin')
 * @returns true if fetch succeeded or was skipped (cache hit), false on failure
 */
export function fetchRemote(repoPath: string, remote: string = 'origin'): boolean {
  return fetchWithLockSync(repoPath, remote);
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

/**
 * Get git diff between two references (branches or commits)
 *
 * This function auto-detects whether the references are branches or commits:
 * - If both are commits: Uses two-dot syntax `git diff target..source`
 * - If either is a branch: Uses three-dot syntax `git diff origin/target...origin/source`
 *
 * @param options - Diff options with reference support
 * @returns Detailed diff result with reference information
 * @throws {GitError} If git command fails or references are invalid
 */
export function getDiffByRefs(options: DiffByRefsOptions): DiffResult {
  const {
    repoPath,
    sourceRef: sourceRefStr,
    targetRef: targetRefStr,
    remote = 'origin',
    skipFetch = false,
  } = options;

  const absolutePath = validateGitRepository(repoPath);

  // Detect reference types
  const sourceType = detectRefType(sourceRefStr);
  const targetType = detectRefType(targetRefStr);
  const isIncremental = sourceType === 'commit' && targetType === 'commit';

  // For incremental mode, check if commits exist locally first
  // If not, we need to fetch to get them from remote
  let needsFetch = !skipFetch;
  if (isIncremental && !skipFetch) {
    // Try to verify commits exist locally
    try {
      execSync(`git cat-file -t ${sourceRefStr}`, {
        cwd: absolutePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      execSync(`git cat-file -t ${targetRefStr}`, {
        cwd: absolutePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      // Both commits exist locally, no fetch needed
      needsFetch = false;
    } catch {
      // At least one commit not found locally, need to fetch
      needsFetch = true;
    }
  }

  // Fetch if needed (for branch mode or when commits don't exist locally)
  if (needsFetch) {
    fetchRemote(absolutePath, remote);
  }

  // Resolve references
  const sourceRef = resolveRef(absolutePath, sourceRefStr, remote);
  const targetRef = resolveRef(absolutePath, targetRefStr, remote);
  const mode = determineReviewMode(sourceRef, targetRef);

  // Build diff command based on mode
  let diffCommand: string;
  if (isIncremental) {
    // Incremental mode: two-dot diff between commits
    // target..source shows commits reachable from source but not from target
    diffCommand = `git diff ${targetRef.resolvedSha}..${sourceRef.resolvedSha}`;
  } else {
    // Branch mode: three-dot diff
    const sourceArg =
      sourceRef.type === 'commit' ? sourceRef.resolvedSha : `${remote}/${sourceRef.value}`;
    const targetArg =
      targetRef.type === 'commit' ? targetRef.resolvedSha : `${remote}/${targetRef.value}`;
    diffCommand = `git diff ${targetArg}...${sourceArg}`;
  }

  try {
    const diff = execSync(diffCommand, {
      cwd: absolutePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });

    return {
      diff,
      // Backward compatibility: use value for branch names
      sourceBranch: sourceRef.value,
      targetBranch: targetRef.value,
      repoPath: absolutePath,
      remote,
      // New fields
      sourceRef,
      targetRef,
      mode,
    };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    const sourceDesc =
      sourceRef.type === 'commit'
        ? sourceRef.resolvedSha?.slice(0, 7)
        : `${remote}/${sourceRef.value}`;
    const targetDesc =
      targetRef.type === 'commit'
        ? targetRef.resolvedSha?.slice(0, 7)
        : `${remote}/${targetRef.value}`;
    throw new GitError(
      `Failed to get diff between ${targetDesc} and ${sourceDesc}`,
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
 * Create a temporary worktree for reviewing a Git reference (branch or commit)
 *
 * This creates a new worktree in a temp directory, allowing code review
 * without affecting the main working directory.
 *
 * @param repoPath - Path to the git repository
 * @param ref - Git reference (branch or commit)
 * @returns Info about the created worktree
 * @throws {GitError} If worktree creation fails
 */
export function createWorktreeForRef(repoPath: string, ref: GitRef): WorktreeInfo {
  const absolutePath = resolve(repoPath);

  // Create temp directory for worktree
  const worktreePath = mkdtempSync(join(tmpdir(), 'code-argus-review-'));

  // Determine the ref to checkout
  const checkoutRef =
    ref.type === 'commit'
      ? ref.resolvedSha || ref.value // Use SHA for commits
      : `${ref.remote || 'origin'}/${ref.value}`; // Use remote/branch for branches

  try {
    // Create worktree with detached HEAD
    execSync(`git worktree add --detach "${worktreePath}" ${checkoutRef}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    return {
      worktreePath,
      originalRepoPath: absolutePath,
      checkedOutRef: checkoutRef,
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
      `Failed to create worktree for ${checkoutRef}`,
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
// Utility Functions
// ============================================================================

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

// ============================================================================
// Managed Worktree Functions (Persistent with Caching)
// ============================================================================

/**
 * Get or create a managed worktree for a branch (with caching and auto-cleanup)
 *
 * Unlike createWorktreeForReview, this:
 * - Uses a persistent directory (~/.code-argus/worktrees/)
 * - Reuses existing worktrees by updating their checkout
 * - Automatically cleans up worktrees older than 5 days
 *
 * @param repoPath - Path to the git repository
 * @param sourceBranch - Source branch to checkout
 * @param remote - Remote name (default: 'origin')
 * @returns Managed worktree info including whether it was reused
 */
export function getManagedWorktree(
  repoPath: string,
  sourceBranch: string,
  remote: string = 'origin'
): ManagedWorktreeInfo {
  const absolutePath = resolve(repoPath);
  return managedGetOrCreateWorktree(absolutePath, sourceBranch, remote);
}

/**
 * Get or create a managed worktree for a GitRef (with caching and auto-cleanup)
 *
 * @param repoPath - Path to the git repository
 * @param ref - Git reference (branch or commit)
 * @returns Managed worktree info including whether it was reused
 */
export function getManagedWorktreeForRef(repoPath: string, ref: GitRef): ManagedWorktreeInfo {
  const absolutePath = resolve(repoPath);
  return managedGetOrCreateWorktreeForRef(absolutePath, ref);
}

// Re-export types and functions from worktree-manager
export type { ManagedWorktreeInfo } from './worktree-manager.js';
export {
  WorktreeManager,
  getWorktreeManager,
  cleanupStaleWorktrees,
  type WorktreeManagerOptions,
} from './worktree-manager.js';
