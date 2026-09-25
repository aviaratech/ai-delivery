import chalk from 'chalk';

import { formatTerminalLogLine } from './terminalMessages.js';

let logsSuppressed = false;

export const setLogsSuppressed = (suppressed: boolean): void => {
  logsSuppressed = suppressed;
};

export const logDebug = (message: string) => {
  if (logsSuppressed) {
    return;
  }
  if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
    console.log(chalk.gray(formatTerminalLogLine('debug', message)));
  }
};

export const logInfo = (message: string) => {
  if (logsSuppressed) {
    return;
  }
  console.log(chalk.blue(formatTerminalLogLine('info', message)));
};

export const logSuccess = (message: string) => {
  if (logsSuppressed) {
    return;
  }
  console.log(chalk.green(formatTerminalLogLine('success', message)));
};

export const logWarn = (message: string) => {
  if (logsSuppressed) {
    return;
  }
  console.warn(chalk.yellow(formatTerminalLogLine('warning', message)));
};

export const logError = (message: string) => {
  // Errors are never suppressed: they go to stderr, which cannot corrupt JSON
  // stdout or the MCP stdio protocol. A nonzero exit with no diagnostic is
  // worse than stderr noise.
  console.error(chalk.red(formatTerminalLogLine('error', message)));
};

export const logProgress = (message: string): void => {
  if (logsSuppressed) {
    return;
  }
  process.stderr.write(`${chalk.cyan(formatTerminalLogLine('progress', message))}\n`);
};

export type CLIErrorCode =
  | 'FETCH_DEFAULT_BRANCH_FAILED'
  | 'WORKTREE_ATTACH_FAILED'
  | 'WORKTREE_BRANCH_ATTACHED_ELSEWHERE'
  | 'WORKTREE_PATH_CONFLICT'
  | 'WORKTREE_UNKNOWN_STATE';

export interface CLIErrorOptions {
  code?: CLIErrorCode;
  data?: Record<string, unknown>;
  hint?: string;
}

export class CLIError extends Error {
  readonly code: CLIErrorCode | undefined;
  readonly data: Record<string, unknown> | undefined;
  readonly hint: string | undefined;

  constructor(message: string, options: CLIErrorOptions = {}) {
    const resolvedMessage = options.code !== undefined ? `[${options.code}] ${message}` : message;
    super(resolvedMessage);
    this.name = 'CLIError';
    this.code = options.code;
    this.data = options.data;
    this.hint = options.hint;
  }
}

export const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const handleCommandError = (error: unknown): void => {
  logError(error instanceof CLIError ? error.message : formatError(error));
  if (error instanceof CLIError && typeof error.hint === 'string' && error.hint.trim().length > 0) {
    const hintLine = `💡 Recovery: ${error.hint}`;
    if (logsSuppressed) {
      // logInfo writes to stdout and is silenced in JSON/MCP modes; route the
      // recovery hint to stderr so failures stay diagnosable.
      console.error(chalk.blue(formatTerminalLogLine('info', hintLine)));
    } else {
      logInfo(hintLine);
    }
  }
};
