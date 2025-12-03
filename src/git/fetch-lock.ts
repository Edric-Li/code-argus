/**
 * Git fetch lock utility to prevent concurrent fetch conflicts
 *
 * When multiple argus processes run against the same repository,
 * they may conflict on `git fetch` due to git's internal locking.
 * This module provides:
 * - File-based locking to serialize fetch operations
 * - Time window caching to skip redundant fetches
 * - Stale lock cleanup for crashed processes
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { setTimeout } from 'node:timers';

// ============================================================================
// Configuration
// ============================================================================

/** Time window to skip redundant fetches (default: 30 seconds) */
const FETCH_CACHE_TTL = parseInt(process.env.ARGUS_FETCH_CACHE_TTL || '30000', 10);

/** Lock timeout - consider lock stale after this duration (default: 60 seconds) */
const LOCK_TIMEOUT = parseInt(process.env.ARGUS_FETCH_LOCK_TIMEOUT || '60000', 10);

/** Delay between retry attempts in milliseconds (default: 500ms) */
const RETRY_DELAY = parseInt(process.env.ARGUS_FETCH_RETRY_DELAY || '500', 10);

/** Maximum number of retry attempts (default: 10) */
const MAX_RETRIES = parseInt(process.env.ARGUS_FETCH_MAX_RETRIES || '10', 10);

// ============================================================================
// Types
// ============================================================================

interface FetchLock {
  pid: number;
  timestamp: number;
  remote: string;
}

/** Tracks the lock we acquired so we can safely release only our own lock */
interface AcquiredLock {
  lockPath: string;
  timestamp: number;
}

// ============================================================================
// Path Helpers
// ============================================================================

function getLockPath(repoPath: string): string {
  return join(repoPath, '.git', 'argus-fetch.lock');
}

function getCachePath(repoPath: string, remote: string): string {
  return join(repoPath, '.git', `argus-fetch-${remote}.time`);
}

// ============================================================================
// Process Detection
// ============================================================================

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Lock Management
// ============================================================================

/**
 * Attempt to acquire the fetch lock
 * Returns the acquired lock info if successful, null otherwise
 */
function tryAcquireLock(lockPath: string, remote: string): AcquiredLock | null {
  try {
    if (existsSync(lockPath)) {
      try {
        const lockContent = readFileSync(lockPath, 'utf-8');
        const lock: FetchLock = JSON.parse(lockContent);

        const lockAge = Date.now() - lock.timestamp;
        const isStale = lockAge > LOCK_TIMEOUT;
        const isOrphan = !isProcessAlive(lock.pid);

        if (isStale || isOrphan) {
          try {
            unlinkSync(lockPath);
          } catch {
            return null;
          }
        } else {
          return null;
        }
      } catch {
        try {
          unlinkSync(lockPath);
        } catch {
          return null;
        }
      }
    }

    const timestamp = Date.now();
    const lockData: FetchLock = {
      pid: process.pid,
      timestamp,
      remote,
    };
    writeFileSync(lockPath, JSON.stringify(lockData), { flag: 'wx' });

    return { lockPath, timestamp };
  } catch {
    return null;
  }
}

/**
 * Release the fetch lock safely
 * Only releases if the lock still belongs to us (same pid AND timestamp)
 */
