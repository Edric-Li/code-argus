/**
 * Git Commits Fetcher
 * Fetches PR commits between two branches
 */

import { execSync } from 'child_process';
import { GitError } from './type.js';
import type { RawCommit } from '../intent/types.js';

/**
 * Field separator for git log output
 * Using a unique separator to avoid conflicts with commit message content
 */
const FIELD_SEP = '§§§';
const COMMIT_SEP = '¶¶¶';

/**
 * Get commits for a PR (commits in source branch but not in target branch)
 *
 * @param repoPath - Path to the git repository
 * @param sourceBranch - Source branch name (PR branch)
 * @param targetBranch - Target branch name (base branch)
 * @param remote - Remote name (default: 'origin')
 * @returns Array of commits in the PR
 */
export function getPRCommits(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  remote: string = 'origin'
): RawCommit[] {
  const format = [
    '%H', // hash
    '%s', // subject (first line)
    '%b', // body (rest of message)
    '%an', // author name
    '%aI', // author date (ISO 8601)
  ].join(FIELD_SEP);

  // Use two-dot syntax: target..source = commits in source but not in target
  const command = `git log ${remote}/${targetBranch}..${remote}/${sourceBranch} --format="${format}${COMMIT_SEP}" --no-merges`;

  try {
    const output = execSync(command, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large histories
    });

    return parseCommitOutput(output);
  } catch (error) {
    if (error instanceof Error && 'stderr' in error) {
      const stderr = (error as { stderr: Buffer | string }).stderr?.toString() || '';
      throw new GitError(
        `Failed to get commits between ${remote}/${targetBranch}..${remote}/${sourceBranch}`,
        'LOG_FAILED',
        stderr
      );
    }
    throw error;
  }
}

/**
 * Parse git log output into structured commits
 */
function parseCommitOutput(output: string): RawCommit[] {
  if (!output.trim()) {
    return [];
  }

  const commits: RawCommit[] = [];
  const rawCommits = output.split(COMMIT_SEP).filter((s) => s.trim());

  for (const raw of rawCommits) {
    const parts = raw.trim().split(FIELD_SEP);

    if (parts.length < 5) {
      continue;
    }

    const [hash, subject, body, author, date] = parts;

    if (!hash || !subject) {
      continue;
    }

    const trimmedBody = body?.trim();

    commits.push({
      hash: hash.trim(),
      subject: subject.trim(),
      body: trimmedBody || undefined,
      message: trimmedBody ? `${subject.trim()}\n\n${trimmedBody}` : subject.trim(),
      author: author?.trim() || 'Unknown',
      date: date?.trim() || new Date().toISOString(),
    });
  }

  return commits;
}

/**
 * Get commit count for a PR
 */
export function getPRCommitCount(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  remote: string = 'origin'
): number {
  const command = `git rev-list --count ${remote}/${targetBranch}..${remote}/${sourceBranch} --no-merges`;

  try {
    const output = execSync(command, {
      cwd: repoPath,
      encoding: 'utf-8',
    });

    return parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}
