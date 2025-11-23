/**
 * Git diff operations using native child_process
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiffOptions, DiffResult } from './type.js';
import { GitError } from './type.js';

/**
 * Get git diff between two branches using three-dot syntax
 *
 * Uses `git diff targetBranch...sourceBranch` to find the merge base
 * and only compare changes from the source branch.
 *
 * @param repoPath - Path to the git repository
 * @param sourceBranch - Source branch (contains new code)
 * @param targetBranch - Target branch (merge destination, baseline)
 * @returns Diff string from git command
 * @throws {GitError} If git command fails or repository is invalid
 */
export function getDiff(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): string {
  const options: DiffOptions = {
    repoPath,
    sourceBranch,
    targetBranch,
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
  const { repoPath, sourceBranch, targetBranch } = options;

  // Validate repository path
  const absolutePath = resolve(repoPath);
  if (!existsSync(absolutePath)) {
    throw new GitError(
      `Repository path does not exist: ${absolutePath}`,
      'REPO_NOT_FOUND'
    );
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

  // Execute three-dot diff: targetBranch...sourceBranch
  // This finds the merge base and shows only changes from sourceBranch
  try {
    const diff = execSync(
      `git diff ${targetBranch}...${sourceBranch}`,
      {
        cwd: absolutePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
      }
    );

    return {
      diff,
      sourceBranch,
      targetBranch,
      repoPath: absolutePath,
    };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `Failed to get diff between ${targetBranch}...${sourceBranch}`,
      'DIFF_FAILED',
      err.stderr || err.message
    );
  }
}