function releaseLock(acquiredLock: AcquiredLock): void {
  try {
    if (!existsSync(acquiredLock.lockPath)) {
      return;
    }

    const lockContent = readFileSync(acquiredLock.lockPath, 'utf-8');
    const lock: FetchLock = JSON.parse(lockContent);

    // Only delete if BOTH pid and timestamp match
    // This prevents deleting a lock that was recreated by another process
    if (lock.pid === process.pid && lock.timestamp === acquiredLock.timestamp) {
      unlinkSync(acquiredLock.lockPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// ============================================================================
// Cache Management
// ============================================================================

function hasRecentFetch(cachePath: string): boolean {
  try {
    if (!existsSync(cachePath)) {
      return false;
    }
    const content = readFileSync(cachePath, 'utf-8');
    const lastFetch = parseInt(content, 10);
    if (isNaN(lastFetch)) {
      return false;
    }
    return Date.now() - lastFetch < FETCH_CACHE_TTL;
  } catch {
    return false;
  }
}

function updateFetchCache(cachePath: string): void {
  try {
    writeFileSync(cachePath, Date.now().toString());
  } catch {
    // Cache update failure is non-fatal
  }
}

// ============================================================================
// Utility
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  const sharedBuffer = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sharedBuffer);
  Atomics.wait(int32, 0, 0, ms);
}

// ============================================================================
// Core Fetch Logic
// ============================================================================

interface ExecuteFetchResult {
  success: boolean;
  executed: boolean;
  reason?: string;
}

function executeFetch(repoPath: string, remote: string, cachePath: string): ExecuteFetchResult {
  try {
    execSync(`git fetch ${remote}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    updateFetchCache(cachePath);
    return { success: true, executed: true };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return {
      success: false,
      executed: true,
      reason: err.stderr || err.message || 'git fetch failed',
    };
  }
}

// ============================================================================
// Main Export
// ============================================================================

export interface FetchWithLockOptions {
  repoPath: string;
  remote?: string;
  /** Force fetch even if recent fetch exists */
  force?: boolean;
}

export interface FetchWithLockResult {
  success: boolean;
  /** Whether fetch was actually executed or skipped due to cache */
  executed: boolean;
  /** Reason for skipping or failure */
  reason?: string;
}

/**
 * Execute git fetch with file locking and caching (async version)
 */
export async function fetchWithLock(options: FetchWithLockOptions): Promise<FetchWithLockResult> {
  const { repoPath, remote = 'origin', force = false } = options;

  const lockPath = getLockPath(repoPath);
  const cachePath = getCachePath(repoPath, remote);

  // Check time window cache first
  if (!force && hasRecentFetch(cachePath)) {
    return {
      success: true,
      executed: false,
      reason: 'Recent fetch exists within cache TTL',
    };
  }

  // Try to acquire lock with retries
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const acquiredLock = tryAcquireLock(lockPath, remote);

    if (acquiredLock) {
      try {
        // Double-check cache after acquiring lock
        if (!force && hasRecentFetch(cachePath)) {
          return {
            success: true,
            executed: false,
            reason: 'Another process completed fetch while waiting for lock',
          };
        }

        return executeFetch(repoPath, remote, cachePath);
      } finally {
        releaseLock(acquiredLock);
      }
    }

    // Wait before retry with jitter
    await sleep(RETRY_DELAY + Math.random() * 200);
  }

  return {
    success: false,
    executed: false,
    reason: `Could not acquire fetch lock after ${MAX_RETRIES} attempts`,
  };
}

/**
 * Execute git fetch with file locking and caching (sync version)
 */
export function fetchWithLockSync(repoPath: string, remote: string = 'origin'): boolean {
  const lockPath = getLockPath(repoPath);
  const cachePath = getCachePath(repoPath, remote);

  // Check time window cache first
  if (hasRecentFetch(cachePath)) {
    return true;
  }

  // Sync version uses fewer retries
  const syncRetries = Math.min(MAX_RETRIES, 5);

  for (let attempt = 0; attempt < syncRetries; attempt++) {
    const acquiredLock = tryAcquireLock(lockPath, remote);

    if (acquiredLock) {
      try {
        // Double-check cache after acquiring lock
        if (hasRecentFetch(cachePath)) {
          return true;
        }

        const result = executeFetch(repoPath, remote, cachePath);
        return result.success;
      } finally {
        releaseLock(acquiredLock);
      }
    }

    // Sleep before retry (except on last attempt)
    if (attempt < syncRetries - 1) {
      sleepSync(RETRY_DELAY + Math.floor(Math.random() * 100));
    }
  }

  console.warn(`Warning: Could not acquire fetch lock for ${remote}, using existing refs`);
  return false;
}

/**
 * Clean up argus fetch lock and cache files
 */
export function cleanupFetchLock(repoPath: string, remote: string = 'origin'): void {
  const lockPath = getLockPath(repoPath);
  const cachePath = getCachePath(repoPath, remote);

  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Ignore
  }

  try {
    if (existsSync(cachePath)) {
      unlinkSync(cachePath);
    }
  } catch {
    // Ignore
  }
}
