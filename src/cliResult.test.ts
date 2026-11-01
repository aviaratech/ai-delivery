import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { pathToFileURL } from 'node:url';
import { DeliveryError, getMachineRequestDiagnostics, setMachineRequestDiagnostics } from './errors.js';

test('actual CLI serializes incomplete native update evidence and exits nonzero', { tags: ['release'] }, () => {
  const cli = pathToFileURL(join(process.cwd(), 'dist', 'cli.js')).href;
  const dispatch = pathToFileURL(join(process.cwd(), 'dist', 'dispatch.js')).href;
  const owner = pathToFileURL(join(process.cwd(), 'dist', 'issue.js')).href;
  const partial = {
    status: 'update-incomplete',
    native: { status: 'unknown', repository: 'example/widget', issueNumber: 17, readback: null },
    project: { status: 'pending', desiredStatus: 'Done' },
    recovery: { tool: 'issue_batch_update' },
  };
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict'; import { mock } from 'node:test'; import { IssueUpdateIncompleteError } from ${JSON.stringify(owner)};
      mock.module(${JSON.stringify(dispatch)}, { exports: {
        contextFor: () => { throw new Error('Unexpected configuration access'); },
        executeTool: async (name, input) => { assert.equal(name, 'issue_update'); assert.equal(input.issueNumber, 17); throw new IssueUpdateIncompleteError(${JSON.stringify(partial)}); }
      }});
      process.argv = [process.execPath, ${JSON.stringify(cli)}, '--repo', 'example/widget', 'update', '--issue', '17', '--state', 'closed', '--close-reason', 'completed'];
      await import(${JSON.stringify(cli)});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), partial);
  assert.equal(result.stderr, '');
});

