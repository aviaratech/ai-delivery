import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const ISSUE_CLI_DATA_DIR = '.issue-cli';

/**
 * Ensure the `.issue-cli` runtime directory exists.
 * All agent runtime data (worktrees, metrics, audit logs) lives here.
 *
 * @param projectRoot - Project root directory (defaults to cwd)
 * @returns Absolute path to the data directory
 */
export function ensureDataDirectory(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  const dataDir = resolve(root, ISSUE_CLI_DATA_DIR);

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  return dataDir;
}
