/**
 * Git Reference Detection and Resolution
 *
 * Utilities for detecting and resolving Git references (branches vs commits).
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { GitError } from './type.js';

/**
 * Git reference type
 */
export type GitRefType = 'branch' | 'commit';

/**
 * Git reference with resolved information
 */
export interface GitRef {
  /** Reference type: branch or commit */
  type: GitRefType;
  /** Original value (branch name or commit SHA) */
  value: string;
  /** Resolved full SHA (40 characters) */
  resolvedSha?: string;
  /** Remote name (only for branches) */
  remote?: string;
}

/**
 * Review mode based on reference types
 */
export type ReviewMode = 'branch' | 'incremental';

/**
 * Detect if a reference is a commit SHA or a branch name
 *
 * @param ref - Reference string to check
 * @returns 'commit' if it looks like a SHA, 'branch' otherwise
 */
export function detectRefType(ref: string): GitRefType {
  // SHA pattern: 7-40 hex characters (short SHA to full SHA)
  const shaPattern = /^[a-f0-9]{7,40}$/i;
  return shaPattern.test(ref) ? 'commit' : 'branch';
}

/**
 * Verify that a commit exists in the repository
 *
 * @param repoPath - Path to the git repository
 * @param sha - Commit SHA to verify
 * @returns Full SHA if commit exists
 * @throws {GitError} If commit does not exist
 */
export function verifyCommit(repoPath: string, sha: string): string {
  const absolutePath = resolve(repoPath);

  try {
    const fullSha = execSync(`git rev-parse --verify ${sha}^{commit}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return fullSha;
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(`Commit not found: ${sha}`, 'COMMIT_NOT_FOUND', err.stderr || err.message);
  }
}

/**
 * Get commit message for a commit
 *
 * @param repoPath - Path to the git repository
 * @param sha - Commit SHA
 * @returns Commit subject line
 */
export function getCommitMessage(repoPath: string, sha: string): string {
  const absolutePath = resolve(repoPath);

  try {
    const message = execSync(`git log -1 --format=%s ${sha}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    return message;
  } catch {
    return '';
  }
}

/**
 * Get commits between two references
 *
 * @param repoPath - Path to the git repository
 * @param fromRef - Starting reference (older)
 * @param toRef - Ending reference (newer)
 * @returns Array of commit info { sha, message }
 */
export function getCommitsBetween(
  repoPath: string,
  fromRef: string,
  toRef: string
): Array<{ sha: string; message: string }> {
  const absolutePath = resolve(repoPath);

  try {
    const output = execSync(`git log --oneline ${fromRef}..${toRef}`, {
      cwd: absolutePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    if (!output) {
      return [];
    }

    return output.split('\n').map((line) => {
      const [sha, ...messageParts] = line.split(' ');
      return {
        sha: sha || '',
        message: messageParts.join(' '),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Resolve a reference to its full GitRef structure
 *
 * @param repoPath - Path to the git repository
 * @param ref - Reference string (branch name or commit SHA)
 * @param remote - Remote name (default: 'origin', only used for branches)
 * @returns Resolved GitRef
 * @throws {GitError} If reference cannot be resolved
 */
export function resolveRef(repoPath: string, ref: string, remote: string = 'origin'): GitRef {
  const type = detectRefType(ref);

  if (type === 'commit') {
    // Verify commit exists and get full SHA
    const resolvedSha = verifyCommit(repoPath, ref);
    return {
      type: 'commit',
      value: ref,
      resolvedSha,
    };
  } else {
    // Branch: resolve remote branch SHA
    const absolutePath = resolve(repoPath);
    const remoteRef = `${remote}/${ref}`;

    try {
      const resolvedSha = execSync(`git rev-parse ${remoteRef}`, {
        cwd: absolutePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      return {
        type: 'branch',
        value: ref,
        resolvedSha,
        remote,
      };
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      throw new GitError(
        `Branch not found: ${remoteRef}`,
        'BRANCH_NOT_FOUND',
        err.stderr || err.message
      );
    }
  }
}

/**
 * Determine the review mode based on source and target refs
 *
 * @param sourceRef - Source reference
 * @param targetRef - Target reference
 * @returns 'incremental' if both are commits, 'branch' otherwise
 */
export function determineReviewMode(sourceRef: GitRef, targetRef: GitRef): ReviewMode {
  return sourceRef.type === 'commit' && targetRef.type === 'commit' ? 'incremental' : 'branch';
}

/**
 * Get display string for a reference (for CLI output)
 *
 * @param ref - Git reference
 * @param repoPath - Optional repo path to get commit message
 * @returns Display string like "abc1234 (Fix bug)" or "feature-branch"
 */
export function getRefDisplayString(ref: GitRef, repoPath?: string): string {
  if (ref.type === 'commit') {
    const shortSha = ref.resolvedSha?.slice(0, 7) || ref.value.slice(0, 7);
    if (repoPath) {
      const message = getCommitMessage(repoPath, ref.resolvedSha || ref.value);
      if (message) {
        // Truncate message if too long
        const truncated = message.length > 50 ? message.slice(0, 47) + '...' : message;
        return `${shortSha} (${truncated})`;
      }
    }
    return shortSha;
  } else {
    return ref.value;
  }
}
