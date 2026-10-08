import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { pathToFileURL } from 'node:url';

test('CLI version agrees with its adjacent package independently of caller cwd', () => {
  const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(typeof metadata === 'object' && metadata !== null && 'version' in metadata);
  assert.equal(typeof metadata.version, 'string');
  const cli = join(process.cwd(), 'dist', 'cli.js');
  const caller = mkdtempSync(join(tmpdir(), 'ai-delivery-version-caller-'));
  try {
    writeFileSync(join(caller, 'package.json'), JSON.stringify({ name: 'unrelated-caller', version: '9.9.9' }));
    const result = spawnSync(process.execPath, [cli, '--version'], { cwd: caller, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), metadata.version);
    const versionModule = pathToFileURL(join(process.cwd(), 'dist', 'version.js')).href;
    const shared = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { PACKAGE_VERSION } from ${JSON.stringify(versionModule)}; console.log(PACKAGE_VERSION);`,
      ],
      { cwd: caller, encoding: 'utf8' },
    );
    assert.equal(shared.status, 0, shared.stderr);
    assert.equal(shared.stderr, '');
    assert.equal(shared.stdout.trim(), metadata.version);
  } finally {
    rmSync(caller, { recursive: true, force: true });
  }
});

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
