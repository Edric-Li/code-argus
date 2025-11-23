/**
 * Commit Filter
 * Filters out invalid commits (reverts, vague messages, merges)
 */

import type { RawCommit, FilteredCommit, CommitFilterResult, ExcludeReason } from './types.js';

/**
 * Vague words that indicate a non-descriptive commit message
 */
const VAGUE_PATTERNS = [
  /^fix$/i,
  /^fixes$/i,
  /^fixed$/i,
  /^update$/i,
  /^updates$/i,
  /^updated$/i,
  /^change$/i,
  /^changes$/i,
  /^changed$/i,
  /^modify$/i,
  /^modified$/i,
  /^edit$/i,
  /^edited$/i,
  /^wip$/i,
  /^work in progress$/i,
  /^temp$/i,
  /^tmp$/i,
  /^test$/i,
  /^testing$/i,
  /^debug$/i,
  /^stuff$/i,
  /^misc$/i,
  /^minor$/i,
  /^small$/i,
  /^some\s+\w+$/i, // "some changes", "some fixes"
  /^various$/i,
  /^cleanup$/i,
  /^clean up$/i,
  /^\.+$/, // just dots "..."
  /^-+$/, // just dashes "---"
];

/**
 * Patterns for ticket/issue numbers only (no description)
 */
const TICKET_ONLY_PATTERNS = [
  /^[A-Z]+-\d+$/, // JIRA-123
  /^#\d+$/, // #123
  /^\[\w+-\d+\]$/, // [JIRA-123]
  /^\(\w+-\d+\)$/, // (JIRA-123)
  /^issue\s*#?\d+$/i, // issue #123, issue 123
  /^bug\s*#?\d+$/i, // bug #123
  /^task\s*#?\d+$/i, // task #123
];

/**
 * Minimum meaningful subject length
 */
const MIN_SUBJECT_LENGTH = 10;

/**
 * Filter commits to exclude invalid ones
 *
 * @param commits - Array of raw commits
 * @returns Filtered result with valid and excluded commits
 */
export function filterCommits(commits: RawCommit[]): CommitFilterResult {
  const valid: RawCommit[] = [];
  const excluded: FilteredCommit[] = [];

  let reverts = 0;
  let vague = 0;
  let merges = 0;
  let empty = 0;

  for (const commit of commits) {
    const excludeReason = getExcludeReason(commit);

    if (excludeReason) {
      excluded.push({
        ...commit,
        excluded: true,
        excludeReason,
      });

      switch (excludeReason) {
        case 'revert':
          reverts++;
          break;
        case 'vague':
          vague++;
          break;
        case 'merge':
          merges++;
          break;
        case 'empty':
          empty++;
          break;
      }
    } else {
      valid.push(commit);
    }
  }

  return {
    valid,
    excluded,
    stats: {
      total: commits.length,
      valid: valid.length,
      reverts,
      vague,
      merges,
      empty,
    },
  };
}

/**
 * Determine if and why a commit should be excluded
 */
function getExcludeReason(commit: RawCommit): ExcludeReason | null {
  const subject = commit.subject.trim();

  // Check for empty
  if (!subject) {
    return 'empty';
  }

  // Check for revert
  if (isRevertCommit(commit)) {
    return 'revert';
  }

  // Check for merge (shouldn't happen with --no-merges, but just in case)
  if (isMergeCommit(commit)) {
    return 'merge';
  }

  // Check for vague message
  if (isVagueCommit(commit)) {
    return 'vague';
  }

  return null;
}

/**
 * Check if commit is a revert
 */
function isRevertCommit(commit: RawCommit): boolean {
  const subject = commit.subject.toLowerCase();
  const message = commit.message.toLowerCase();

  return (
    subject.startsWith('revert') ||
    message.includes('this reverts commit') ||
    /^revert\s*[:-]?\s*/i.test(subject)
  );
}

/**
 * Check if commit is a merge commit
 */
function isMergeCommit(commit: RawCommit): boolean {
  const subject = commit.subject.toLowerCase();

  return (
    subject.startsWith('merge') ||
    subject.startsWith('merge branch') ||
    subject.startsWith('merge pull request') ||
    subject.startsWith('merge remote')
  );
}

/**
 * Check if commit message is too vague to be useful
 */
function isVagueCommit(commit: RawCommit): boolean {
  const subject = commit.subject.trim();

  // Too short
  if (subject.length < MIN_SUBJECT_LENGTH) {
    // But allow conventional commits like "fix: xxx" even if short
    if (!hasConventionalPrefix(subject)) {
      return true;
    }
  }

  // Matches vague patterns
  for (const pattern of VAGUE_PATTERNS) {
    if (pattern.test(subject)) {
      return true;
    }
  }

  // Ticket number only (no description)
  for (const pattern of TICKET_ONLY_PATTERNS) {
    if (pattern.test(subject)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if message has a conventional commit prefix
 */
function hasConventionalPrefix(subject: string): boolean {
  const conventionalPrefixes = [
    'feat',
    'fix',
    'docs',
    'style',
    'refactor',
    'perf',
    'test',
    'chore',
    'ci',
    'build',
    'revert',
  ];

  const lowerSubject = subject.toLowerCase();

  return conventionalPrefixes.some(
    (prefix) => lowerSubject.startsWith(`${prefix}:`) || lowerSubject.startsWith(`${prefix}(`)
  );
}
