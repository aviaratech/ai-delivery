import { runStageCommand } from './verification.js';

export async function captureAuthenticationProbe(
  cwd: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<{ failed: boolean; stdout: string; diagnostic: string; cleanupConfirmed: boolean }> {
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(cancel, timeoutMs);
  let diagnostic = '';
  let cleanupConfirmed = false;
  try {
    const output = await runStageCommand(
      cwd,
      argv,
      cancellation.signal,
      { maxAggregateRssBytes: 1024 ** 3, minFreeDiskBytes: 256 * 1024 ** 2, maxNewOutputBytes: 1024 * 1024 },
      {
        starting: () => {},
        observed: () => {},
        idle: () => {
          cleanupConfirmed = true;
        },
        assertQuiescent: () => {},
      },
      {
        environment,
        cwd,
        maxCapturedOutputBytes: 1024 * 1024,
        stdoutOnly: true,
        failedOutput: (bytes) => {
          // Only the final CLI-owned allowlisted classification may leave this
          // bounded capture. Opaque stdout/stderr never reaches logs or files.
          const finalLine = bytes.toString('utf8').trimEnd().split(/\r?\n/u).at(-1);
          if (
            [
              'ai-delivery: Configured personal author token is invalid or expired; refresh the selected token.',
              'ai-delivery: Machine GitHub session is invalid or expired; verify the selected github.com account.',
              'ai-delivery: Author cannot read the selected GitHub repository; verify configured access.',
              'ai-delivery: Reviewer GitHub App cannot read the selected repository; verify its installation and repository access.',
            ].includes(finalLine ?? '')
          )
            diagnostic = finalLine!;
          return ' Authentication probe failed; raw output withheld.';
        },
      },
    );
    return {
      failed: !cleanupConfirmed,
      stdout: cleanupConfirmed ? output.toString('utf8') : '',
      diagnostic,
      cleanupConfirmed,
    };
  } catch {
    return { failed: true, stdout: '', diagnostic, cleanupConfirmed };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
