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
    console.error(chalk.gray(formatTerminalLogLine('debug', message)));
  }
};

export const logInfo = (message: string) => {
  if (logsSuppressed) {
    return;
  }
  console.error(chalk.blue(formatTerminalLogLine('info', message)));
};

export const logWarn = (message: string) => {
  if (logsSuppressed) {
    return;
  }
  console.warn(chalk.yellow(formatTerminalLogLine('warning', message)));
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
