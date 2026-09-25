export type TerminalRunState = 'blocked' | 'completed' | 'failed' | 'ready' | 'review_required' | 'running' | 'unknown';

export type TerminalSeverity = 'debug' | 'error' | 'info' | 'progress' | 'success' | 'warning';

const RUN_STATE_LABELS = {
  blocked: 'BLOCKED',
  completed: 'COMPLETED',
  failed: 'FAILED',
  ready: 'READY',
  review_required: 'REVIEW REQUIRED',
  running: 'RUNNING',
  unknown: 'UNKNOWN',
} satisfies Record<TerminalRunState, string>;

const SEVERITY_LABELS = {
  debug: 'DEBUG',
  error: 'ERROR',
  info: 'INFO',
  progress: 'PROGRESS',
  success: 'SUCCESS',
  warning: 'WARNING',
} satisfies Record<TerminalSeverity, string>;

export interface TerminalStatusBlock {
  explanation?: string;
  nextAction?: string;
  state: TerminalRunState;
  stopReason?: string;
  title?: string;
}

export function formatTerminalLogLine(severity: TerminalSeverity, message: string): string {
  return `${formatTerminalSeverityPrefix(severity)} ${message}`;
}

export function formatTerminalSeverityPrefix(severity: TerminalSeverity): string {
  return `[${SEVERITY_LABELS[severity]}]`;
}

export function formatTerminalStateLabel(state: TerminalRunState): string {
  return RUN_STATE_LABELS[state];
}

export function formatTerminalStatusBlock(block: TerminalStatusBlock): string {
  const lines = [`Status: ${formatTerminalStateLabel(block.state)}`];
  if (block.stopReason !== undefined && block.stopReason.length > 0) {
    lines.push(`Stop reason: ${block.stopReason}`);
  }
  if (block.title !== undefined && block.title.length > 0) {
    lines.push(`Diagnosis: ${block.title}`);
  }
  if (block.explanation !== undefined && block.explanation.length > 0) {
    lines.push(`Explanation: ${block.explanation}`);
  }
  if (block.nextAction !== undefined && block.nextAction.length > 0) {
    lines.push(`Next action: ${block.nextAction}`);
  }
  return lines.join('\n');
}
