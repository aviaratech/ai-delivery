import { resolve } from 'node:path';
import * as lockfile from 'proper-lockfile';

import { logDebug, logWarn } from '../logger.js';

const LOCK_OPTIONS = {
  realpath: false,
  retries: 0,
  stale: 10000, // 10 seconds - auto-release stale locks
};

const LOCK_RETRY_DELAY_MS = 200;

interface WithLockOptions<T> {
  onCompromised?: (error: Error) => void;
  onReleaseError?: (error: unknown) => void;
  onTimeout?: () => void;
  operation: () => Promise<T> | T;
  projectRoot?: string;
  timeout?: number;
}

/**
 * Execute a function with exclusive file lock
 * Prevents concurrent modifications to the worktree registry
 */
export async function withLock<T>(
  filePath: string,
  { onCompromised, onReleaseError, onTimeout, operation, projectRoot, timeout }: WithLockOptions<T>,
): Promise<T> {
  const root = projectRoot ?? process.cwd();
  const lockPath = resolve(root, filePath);

  let release: (() => Promise<void>) | null = null;
  const timeoutInterval = typeof timeout === 'number' && timeout > 0 ? timeout : null;
  const maxAttempts = timeoutInterval !== null ? Math.ceil(timeoutInterval / LOCK_RETRY_DELAY_MS) : null;
  let attempts = 0;
  let nextTimeoutAt = timeoutInterval === null ? null : Date.now() + timeoutInterval;
  let warned = false;

  try {
    for (;;) {
      // Enforce hard timeout by breaking after max attempts
      if (maxAttempts !== null && attempts >= maxAttempts) {
        const timeoutLabel = timeoutInterval === null ? 'unknown' : String(timeoutInterval);
        throw new Error(
          `Lock acquisition timeout after ${timeoutLabel}ms on ${lockPath}. Another process may be holding the lock.`,
        );
      }

      attempts += 1;
      const attemptLabel = maxAttempts !== null ? `${String(attempts)}/${String(maxAttempts)}` : String(attempts);
      logDebug(`Acquiring lock on ${lockPath}... (attempt ${attemptLabel})`);

      try {
        release = await lockfile.lock(lockPath, {
          ...LOCK_OPTIONS,
          ...(onCompromised === undefined ? {} : { onCompromised }),
        });
        logDebug(`Lock acquired on ${lockPath}`);
        break;
      } catch (error: unknown) {
        if (!isLockError(error)) {
          throw error;
        }

        if (!warned) {
          logWarn(`Unable to acquire lock on ${lockPath} - another agent is modifying it. Retrying...`);
          warned = true;
        }

        if (nextTimeoutAt !== null && timeoutInterval !== null && Date.now() >= nextTimeoutAt) {
          onTimeout?.();
          nextTimeoutAt = Date.now() + timeoutInterval;
        }

        await delay(LOCK_RETRY_DELAY_MS);
      }
    }

    return await operation();
  } finally {
    if (release !== null) {
      try {
        await release();
        logDebug(`Lock released on ${lockPath}`);
      } catch (error: unknown) {
        onReleaseError?.(error);
        // Lock release failure is non-fatal - stale lock will auto-expire
        logDebug(`Failed to release lock on ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === 'ELOCKED';
}
