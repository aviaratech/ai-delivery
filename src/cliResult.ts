import { getMachineRequestDiagnostics } from './errors.js';
import { getIncompleteIssueUpdate } from './issue.js';

/** Keep a recoverable start failure machine-readable while signalling shell failure. */
export function printCommandResult(command: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, command === 'board_reconcile' ? undefined : 2)}\n`);
  if (command === 'board_reconcile' && typeof value === 'object' && value !== null) {
    if ('scopeComplete' in value && value.scopeComplete === false) process.exitCode = 1;
    if (
      'schemaVersion' in value &&
      value.schemaVersion === 'ai-delivery.board-reconcile-result@1' &&
      'summary' in value &&
      typeof value.summary === 'object' &&
      value.summary !== null
    ) {
      const summary = value.summary as Record<string, unknown>;
      if (
        ['failed', 'drifted', 'refused', 'unknown', 'unresolved'].some(
          (key) => typeof summary[key] === 'number' && summary[key] > 0,
        )
      )
        process.exitCode = 1;
    }
  }
  if (
    command === 'issue_batch_update' &&
    typeof value === 'object' &&
    value !== null &&
    'summary' in value &&
    typeof value.summary === 'object' &&
    value.summary !== null &&
    'failed' in value.summary &&
    typeof value.summary.failed === 'number' &&
    value.summary.failed > 0
  )
    process.exitCode = 1;
  if (
    command === 'issue_start' &&
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    (value.status === 'created-not-started' || value.status === 'start-incomplete')
  ) {
    process.exitCode = 1;
  }
}

export function printCommandError(error: unknown): void {
  const incomplete = getIncompleteIssueUpdate(error);
  if (incomplete !== undefined) {
    process.stdout.write(`${JSON.stringify(incomplete, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const diagnostic = getMachineRequestDiagnostics(error);
  if (diagnostic)
    process.stderr.write(
      `ai-delivery: request phase=${diagnostic.phase}; endpoint=${diagnostic.endpoint}; status=${diagnostic.status}; code=${diagnostic.code}; requestId=${diagnostic.requestId}\n`,
    );
  process.stderr.write(`ai-delivery: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
