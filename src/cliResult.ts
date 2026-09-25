/** Keep a recoverable start failure machine-readable while signalling shell failure. */
export function printCommandResult(command: string, value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (
    command === 'issue_start' &&
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'created-not-started'
  ) {
    process.exitCode = 1;
  }
}
