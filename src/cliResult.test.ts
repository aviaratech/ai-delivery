import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'vitest';
import { pathToFileURL } from 'node:url';

test('CLI preserves recoverable start JSON and exits nonzero after creation failure', () => {
  const helper = pathToFileURL(join(process.cwd(), 'dist', 'cliResult.js')).href;
  const failure = {
    schemaVersion: 'ai-delivery.issue-start-registration@1',
    status: 'created-not-started',
    createdIssue: { number: 17 },
  };
  const code =
    `import { printCommandResult } from ${JSON.stringify(helper)};` +
    `printCommandResult('issue_start', ${JSON.stringify(failure)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), failure);
  assert.equal(result.stderr, '');

  const ordinary = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { printCommandResult } from ${JSON.stringify(helper)};` +
        `printCommandResult('issue_start', {status:'started'});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(ordinary.status, 0);
  const parsed: unknown = JSON.parse(ordinary.stdout);
  assert.ok(parsed !== null && typeof parsed === 'object' && 'status' in parsed);
  assert.equal(parsed.status, 'started');
});
