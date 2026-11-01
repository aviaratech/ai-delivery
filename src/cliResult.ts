import { getMachineRequestDiagnostics } from './errors.js';
import { getIncompleteIssueUpdate } from './issue.js';
import { projectToolOutput } from './toolOutput.js';

/** Keep a recoverable start failure machine-readable while signalling shell failure. */
export function printCommandResult(command: string, value: unknown, verbose = false): void {
  process.stdout.write(`${JSON.stringify(projectToolOutput(command, value, verbose), null, 2)}\n`);
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

export function printCommandError(error: unknown, verbose = false): void {
  const incomplete = getIncompleteIssueUpdate(error);
  if (incomplete !== undefined) {
    process.stdout.write(`${JSON.stringify(projectToolOutput('issue_update', incomplete, verbose), null, 2)}\n`);
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
