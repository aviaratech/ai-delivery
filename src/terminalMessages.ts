export type TerminalSeverity = 'debug' | 'error' | 'info' | 'progress' | 'success' | 'warning';

const SEVERITY_LABELS = {
  debug: 'DEBUG',
  error: 'ERROR',
  info: 'INFO',
  progress: 'PROGRESS',
  success: 'SUCCESS',
  warning: 'WARNING',
} satisfies Record<TerminalSeverity, string>;

export function formatTerminalLogLine(severity: TerminalSeverity, message: string): string {
  return `${formatTerminalSeverityPrefix(severity)} ${message}`;
}

export function formatTerminalSeverityPrefix(severity: TerminalSeverity): string {
  return `[${SEVERITY_LABELS[severity]}]`;
}
