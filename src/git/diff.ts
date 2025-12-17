/**
 * Git diff operations using native child_process
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  DiffOptions,
  DiffResult,
  DiffByRefsOptions,
  CommitInfo,
  IncrementalDiffResult,
} from './type.js';
import { GitError } from './type.js';
import { fetchWithLockSync } from './fetch-lock.js';
import { detectRefType, resolveRef, determineReviewMode, type GitRef } from './ref.js';
import {
  getOrCreateWorktree as managedGetOrCreateWorktree,
  getOrCreateWorktreeForRef as managedGetOrCreateWorktreeForRef,
  type ManagedWorktreeInfo,
  type WorktreeManagerOptions,
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
    smartMergeFilter = true, // Default to smart filtering
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

  // Build diff based on mode
  let diff: string;

  if (isIncremental && smartMergeFilter) {
    // Use smart incremental diff that filters out merge noise
    const smartResult = getIncrementalDiffSmart(
      absolutePath,
      targetRef.resolvedSha!,
      sourceRef.resolvedSha!
    );
    diff = smartResult.diff;
    // Note: Caller can inspect smartResult for merge filtering stats if needed
    // smartResult contains: commits, mergeCommitsWithChanges, regularCommits
  } else if (isIncremental) {
    // Legacy incremental mode: simple two-dot diff between commits
    // WARNING: This includes all changes from merged branches!
    try {
      diff = execSync(`git diff ${targetRef.resolvedSha}..${sourceRef.resolvedSha}`, {
        cwd: absolutePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      throw new GitError(
        `Failed to get diff between ${targetRef.resolvedSha?.slice(0, 7)} and ${sourceRef.resolvedSha?.slice(0, 7)}`,
        'DIFF_FAILED',
        err.stderr || err.message
      );
    }
  } else {
    // Branch mode: three-dot diff
    const sourceArg =
      sourceRef.type === 'commit' ? sourceRef.resolvedSha : `${remote}/${sourceRef.value}`;
    const targetArg =
      targetRef.type === 'commit' ? targetRef.resolvedSha : `${remote}/${targetRef.value}`;
    const diffCommand = `git diff ${targetArg}...${sourceArg}`;

    try {
      diff = execSync(diffCommand, {
        cwd: absolutePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      throw new GitError(
        `Failed to get diff between ${targetArg} and ${sourceArg}`,
        'DIFF_FAILED',
        err.stderr || err.message
      );
    }
  }

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
// Smart Incremental Diff (Merge Filtering)
// ============================================================================

/**
 * Get commits between two refs with parent information
 *
 * @param repoPath - Path to the git repository
 * @param targetSha - Target commit SHA (older)
 * @param sourceSha - Source commit SHA (newer)
 * @returns Array of commit info including parent relationships
 */
export function getCommitsWithParents(
  repoPath: string,
  targetSha: string,
  sourceSha: string
): CommitInfo[] {
  const absolutePath = resolve(repoPath);

  try {
    // Get commits in reverse chronological order with parent info
    // Format: SHA PARENT1 PARENT2 ... (space separated)
    const output = execSync(`git log --format="%H %P" ${targetSha}..${sourceSha}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    if (!output) return [];

    return output.split('\n').map((line) => {
      const parts = line.split(' ').filter(Boolean);
      const sha = parts[0]!;
      const parents = parts.slice(1);
      return {
        sha,
        parents,
        isMerge: parents.length > 1,
      };
    });
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to get commits between ${targetSha} and ${sourceSha}`,
      'COMMITS_FAILED',
      err.stderr || err.message
    );
  }
}

/**
 * Get diff for a single commit against its first parent
 *
 * @param repoPath - Path to the git repository
 * @param sha - Commit SHA
 * @returns Diff string
 */
function getCommitDiff(repoPath: string, sha: string): string {
  const absolutePath = resolve(repoPath);

  try {
    return execSync(`git diff ${sha}^..${sha}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: 'pipe',
    });
  } catch {
    // If commit has no parent (initial commit), use git show to get the diff
    // git show displays the commit's changes in patch format
    try {
      return execSync(`git show ${sha} --format="" --patch`, {
        cwd: absolutePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: 'pipe',
      });
    } catch {
      return '';
    }
  }
}

/**
 * Get "own changes" from a merge commit (conflict resolutions + extra changes)
 *
 * Uses git diff-tree --cc to show combined diff, which only includes
 * changes that differ from ALL parents (i.e., conflict resolutions or
 * changes made during the merge that weren't in any parent).
 *
 * @param repoPath - Path to the git repository
 * @param mergeSha - Merge commit SHA
 * @returns Diff string (empty if pure merge with no conflicts)
 */
function getMergeCommitOwnChanges(repoPath: string, mergeSha: string): string {
  const absolutePath = resolve(repoPath);

  try {
    // --cc shows combined diff for merge commits
    // Only outputs hunks where the merge result differs from ALL parents
    const output = execSync(`git diff-tree -p --cc ${mergeSha}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: 'pipe',
    }).trim();

    // diff-tree output includes commit info on first line, skip it
    const lines = output.split('\n');
    if (lines.length > 0 && lines[0]?.startsWith(mergeSha.slice(0, 7))) {
      return lines.slice(1).join('\n');
    }
    return output;
  } catch {
    return '';
  }
}