test('CLI version agrees with its adjacent package independently of caller cwd', { tags: ['release'] }, () => {
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

test('CLI preserves recoverable start JSON and exits nonzero after creation failure', { tags: ['release'] }, () => {
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

test('CLI known-issue incomplete start preserves recovery JSON and exits nonzero', { tags: ['release'] }, () => {
  const helper = pathToFileURL(join(process.cwd(), 'dist', 'cliResult.js')).href;
  const failure = {
    status: 'start-incomplete',
    issueNumber: 17,
    repository: 'example/widget',
    failure: { phase: 'project-status', message: 'Readback failed' },
    safeResume: { tool: 'issue_start', arguments: { repo: 'example/widget', issueNumber: 17, branch: 'issue/17' } },
  };
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { printCommandResult } from ${JSON.stringify(helper)}; printCommandResult('issue_start', ${JSON.stringify(failure)});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), failure);
  assert.equal(result.stderr, '');
});

test('the extracted real CLI error renderer preserves ordinary refusal, exit and stdout', { tags: ['release'] }, () => {
  const helper = pathToFileURL(join(process.cwd(), 'dist', 'cliResult.js')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { printCommandError } from ${JSON.stringify(helper)}; printCommandError(new Error('ordinary refusal'));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'ai-delivery: ordinary refusal\n');
});

test('machine diagnostics are immutable identity-bound data and do not change error serialization', () => {
  const error = new DeliveryError('safe refusal');
  Object.assign(error, { status: 503 });
  const before = JSON.stringify(error);
  const input = {
    phase: 'rest.request',
    endpoint: 'pulls.merge',
    status: 503,
    code: 'ECONNRESET',
    requestId: 'ABCD:1234:5678:9ABC:DEF0',
  };
  setMachineRequestDiagnostics(error, input);
  const diagnostic = getMachineRequestDiagnostics(error);
  assert.deepEqual(diagnostic, {
    phase: 'rest.request',
    endpoint: 'pulls.merge',
    status: 503,
    code: 'ECONNRESET',
    requestId: 'ABCD:1234:5678:9ABC:DEF0',
  });
  assert.ok(diagnostic && Object.isFrozen(diagnostic));
  input.status = 401;
  assert.equal(Reflect.set(diagnostic, 'status', 401), false);
  setMachineRequestDiagnostics(error, input);
  assert.equal(getMachineRequestDiagnostics(error)?.status, 503);
  assert.equal(JSON.stringify(error), before);
  assert.equal(getMachineRequestDiagnostics(new Error('ordinary refusal')), undefined);
  assert.equal(getMachineRequestDiagnostics({ name: 'DeliveryError', status: 503, diagnostic }), undefined);
});

test('invalid machine metadata remains UNKNOWN without getter or coercion execution', () => {
  const invalidStatuses: unknown[] = [
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    99,
    600,
    401.5,
    '403',
    {},
    [],
    Symbol('private'),
  ];
  for (const status of invalidStatuses) {
    const error = new DeliveryError('safe refusal');
    setMachineRequestDiagnostics(error, {
      phase: 'private-phase',
      endpoint: 'https://private.invalid/token',
      status,
      code: 'private-code',
      requestId: 'ghp_fictional_private_token',
    });
    assert.deepEqual(getMachineRequestDiagnostics(error), {
      phase: 'UNKNOWN',
      endpoint: 'UNKNOWN',
      status: 'UNKNOWN',
      code: 'UNKNOWN',
      requestId: 'UNKNOWN',
    });
    assert.equal(JSON.stringify(error).includes('private'), false);
  }
  let invoked = 0;
  const input = {
    phase: 'rest.request',
    endpoint: 'pulls.merge',
    status: 500,
    code: 'ECONNRESET',
    requestId: 'ABCD:1234:5678:9ABC:DEF0',
  };
  for (const key of Object.keys(input))
    Object.defineProperty(input, key, {
      get() {
        invoked++;
        throw new Error('private getter');
      },
    });
  const error = new DeliveryError('safe refusal');
  setMachineRequestDiagnostics(error, input);
  assert.equal(invoked, 0);
  assert.deepEqual(getMachineRequestDiagnostics(error), {
    phase: 'UNKNOWN',
    endpoint: 'UNKNOWN',
    status: 'UNKNOWN',
    code: 'UNKNOWN',
    requestId: 'UNKNOWN',
  });
  const proxy = new Proxy(input, {
    getOwnPropertyDescriptor() {
      invoked++;
      throw new Error('private trap');
    },
    get() {
      invoked++;
      throw new Error('private trap');
    },
  });
  const proxyError = new DeliveryError('safe refusal');
  setMachineRequestDiagnostics(proxyError, proxy);
  assert.deepEqual(getMachineRequestDiagnostics(proxyError), getMachineRequestDiagnostics(error));
  assert.equal(getMachineRequestDiagnostics(proxy), undefined);
  assert.equal(invoked, 0);
});

test('request identifiers and transport codes reject oversized, control and private-looking values', () => {
  const requestIds = [
    undefined,
    null,
    {},
    [],
    'ABCD:1234:5678',
    'ABCD:1234:5678:9ABC:DEF0\r\n',
    'ABCD:1234:5678:9ABC:\u001b',
    'ABCD:1234:5678:9ABC:秘密',
    '/private/credential.pem',
    'Bearer fictional_private_token',
    `ABCD:${'A'.repeat(31)}:${'B'.repeat(30)}:${'C'.repeat(30)}:${'D'.repeat(30)}`,
  ];
  for (const requestId of requestIds) {
    const error = new DeliveryError('safe refusal');
    setMachineRequestDiagnostics(error, {
      phase: 'rest.request',
      endpoint: 'pulls.merge',
      status: 500,
      code: 'ECONNRESET\n',
      requestId,
    });
    assert.equal(getMachineRequestDiagnostics(error)?.requestId, 'UNKNOWN');
    assert.equal(getMachineRequestDiagnostics(error)?.code, 'UNKNOWN');
  }
  for (const code of [
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ABORT_ERR',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ]) {
    const error = new DeliveryError('safe refusal');
    setMachineRequestDiagnostics(error, {
      phase: 'graphql.request',
      endpoint: 'graphql',
      status: undefined,
      code,
      requestId: undefined,
    });
    assert.equal(getMachineRequestDiagnostics(error)?.code, code);
    assert.equal(getMachineRequestDiagnostics(error)?.status, 'UNKNOWN');
  }
});

test(
  'the real CLI renderer bounds diagnostics and leaves the unchanged refusal line last',
  { tags: ['release'] },
  () => {
    const helper = pathToFileURL(join(process.cwd(), 'dist', 'cliResult.js')).href;
    const errors = pathToFileURL(join(process.cwd(), 'dist', 'errors.js')).href;
    const requestId = `ABCD:${'A'.repeat(30)}:${'B'.repeat(30)}:${'C'.repeat(30)}:${'D'.repeat(30)}`;
    assert.equal(requestId.length, 128);
    const code = `import { DeliveryError,setMachineRequestDiagnostics } from ${JSON.stringify(errors)}; import { printCommandError } from ${JSON.stringify(helper)}; const error=new DeliveryError('safe refusal','fictional_private_hint'); setMachineRequestDiagnostics(error,${JSON.stringify({ phase: 'rest.request', endpoint: 'pulls.merge', status: 500, code: 'UND_ERR_CONNECT_TIMEOUT', requestId })}); printCommandError(error);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('fictional_private_hint'), false);
    assert.ok(Buffer.byteLength(result.stderr.split('\n')[0]! + '\n') <= 512);
    assert.equal(result.stderr.trimEnd().split('\n').at(-1), 'ai-delivery: safe refusal');
  },
);

test('CLI batch partial failure prints every result before returning nonzero', { tags: ['release'] }, () => {
  const helper = pathToFileURL(join(process.cwd(), 'dist', 'cliResult.js')).href;
  const partial = {
    results: [
      { issueNumber: 1, status: 'applied' },
      { issueNumber: 2, status: 'failed', reason: 'Native readback unavailable' },
    ],
    summary: { failed: 1 },
  };
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { printCommandResult } from ${JSON.stringify(helper)};printCommandResult('issue_batch_update',${JSON.stringify(partial)});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), partial);
  assert.equal(result.stderr, '');
  const success = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { printCommandResult } from ${JSON.stringify(helper)};printCommandResult('issue_batch_update',{summary:{failed:0}});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(success.status, 0);
});

test('actual CLI batch input validates before configuration or native access', { tags: ['release'] }, () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-cli-refusal-'));
  try {
    const file = join(root, 'items.json');
    writeFileSync(file, '[]');
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'dist', 'cli.js'),
        '--repo',
        'example/widget',
        'batch:update',
        '--items-file',
        file,
        '--dry-run',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, AI_DELIVERY_CONFIG: join(root, 'absent-settings.json') },
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /absent-settings|credential|token/iu);
    const diagnostic = JSON.parse(result.stderr.replace(/^ai-delivery: /u, '').trim()) as {
      failures: { field: string; code: string }[];
    };
    assert.equal(diagnostic.failures[0]!.field, 'items');
    assert.equal(diagnostic.failures[0]!.code, 'field.type');
    writeFileSync(file, JSON.stringify([{ issueNumber: 1, PRIVATE_PROPERTY: 'PRIVATE_VALUE' }]));
    const privateInput = spawnSync(
      process.execPath,
      [join(process.cwd(), 'dist', 'cli.js'), '--repo', 'example/widget', 'batch:update', '--items-file', file],
      {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, AI_DELIVERY_CONFIG: join(root, 'absent-settings.json') },
      },
    );
    assert.equal(privateInput.status, 1);
    assert.doesNotMatch(privateInput.stderr, /PRIVATE_PROPERTY|PRIVATE_VALUE|absent-settings/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
