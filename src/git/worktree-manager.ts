/**
 * Worktree Manager - Persistent worktree management with caching and cleanup
 *
 * Instead of creating temporary worktrees for each review, this manager:
 * - Uses a fixed parent directory for all worktrees
 * - Names worktrees based on repo + branch/commit for reuse
 * - Reuses existing worktrees by updating their checkout
 * - Automatically cleans up stale worktrees older than configured days
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { GitError } from './type.js';
import type { GitRef } from './ref.js';

// ============================================================================
// Configuration
// ============================================================================

/** Default parent directory for all worktrees */
const DEFAULT_WORKTREE_BASE = join(homedir(), '.code-argus', 'worktrees');

/** Default age in days before a worktree is considered stale */
const DEFAULT_STALE_DAYS = 5;

// ============================================================================
// Types
// ============================================================================

/**
 * Logger interface for worktree operations
 */
export interface WorktreeLogger {
  /** Log informational messages */
  info(message: string): void;
  /** Log debug/verbose messages */
  debug?(message: string): void;
}

export interface WorktreeManagerOptions {
  /** Base directory for worktrees (default: ~/.code-argus/worktrees) */
  baseDir?: string;
  /** Days before worktree is considered stale (default: 5) */
  staleDays?: number;
  /** Whether to run cleanup on each operation (default: true) */
  autoCleanup?: boolean;
  /** Logger for worktree operations (optional) */
  logger?: WorktreeLogger;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

export interface ManagedWorktreeInfo {
  /** Path to the worktree directory */
  worktreePath: string;
  /** Original repository path */
  originalRepoPath: string;
  /** Branch/ref checked out in the worktree */
  checkedOutRef: string;
  /** Whether this worktree was reused (vs newly created) */
  reused: boolean;
}

// ============================================================================
// Worktree Manager
// ============================================================================

/**
 * Manages persistent worktrees with caching and automatic cleanup
 */
export class WorktreeManager {
  private baseDir: string;
  private staleDays: number;
  private autoCleanup: boolean;
  private logger?: WorktreeLogger;
  private verbose: boolean;

  constructor(options: WorktreeManagerOptions = {}) {
    this.baseDir = options.baseDir || DEFAULT_WORKTREE_BASE;
    this.staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
    this.autoCleanup = options.autoCleanup ?? true;
    this.logger = options.logger;
    this.verbose = options.verbose ?? false;

    // Ensure base directory exists
    this.ensureBaseDir();
  }

  /**
   * Log an informational message
   */
  private logInfo(message: string): void {
    if (this.logger) {
      this.logger.info(message);
    } else if (this.verbose) {
      console.log(message);
    }
  }

  /**
   * Log a debug/verbose message
   */
  private logDebug(message: string): void {
    if (this.logger?.debug) {
      this.logger.debug(message);
    } else if (this.verbose) {
      console.log(message);
    }
  }