/**
 * Get smart incremental diff that filters out merge noise
 *
 * This function addresses the problem where a simple `git diff A..B` includes
 * all changes from merged branches, not just the actual development work.
 *
 * Algorithm:
 * 1. Get all commits between target..source
 * 2. For regular commits: diff against first parent (sha^..sha)
 * 3. For merge commits: only get "own changes" (conflict resolutions, etc.)
 * 4. Combine all diffs
 *
 * @param repoPath - Path to the git repository
 * @param targetSha - Target commit SHA (older)
 * @param sourceSha - Source commit SHA (newer)
 * @returns Combined diff with merge noise filtered out
 */
export function getIncrementalDiffSmart(
  repoPath: string,
  targetSha: string,
  sourceSha: string
): IncrementalDiffResult {
  const absolutePath = resolve(repoPath);

  // Get all commits with parent info
  const commits = getCommitsWithParents(absolutePath, targetSha, sourceSha);

  if (commits.length === 0) {
    return {
      diff: '',
      commits: [],
      mergeCommitsWithChanges: 0,
      regularCommits: 0,
    };
  }

  const diffs: string[] = [];
  let mergeCommitsWithChanges = 0;
  let regularCommits = 0;

  for (const commit of commits) {
    if (commit.isMerge) {
      // For merge commits, only get conflict resolutions and extra changes
      const mergeOwnDiff = getMergeCommitOwnChanges(absolutePath, commit.sha);
      if (mergeOwnDiff.trim()) {
        diffs.push(mergeOwnDiff);
        mergeCommitsWithChanges++;
      }
      // If empty, it was a clean merge with no conflicts - skip it
    } else {
      // For regular commits, diff against parent
      const commitDiff = getCommitDiff(absolutePath, commit.sha);
      if (commitDiff.trim()) {
        diffs.push(commitDiff);
      }
      regularCommits++;
    }
  }

  return {
    diff: diffs.join('\n'),
    commits,
    mergeCommitsWithChanges,
    regularCommits,
  };
}

/**
 * Get list of files actually changed by non-merge commits
 *
 * This is useful when you want to know which files have real development
 * changes, excluding files that were only touched by merges.
 *
 * @param repoPath - Path to the git repository
 * @param targetSha - Target commit SHA (older)
 * @param sourceSha - Source commit SHA (newer)
 * @returns Array of file paths
 */
export function getActualChangedFiles(
  repoPath: string,
  targetSha: string,
  sourceSha: string
): string[] {
  const absolutePath = resolve(repoPath);

  try {
    // --no-merges excludes merge commits
    // --name-only shows only file names
    // --format="" suppresses commit info
    const output = execSync(
      `git log --no-merges --name-only --format="" ${targetSha}..${sourceSha}`,
      {
        cwd: absolutePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }
    ).trim();

    if (!output) return [];

    // Deduplicate file paths
    const files = output.split('\n').filter(Boolean);
    return [...new Set(files)];
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to get changed files between ${targetSha} and ${sourceSha}`,
      'FILES_FAILED',
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
 * @param options - Optional worktree manager options (logger, verbose, etc.)
 * @returns Managed worktree info including whether it was reused
 */
export function getManagedWorktree(
  repoPath: string,
  sourceBranch: string,
  remote: string = 'origin',
  options?: WorktreeManagerOptions
): ManagedWorktreeInfo {
  const absolutePath = resolve(repoPath);
  return managedGetOrCreateWorktree(absolutePath, sourceBranch, remote, options);
}

/**
 * Get or create a managed worktree for a GitRef (with caching and auto-cleanup)
 *
 * @param repoPath - Path to the git repository
 * @param ref - Git reference (branch or commit)
 * @param options - Optional worktree manager options (logger, verbose, etc.)
 * @returns Managed worktree info including whether it was reused
 */
export function getManagedWorktreeForRef(
  repoPath: string,
  ref: GitRef,
  options?: WorktreeManagerOptions
): ManagedWorktreeInfo {
  const absolutePath = resolve(repoPath);
  return managedGetOrCreateWorktreeForRef(absolutePath, ref, options);
}

// Re-export types and functions from worktree-manager
export type { ManagedWorktreeInfo, WorktreeLogger } from './worktree-manager.js';
export {
  WorktreeManager,
  getWorktreeManager,
  cleanupStaleWorktrees,
  type WorktreeManagerOptions,
} from './worktree-manager.js';
