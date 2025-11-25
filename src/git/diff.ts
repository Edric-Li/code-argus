/**
 * Git diff operations using native child_process
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * and only compare changes from the source branch on remote.
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
  // This finds the merge base and shows only changes from sourceBranch on remote
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