  /**
   * Ensure the base worktree directory exists
   */
  private ensureBaseDir(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Generate a safe directory name for a worktree
   *
   * Format: {repoName}_{branchOrCommit}
   * Special characters are replaced with underscores
   */
  private generateWorktreeName(repoPath: string, ref: string): string {
    const repoName = basename(repoPath);
    // Replace path separators and special chars with underscores
    const safeRef = ref.replace(/[/\\:*?"<>|]/g, '_');
    return `${repoName}_${safeRef}`;
  }

  /**
   * Get the full path for a worktree
   */
  private getWorktreePath(repoPath: string, ref: string): string {
    const name = this.generateWorktreeName(repoPath, ref);
    return join(this.baseDir, name);
  }

  /**
   * Check if a worktree exists and is valid
   */
  private isValidWorktree(worktreePath: string, repoPath: string): boolean {
    if (!existsSync(worktreePath)) {
      return false;
    }

    // Check if it's a valid git worktree
    try {
      execSync('git rev-parse --git-dir', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      return true;
    } catch {
      // Directory exists but is not a valid worktree - clean it up
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        // Also prune from git
        execSync('git worktree prune', {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch {
        // Ignore cleanup errors
      }
      return false;
    }
  }

  /**
   * Update an existing worktree to a new ref
   */
  private updateWorktree(worktreePath: string, checkoutRef: string): void {
    try {
      // Fetch latest and checkout the ref
      execSync(`git checkout --detach ${checkoutRef}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      throw new GitError(
        `Failed to update worktree to ${checkoutRef}`,
        'WORKTREE_UPDATE_FAILED',
        err.stderr || err.message
      );
    }
  }

  /**
   * Create a new worktree
   */
  private createWorktree(repoPath: string, worktreePath: string, checkoutRef: string): void {
    try {
      execSync(`git worktree add --detach "${worktreePath}" ${checkoutRef}`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      throw new GitError(
        `Failed to create worktree for ${checkoutRef}`,
        'WORKTREE_CREATE_FAILED',
        err.stderr || err.message
      );
    }
  }

  /**
   * Touch a worktree directory to update its modification time
   */
  private touchWorktree(worktreePath: string): void {
    try {
      // Update mtime by touching a marker file
      const markerPath = join(worktreePath, '.argus-last-used');
      execSync(`touch "${markerPath}"`, { stdio: 'pipe' });
    } catch {
      // Ignore touch errors
    }
  }

  /**
   * Get or create a worktree for a branch
   *
   * If worktree exists, updates it to the latest ref.
   * If not, creates a new one.
   */
  getOrCreateWorktree(
    repoPath: string,
    sourceBranch: string,
    remote: string = 'origin'
  ): ManagedWorktreeInfo {
    if (this.autoCleanup) {
      this.cleanupStaleWorktrees(repoPath);
    }

    const remoteRef = `${remote}/${sourceBranch}`;
    const worktreePath = this.getWorktreePath(repoPath, sourceBranch);
    const reused = this.isValidWorktree(worktreePath, repoPath);

    if (reused) {
      // Update existing worktree
      this.logDebug(`[WorktreeManager] Reusing existing worktree: ${worktreePath}`);
      this.updateWorktree(worktreePath, remoteRef);
    } else {
      // Create new worktree
      this.logDebug(`[WorktreeManager] Creating new worktree: ${worktreePath}`);
      this.createWorktree(repoPath, worktreePath, remoteRef);
    }

    // Update last-used timestamp
    this.touchWorktree(worktreePath);

    return {
      worktreePath,
      originalRepoPath: repoPath,
      checkedOutRef: remoteRef,
      reused,
    };
  }

  /**
   * Get or create a worktree for a GitRef (branch or commit)
   */
  getOrCreateWorktreeForRef(repoPath: string, ref: GitRef): ManagedWorktreeInfo {
    if (this.autoCleanup) {
      this.cleanupStaleWorktrees(repoPath);
    }

    // Determine the checkout ref and naming key
    const checkoutRef =
      ref.type === 'commit'
        ? ref.resolvedSha || ref.value
        : `${ref.remote || 'origin'}/${ref.value}`;

    // For commits, use short SHA for directory name; for branches, use branch name
    const nameKey = ref.type === 'commit' ? (ref.resolvedSha || ref.value).slice(0, 12) : ref.value;

    const worktreePath = this.getWorktreePath(repoPath, nameKey);
    const reused = this.isValidWorktree(worktreePath, repoPath);

    if (reused) {
      this.logDebug(`[WorktreeManager] Reusing existing worktree: ${worktreePath}`);
      this.updateWorktree(worktreePath, checkoutRef);
    } else {
      this.logDebug(`[WorktreeManager] Creating new worktree: ${worktreePath}`);
      this.createWorktree(repoPath, worktreePath, checkoutRef);
    }

    this.touchWorktree(worktreePath);

    return {
      worktreePath,
      originalRepoPath: repoPath,
      checkedOutRef: checkoutRef,
      reused,
    };
  }

  /**
   * Clean up stale worktrees older than configured days
   */
  cleanupStaleWorktrees(repoPath?: string): number {
    const now = Date.now();
    const staleMs = this.staleDays * 24 * 60 * 60 * 1000;
    let cleanedCount = 0;

    try {
      const entries = readdirSync(this.baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const worktreePath = join(this.baseDir, entry.name);
        const markerPath = join(worktreePath, '.argus-last-used');

        // Check last-used marker or directory mtime
        let lastUsed: number;
        try {
          if (existsSync(markerPath)) {
            lastUsed = statSync(markerPath).mtimeMs;
          } else {
            lastUsed = statSync(worktreePath).mtimeMs;
          }
        } catch {
          // Can't stat, assume stale
          lastUsed = 0;
        }

        if (now - lastUsed > staleMs) {
          this.logInfo(
            `[WorktreeManager] Cleaning up stale worktree: ${entry.name} (age: ${Math.floor((now - lastUsed) / (24 * 60 * 60 * 1000))} days)`
          );

          try {
            // Try git worktree remove first
            if (repoPath) {
              execSync(`git worktree remove --force "${worktreePath}"`, {
                cwd: repoPath,
                encoding: 'utf-8',
                stdio: 'pipe',
              });
            } else {
              // No repo path, just delete directory
              rmSync(worktreePath, { recursive: true, force: true });
            }
            cleanedCount++;
          } catch {
            // Fallback to direct removal
            try {
              rmSync(worktreePath, { recursive: true, force: true });
              cleanedCount++;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.logInfo(`[WorktreeManager] Failed to clean up: ${worktreePath} (${message})`);
            }
          }
        }
      }

      // Prune git worktree references
      if (repoPath && cleanedCount > 0) {
        try {
          execSync('git worktree prune', {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: 'pipe',
          });
        } catch {
          // Ignore prune errors
        }
      }
    } catch {
      // Ignore read errors
    }

    if (cleanedCount > 0) {
      this.logInfo(`[WorktreeManager] Cleaned up ${cleanedCount} stale worktrees`);
    }

    return cleanedCount;
  }

  /**
   * Force remove a specific worktree
   */
  removeWorktree(worktreePath: string, repoPath?: string): void {
    try {
      if (repoPath) {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } else {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // Fallback to direct removal
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logInfo(`[WorktreeManager] Failed to remove worktree: ${worktreePath} (${message})`);
      }
    }
  }

  /**
   * List all managed worktrees
   */
  listWorktrees(): Array<{ name: string; path: string; lastUsed: Date }> {
    const result: Array<{ name: string; path: string; lastUsed: Date }> = [];

    try {
      const entries = readdirSync(this.baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const worktreePath = join(this.baseDir, entry.name);
        const markerPath = join(worktreePath, '.argus-last-used');

        let lastUsed: Date;
        try {
          if (existsSync(markerPath)) {
            lastUsed = statSync(markerPath).mtime;
          } else {
            lastUsed = statSync(worktreePath).mtime;
          }
        } catch {
          lastUsed = new Date(0);
        }

        result.push({
          name: entry.name,
          path: worktreePath,
          lastUsed,
        });
      }
    } catch {
      // Ignore read errors
    }

    return result.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/** Default worktree manager instance */
let defaultManager: WorktreeManager | null = null;

/**
 * Get the default worktree manager instance
 *
 * Note: When options are provided, a new instance is created to ensure
 * the latest logger/verbose settings are used. This is intentional as
 * different callers may need different logging configurations.
 * The core worktree management (baseDir, staleDays) remains consistent.
 */
export function getWorktreeManager(options?: WorktreeManagerOptions): WorktreeManager {
  if (!defaultManager || options) {
    defaultManager = new WorktreeManager(options);
  }
  return defaultManager;
}

/**
 * Convenience function: Get or create worktree for a branch
 */
export function getOrCreateWorktree(
  repoPath: string,
  sourceBranch: string,
  remote: string = 'origin',
  options?: WorktreeManagerOptions
): ManagedWorktreeInfo {
  return getWorktreeManager(options).getOrCreateWorktree(repoPath, sourceBranch, remote);
}

/**
 * Convenience function: Get or create worktree for a GitRef
 */
export function getOrCreateWorktreeForRef(
  repoPath: string,
  ref: GitRef,
  options?: WorktreeManagerOptions
): ManagedWorktreeInfo {
  return getWorktreeManager(options).getOrCreateWorktreeForRef(repoPath, ref);
}

/**
 * Convenience function: Clean up stale worktrees
 */
export function cleanupStaleWorktrees(repoPath?: string): number {
  return getWorktreeManager().cleanupStaleWorktrees(repoPath);
}
