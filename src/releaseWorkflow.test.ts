import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Script } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { withResolvedClosureDiagnostic } from './fixtures/resolvedClosureDiagnostic.js';

type Json = { [key: string]: unknown };
type DiagnosticReads = { readSync?: typeof readSync; openSync?: typeof openSync; lstatSync?: typeof lstatSync };
type Inputs = { source: string; version: string; digest: string };
type DispatchInputs = Inputs & { qualificationOnly: string; artifactId: string };
type ReleaseContext = {
  contractPath: string;
  checkpoint: { path: string; sha256: string };
  sourceCommit: string;
  sourceTree: string;
  sourceManifestSha256: string;
  sourceLockSha256: string;
  producerSha256: string;
  archiveSha256: string;
};
type Bundle = {
  archive: { filename: string; sha256: string };
  records: Record<string, { sha256: string; contents: string }>;
};
type Api = {
  selectReleaseArtifact(root: string, output: string, inputs: Pick<Inputs, 'source' | 'version'>, cwd: string): Bundle;
  verifyReleaseArtifact(root: string, inputs: Inputs): string;
  validateQualificationOrigin(
    this: void,
    metadata: { artifact: Json; attempt: Json; workflow: Json; jobs: Json },
    inputs: { repository: string; repositoryId: number; source: string; artifactId: number },
  ): { artifactId: number; runId: number; runAttempt: number; artifactName: string };
  releaseDispatch(
    this: void,
    inputs: DispatchInputs,
  ):
    | { qualificationOnly: true; source: string; version: string }
    | { qualificationOnly: false; source: string; version: string; digest: string; artifactId: number };
};
type Contract = {
  sourceRoot: string;
  archivePath: string;
  archiveSha256: string;
  sourceCommit: string;
  sourceTree: string;
  sourceManifestSha256: string;
  sourceLockSha256: string;
  packageVersion: string;
  dryInventory: { path: string; size: number; mode: number }[];
  node24: string;
  node26: string;
  npmCli: string;
  producer?: {
    checksResultPath: string;
    checksResultSha256: string;
    artifactReceiptPath: string;
    artifactReceiptSha256: string;
  };
};
type Canonical = {
  sha256(bytes: Buffer | string): string;
  inspectCandidate(contract: Contract): {
    inventory: { path: string; size: number; mode: number; sha256: string }[];
    inventorySha256: string;
  };
  verifyProducerJoin(contract: Contract, candidate: ReturnType<Canonical['inspectCandidate']>): Json;
};
type Source = {
  commit: string;
  tree: string;
  manifestSha256: string;
  lockSha256: string;
  fingerprint: { kind: string; sha256: string; fileCount: number };
};
const api = (await import(new URL('../scripts/release-artifact.mjs', import.meta.url).href)) as Api;
const canonical = (await import(new URL('../scripts/current-consumer.mjs', import.meta.url).href)) as Canonical;
const qualification = (await import(new URL('../scripts/current-qualification.mjs', import.meta.url).href)) as {
  sourceIdentity(cwd: string): Source;
  copyReleaseArchive(
    contractPath: string,
    cwd: string,
    destination: string,
  ): { archivePath: string; archiveSha256: string };
  validateReleaseEntry(contractPath: string, cwd: string): ReleaseContext;
  runQualification(options: {
    cwd: string;
    resultsDir: string;
    resume: string;
    checks: () => Promise<never>;
    execute: () => Promise<never>;
  }): Promise<{ qualified: boolean; error?: string }>;
};
type LaneChecks = {
  executeCommand: unknown;
  RELEASE_CASES: {
    file: string;
    title: string;
    kind: 'mandatory' | 'external-historical-qualification' | 'parent-launched-helper';
  }[];
  runChecks(options: {
    cwd: string;
    resultsDir: string;
    release: ReleaseContext;
    toolchain: () => object;
    execute: (command: string[], options: { directory: string; env: NodeJS.ProcessEnv }) => Promise<object>;
  }): Promise<{
    scope: string;
    status: string;
    fullSuccess: boolean;
    artifactQualified: boolean;
    commands: { stage: string }[];
    tests?: { passed: number };
    release?: { temporary?: { path: string; removed: boolean; quiescent: boolean; error?: string } };
    error?: string;
  }>;
};
const laneChecks = (await import(new URL('../scripts/checks.mjs', import.meta.url).href)) as LaneChecks;
const gates = ['format', 'lint', 'types', 'build', 'tests', 'inventory'];

function diagnosticStep(name: string) {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const step = workflow.split(/(?=^ {6}- )/mu).find((value) => value.includes(`name: ${name}\n`));
  assert.ok(step, name);
  return step;
}

function failureLogUpload(directory: string, outcome: string, scanned?: string) {
  const step = diagnosticStep('Upload scanned failure logs');
  const expression = /if: \$\{\{ (.+) \}\}/u.exec(step)?.[1];
  assert.ok(expression);
  const values: Record<string, unknown> = {
    'always()': true,
    'inputs.qualification_only': true,
    'steps.failure_log_scan.outcome': outcome,
    'steps.failure_log_scan.outputs.scanned': scanned ?? '',
  };
  const admitted = expression.split(' && ').every((term) => {
    const comparison = /^(\S+) == '([^']*)'$/u.exec(term);
    if (comparison) {
      assert.ok(comparison[1]! in values, term);
      return values[comparison[1]!] === comparison[2];
    }
    assert.ok(term in values, term);
    return values[term] === true;
  });
  if (!admitted) return [];
  const paths = /path: \|\n([\s\S]*?)\n\s+if-no-files-found:/u.exec(step)?.[1];
  assert.ok(paths);
  return paths
    .trim()
    .split('\n')
    .map((line) => {
      const prefix = '${{ steps.diagnostics.outputs.logs_directory }}/';
      const path = line.trim();
      assert.ok(path.startsWith(prefix));
      const name = path.slice(prefix.length);
      assert.ok(
        [
          'manifest.json',
          'producer.stdout.txt',
          'producer.stderr.txt',
          'release.stdout.txt',
          'release.stderr.txt',
        ].includes(name),
      );
      return { name, path: join(directory, name) };
    })
    .filter((file) => existsSync(file.path));
}

// Test-only reader of the fixed observation format; qualification never consumes it.
function decodeDiagnostic(wire: Json, source: string, sourceRoot: string, inventory = laneChecks.RELEASE_CASES): Json {
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.equal(wire['source'], source, 'Diagnostic source differs.');
  assert.deepEqual(Object.keys(wire).sort(), [
    'consumer',
    'inputs',
    'logs',
    'observationOnly',
    'overall',
    'pack',
    'producer',
    'promotionEligible',
    'qualificationOutcome',
    'qualified',
    'release',
    'runAttempt',
    'runId',
    'source',
  ]);
  assert.equal(wire['observationOnly'], true);
  assert.equal(wire['qualified'], false);
  assert.equal(wire['promotionEligible'], false);
  const logs = wire['logs'] as Json;
  assert.deepEqual(Object.keys(logs).sort(), [
    'bytes',
    ...(Object.hasOwn(logs, 'cleanupConfirmed') ? ['cleanupConfirmed'] : []),
    'files',
    'status',
  ]);
  assert.ok(['unavailable', 'staged', 'refused'].includes(logs['status'] as string));
  assert.ok(
    Number.isSafeInteger(logs['bytes']) && Number(logs['bytes']) >= 0 && Number(logs['bytes']) <= 64 * 1024 * 1024,
  );
  if (Object.hasOwn(logs, 'cleanupConfirmed')) assert.equal(typeof logs['cleanupConfirmed'], 'boolean');
  const logFiles = logs['files'];
  assert.ok(Array.isArray(logFiles) && logFiles.length <= 4);
  const logNames = ['producer.stdout.txt', 'producer.stderr.txt', 'release.stdout.txt', 'release.stderr.txt'];
  for (const [index, value] of logFiles.entries()) {
    const entry = value as Json;
    assert.deepEqual(Object.keys(entry).sort(), ['name', 'status']);
    assert.equal(entry['name'], logNames[index]);
    assert.ok(['unavailable', 'missing', 'read', 'unsafe', 'oversized', 'changed'].includes(entry['status'] as string));
  }
  const release = wire['release'] as Json;
  assert.deepEqual(Object.keys(release).sort(), [
    'caseEncoding',
    'cases',
    'cleanup',
    'command',
    'counts',
    'inventory',
    'status',
  ]);
  assert.equal(release['caseEncoding'], 'ai-delivery.release-case-tuples@1');
  const identities = inventory.map(({ file, title, kind }) => ({ file, title, kind }));
  assert.equal(new Set(identities.map(({ file, title }) => JSON.stringify([file, title]))).size, identities.length);
  const files = [
    ...new Set(identities.flatMap(({ file }) => [file, file.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts')])),
  ];
  assert.deepEqual(release['inventory'], {
    sha256: createHash('sha256').update(JSON.stringify(identities)).digest('hex'),
    caseCount: identities.length,
    publicFileCount: files.length,
  });
  const cases = release['cases'];
  assert.ok(Array.isArray(cases));
  assert.equal(cases.length, identities.length);
  const code = new Map<string, string[]>();
  const decoded = cases.map((row: unknown, ordinal: number) => {
    assert.ok(Array.isArray(row));
    assert.equal(row.length, 3);
    assert.equal(row[0], ordinal, 'Diagnostic case ordinal differs.');
    const state: unknown = row[1];
    assert.equal(typeof state, 'string');
    assert.ok(
      ['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled', 'ambiguous', 'unknown'].includes(state as string),
    );
    const identity = identities[ordinal]!;
    if (state !== 'failed') {
      assert.equal(row[2], null);
      return { file: identity.file, title: identity.title, status: state };
    }
    const failure: unknown = row[2];
    assert.ok(Array.isArray(failure));
    assert.equal(failure.length, 3);
    const frameStatus: unknown = failure[0];
    const truncated: unknown = failure[1];
    assert.ok(typeof frameStatus === 'string' && ['matched', 'no-match', 'unknown'].includes(frameStatus));
    assert.equal(typeof truncated, 'boolean');
    assert.ok(Array.isArray(failure[2]) && failure[2].length <= 4);
    let priorMessage = 1;
    const frames = failure[2].map((frame: unknown) => {
      assert.ok(Array.isArray(frame));
      assert.equal(frame.length, 4);
      const [file, line, column, message] = frame as unknown[];
      assert.ok(Number.isSafeInteger(file) && Number(file) >= 0 && Number(file) < files.length);
      assert.ok(Number.isSafeInteger(line) && Number(line) > 0);
      assert.ok(Number.isSafeInteger(column) && Number(column) > 0);
      assert.ok((message === 1 || message === 2) && message >= priorMessage);
      priorMessage = message;
      const path = files[Number(file)]!;
      if (!code.has(path)) {
        const absolute = join(sourceRoot, path);
        const stat = lstatSync(absolute);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4 * 1024 * 1024);
        assert.equal(realpathSync(absolute), absolute);
        const bytes = readFileSync(absolute);
        assert.equal(bytes.length, stat.size);
        code.set(path, bytes.toString('utf8').split(/\r?\n/u));
      }
      const lines = code.get(path)!;
      assert.ok(Number(line) <= lines.length && Number(column) <= lines[Number(line) - 1]!.length + 1);
      return { file: path, line, column, message };
    });
    if (frameStatus === 'matched') assert.ok(frames.length > 0);
    if (frameStatus === 'no-match') assert.ok(frames.length === 0 && truncated === false);
    return {
      file: identity.file,
      title: identity.title,
      status: state,
      failureFrames: { status: frameStatus, truncated, frames },
    };
  });
  return { ...wire, release: { ...release, cases: decoded } };
}

function diagnosticFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-diagnostic-')));
  const sourceRoot = join(root, 'public source');
  for (const file of new Set(laneChecks.RELEASE_CASES.map((entry) => entry.file))) {
    for (const relative of [file, file.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts')]) {
      const path = join(sourceRoot, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '// synthetic public coordinate bounds\n'.repeat(1200));
    }
  }
  const qualificationRoot = join(root, 'release-qualification');
  const runId = '11111111-1111-4111-8111-111111111111';
  const releaseDirectory = join(qualificationRoot, `release-tests-${runId}`);
  const consumerDirectory = join(qualificationRoot, `consumer-${runId}`);
  const sensitive = 'SENSITIVE_DIAGNOSTIC_SENTINEL';
  const save = (path: string, value: unknown) => {
    const destination = join(qualificationRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify(value));
  };
  save('result.json', {
    schemaVersion: 'ai-delivery.current-qualification@1',
    runId,
    status: 'failed',
    qualified: false,
    source: { commit: 'a'.repeat(40) },
    error: sensitive,
    environment: { token: sensitive },
    pack: { status: 'passed', exitCode: 0, signal: null, cleanupConfirmed: true, command: [sensitive] },
  });
  save('producer/result.json', {
    status: 'passed',
    fullSuccess: true,
    commands: gates.map((stage) => ({
      stage,
      status: 'passed',
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
      error: sensitive,
    })),
  });
  save('pack/producer.json', { archiveSha256: 'b'.repeat(64), error: sensitive });
  save('release-tests-attempt.json', {
    stage: 'release-tests',
    runId,
    status: 'completed',
    directory: releaseDirectory,
    resultPath: join(releaseDirectory, 'result.json'),
  });
  save(`release-tests-${runId}/result.json`, {
    status: 'failed',
    commands: [
      {
        stage: 'tests',
        status: 'failed',
        exitCode: 1,
        signal: null,
        cleanupConfirmed: true,
        stdoutPath: sensitive,
        error: sensitive,
      },
    ],
    release: { temporary: { removed: false, quiescent: true, error: sensitive } },
  });
  const entry = laneChecks.RELEASE_CASES[0]!;
  save(`release-tests-${runId}/vitest.json`, {
    numTotalTests: 24,
    numPassedTests: 22,
    numFailedTests: 1,
    testResults: [
      {
        name: join(sourceRoot, entry.file),
        assertionResults: [
          { fullName: entry.title, status: 'failed', failureMessages: [sensitive] },
          { fullName: sensitive, status: 'passed' },
        ],
      },
    ],
  });
  save('consumer-attempt.json', {
    schemaVersion: 'ai-delivery.current-consumer-attempt@1',
    runId,
    status: 'running',
    directory: consumerDirectory,
    consumerPath: join(consumerDirectory, 'result.json'),
    command: { status: 'cancelled', signal: 'SIGTERM', cleanupConfirmed: false },
  });
  save(`consumer-${runId}/result.json`, {
    status: 'incomplete',
    qualified: false,
    cleanup: { removed: false, quiescent: false, retainedDirectory: sensitive },
    error: sensitive,
  });
  save(`release-tests-${runId}/temporary/.npmrc`, sensitive);
  save('producer/command/stderr.txt', sensitive);
  let outputs: Record<string, string> = {};
  const raw = (
    outcome = 'failure',
    env: Record<string, string | undefined> = {},
    inventory = laneChecks.RELEASE_CASES,
    overrides: DiagnosticReads = {},
  ) => {
    const step = diagnosticStep('Prepare failed qualification diagnostics');
    const script = /node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/u.exec(step)?.[1];
    assert.ok(script);
    const program = script.replace(/^\s*import .+;\n/gmu, '');
    const output = join(root, 'output');
    writeFileSync(output, '');
    new Script(program).runInNewContext({
      constants,
      createHash,
      closeSync,
      fstatSync,
      lstatSync,
      mkdirSync,
      mkdtempSync,
      openSync,
      readFileSync,
      readSync,
      realpathSync,
      rmSync,
      writeFileSync,
      ...overrides,
      appendFileSync: (path: string, value: string) => {
        assert.equal(path, output);
        writeFileSync(path, value, { flag: 'a' });
      },
      basename,
      dirname,
      join,
      resolve,
      fileURLToPath,
      URL,
      Buffer,
      RELEASE_CASES: inventory,
      process: {
        env: {
          RUNNER_TEMP: root,
          GITHUB_WORKSPACE: sourceRoot,
          GITHUB_OUTPUT: output,
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '1',
          REVIEWED_SOURCE_SHA: 'a'.repeat(40),
          GITHUB_SHA: 'a'.repeat(40),
          QUALIFICATION_OUTCOME: outcome,
          SECRET_VALUE: sensitive,
          ...env,
        },
      },
    });
    outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const equal = line.indexOf('=');
          return [line.slice(0, equal), line.slice(equal + 1)];
        }),
    );
    const path = outputs['file'];
    assert.ok(path);
    assert.equal(dirname(dirname(path)), root);
    const bytes = readFileSync(path, 'utf8');
    assert.ok(Buffer.byteLength(bytes) <= 64 * 1024);
    assert.ok(!bytes.includes(sensitive));
    assert.ok(!bytes.includes(root), 'runtime paths must not cross the public projection');
    return JSON.parse(bytes) as Json;
  };
  const execute = (outcome = 'failure', overrides: DiagnosticReads = {}) =>
    decodeDiagnostic(raw(outcome, {}, laneChecks.RELEASE_CASES, overrides), 'a'.repeat(40), sourceRoot);
  const failures = (failureMessages: unknown, status = 'failed') =>
    save(`release-tests-${runId}/vitest.json`, {
      testResults: [
        {
          name: join(sourceRoot, entry.file),
          assertionResults: [{ fullName: entry.title, status, failureMessages, location: { line: 12, column: 1 } }],
        },
      ],
    });
  const frames = () => {
    const cases = (execute()['release'] as Json)['cases'] as Json[];
    return cases[0]!['failureFrames'];
  };
  const log = (relative: string, bytes: string) => {
    const path = join(qualificationRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
    return path;
  };
  return {
    root,
    sourceRoot,
    qualificationRoot,
    releaseDirectory,
    runId,
    save,
    raw,
    execute,
    sensitive,
    failures,
    frames,
    log,
    logs: () => outputs['logs_directory'],
  };
}

test('closure provenance survives the scanned artifact boundary without masking its assertion', () => {
  for (const scenario of ['hidden', 'installed', 'missing', 'unsafe', 'oversized', 'invalid'] as const) {
    const f = diagnosticFixture();
    try {
      const runtimeDirectory = join(f.root, 'current', 'staged');
      const fixtureRoot = join(f.root, 'current', 'consumer');
      const actual = `file:${join(f.root, 'other-fixture', 'staged', 'reviewed-archive.tgz')}`;
      const hidden = join(runtimeDirectory, 'node_modules', '.package-lock.json');
      const installed = join(runtimeDirectory, 'node_modules', '@aviaratech', 'ai-delivery', 'package.json');
      const declared = 'file:reviewed-archive.tgz';
      const packages = {
        '': { dependencies: { '@aviaratech/ai-delivery': declared } },
        'node_modules/@aviaratech/ai-delivery': { resolved: declared },
      };
      mkdirSync(dirname(hidden), { recursive: true });
      mkdirSync(dirname(installed), { recursive: true });
      writeFileSync(
        hidden,
        JSON.stringify({
          packages: { 'node_modules/@aviaratech/ai-delivery': { resolved: scenario === 'hidden' ? actual : declared } },
        }),
      );
      writeFileSync(installed, JSON.stringify({ _resolved: actual, _where: fixtureRoot, private: f.sensitive }));
      if (scenario === 'missing') rmSync(hidden);
      if (scenario === 'unsafe') {
        rmSync(hidden);
        symlinkSync(installed, hidden);
      }
      if (scenario === 'oversized') truncateSync(hidden, 65537);
      if (scenario === 'invalid') writeFileSync(hidden, '{');
      const input = {
        runtimeDirectory,
        fixtureRoot,
        actual,
        rootPackage: Buffer.from(JSON.stringify(packages[''])),
        rootLock: Buffer.from(JSON.stringify({ packages })),
      };
      const failure = new Error('Recorded absolute closure mismatch');
      const chunks: string[] = [];
      assert.throws(
        () =>
          withResolvedClosureDiagnostic(
            input,
            () => {
              throw failure;
            },
            (line) => chunks.push(line),
          ),
        (error) => error === failure,
      );
      assert.equal(chunks.length, 1, 'The failed assertion must emit its provenance receipt.');
      const output = chunks[0]!;
      assert.ok(Buffer.byteLength(output) <= 2048);
      assert.ok(output.startsWith('RESOLVED_CLOSURE_ORIGIN_RECEIPT '));
      assert.ok(!output.includes(f.root) && !output.includes(f.sensitive));
      const receipt = JSON.parse(output.slice(output.indexOf(' ') + 1)) as Json;
      const root = receipt['root'] as Json;
      const observed = receipt['actual'] as Json;
      const hiddenReceipt = receipt['hidden'] as Json;
      assert.equal(root['previouslyCaptured'], true);
      assert.equal(observed['matchesExpected'], false);
      assert.equal(hiddenReceipt['state'], ['hidden', 'installed'].includes(scenario) ? 'valid' : scenario);
      if (scenario === 'hidden') assert.equal((hiddenReceipt['resolved'] as Json)['matchesActual'], true);
      if (scenario === 'installed')
        assert.equal(((receipt['installed'] as Json)['resolved'] as Json)['matchesActual'], true);
      f.log(`release-tests-${f.runId}/tests/stdout.txt`, output);
      f.execute();
      const directory = f.logs();
      assert.ok(directory);
      const uploaded = failureLogUpload(directory, 'success', 'true');
      assert.equal(readFileSync(uploaded.find((file) => file.name === 'release.stdout.txt')!.path, 'utf8'), output);
      assert.deepEqual(failureLogUpload(directory, 'failure', 'true'), []);
      assert.throws(
        () =>
          withResolvedClosureDiagnostic(
            input,
            () => {
              throw failure;
            },
            () => {
              throw new Error('Reporting unavailable');
            },
          ),
        (error) => error === failure,
      );
      let emitted = false;
      withResolvedClosureDiagnostic(
        input,
        () => {},
        () => {
          emitted = true;
        },
      );
      assert.equal(emitted, false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test.each(['producer', 'release', 'both'] as const)(
  'failed qualification stages exact fixed %s test output including the actual synthetic receipt',
  (scope) => {
    const f = diagnosticFixture();
    try {
      const receipt = 'SETUP_CLI_PHASE_RECEIPT {"scenario":"budget","nativeIdle":true}\n';
      const expected: Record<string, string> = {};
      for (const stage of ['producer', 'release'] as const) {
        if (scope !== 'both' && scope !== stage) continue;
        const directory = stage === 'producer' ? 'producer' : `release-tests-${f.runId}`;
        for (const stream of ['stdout', 'stderr']) {
          const bytes = stream === 'stdout' ? receipt : 'Synthetic test failure\n';
          f.log(`${directory}/tests/${stream}.txt`, bytes);
          expected[`${stage}.${stream}.txt`] = bytes;
        }
      }
      if (scope === 'producer') rmSync(join(f.qualificationRoot, 'release-tests-attempt.json'));
      const projection = f.execute();
      const directory = f.logs();
      assert.ok(directory, 'Fixed failed test logs must be staged for scanning.');
      assert.equal(dirname(directory), f.root);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Json;
      assert.equal(manifest['observationOnly'], true);
      assert.equal(manifest['qualified'], false);
      assert.equal(manifest['promotionEligible'], false);
      const files = manifest['files'] as { name: string; bytes: number; sha256: string }[];
      assert.deepEqual(
        files.map((file) => file.name),
        Object.keys(expected),
      );
      for (const file of files) {
        assert.equal(readFileSync(join(directory, file.name), 'utf8'), expected[file.name]);
        assert.equal(file.bytes, Buffer.byteLength(expected[file.name]!));
        assert.equal(file.sha256, canonical.sha256(expected[file.name]!));
        assert.equal(lstatSync(join(directory, file.name)).mode & 0o777, 0o600);
      }
      assert.equal(JSON.stringify(projection).includes('SETUP_CLI_PHASE_RECEIPT'), false);
      assert.equal(JSON.stringify(manifest).includes(f.sensitive), false);
      assert.equal(JSON.stringify(manifest).includes(f.root), false);
      const upload = failureLogUpload(directory, 'success', 'true');
      assert.deepEqual(upload.map((file) => file.name).sort(), ['manifest.json', ...Object.keys(expected)].sort());
      assert.ok(upload.some((file) => readFileSync(file.path, 'utf8').includes(receipt)));
      assert.deepEqual(failureLogUpload(directory, 'failure', 'true'), []);
      assert.deepEqual(failureLogUpload(directory, 'success'), []);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

for (const fault of [
  'leaf-link',
  'parent-link',
  'hardlink',
  'fifo',
  'oversized',
  'combined-limit',
  'changed',
  'deleted',
  'parent-changed',
  'parent-deleted',
  'before-open',
  'before-leaf',
] as const) {
  test(
    `failed qualification refuses ${fault} test logs while retaining the safe projection`,
    { tags: fault === 'fifo' ? ['release'] : [] },
    () => {
      const f = diagnosticFixture();
      try {
        const path = f.log('producer/tests/stdout.txt', 'SETUP_CLI_PHASE_RECEIPT {}\n');
        if (fault === 'leaf-link' || fault === 'hardlink') {
          const outside = join(f.root, 'private-unrelated');
          writeFileSync(outside, f.sensitive);
          rmSync(path);
          if (fault === 'leaf-link') symlinkSync(outside, path);
          else linkSync(outside, path);
        }
        if (fault === 'parent-link') {
          const outside = join(f.root, 'private-tests');
          renameSync(dirname(path), outside);
          symlinkSync(outside, dirname(path));
        }
        if (fault === 'fifo') {
          rmSync(path);
          execFileSync('mkfifo', [path]);
        }
        if (fault === 'oversized' || fault === 'combined-limit') {
          truncateSync(path, 32 * 1024 * 1024 + (fault === 'oversized' ? 1 : 0));
          if (fault === 'combined-limit') f.log('producer/tests/stderr.txt', 'x');
        }
        const changing = ['changed', 'deleted', 'parent-changed', 'parent-deleted'].includes(fault);
        const inode = changing ? lstatSync(path).ino : undefined;
        const overrides: DiagnosticReads = {};
        if (changing)
          overrides.readSync = ((...args: Parameters<typeof readSync>) => {
            const count = readSync(...args);
            if (fstatSync(args[0]).ino === inode) {
              if (fault === 'deleted') rmSync(path);
              else if (fault === 'parent-changed' || fault === 'parent-deleted') {
                renameSync(dirname(path), join(f.root, 'former-tests'));
                if (fault === 'parent-changed') {
                  mkdirSync(dirname(path));
                  writeFileSync(path, 'replacement parent');
                }
              } else writeFileSync(path, 'changed after read');
            }
            return count;
          }) as typeof readSync;
        if (fault === 'before-open' || fault === 'before-leaf') {
          f.log('producer/tests/stderr.txt', 'Other available log must not authorize changed input.');
          if (fault === 'before-open')
            overrides.openSync = ((...args: Parameters<typeof openSync>) => {
              if (args[0] === path) rmSync(path);
              return openSync(...args);
            }) as typeof openSync;
          else
            overrides.lstatSync = ((...args: Parameters<typeof lstatSync>) => {
              if (args[0] === path) renameSync(dirname(path), join(f.root, 'former-tests'));
              return lstatSync(...args);
            }) as typeof lstatSync;
        }
        const projection = f.execute('failure', overrides);
        assert.equal(f.logs(), undefined, 'Unsafe or oversized bytes must never be offered for upload.');
        assert.equal(projection['observationOnly'], true);
        assert.ok(projection['logs'], 'The safe projection must report fixed log availability states.');
        assert.equal((projection['logs'] as Json)['status'], 'refused');
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
}

test('missing failure logs retain explicit availability without inventing raw output', () => {
  const f = diagnosticFixture();
  try {
    const projection = f.execute();
    assert.equal(f.logs(), undefined);
    assert.equal((projection['logs'] as Json)['status'], 'unavailable');
    assert.equal(((projection['logs'] as Json)['files'] as Json[]).length, 4);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

async function scanFixture(scenario: string) {
  const f = diagnosticFixture();
  const receipt = 'SETUP_CLI_PHASE_RECEIPT {"scenario":"budget","nativeIdle":true}\n';
  f.log('producer/tests/stdout.txt', receipt);
  f.log('producer/tests/stderr.txt', 'Synthetic test failure\n');
  f.execute();
  const directory = f.logs();
  assert.ok(directory);
  if (scenario === 'extra-staged') writeFileSync(join(directory, 'unrelated-config'), f.sensitive);
  if (scenario === 'unsafe-staged') {
    rmSync(join(directory, 'producer.stdout.txt'));
    symlinkSync(join(f.qualificationRoot, 'producer/tests/stdout.txt'), join(directory, 'producer.stdout.txt'));
  }
  if (scenario === 'manifest-fields') {
    const path = join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Json;
    manifest['unreviewed'] = f.sensitive;
    writeFileSync(path, JSON.stringify(manifest));
  }
  const statePath = join(f.root, 'docker-state.json');
  const image = 'sha256:' + '1'.repeat(64);
  const owned = 'c'.repeat(64);
  const unrelated = 'f'.repeat(64);
  const initial = {
    image,
    scannedFiles: [] as string[],
    imagePresent: scenario !== 'image-pull',
    containers: [{ Id: unrelated, Name: '/unrelated', Image: image, Config: { Labels: {} }, State: { Running: true } }],
  };
  writeFileSync(statePath, JSON.stringify(initial));
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const cli = join(bin, 'docker');
  // Substitute only the external daemon boundary; real workflow supervision, capture and cancellation run.
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require('node:fs');
const path = ${JSON.stringify(statePath)}, directory = ${JSON.stringify(directory)}, scenario = ${JSON.stringify(scenario)};
const args = process.argv.slice(2), state = JSON.parse(fs.readFileSync(path, 'utf8'));
const save = () => { fs.writeFileSync(path + '.next', JSON.stringify(state)); fs.renameSync(path + '.next', path); };
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
const option = name => args[args.indexOf(name) + 1];
if (process.env.GH_TOKEN || process.env.SECRET_VALUE) process.exit(96);
if (args[0] === 'image' && args[1] === 'inspect') {
  if (!state.imagePresent) process.exit(1);
  out({ Id: state.image, RepoDigests: ['ghcr.io/trufflesecurity/trufflehog@sha256:' + '2'.repeat(64)] });
} else if (args[0] === 'pull') { state.imagePresent = true; save(); process.stdout.write('synthetic pinned image ready\\n'); }
else if (args[0] === 'create') {
  const labels = {};
  args.forEach((value, index) => { if (value === '--label') { const [key, ...rest] = args[index + 1].split('='); labels[key] = rest.join('='); } });
  const container = { Id: '${owned}', Name: '/' + option('--name'), Image: state.image, Config: { Labels: labels, User: args.includes('--user') ? option('--user') : '', Cmd: args.slice(args.indexOf(state.image) + 1) }, Mounts: [{ Type: 'bind', Source: directory, Destination: '/logs', RW: false }], HostConfig: { Memory: Number(option('--memory')), MemorySwap: Number(option('--memory-swap')), NetworkMode: option('--network'), ReadonlyRootfs: args.includes('--read-only'), CapDrop: [option('--cap-drop')], SecurityOpt: [option('--security-opt')], LogConfig: { Type: option('--log-driver') }, PidsLimit: Number(option('--pids-limit')) }, State: { Running: false, ExitCode: 0, OOMKilled: false } };
  if (scenario === 'resource') container.HostConfig.Memory = 0;
  if (scenario === 'inaccessible') container.Config.User = '999:999';
  state.containers.push(container); save();
  if (scenario === 'create-ack') process.exit(7);
  if (scenario === 'malformed-ack') { process.stdout.write('created ' + container.Id + '\\n'); process.exit(0); }
  process.stdout.write(container.Id + '\\n');
} else if (args[0] === 'start') {
  const container = state.containers.find(value => value.Id === args.at(-1));
  if (!container) process.exit(3);
  container.State.Running = true; save();
  if (scenario === 'cancel') setInterval(() => {}, 1000);
  else if (scenario === 'overflow') process.stdout.write(Buffer.alloc(33 * 1024 * 1024, 120));
  else {
    container.State.Running = false;
    container.State.ExitCode = scenario === 'findings' ? 183 : 0;
    const user = fs.lstatSync(directory), canRead = container.Config.User === user.uid + ':' + user.gid;
    const paths = container.Config.Cmd.slice(1).filter(value => value.startsWith('/logs'));
    const explicit = paths.length > 0 && paths.every(value => value.startsWith('/logs/'));
    const error = !canRead || scenario === 'scan-error' || scenario === 'directory-error';
    state.scannedFiles = error ? [] : (explicit ? paths.map(value => value.slice(6)) : fs.readdirSync(directory));
    // Pinned TruffleHog directory walking can log an error yet return zero; exact file-unit errors propagate.
    if (error && container.Config.Cmd.includes('--fail-on-scan-errors') && (scenario === 'scan-error' || explicit)) container.State.ExitCode = 1;
    if (scenario === 'foreign') container.Config.Labels = {};
    if (scenario === 'drift') fs.writeFileSync(directory + '/producer.stdout.txt', 'changed after scan');
    save();
    if (scenario === 'findings') { process.stdout.write('SENSITIVE_SCANNER_FINDING\\n'); process.exit(183); }
    if (container.State.ExitCode) { process.stderr.write('SENSITIVE_SCANNER_FINDING file read error\\n'); process.exit(container.State.ExitCode); }
  }
} else if (args[0] === 'container' && args[1] === 'inspect') {
  const selector = args.at(-1), container = state.containers.find(value => value.Id === selector || value.Name === '/' + selector);
  if (!container) process.exit(1);
  out(container);
} else if (args[0] === 'container' && args[1] === 'ls') {
  const filters = args.flatMap((value, index) => value === '--filter' ? [args[index + 1]] : []);
  for (const container of state.containers) {
    const matches = filters.every(filter => {
      if (filter.startsWith('name=')) return new RegExp(filter.slice(5)).test(container.Name);
      if (filter.startsWith('label=')) { const [key, ...rest] = filter.slice(6).split('='); return container.Config.Labels[key] === rest.join('='); }
      return false;
    });
    if (matches) process.stdout.write(container.Id + '\\n');
  }
} else if (args[0] === 'container' && args[1] === 'rm') {
  if (scenario === 'cleanup') process.exit(8);
  state.containers = state.containers.filter(value => value.Id !== args.at(-1)); save();
} else process.exit(88);
`,
    { mode: 0o755 },
  );
  const output = join(f.root, 'scan-output');
  writeFileSync(output, '');
  let visibleError = '';
  const host = Object.assign(new EventEmitter(), {
    env: {
      PATH: bin + ':' + (process.env.PATH ?? ''),
      RUNNER_TEMP: f.root,
      LOGS_DIRECTORY: directory,
      GITHUB_WORKSPACE: process.cwd(),
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '101',
      GITHUB_RUN_ATTEMPT: '1',
      REVIEWED_SOURCE_SHA: 'a'.repeat(40),
      GH_TOKEN: f.sensitive,
      SECRET_VALUE: f.sensitive,
    },
    exitCode: 0,
    stderr: {
      write: (bytes: string) => {
        visibleError += bytes;
      },
    },
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const script = /node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/u.exec(
      diagnosticStep('Scan failed qualification logs'),
    )?.[1];
    assert.ok(script);
    const program = script.replace(/^\s*import .+;\n/gmu, '');
    if (scenario === 'cancel')
      timer = setInterval(() => {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
          containers: { Id: string; State: { Running: boolean } }[];
        };
        if (state.containers.some((value) => value.Id === owned && value.State.Running)) host.emit('SIGTERM');
      }, 50);
    await new Script('(async () => {\n' + program + '\n})()').runInNewContext({
      constants,
      closeSync,
      fstatSync,
      lstatSync,
      mkdirSync,
      mkdtempSync,
      openSync,
      readFileSync,
      readdirSync,
      readSync,
      realpathSync,
      writeFileSync,
      createHash,
      randomUUID,
      appendFileSync: (path: string, bytes: string) => writeFileSync(path, bytes, { flag: 'a' }),
      basename,
      dirname,
      join,
      resolve,
      Buffer,
      AbortController,
      process: host,
      executeCommand: laneChecks.executeCommand,
    });
    const values = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const equal = line.indexOf('=');
          return [line.slice(0, equal), line.slice(equal + 1)];
        }),
    );
    const resultPath = values['receipt'];
    assert.ok(resultPath, 'Scanner must retain its custody and cleanup result.');
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Json;
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as typeof initial;
    assert.deepEqual(
      state.containers.find((value) => value.Id === unrelated),
      initial.containers[0],
    );
    assert.equal(state.image, image, 'Reusable pinned scanner image must remain available.');
    assert.equal(visibleError.includes('SENSITIVE_SCANNER_FINDING'), false);
    assert.equal(visibleError.includes(f.sensitive), false);
    for (const command of result['commands'] as Json[]) {
      assert.ok(
        lstatSync(command['stdoutPath'] as string).size + lstatSync(command['stderrPath'] as string).size <=
          32 * 1024 * 1024,
      );
      assert.equal(command['cleanupConfirmed'], true);
    }
    if (scenario === 'success' || scenario === 'image-pull') {
      assert.equal(values['scanned'], 'true');
      assert.equal(host.exitCode, 0);
      assert.deepEqual(
        state.scannedFiles.sort(),
        ['manifest.json', 'producer.stdout.txt', 'producer.stderr.txt'].sort(),
      );
      assert.equal(readFileSync(join(directory, 'producer.stdout.txt'), 'utf8'), receipt);
      assert.ok(
        failureLogUpload(directory, 'success', values['scanned']).some((file) =>
          readFileSync(file.path, 'utf8').includes(receipt),
        ),
      );
    } else {
      assert.equal(values['scanned'], undefined, 'Unscanned or uncertain bytes cannot become upload-eligible.');
      assert.equal(host.exitCode, 1);
      assert.deepEqual(failureLogUpload(directory, 'failure', values['scanned']), []);
    }
    const retained = state.containers.some((value) => value.Id === owned);
    assert.equal(retained, scenario === 'cleanup' || scenario === 'foreign');
    assert.equal(result['cleanupConfirmed'], !retained);
  } finally {
    if (timer !== undefined) clearInterval(timer);
    rmSync(f.root, { recursive: true, force: true });
  }
}

test.each([
  'success',
  'image-pull',
  'findings',
  'overflow',
  'cancel',
  'resource',
  'drift',
  'create-ack',
  'cleanup',
  'foreign',
  'extra-staged',
  'unsafe-staged',
  'manifest-fields',
  'inaccessible',
  'scan-error',
  'directory-error',
  'malformed-ack',
])(
  'failure-log scanner gates upload and preserves unrelated resources after %s',
  { tags: ['release'] },
  async (scenario) => scanFixture(scenario),
);

test.each([1110, 1114, 1122])('diagnostic frames preserve the public closure helper and caller at %s', (caller) => {
  const f = diagnosticFixture();
  try {
    f.failures([
      `AssertionError: ${f.sensitive}\n    at closure (${f.sourceRoot}/src/setup.test.ts:1108:7)\n    at test (${f.sourceRoot}/src/setup.test.ts:${caller}:3)`,
    ]);
    assert.deepEqual(f.frames(), {
      status: 'matched',
      truncated: false,
      frames: [
        { file: 'src/setup.test.ts', line: 1108, column: 7, message: 1 },
        { file: 'src/setup.test.ts', line: caller, column: 3, message: 1 },
      ],
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('diagnostic frames preserve message order, repeats, file URLs and distinct source/dist coordinates', () => {
  const f = diagnosticFixture();
  try {
    const source = pathToFileURL(join(f.sourceRoot, 'src/setup.test.ts')).href;
    f.failures([
      `${f.sensitive}\n    at privateFrame (/private/unrelated/src/setup.test.ts:5:2)\n    at closure (\u001b[36m${source}:1108:7\u001b[0m)\n    at caller (${f.sourceRoot}/src/setup.test.ts:1110:3)`,
      `Error: ${f.sensitive}\n    at compiled (${f.sourceRoot}/dist/setup.test.js:100:4)\n    at compiled (${f.sourceRoot}/dist/setup.test.js:100:4)`,
    ]);
    assert.deepEqual(f.frames(), {
      status: 'matched',
      truncated: false,
      frames: [
        { file: 'src/setup.test.ts', line: 1108, column: 7, message: 1 },
        { file: 'src/setup.test.ts', line: 1110, column: 3, message: 1 },
        { file: 'dist/setup.test.js', line: 100, column: 4, message: 2 },
        { file: 'dist/setup.test.js', line: 100, column: 4, message: 2 },
      ],
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each([
  { GITHUB_SHA: undefined },
  { GITHUB_SHA: 'b'.repeat(40) },
  { GITHUB_SHA: 'invalid' },
  { REVIEWED_SOURCE_SHA: undefined },
  { REVIEWED_SOURCE_SHA: 'invalid' },
])('diagnostic writer refuses an unbound source before creating observations: %j', (env) => {
  const f = diagnosticFixture();
  try {
    assert.throws(() => f.raw('failure', env), /Diagnostic source/u);
    assert.equal(readFileSync(join(f.root, 'output'), 'utf8'), '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('diagnostic writer and reader refuse duplicate or differently ordered source inventories', () => {
  const f = diagnosticFixture();
  try {
    const inventory = laneChecks.RELEASE_CASES;
    assert.throws(() => f.raw('failure', {}, [...inventory, inventory[0]!]), /Diagnostic inventory/u);
    const wire = f.raw();
    assert.throws(() => decodeDiagnostic(wire, 'b'.repeat(40), f.sourceRoot), /Diagnostic source/u);
    assert.throws(() => decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot, inventory.toReversed()));
    assert.throws(() => decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot, [...inventory, inventory[0]!]));
    assert.throws(() => decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot, inventory.slice(1)));
    assert.throws(() =>
      decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot, [
        { ...inventory[0]!, kind: 'parent-launched-helper' },
        ...inventory.slice(1),
      ]),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each([
  'encoding',
  'extra-top',
  'extra-release',
  'extra-inventory',
  'hash',
  'count',
  'file-count',
  'source',
  'duplicate',
  'missing',
  'order',
  'negative',
  'fractional',
  'outside',
  'extra-row',
  'missing-row',
  'case-status',
  'frame-status',
  'truncation',
  'nonfailed-frames',
  'file-negative',
  'file-outside',
  'file-fractional',
  'line-zero',
  'line-outside',
  'column-zero',
  'column-outside',
  'message-zero',
  'message-outside',
  'extra-frame',
  'missing-frame',
  'too-many-frames',
  'matched-empty',
  'no-match-frames',
  'message-order',
  'logs-status',
  'logs-extra',
  'logs-path',
  'logs-bytes',
  'logs-duplicate',
])('diagnostic reader refuses malformed %s observations without guessing identities', (failure) => {
  const f = diagnosticFixture();
  try {
    f.failures([`    at caller (${f.sourceRoot}/src/setup.test.ts:1110:3)`]);
    const wire = f.raw();
    const release = wire['release'] as Json;
    const inventory = release['inventory'] as Json;
    const rows = release['cases'] as unknown[][];
    const frames = rows[0]![2] as unknown[];
    const coordinates = frames[2] as unknown[][];
    if (failure === 'encoding') release['caseEncoding'] = 'ai-delivery.release-case-tuples@2';
    if (failure === 'extra-top') wire['extra'] = true;
    if (failure === 'extra-release') release['extra'] = true;
    if (failure === 'extra-inventory') inventory['extra'] = true;
    if (failure === 'hash') inventory['sha256'] = 'b'.repeat(64);
    if (failure === 'count') inventory['caseCount'] = rows.length - 1;
    if (failure === 'file-count') inventory['publicFileCount'] = 0;
    if (failure === 'source') delete wire['source'];
    if (failure === 'duplicate') rows[1] = rows[0]!;
    if (failure === 'missing') rows.pop();
    if (failure === 'order') rows.reverse();
    if (failure === 'negative') rows[0]![0] = -1;
    if (failure === 'fractional') rows[0]![0] = 0.5;
    if (failure === 'outside') rows[0]![0] = rows.length;
    if (failure === 'extra-row') rows[0]!.push(null);
    if (failure === 'missing-row') rows[0]!.pop();
    if (failure === 'case-status') rows[0]![1] = 'invented';
    if (failure === 'frame-status') frames[0] = 'invented';
    if (failure === 'truncation') frames[1] = 'false';
    if (failure === 'nonfailed-frames') rows[0]![1] = 'passed';
    if (failure === 'file-negative') coordinates[0]![0] = -1;
    if (failure === 'file-outside') coordinates[0]![0] = inventory['publicFileCount'];
    if (failure === 'file-fractional') coordinates[0]![0] = 0.5;
    if (failure === 'line-zero') coordinates[0]![1] = 0;
    if (failure === 'line-outside') coordinates[0]![1] = 1202;
    if (failure === 'column-zero') coordinates[0]![2] = 0;
    if (failure === 'column-outside') coordinates[0]![2] = 999;
    if (failure === 'message-zero') coordinates[0]![3] = 0;
    if (failure === 'message-outside') coordinates[0]![3] = 3;
    if (failure === 'extra-frame') coordinates[0]!.push(null);
    if (failure === 'missing-frame') coordinates[0]!.pop();
    if (failure === 'too-many-frames') frames[2] = Array.from({ length: 5 }, () => coordinates[0]);
    if (failure === 'matched-empty') frames[2] = [];
    if (failure === 'no-match-frames') frames[0] = 'no-match';
    if (failure === 'message-order')
      frames[2] = [
        [...coordinates[0]!.slice(0, 3), 2],
        [...coordinates[0]!.slice(0, 3), 1],
      ];
    const logs = wire['logs'] as Json;
    if (failure === 'logs-status') logs['status'] = 'invented';
    if (failure === 'logs-extra') logs['path'] = f.root;
    if (failure === 'logs-path') (logs['files'] as Json[])[0]!['name'] = f.root;
    if (failure === 'logs-bytes') logs['bytes'] = 64 * 1024 * 1024 + 1;
    if (failure === 'logs-duplicate') (logs['files'] as Json[])[1] = (logs['files'] as Json[])[0]!;
    assert.throws(() => decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each(['link', 'changed-coordinates'])('diagnostic reader refuses %s public source after projection', (failure) => {
  const f = diagnosticFixture();
  try {
    const path = join(f.sourceRoot, 'src/setup.test.ts');
    f.failures([`    at caller (${path}:1110:3)`]);
    const wire = f.raw();
    if (failure === 'link') {
      rmSync(path);
      symlinkSync(join(f.sourceRoot, 'dist/setup.test.js'), path);
    } else writeFileSync(path, '// changed\n');
    assert.throws(() => decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('diagnostic tuples round-trip every identity and descriptive case status', () => {
  const f = diagnosticFixture();
  try {
    const states = ['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled', 'ambiguous', 'unknown'];
    f.save(`release-tests-${f.runId}/vitest.json`, {
      testResults: [...new Set(laneChecks.RELEASE_CASES.map((entry) => entry.file))].map((file) => ({
        name: join(f.sourceRoot, file),
        assertionResults: laneChecks.RELEASE_CASES.flatMap((entry, index) => {
          if (entry.file !== file || index >= states.length || states[index] === 'unknown') return [];
          const value = { fullName: entry.title, status: states[index], failureMessages: ['no public frames'] };
          return states[index] === 'ambiguous' ? [value, value] : [value];
        }),
      })),
    });
    const wire = f.raw();
    const decoded = decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot);
    const observed = (decoded['release'] as Json)['cases'] as Json[];
    assert.deepEqual(
      observed.slice(0, states.length).map((entry) => entry['status']),
      states,
    );
    assert.deepEqual(
      observed.map(({ file, title }) => ({ file, title })),
      laneChecks.RELEASE_CASES.map(({ file, title }) => ({ file, title })),
    );
    assert.deepEqual(observed[1]!['failureFrames'], { status: 'no-match', truncated: false, frames: [] });
    assert.throws(() => JSON.parse(JSON.stringify(wire).slice(0, -5)));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('diagnostics retain the complete release inventory with four seven-digit frames per case under64KiB', () => {
  const f = diagnosticFixture();
  try {
    const publicFiles = [
      ...new Set(
        laneChecks.RELEASE_CASES.flatMap(({ file }) => [
          file,
          file.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts'),
        ]),
      ),
    ];
    const publicFile = publicFiles.at(-1)!;
    // These coordinates are simultaneously valid in a 2,000,000-byte public file.
    writeFileSync(join(f.sourceRoot, publicFile), '\n'.repeat(1_000_000) + 'x'.repeat(1_000_000));
    const command = {
      status: 'incomplete',
      exitCode: -255,
      signal: 'SIGTERM',
      cleanupConfirmed: false,
      outputBytes: Number.MAX_SAFE_INTEGER,
      peakRssBytes: Number.MAX_SAFE_INTEGER,
    };
    f.save('result.json', {
      schemaVersion: 'ai-delivery.current-qualification@1',
      runId: f.runId,
      status: 'incomplete',
      pack: command,
    });
    f.save('producer/result.json', {
      status: 'incomplete',
      fullSuccess: false,
      commands: gates.map((stage) => ({ stage, ...command })),
    });
    f.save(`release-tests-${f.runId}/result.json`, {
      status: 'incomplete',
      commands: [command],
      release: { temporary: { removed: false, quiescent: false } },
    });
    const consumerDirectory = join(f.qualificationRoot, `consumer-${f.runId}`);
    f.save('consumer-attempt.json', {
      runId: f.runId,
      directory: consumerDirectory,
      consumerPath: join(consumerDirectory, 'result.json'),
      command,
    });
    f.save(`consumer-${f.runId}/result.json`, { status: 'incomplete', cleanup: { removed: false, quiescent: false } });
    // Include the complete bounded #199 raw-log availability envelope.
    const logBytes = 'x'.repeat(16 * 1024 * 1024);
    for (const directory of ['producer', `release-tests-${f.runId}`])
      for (const stream of ['stdout', 'stderr']) f.log(`${directory}/tests/${stream}.txt`, logBytes);
    f.save(`release-tests-${f.runId}/vitest.json`, {
      numTotalTests: Number.MAX_SAFE_INTEGER,
      numPassedTests: Number.MAX_SAFE_INTEGER,
      numFailedTests: Number.MAX_SAFE_INTEGER,
      testResults: [...new Set(laneChecks.RELEASE_CASES.map((entry) => entry.file))].map((file) => ({
        name: join(f.sourceRoot, file),
        assertionResults: laneChecks.RELEASE_CASES.filter((entry) => entry.file === file).map(({ title }) => ({
          fullName: title,
          status: 'failed',
          failureMessages: [
            null,
            Array.from({ length: 4 }, () => `    at caller (${join(f.sourceRoot, publicFile)}:1000001:1000001)`).join(
              '\n',
            ),
          ],
        })),
      })),
    });
    const wire = f.raw('cancelled', {
      GITHUB_RUN_ID: String(Number.MAX_SAFE_INTEGER),
      GITHUB_RUN_ATTEMPT: String(Number.MAX_SAFE_INTEGER),
    });
    const bytes = Buffer.byteLength(JSON.stringify(wire) + '\n');
    assert.ok(bytes <= 64 * 1024);
    process.stdout.write(
      `DIAGNOSTIC_FIXED_BOUND ${JSON.stringify({ cases: laneChecks.RELEASE_CASES.length, frames: laneChecks.RELEASE_CASES.length * 4, bytes, bound: 64 * 1024 })}\n`,
    );
    const observed = (decodeDiagnostic(wire, 'a'.repeat(40), f.sourceRoot)['release'] as Json)['cases'] as Json[];
    assert.equal(observed.length, laneChecks.RELEASE_CASES.length);
    for (const entry of observed) {
      assert.equal(entry['status'], 'failed');
      const frames = entry['failureFrames'] as Json;
      assert.equal(frames['status'], 'unknown');
      assert.equal(frames['truncated'], false);
      assert.deepEqual(
        frames['frames'],
        Array.from({ length: 4 }, () => ({ file: publicFile, line: 1_000_001, column: 1_000_001, message: 2 })),
      );
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test.each([
  { messages: undefined, status: 'unknown' },
  { messages: null, status: 'unknown' },
  { messages: {}, status: 'unknown' },
  { messages: [], status: 'unknown' },
  { messages: [null], status: 'unknown' },
  { messages: [''], status: 'no-match' },
  { messages: ['an error without public frames'], status: 'no-match' },
])(
  'diagnostic frame availability distinguishes $status from test-declaration coordinates: $messages',
  ({ messages, status }) => {
    const f = diagnosticFixture();
    try {
      f.failures(messages);
      assert.deepEqual(f.frames(), { status, truncated: false, frames: [] });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.each(['frames', 'messages', 'text', 'lines', 'line-bytes', 'partial-line', 'utf8-text'] as const)(
  'diagnostic frames retain a bounded prefix and disclose %s truncation',
  (bound) => {
    const f = diagnosticFixture();
    try {
      const helper = `    at closure (${f.sourceRoot}/src/setup.test.ts:1108:7)`;
      const caller = `    at caller (${f.sourceRoot}/src/setup.test.ts:1110:3)`;
      let messages = [helper + '\n' + caller];
      let expected = [{ file: 'src/setup.test.ts', line: 1108, column: 7, message: 1 }];
      if (bound === 'frames') {
        messages = [Array.from({ length: 5 }, () => helper).join('\n')];
        expected = Array.from({ length: 4 }, () => expected[0]!);
      }
      if (bound === 'messages') {
        messages = [helper, helper, helper];
        expected = [expected[0]!, { ...expected[0]!, message: 2 }];
      }
      if (bound === 'text') messages = [helper + '\n' + 'x'.repeat(16 * 1024) + '\n' + caller];
      if (bound === 'lines') messages = [helper + '\n' + 'header\n'.repeat(63) + caller];
      if (bound === 'line-bytes') messages = [helper + '\n' + ' '.repeat(2048) + caller];
      if (bound === 'partial-line' || bound === 'utf8-text') {
        messages = [(bound === 'partial-line' ? ' '.repeat(16370) : 'é'.repeat(8190)) + caller];
        expected = [];
      }
      f.failures(messages);
      assert.deepEqual(f.frames(), {
        status: expected.length ? 'matched' : 'unknown',
        truncated: true,
        frames: expected,
      });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.each(['private-suffix', 'path-traversal', 'file-query', 'file-host', 'function-body'] as const)(
  'diagnostic frames reject %s near-matches without exposing their bytes',
  (kind) => {
    const f = diagnosticFixture();
    try {
      const file = join(f.sourceRoot, 'src/setup.test.ts');
      let frame = `    at fake (/private${file}:1108:7)`;
      if (kind === 'path-traversal') frame = `    at fake (${f.sourceRoot}/src/../src/setup.test.ts:1108:7)`;
      if (kind === 'file-query') frame = `    at fake (${pathToFileURL(file).href}?${f.sensitive}:1108:7)`;
      if (kind === 'file-host') frame = `    at fake (file://unrelated${file}:1108:7)`;
      if (kind === 'function-body') frame = `Error: (not a frame ${file}:1108:7)`;
      f.failures([frame]);
      assert.deepEqual(f.frames(), { status: 'no-match', truncated: false, frames: [] });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.each(['0:1', '-1:1', '1202:1', '1:999', '999999999999999999:1'])(
  'diagnostic frames keep invalid public coordinates %s unknown',
  (coordinates) => {
    const f = diagnosticFixture();
    try {
      f.failures([`    at closure (${f.sourceRoot}/src/setup.test.ts:${coordinates})`]);
      assert.deepEqual(f.frames(), { status: 'unknown', truncated: false, frames: [] });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test('diagnostic frames do not follow public-code symlinks or claim malformed messages are complete', () => {
  const f = diagnosticFixture();
  try {
    const file = join(f.sourceRoot, 'src/setup.test.ts');
    rmSync(file);
    symlinkSync(join(f.sourceRoot, 'dist/setup.test.js'), file);
    f.failures([`    at closure (${file}:1108:7)`]);
    assert.deepEqual(f.frames(), { status: 'unknown', truncated: false, frames: [] });
    f.failures([null, `    at compiled (${f.sourceRoot}/dist/setup.test.js:100:4)`]);
    assert.deepEqual(f.frames(), {
      status: 'unknown',
      truncated: false,
      frames: [{ file: 'dist/setup.test.js', line: 100, column: 4, message: 2 }],
    });
    f.failures([`    at compiled (${f.sourceRoot}/dist/setup.test.js:100:4)`], 'passed');
    assert.equal(f.frames(), undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('failed qualification diagnostics have an isolated nonpromotable workflow boundary', () => {
  const prepare = diagnosticStep('Prepare failed qualification diagnostics');
  const upload = diagnosticStep('Upload failed qualification diagnostics');
  assert.match(prepare, /always\(\) && inputs\.qualification_only && steps\.origin\.outcome == 'success'/u);
  assert.match(
    prepare,
    /steps\.qualification\.outcome == 'failure' \|\| steps\.qualification\.outcome == 'cancelled'/u,
  );
  assert.match(upload, /always\(\) && inputs\.qualification_only && steps\.diagnostics\.outcome == 'success'/u);
  assert.match(upload, /name: npm-qualification-diagnostics-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(upload, /path: \$\{\{ steps\.diagnostics\.outputs\.file \}\}/u);
  assert.match(upload, /retention-days: 1/u);
  assert.match(upload, /if-no-files-found: error/u);
  assert.match(upload, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.doesNotMatch(prepare + upload, /continue-on-error|overwrite:|id-token:|npm run|npm pack/u);
  const fixture = originFixture();
  fixture.metadata.artifact['name'] = 'npm-qualification-diagnostics-2';
  assert.throws(() => api.validateQualificationOrigin(fixture.metadata, fixture.inputs));
  fixture.metadata.artifact['name'] = 'npm-qualification-failure-logs-2';
  assert.throws(() => api.validateQualificationOrigin(fixture.metadata, fixture.inputs));
});

test.each(['failure', 'cancelled'])(
  'diagnostics project bounded observations after %s without exposing raw evidence',
  (outcome) => {
    const f = diagnosticFixture();
    try {
      symlinkSync(process.cwd(), join(f.releaseDirectory, 'temporary', 'linked-source'));
      const observed = f.execute(outcome);
      assert.equal(observed['observationOnly'], true);
      assert.equal(observed['qualified'], false);
      assert.equal(observed['promotionEligible'], false);
      assert.equal(observed['qualificationOutcome'], outcome);
      const release = observed['release'] as Json;
      assert.equal(release['status'], 'failed');
      assert.deepEqual(release['cleanup'], { removed: false, quiescent: true });
      const cases = release['cases'] as Json[];
      assert.equal(cases.length, laneChecks.RELEASE_CASES.length);
      assert.equal(cases[0]!['status'], 'failed');
      assert.equal(cases[1]!['status'], 'unknown');
      assert.deepEqual((observed['consumer'] as Json)['cleanup'], { removed: false, quiescent: false });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test.each([
  'missing',
  'malformed',
  'oversized',
  'leaf-link',
  'parent-link',
  'root-link',
  'redirect',
  'wrong-run',
  'malformed-run',
  'duplicate',
  'unknown-fields',
] as const)('diagnostics preserve missing or unsafe %s evidence as unknown', (failure) => {
  const f = diagnosticFixture();
  try {
    const receipt = join(f.releaseDirectory, 'result.json');
    if (failure === 'missing') rmSync(receipt);
    if (failure === 'malformed') writeFileSync(receipt, '{');
    if (failure === 'malformed-run')
      f.save('result.json', { schemaVersion: 'ai-delivery.current-qualification@1', runId: { toString: null } });
    if (failure === 'oversized') writeFileSync(receipt, 'x'.repeat(4 * 1024 * 1024 + 1));
    if (failure === 'leaf-link') {
      rmSync(receipt);
      symlinkSync(join(f.qualificationRoot, 'result.json'), receipt);
    }
    if (failure === 'parent-link') {
      rmSync(f.releaseDirectory, { recursive: true });
      symlinkSync(join(f.qualificationRoot, 'producer'), f.releaseDirectory);
    }
    if (failure === 'root-link') {
      const retained = join(f.root, 'retained');
      mkdirSync(retained);
      rmSync(f.qualificationRoot, { recursive: true });
      symlinkSync(retained, f.qualificationRoot);
    }
    if (failure === 'redirect' || failure === 'wrong-run')
      f.save('release-tests-attempt.json', {
        stage: 'release-tests',
        runId: failure === 'wrong-run' ? '22222222-2222-4222-8222-222222222222' : f.runId,
        status: 'completed',
        directory: failure === 'redirect' ? f.root : f.releaseDirectory,
        resultPath: receipt,
      });
    if (failure === 'duplicate') {
      const entry = laneChecks.RELEASE_CASES[0]!;
      f.save(`release-tests-${f.runId}/vitest.json`, {
        testResults: [
          {
            name: join(f.sourceRoot, entry.file),
            assertionResults: [1, 2].map(() => ({ fullName: entry.title, status: 'passed' })),
          },
        ],
      });
    }
    if (failure === 'unknown-fields')
      f.save(`release-tests-${f.runId}/result.json`, {
        status: f.sensitive,
        release: { temporary: { removed: f.sensitive, quiescent: f.sensitive } },
        commands: [{ signal: f.sensitive, error: f.sensitive }],
      });
    const observed = f.execute();
    const release = observed['release'] as Json;
    if (failure === 'duplicate') assert.equal((release['cases'] as Json[])[0]!['status'], 'ambiguous');
    else {
      assert.equal(release['status'], 'unknown');
      assert.deepEqual(release['cleanup'], { removed: null, quiescent: null });
    }
    assert.equal(observed['qualified'], false);
    assert.equal(observed['promotionEligible'], false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('qualification without a digest cannot enter publication', () => {
  assert.equal(typeof api.releaseDispatch, 'function');
  const inputs = { source: 'a'.repeat(40), version: '0.3.35', digest: '', qualificationOnly: 'true', artifactId: '' };
  assert.deepEqual(api.releaseDispatch(inputs), {
    source: inputs.source,
    version: inputs.version,
    qualificationOnly: true,
  });
  assert.throws(() => api.releaseDispatch({ ...inputs, qualificationOnly: 'false' }));
});

test('accepted artifact dispatch requires the complete external tuple', () => {
  assert.equal(typeof api.releaseDispatch, 'function');
  const inputs = {
    source: 'a'.repeat(40),
    version: '0.3.35',
    digest: 'b'.repeat(64),
    qualificationOnly: 'false',
    artifactId: '42',
  };
  assert.deepEqual(api.releaseDispatch(inputs), {
    source: inputs.source,
    version: inputs.version,
    digest: inputs.digest,
    qualificationOnly: false,
    artifactId: 42,
  });
});

test.each([
  'unknown-mode',
  'empty-mode',
  'missing-source',
  'missing-digest',
  'dummy-digest',
  'missing-id',
  'multiple-ids',
  'zero-id',
  'leading-zero-id',
  'unsafe-id',
  'qualification-digest',
  'qualification-id',
])('release dispatch refuses %s before costly commands', (failure) => {
  assert.equal(typeof api.releaseDispatch, 'function');
  const inputs = {
    source: 'a'.repeat(40),
    version: '0.3.35',
    digest: 'b'.repeat(64),
    qualificationOnly: 'false',
    artifactId: '42',
  };
  if (failure === 'unknown-mode') inputs.qualificationOnly = 'automatic';
  if (failure === 'empty-mode') inputs.qualificationOnly = '';
  if (failure === 'missing-source') inputs.source = '';
  if (failure === 'missing-digest') inputs.digest = '';
  if (failure === 'dummy-digest') inputs.digest = 'dummy';
  if (failure === 'missing-id') inputs.artifactId = '';
  if (failure === 'multiple-ids') inputs.artifactId = '42,43';
  if (failure === 'zero-id') inputs.artifactId = '0';
  if (failure === 'leading-zero-id') inputs.artifactId = '042';
  if (failure === 'unsafe-id') inputs.artifactId = '9007199254740992';
  if (failure === 'qualification-digest') {
    inputs.qualificationOnly = 'true';
    inputs.artifactId = '';
  }
  if (failure === 'qualification-id') {
    inputs.qualificationOnly = 'true';
    inputs.digest = '';
  }
  assert.throws(() => api.releaseDispatch(inputs));
});

function originFixture() {
  const source = 'a'.repeat(40);
  const repository = 'aviaratech/ai-delivery';
  const repo = { id: 123, full_name: repository };
  const artifact: Json = {
    id: 42,
    name: 'npm-qualified-2',
    expired: false,
    expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: 101, repository_id: 123, head_repository_id: 123, head_branch: 'main', head_sha: source },
  };
  const attempt: Json = {
    id: 101,
    run_attempt: 2,
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: source,
    status: 'completed',
    conclusion: 'success',
    workflow_id: 201,
    repository: repo,
    head_repository: repo,
  };
  const workflow: Json = { id: 201, path: '.github/workflows/release.yml', state: 'active' };
  const jobs: Json = {
    total_count: 1,
    jobs: [
      {
        run_id: 101,
        run_attempt: 2,
        head_sha: source,
        name: 'package',
        status: 'completed',
        conclusion: 'success',
        steps: ['Qualify and retain the exact archive', 'Scan source history', 'Upload qualified package'].map(
          (name) => ({ name, status: 'completed', conclusion: 'success' }),
        ),
      },
    ],
  };
  return {
    metadata: { artifact, attempt, workflow, jobs },
    inputs: { repository, repositoryId: 123, source, artifactId: 42 },
  };
}

async function runOriginWorkflow(
  qualificationOnly: boolean,
  inputs: Inputs,
  failure?: 'main' | 'network' | 'oversized',
) {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const script = /node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/u.exec(workflow)?.[1];
  assert.ok(script);
  const program = script.replace(/^\s*import .+;\n/gmu, '');
  const f = originFixture();
  (f.metadata.artifact['workflow_run'] as Json)['head_sha'] = inputs.source;
  f.metadata.attempt['head_sha'] = inputs.source;
  (f.metadata.jobs['jobs'] as Json[])[0]!['head_sha'] = inputs.source;
  const prefix = 'https://api.github.com/repos/aviaratech/ai-delivery/';
  const responses: Record<string, unknown> = {
    'branches/main': {
      name: 'main',
      protected: true,
      commit: { sha: failure === 'main' ? 'b'.repeat(40) : inputs.source },
      protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['checks', 'secrets'] } },
    },
    'actions/artifacts/42': f.metadata.artifact,
    'actions/runs/101/attempts/2': f.metadata.attempt,
    'actions/workflows/release.yml': f.metadata.workflow,
    'actions/runs/101/attempts/2/jobs?per_page=100': f.metadata.jobs,
  };
  const commands: { command: string; args: string[] }[] = [];
  const requests: string[] = [];
  let output = '';
  const context = {
    pkg: {
      name: '@aviaratech/ai-delivery',
      version: inputs.version,
      private: false,
      license: 'MIT',
      repository: { url: 'git+https://github.com/aviaratech/ai-delivery.git' },
    },
    process: {
      env: {
        GITHUB_SHA: inputs.source,
        GITHUB_REPOSITORY: 'aviaratech/ai-delivery',
        GITHUB_REPOSITORY_ID: '123',
        REVIEWED_SOURCE_SHA: inputs.source,
        RELEASE_VERSION: inputs.version,
        REVIEWED_ARCHIVE_SHA256: qualificationOnly ? '' : inputs.digest,
        QUALIFICATION_ONLY: String(qualificationOnly),
        QUALIFICATION_ARTIFACT_ID: qualificationOnly ? '' : '42',
        GITHUB_OUTPUT: '/synthetic/output',
        GH_TOKEN: 'synthetic',
      },
    },
    execFileSync: (command: string, args: string[]) => {
      commands.push({ command, args: Array.from(args) });
      assert.equal(command, 'git');
      assert.deepEqual(Array.from(args), ['rev-parse', 'HEAD']);
      return inputs.source + '\n';
    },
    appendFileSync: (path: string, contents: string) => {
      assert.equal(path, '/synthetic/output');
      output += contents;
    },
    fetch: (url: string, options: RequestInit) => {
      requests.push(url);
      assert.equal(options.method ?? 'GET', 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal((options.headers as Record<string, string>)['Authorization'], 'Bearer synthetic');
      if (failure === 'network') return Promise.reject(new Error('Synthetic request failure'));
      if (failure === 'oversized') return Promise.resolve(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
      assert.ok(url.startsWith(prefix));
      const response = responses[url.slice(prefix.length)];
      assert.ok(response, 'No latest/by-name/fallback endpoint is permitted.');
      return Promise.resolve(Response.json(response));
    },
    releaseDispatch: api.releaseDispatch,
    validateQualificationOrigin: api.validateQualificationOrigin,
    Buffer,
    AbortSignal,
  };
  let error: string | null = null;
  try {
    await (new Script(`(async () => {${program}\n})()`).runInNewContext(context) as Promise<void>);
  } catch (failure) {
    error = String(failure);
  }
  return { error, commands, requests, output };
}

test('actual qualification entry observes only protected source before any archive exists', async () => {
  const result = await runOriginWorkflow(true, { source: 'a'.repeat(40), version: '0.3.35', digest: '' });
  assert.equal(result.error, null);
  assert.deepEqual(result.commands, [{ command: 'git', args: ['rev-parse', 'HEAD'] }]);
  assert.deepEqual(result.requests, ['https://api.github.com/repos/aviaratech/ai-delivery/branches/main']);
  assert.equal(result.output, '');
});

test('accepted artifact promotion executes no qualification graph', async () => {
  const f = fixture();
  try {
    api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source);
    writeFileSync(join(f.output, 'SHA256SUMS'), `${f.inputs.digest}  ${basename(f.archivePath)}\n`);
    const result = await runOriginWorkflow(false, f.inputs);
    assert.equal(result.error, null);
    assert.equal(result.output, 'run_id=101\nrun_attempt=2\nartifact_id=42\n');
    assert.equal(result.requests.length, 5);
    assert.deepEqual(result.commands, [{ command: 'git', args: ['rev-parse', 'HEAD'] }]);
    const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const step = workflow
      .split(/(?=^ {6}- )/mu)
      .find((step) => step.includes('name: Verify accepted original archive\n'));
    assert.ok(step);
    assert.match(step, /if: \$\{\{ !inputs\.qualification_only \}\}/u);
    const script = step
      .split('        run: |\n')[1]
      ?.split('\n')
      .map((line) => line.replace(/^ {10}/u, ''))
      .join('\n');
    assert.ok(script);
    const trace = execFileSync('/bin/bash', ['-ex', '-c', 'exec 2>&1\n' + script], {
      cwd: realpathSync(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        RUNNER_TEMP: f.directory,
        REVIEWED_SOURCE_SHA: f.inputs.source,
        RELEASE_VERSION: f.inputs.version,
        REVIEWED_ARCHIVE_SHA256: f.inputs.digest,
      },
      encoding: 'utf8',
    });
    assert.match(trace, /node scripts\/release-artifact\.mjs verify/u);
    assert.match(trace, /shasum -a 256 -c SHA256SUMS/u);
    assert.doesNotMatch(trace, /npm ci|npm run|npm pack|current-qualification|current-consumer/u);
  } finally {
    f.cleanup();
  }
});

test.each(['main', 'network', 'oversized'] as const)(
  'actual origin entry refuses %s readback without fallback commands',
  async (failure) => {
    const result = await runOriginWorkflow(
      false,
      { source: 'a'.repeat(40), version: '0.3.35', digest: 'b'.repeat(64) },
      failure,
    );
    assert.ok(result.error);
    assert.equal(result.requests.length, 1);
    assert.equal(result.output, '');
    assert.deepEqual(result.commands, [{ command: 'git', args: ['rev-parse', 'HEAD'] }]);
  },
);

test('origin binds the exact successful original release attempt', () => {
  const f = originFixture();
  assert.equal(typeof api.validateQualificationOrigin, 'function');
  assert.deepEqual(api.validateQualificationOrigin(f.metadata, f.inputs), {
    artifactId: 42,
    runId: 101,
    runAttempt: 2,
    artifactName: 'npm-qualified-2',
  });
});

test.each([
  'missing-artifact',
  'different-id',
  'unsafe-id',
  'expired',
  'expiry',
  'promotion-namespace',
  'unsafe-attempt',
  'foreign-repository',
  'fork',
  'wrong-source',
  'wrong-branch',
  'wrong-event',
  'wrong-workflow',
  'wrong-workflow-path',
  'failed-original-attempt',
  'later-attempt',
  'incomplete-attempt',
  'missing-job',
  'incomplete-job-list',
  'wrong-job-attempt',
  'failed-package',
  'missing-qualification-step',
  'failed-scan',
  'skipped-upload',
])('origin refuses %s without substituting latest qualification', (failure) => {
  const f = originFixture();
  assert.equal(typeof api.validateQualificationOrigin, 'function');
  const { artifact, attempt, workflow, jobs } = f.metadata;
  const run = artifact['workflow_run'] as Json;
  const job = (jobs['jobs'] as Json[])[0]!;
  const steps = job['steps'] as Json[];
  if (failure === 'missing-artifact') f.metadata.artifact = {};
  if (failure === 'different-id') artifact['id'] = 43;
  if (failure === 'unsafe-id') f.inputs.artifactId = Number.MAX_SAFE_INTEGER + 1;
  if (failure === 'expired') artifact['expired'] = true;
  if (failure === 'expiry') artifact['expires_at'] = '2000-01-01T00:00:00Z';
  if (failure === 'promotion-namespace') artifact['name'] = 'npm-package';
  if (failure === 'unsafe-attempt') artifact['name'] = 'npm-qualified-9007199254740992';
  if (failure === 'foreign-repository') run['repository_id'] = 124;
  if (failure === 'fork') run['head_repository_id'] = 124;
  if (failure === 'wrong-source') run['head_sha'] = 'b'.repeat(40);
  if (failure === 'wrong-branch') attempt['head_branch'] = 'issue/166';
  if (failure === 'wrong-event') attempt['event'] = 'pull_request';
  if (failure === 'wrong-workflow') attempt['workflow_id'] = 202;
  if (failure === 'wrong-workflow-path') workflow['path'] = '.github/workflows/ci.yml';
  if (failure === 'failed-original-attempt') attempt['conclusion'] = 'failure';
  if (failure === 'later-attempt') attempt['run_attempt'] = 3;
  if (failure === 'incomplete-attempt') attempt['status'] = 'in_progress';
  if (failure === 'missing-job') jobs['jobs'] = [];
  if (failure === 'incomplete-job-list') jobs['total_count'] = 2;
  if (failure === 'wrong-job-attempt') job['run_attempt'] = 3;
  if (failure === 'failed-package') job['conclusion'] = 'failure';
  if (failure === 'missing-qualification-step') steps.shift();
  if (failure === 'failed-scan') steps[1]!['conclusion'] = 'failure';
  if (failure === 'skipped-upload') steps[2]!['conclusion'] = 'skipped';
  assert.throws(() => api.validateQualificationOrigin(f.metadata, f.inputs));
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-release-workflow-')));
  const source = join(directory, 'source');
  const results = join(directory, 'qualification');
  mkdirSync(source);
  mkdirSync(join(results, 'pack'), { recursive: true });
  const version = '0.0.0';
  const manifest = {
    name: '@aviaratech/ai-delivery',
    version,
    type: 'module',
    main: './dist/index.js',
    bin: { 'ai-delivery': './dist/cli.js' },
    engines: { node: '>=24.21.0 <25 || 26.2.0', npm: '11.19.0' },
    exports: {
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './agent': { default: './dist/agent.js', types: './dist/agent.d.ts' },
      './delivery': { default: './dist/delivery/index.js', types: './dist/delivery/index.d.ts' },
      './mcp': { default: './dist/mcp/index.js', types: './dist/mcp/index.d.ts' },
    },
  };
  const files = new Map<string, string>([['package.json', JSON.stringify(manifest)]]);
  for (const file of ['setup', 'lifecycle', 'targetPolicyLocal', 'pluginPackaging'])
    files.set(`dist/${file}.test.js`, '// fictional compiled release test bytes\n');
  for (const path of [
    'LICENSE',
    'README.md',
    'CONTRIBUTING.md',
    'dist/cli.js',
    'plugins/ai-delivery/dist/mcp-launcher.js',
    'plugins/ai-delivery/runtime/dist/cli.js',
    'plugins/ai-delivery/runtime/dist/THIRD-PARTY-NOTICES.md',
  ])
    files.set(path, 'synthetic inert bytes\n');
  for (const path of ['index', 'agent', 'delivery/index', 'mcp/index'])
    for (const ext of ['js', 'd.ts']) files.set(`dist/${path}.${ext}`, 'synthetic inert export\n');
  for (const path of ['plugins/ai-delivery/plugin.json', 'plugins/ai-delivery/.claude-plugin/plugin.json'])
    files.set(path, JSON.stringify({ name: 'ai-delivery', version }));
  files.set('plugins/ai-delivery/runtime/package.json', JSON.stringify({ version }));
  files.set(
    'plugins/ai-delivery/mcp.json',
    JSON.stringify({
      mcpServers: { 'ai-delivery': { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/mcp-launcher.js'] } },
    }),
  );
  for (const skill of ['intake-create', 'worktree-lifecycle', 'pr-handoff'])
    files.set(
      `plugins/ai-delivery/skills/${skill}/SKILL.md`,
      `---\nname: ai-delivery:${skill}\ndescription: Fictional release fixture\n---\n`,
    );
  const members = [...files].map(([path, contents]) => ({
    path,
    bytes: Buffer.from(contents),
    mode: path.endsWith('/cli.js') || path.endsWith('/mcp-launcher.js') ? 0o755 : 0o644,
  }));
  const chunks: Buffer[] = [];
  for (const member of members) {
    const path = join(source, member.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, member.bytes);
    chmodSync(path, member.mode);
    const header = Buffer.alloc(512);
    header.write(`package/${member.path}`, 0, 100);
    const number = (value: number, offset: number, size: number) =>
      header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size);
    number(member.mode, 100, 8);
    number(0, 108, 8);
    number(0, 116, 8);
    number(member.bytes.length, 124, 12);
    number(0, 136, 12);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(
      header
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      8,
    );
    chunks.push(header, member.bytes, Buffer.alloc((512 - (member.bytes.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks));
  const archivePath = join(results, 'pack', `aviaratech-ai-delivery-${version}.tgz`);
  writeFileSync(archivePath, archive);
  writeFileSync(join(source, 'package-lock.json'), '{"synthetic":true}\n');
  writeFileSync(
    join(source, '.gitignore'),
    ['setup', 'lifecycle', 'targetPolicyLocal', 'pluginPackaging'].map((name) => `/dist/${name}.test.js`).join('\n') +
      '\n',
  );
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fictional Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'synthetic source',
    ],
    { cwd: source },
  );
  const identity = qualification.sourceIdentity(source);
  const contract: Contract = {
    sourceRoot: source,
    sourceCommit: identity.commit,
    sourceTree: identity.tree,
    sourceManifestSha256: identity.manifestSha256,
    sourceLockSha256: identity.lockSha256,
    packageVersion: version,
    archivePath,
    archiveSha256: canonical.sha256(archive),
    dryInventory: members.map(({ path, bytes, mode }) => ({ path, size: bytes.length, mode })),
    node24: process.execPath,
    node26: '/fictional/node26',
    npmCli: '/fictional/npm',
  };
  const candidate = canonical.inspectCandidate(contract);
  const save = (path: string, object: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    const contents = JSON.stringify(object, null, 2) + '\n';
    writeFileSync(path, contents);
    return { path, sha256: canonical.sha256(contents) };
  };
  const command = { status: 'passed', exitCode: 0, signal: null, cleanupConfirmed: true };
  // Fictional successful receipts exercise the validator, never claim actual execution.
  const producer = save(join(results, 'producer/result.json'), {
    schemaVersion: 'contributor-checks@1',
    runId: 'synthetic',
    scope: 'full',
    status: 'passed',
    fullSuccess: true,
    exitCode: 0,
    gates,
    omitted: [],
    tree: identity.fingerprint,
    commands: gates.map((stage) => ({ stage, ...command })),
    selectedTestFiles: ['src/fictional.test.ts'],
    tests: { files: 1, passed: 1, total: 1, skips: [] },
    toolchain: {
      controller: { executable: contract.node24, version: 'v24.21.0' },
      npm: { executable: contract.npmCli, version: '11.19.0' },
      libraryConsumer: { executable: contract.node26, version: 'v26.2.0' },
    },
    inventory: {
      kind: 'dry-inventory-only',
      name: manifest.name,
      version,
      fileCount: members.length,
      files: candidate.inventory,
    },
  });
  const packCommand = {
    ...command,
    command: [
      contract.node24,
      contract.npmCli,
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      dirname(archivePath),
    ],
  };
  const artifact = save(join(results, 'pack/producer.json'), {
    schemaVersion: 'ai-delivery.current-artifact-producer@1',
    status: 'passed',
    ...contract,
    checksResultSha256: producer.sha256,
    inventorySha256: candidate.inventorySha256,
    sourceFingerprint: identity.fingerprint,
    pack: {
      status: 'passed',
      exitCode: 0,
      quiescent: true,
      archiveSha256: contract.archiveSha256,
      command: packCommand,
      sourceBefore: identity,
      sourceAfter: identity,
    },
  });
  contract.producer = {
    checksResultPath: producer.path,
    checksResultSha256: producer.sha256,
    artifactReceiptPath: artifact.path,
    artifactReceiptSha256: artifact.sha256,
  };
  const joinProof = canonical.verifyProducerJoin(contract, candidate);
  save(join(results, 'contract.json'), contract);
  const contractSha256 = canonical.sha256(JSON.stringify(contract));
  const checkpoint = save(join(results, 'checkpoint.json'), {
    schemaVersion: 'ai-delivery.current-qualification-checkpoint@1',
    status: 'producer-passed-consumer-required',
    source: identity,
    contract,
    contractSha256,
  });
  const releaseDirectory = join(results, 'release-tests-00000000-0000-4000-8000-000000000000');
  const releaseTests = save(join(releaseDirectory, 'result.json'), {
    schemaVersion: 'contributor-checks@1',
    scope: 'release',
    status: 'passed',
    exitCode: 0,
    fullSuccess: false,
    artifactQualified: false,
    resultsDir: releaseDirectory,
    gates: ['tests'],
    omitted: ['PR producer and consumer'],
    tree: identity.fingerprint,
    toolchain: {
      controller: { version: 'v24.21.0', executable: contract.node24 },
      libraryConsumer: { version: 'v26.2.0', executable: contract.node26 },
      npm: { version: '11.19.0', executable: contract.npmCli },
    },
    release: {
      ...qualification.validateReleaseEntry(join(results, 'contract.json'), source),
      contractSha256: canonical.sha256(readFileSync(join(results, 'contract.json'))),
      historicalInputSupplied: false,
      temporary: { path: join(releaseDirectory, 'temporary'), dev: 1, ino: 1, removed: true, quiescent: true },
    },
    commands: [{ stage: 'tests', ...command }],
    selectedTestFiles: [...new Set(laneChecks.RELEASE_CASES.map((test) => test.file))],
    tests: {
      lane: 'release',
      files: new Set(laneChecks.RELEASE_CASES.map((test) => test.file)).size,
      total: laneChecks.RELEASE_CASES.length,
      passed: laneChecks.RELEASE_CASES.filter((test) => test.kind === 'mandatory').length,
      skips: laneChecks.RELEASE_CASES.filter((test) => test.kind !== 'mandatory'),
      selectedCases: laneChecks.RELEASE_CASES.map(({ file, title }) => ({ file, title })),
      laneExcluded: [],
    },
  });
  save(join(results, 'release-tests-attempt.json'), {
    stage: 'release-tests',
    status: 'completed',
    checkpointSha256: checkpoint.sha256,
    contractSha256,
    directory: releaseDirectory,
    resultPath: releaseTests.path,
    receipt: releaseTests,
    command: { stage: 'tests', ...command },
  });
  const consumerDirectory = join(results, 'consumer-00000000-0000-4000-8000-000000000000');
  const consumer = save(join(consumerDirectory, 'result.json'), {
    schemaVersion: 'ai-delivery.current-consumer@1',
    status: 'passed',
    qualified: true,
    sourceIdentityVerified: true,
    scriptsDisabled: true,
    ...contract,
    archiveManifestSha256: contract.sourceManifestSha256,
    inventorySha256: candidate.inventorySha256,
    inventory: candidate.inventory,
    producerJoin: joinProof,
    cleanup: { removed: true, quiescent: true },
    productionClosure: {},
    mcp: {},
    skills: ['fictional1', 'fictional2', 'fictional3'],
    resolutions: ['fictional'],
    phases: [
      'node24',
      'node26',
      'npm',
      'production-install',
      'production-closure',
      'cli-version',
      'cli-json',
      'exports-node24',
      'library-node26',
      'packaged-mcp',
    ].map((phase) => ({ phase, code: 0, signal: null, quiescent: true })),
  });
  const attempt = save(join(results, 'consumer-attempt.json'), {
    schemaVersion: 'ai-delivery.current-consumer-attempt@1',
    status: 'completed',
    temporaryRemoved: true,
    checkpointSha256: checkpoint.sha256,
    contractSha256,
    command,
    receipt: consumer,
    directory: consumerDirectory,
    consumerPath: consumer.path,
    tempRoot: join(consumerDirectory, 'temporary'),
  });
  const overall: Json = {
    schemaVersion: 'ai-delivery.current-qualification@1',
    status: 'passed',
    qualified: true,
    exitCode: 0,
    omitted: [],
    resultsDir: results,
    source: identity,
    producer,
    artifact,
    checkpoint,
    releaseTests,
    consumer,
    consumerAttempt: attempt,
    consumerProcess: command,
    pack: packCommand,
  };
  save(join(results, 'result.json'), overall);
  const inputs = { source: identity.commit, version, digest: contract.archiveSha256 };
  const output = join(directory, 'release-artifact');
  const edit = (path: string, action: (data: Json) => void) => {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Json;
    action(data);
    save(path, data);
  };
  return {
    contract,
    directory,
    source,
    results,
    output,
    inputs,
    archivePath,
    consumerDirectory,
    releaseTests,
    overall,
    save,
    edit,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('release selects and re-verifies exact synthetic qualified bytes and retains original receipts', () => {
  const f = fixture();
  try {
    const bundle = api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source);
    const selected = api.verifyReleaseArtifact(f.output, f.inputs);
    assert.equal(basename(selected), basename(f.archivePath));
    assert.deepEqual(readFileSync(selected), readFileSync(f.archivePath));
    assert.equal(bundle.records['overall']?.contents, readFileSync(join(f.results, 'result.json'), 'utf8'));
    assert.equal(bundle.archive.sha256, f.inputs.digest);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: f.source, encoding: 'utf8' }), '');
    assert.throws(() => api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source));
  } finally {
    f.cleanup();
  }
});

test('first qualification selects observed bytes without a pre-known digest', () => {
  const f = fixture();
  try {
    const bundle = api.selectReleaseArtifact(
      f.results,
      f.output,
      { source: f.inputs.source, version: f.inputs.version },
      f.source,
    );
    assert.equal(bundle.archive.sha256, f.inputs.digest);
    assert.equal(api.verifyReleaseArtifact(f.output, f.inputs), join(f.output, basename(f.archivePath)));
  } finally {
    f.cleanup();
  }
});

test('packed helpers copy only the retained qualified archive without repacking', () => {
  assert.equal(typeof qualification.copyReleaseArchive, 'function');
  const f = fixture();
  try {
    const original = readFileSync(f.archivePath);
    const contract = readFileSync(join(f.results, 'contract.json'));
    const destination = join(f.directory, 'helper.tgz');
    assert.deepEqual(qualification.copyReleaseArchive(join(f.results, 'contract.json'), f.source, destination), {
      archivePath: destination,
      archiveSha256: f.inputs.digest,
    });
    assert.deepEqual(readFileSync(destination), original);
    assert.deepEqual(readFileSync(f.archivePath), original);
    assert.deepEqual(readFileSync(join(f.results, 'contract.json')), contract);
    assert.throws(() => qualification.copyReleaseArchive(join(f.results, 'contract.json'), f.source, destination));
  } finally {
    f.cleanup();
  }
});

test('release scope runs only the exact mandatory inventory without another build', async () => {
  const f = fixture();
  try {
    const context = qualification.validateReleaseEntry(join(f.results, 'contract.json'), f.source);
    const files = [...new Set(laneChecks.RELEASE_CASES.map((test) => test.file))];
    let launched = 0;
    let driftDuringTest = false;
    let commandStatus = 'passed';
    let confirmed = true;
    const unrelated = join(f.directory, 'unrelated');
    writeFileSync(unrelated, 'preserve');
    const toolchain = () => ({
      controller: { version: 'v24.21.0', executable: f.contract.node24 },
      npm: { version: '11.19.0', executable: f.contract.npmCli },
      libraryConsumer: { version: 'v26.2.0', executable: f.contract.node26 },
    });
    const execute = async (command: string[], options: { directory: string; env: NodeJS.ProcessEnv }) => {
      launched++;
      assert.ok(command.includes('--tags-filter=release'));
      assert.deepEqual(
        command.filter((arg) => arg.startsWith('dist/')),
        files,
      );
      assert.equal(options.env.AI_DELIVERY_TEST_LANE, 'release');
      assert.equal(options.env.AI_DELIVERY_RELEASE_CONTRACT, context.contractPath);
      assert.equal(options.env.TMPDIR, options.env.TEMP);
      assert.equal(options.env.TEMP, options.env.TMP);
      assert.ok(options.env.TMPDIR);
      writeFileSync(join(options.env.TMPDIR, 'owned-leftover'), 'remove after quiescence');
      mkdirSync(options.directory, { recursive: true });
      const output = command.find((arg) => arg.startsWith('--outputFile.json='))!.slice('--outputFile.json='.length);
      writeFileSync(
        output,
        JSON.stringify({
          success: true,
          numTotalTests: laneChecks.RELEASE_CASES.length,
          numPassedTests: laneChecks.RELEASE_CASES.filter((test) => test.kind === 'mandatory').length,
          testResults: files.map((file) => ({
            name: join(f.source, file),
            status: 'passed',
            assertionResults: laneChecks.RELEASE_CASES.filter((test) => test.file === file).map((test) => ({
              fullName: test.title,
              status: test.kind === 'mandatory' ? 'passed' : 'pending',
              tags: ['release'],
            })),
          })),
        }),
      );
      const stdoutPath = join(options.directory, 'stdout.txt');
      const stderrPath = join(options.directory, 'stderr.txt');
      writeFileSync(stdoutPath, 'SETUP_INTERRUPTION_RECEIPT SETUP_CLI_PHASE_RECEIPT');
      writeFileSync(stderrPath, '');
      if (driftDuringTest) writeFileSync(join(f.source, files[0]!), '// changed ignored compiled bytes\n');
      return {
        status: commandStatus,
        exitCode: commandStatus === 'passed' ? 0 : 1,
        signal: commandStatus === 'cancelled' ? 'SIGTERM' : null,
        cleanupConfirmed: confirmed,
        stdoutPath,
        stderrPath,
      };
    };
    const report = await laneChecks.runChecks({
      cwd: f.source,
      resultsDir: join(f.directory, 'release-checks'),
      release: context,
      toolchain,
      execute,
    });
    assert.equal(report.status, 'passed', report.error);
    assert.equal(report.scope, 'release');
    assert.equal(report.fullSuccess, false);
    assert.equal(report.artifactQualified, false);
    assert.equal(report.tests?.passed, laneChecks.RELEASE_CASES.filter((test) => test.kind === 'mandatory').length);
    assert.deepEqual(
      report.commands.map((command) => command.stage),
      ['tests'],
    );
    assert.equal(launched, 1);
    assert.equal(report.release?.temporary?.removed, true);
    assert.equal(existsSync(report.release!.temporary!.path), false);
    for (const status of ['failed', 'cancelled']) {
      commandStatus = status;
      const terminal = await laneChecks.runChecks({
        cwd: f.source,
        resultsDir: join(f.directory, `release-${status}`),
        release: context,
        toolchain,
        execute,
      });
      assert.equal(terminal.status, status);
      assert.equal(terminal.release?.temporary?.removed, true);
      assert.equal(existsSync(terminal.release!.temporary!.path), false);
      assert.equal(readFileSync(unrelated, 'utf8'), 'preserve');
    }
    commandStatus = 'passed';
    confirmed = false;
    const unconfirmed = await laneChecks.runChecks({
      cwd: f.source,
      resultsDir: join(f.directory, 'unconfirmed-cleanup'),
      release: context,
      toolchain,
      execute,
    });
    assert.equal(unconfirmed.status, 'failed');
    assert.equal(unconfirmed.release?.temporary?.removed, false);
    assert.ok(existsSync(join(unconfirmed.release!.temporary!.path, 'owned-leftover')));
    assert.match(unconfirmed.release!.temporary!.error!, /quiescence/u);
    confirmed = true;
    const beforeRefusal = launched;
    const rejected = await laneChecks.runChecks({
      cwd: f.source,
      resultsDir: join(f.directory, 'wrong-context'),
      release: { ...context, archiveSha256: '0'.repeat(64) },
      toolchain,
      execute,
    });
    assert.equal(rejected.status, 'failed');
    assert.equal(launched, beforeRefusal, 'A mismatched context must not launch another child.');
    driftDuringTest = true;
    const changed = await laneChecks.runChecks({
      cwd: f.source,
      resultsDir: join(f.directory, 'changed-during-tests'),
      release: context,
      toolchain,
      execute,
    });
    assert.equal(changed.status, 'failed', 'Ignored compiled changes during a release run must invalidate its proof.');
    assert.equal(launched, beforeRefusal + 1);
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: f.source, encoding: 'utf8' }),
      '',
      'Git cleanliness cannot prove ignored test bytes.',
    );
    const stale = await laneChecks.runChecks({
      cwd: f.source,
      resultsDir: join(f.directory, 'stale-compiled'),
      release: context,
      toolchain,
      execute,
    });
    assert.equal(stale.status, 'failed');
    assert.equal(launched, beforeRefusal + 1, 'Stale compiled release bytes must fail before launch.');
  } finally {
    f.cleanup();
  }
});

test.each(['archive-drift', 'source-drift', 'compiled-drift', 'destination-link', 'parent-alias'])(
  'packed archive copy refuses %s without replacing originals',
  (failure) => {
    assert.equal(typeof qualification.copyReleaseArchive, 'function');
    const f = fixture();
    try {
      let destination = join(f.directory, 'helper.tgz');
      const original = readFileSync(f.archivePath);
      if (failure === 'archive-drift') writeFileSync(f.archivePath, 'changed archive');
      if (failure === 'source-drift') writeFileSync(join(f.source, 'untracked'), 'changed source');
      if (failure === 'compiled-drift') {
        writeFileSync(join(f.source, 'dist/setup.test.js'), '// changed ignored compiled bytes\n');
        assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: f.source, encoding: 'utf8' }), '');
      }
      if (failure === 'destination-link') symlinkSync(f.archivePath, destination);
      if (failure === 'parent-alias') {
        symlinkSync(f.directory, join(f.directory, 'alias'));
        destination = join(f.directory, 'alias/helper.tgz');
      }
      assert.throws(() => qualification.copyReleaseArchive(join(f.results, 'contract.json'), f.source, destination));
      if (failure !== 'archive-drift') assert.deepEqual(readFileSync(f.archivePath), original);
      if (failure !== 'destination-link') assert.equal(existsSync(destination), false);
    } finally {
      f.cleanup();
    }
  },
);

test('publication verification never learns a missing expected digest', () => {
  const f = fixture();
  try {
    api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source);
    for (const digest of ['', 'dummy', '0'.repeat(64)])
      assert.throws(() => api.verifyReleaseArtifact(f.output, { ...f.inputs, digest }));
  } finally {
    f.cleanup();
  }
});

test('fresh outer resume selects and portably verifies original qualified bytes without replay', async () => {
  const f = fixture();
  try {
    const originalResult = readFileSync(join(f.results, 'result.json'));
    const originalArchive = readFileSync(f.archivePath);
    const outer = join(f.directory, 'resumed-outer');
    let commands = 0;
    const forbidden = async () => {
      commands++;
      throw new Error('Completed units must not replay.');
    };
    const resumed = await qualification.runQualification({
      cwd: f.source,
      resultsDir: outer,
      resume: join(f.results, 'checkpoint.json'),
      checks: forbidden,
      execute: forbidden,
    });
    assert.equal(resumed.qualified, true, resumed.error);
    assert.equal(commands, 0);
    const bundle = api.selectReleaseArtifact(outer, f.output, f.inputs, f.source);
    assert.deepEqual(readFileSync(join(f.results, 'result.json')), originalResult);
    assert.equal(bundle.records['checkpoint']?.contents, readFileSync(join(f.results, 'checkpoint.json'), 'utf8'));
    assert.deepEqual(readFileSync(f.archivePath), originalArchive);
    rmSync(f.results, { recursive: true });
    rmSync(outer, { recursive: true });
    assert.deepEqual(readFileSync(api.verifyReleaseArtifact(f.output, f.inputs)), originalArchive);
  } finally {
    f.cleanup();
  }
});

test.each([
  'missing',
  'corrupt',
  'PR-only',
  'source',
  'contract',
  'producer',
  'archive',
  'missing-case',
  'duplicate-case',
  'failed-case',
  'cleanup',
  'command-cleanup',
  'leftover-temp',
])('release selection refuses %s release proof before retaining output', (failure) => {
  const f = fixture();
  try {
    if (failure === 'missing')
      f.edit(join(f.results, 'result.json'), (data) => {
        delete data['releaseTests'];
      });
    else if (failure === 'corrupt') writeFileSync(f.releaseTests.path, '{}');
    else {
      f.edit(f.releaseTests.path, (data) => {
        const context = data['release'] as Json;
        const tests = data['tests'] as Json;
        if (failure === 'PR-only') data['scope'] = 'full';
        if (failure === 'source') context['sourceCommit'] = 'a'.repeat(40);
        if (failure === 'contract') context['contractSha256'] = 'b'.repeat(64);
        if (failure === 'producer') context['producerSha256'] = 'c'.repeat(64);
        if (failure === 'archive') context['archiveSha256'] = 'd'.repeat(64);
        if (failure === 'missing-case') (tests['selectedCases'] as unknown[]).pop();
        if (failure === 'duplicate-case')
          (tests['selectedCases'] as unknown[]).push((tests['selectedCases'] as unknown[])[0]);
        if (failure === 'failed-case') tests['passed'] = 22;
        if (failure === 'cleanup') (context['temporary'] as Json)['removed'] = false;
        if (failure === 'command-cleanup') (data['commands'] as Json[])[0]!['cleanupConfirmed'] = false;
      });
      f.edit(join(f.results, 'result.json'), (data) => {
        data['releaseTests'] = {
          path: f.releaseTests.path,
          sha256: canonical.sha256(readFileSync(f.releaseTests.path)),
        };
      });
    }
    if (failure === 'leftover-temp') mkdirSync(join(dirname(f.releaseTests.path), 'temporary'));
    assert.throws(() => api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source));
    assert.equal(existsSync(f.output), false);
  } finally {
    f.cleanup();
  }
});

test('portable verification refuses missing or incomplete release proof even with consistent hashes', () => {
  const f = fixture();
  const diagnostic = diagnosticFixture();
  try {
    const bundle = api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source);
    const original = bundle.records['releaseTests'];
    assert.ok(original);
    const path = join(f.output, 'qualification.json');
    f.edit(path, (data) => {
      delete (data['records'] as Json)['releaseTests'];
    });
    assert.throws(() => api.verifyReleaseArtifact(f.output, f.inputs));
    bundle.records['releaseTests'] = original;
    const report = JSON.parse(original.contents) as Json;
    report['scope'] = 'full';
    const observations = diagnostic.raw('failure', {
      REVIEWED_SOURCE_SHA: f.inputs.source,
      GITHUB_SHA: f.inputs.source,
    });
    for (const invalid of [report, observations]) {
      const contents = JSON.stringify(invalid);
      bundle.records['releaseTests'] = { contents, sha256: canonical.sha256(contents) };
      const overall = JSON.parse(bundle.records['overall']!.contents) as Json;
      (overall['releaseTests'] as Json)['sha256'] = canonical.sha256(contents);
      const overallContents = JSON.stringify(overall);
      bundle.records['overall'] = { contents: overallContents, sha256: canonical.sha256(overallContents) };
      f.save(path, bundle);
      assert.throws(() => api.verifyReleaseArtifact(f.output, f.inputs));
    }
  } finally {
    rmSync(diagnostic.root, { recursive: true, force: true });
    f.cleanup();
  }
});

test.each(['checkpoint-alias', 'checkpoint-redirection', 'output-inside-original', 'output-inside-outer'])(
  'resumed selection refuses %s without changing original evidence',
  (failure) => {
    const f = fixture();
    try {
      const outer = join(f.directory, 'resumed-outer');
      mkdirSync(outer);
      const overall: Json = { ...f.overall, resultsDir: outer };
      const checkpoint = f.overall['checkpoint'] as { path: string; sha256: string };
      if (failure === 'checkpoint-alias') {
        const alias = join(f.directory, 'checkpoint-alias');
        symlinkSync(f.results, alias);
        overall['checkpoint'] = { ...checkpoint, path: join(alias, 'checkpoint.json') };
      }
      if (failure === 'checkpoint-redirection') {
        const other = join(f.directory, 'unrelated');
        mkdirSync(other);
        const path = join(other, 'checkpoint.json');
        writeFileSync(path, readFileSync(checkpoint.path));
        overall['checkpoint'] = { ...checkpoint, path };
      }
      f.save(join(outer, 'result.json'), overall);
      const output =
        failure === 'output-inside-original'
          ? join(f.results, 'selected')
          : failure === 'output-inside-outer'
            ? join(outer, 'selected')
            : f.output;
      assert.throws(() => api.selectReleaseArtifact(outer, output, f.inputs, f.source));
      assert.equal(existsSync(output), false);
    } finally {
      f.cleanup();
    }
  },
);

test.each([
  'missing',
  'incomplete',
  'unqualified',
  'exit',
  'omission',
  'wrong-source',
  'wrong-version',
  'modified-archive',
  'unsafe-archive-path',
  'linked-archive',
  'producer-digest',
  'consumer-digest',
  'cleanup',
  'leftover-temp',
  'source-drift',
])('release refuses %s before upload', (failure) => {
  const f = fixture();
  try {
    const resultPath = join(f.results, 'result.json');
    if (failure === 'missing') rmSync(resultPath);
    if (failure === 'incomplete')
      f.edit(resultPath, (data) => {
        data['status'] = 'incomplete';
      });
    if (failure === 'unqualified')
      f.edit(resultPath, (data) => {
        data['qualified'] = false;
      });
    if (failure === 'exit')
      f.edit(resultPath, (data) => {
        data['exitCode'] = 1;
      });
    if (failure === 'omission')
      f.edit(resultPath, (data) => {
        data['omitted'] = ['consumer'];
      });
    if (failure === 'wrong-source') f.inputs.source = '0'.repeat(40);
    if (failure === 'wrong-version') f.inputs.version = '0.0.1';
    if (failure === 'modified-archive') writeFileSync(f.archivePath, 'changed archive');
    if (failure === 'unsafe-archive-path') {
      const path = join(f.results, 'checkpoint.json');
      f.edit(path, (data) => {
        (data['contract'] as Json)['archivePath'] = join(f.directory, 'outside.tgz');
      });
      f.edit(resultPath, (data) => {
        data['checkpoint'] = { path, sha256: canonical.sha256(readFileSync(path)) };
      });
    }
    if (failure === 'linked-archive') {
      const other = join(f.directory, 'other.tgz');
      writeFileSync(other, readFileSync(f.archivePath));
      rmSync(f.archivePath);
      symlinkSync(other, f.archivePath);
    }
    if (failure === 'producer-digest')
      f.edit(join(f.results, 'producer/result.json'), (data) => {
        data['fullSuccess'] = false;
      });
    if (failure === 'consumer-digest')
      f.edit(join(f.consumerDirectory, 'result.json'), (data) => {
        data['qualified'] = false;
      });
    if (failure === 'cleanup') {
      const path = join(f.results, 'consumer-attempt.json');
      f.edit(path, (data) => {
        data['temporaryRemoved'] = false;
      });
      f.edit(resultPath, (data) => {
        data['consumerAttempt'] = { path, sha256: canonical.sha256(readFileSync(path)) };
      });
    }
    if (failure === 'leftover-temp') mkdirSync(join(f.consumerDirectory, 'temporary'));
    if (failure === 'source-drift') writeFileSync(join(f.source, 'untracked'), 'changed source');
    assert.throws(() => api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source));
    assert.equal(existsSync(f.output), false, 'No upload directory may be created before validation.');
  } finally {
    f.cleanup();
  }
});

test('downloaded portable proof and bytes must still match before publication', () => {
  const f = fixture();
  try {
    api.selectReleaseArtifact(f.results, f.output, f.inputs, f.source);
    const proof = join(f.output, 'qualification.json');
    f.edit(proof, (data) => {
      ((data['records'] as Json)['consumer'] as Json)['contents'] = '{}';
    });
    assert.throws(() => api.verifyReleaseArtifact(f.output, f.inputs));
    api.selectReleaseArtifact(f.results, join(f.directory, 'second-copy'), f.inputs, f.source);
    writeFileSync(join(f.directory, 'second-copy', basename(f.archivePath)), 'changed bytes');
    assert.throws(() => api.verifyReleaseArtifact(join(f.directory, 'second-copy'), f.inputs));
  } finally {
    f.cleanup();
  }
});

test('actual release workflow passes the qualified archive through upload and direct npm argument', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const packageJob = workflow.slice(workflow.indexOf('  package:'), workflow.indexOf('  publish:'));
  const publishJob = workflow.slice(workflow.indexOf('  publish:'));
  assert.equal((packageJob.match(/npm run checks/gu) ?? []).length, 1);
  assert.match(packageJob, /npm run checks:release -- --results-dir "\$RUNNER_TEMP\/release-qualification"/u);
  assert.match(
    packageJob,
    /release-artifact\.mjs select "\$RUNNER_TEMP\/release-qualification" "\$RUNNER_TEMP\/release-artifact"/u,
  );
  assert.match(packageJob, /path: \$\{\{ runner\.temp \}\}\/release-artifact\//u);
  assert.doesNotMatch(packageJob, /npm run build|npm pack/u);
  const steps = packageJob.split(/(?=^ {6}- )/mu);
  for (const name of [
    'Pin npm',
    'Qualify and retain the exact archive',
    'Scan source history',
    'Upload qualified package',
  ]) {
    const step = steps.find((step) => step.includes(`name: ${name}\n`));
    assert.ok(step, name);
    assert.match(step, /if: \$\{\{ inputs\.qualification_only \}\}/u, name);
  }
  const promotion = steps.find((step) => step.includes('name: Verify accepted original archive\n'));
  assert.ok(promotion);
  assert.match(promotion, /if: \$\{\{ !inputs\.qualification_only \}\}/u);
  assert.doesNotMatch(promotion, /npm ci|npm run|npm pack|current-qualification|current-consumer/u);
  assert.match(packageJob, /artifact-ids: \$\{\{ inputs\.qualification_artifact_id \}\}/u);
  assert.match(packageJob, /run-id: \$\{\{ steps\.origin\.outputs\.run_id \}\}/u);
  assert.match(packageJob, /actions: read/u);
  assert.doesNotMatch(packageJob, /id-token: write/u);
  assert.match(publishJob, /!inputs\.qualification_only && needs\.package\.result == 'success'/u);
  assert.match(publishJob, /release-artifact\.mjs verify package-artifact/u);
  assert.match(publishJob, /ref: \$\{\{ inputs\.reviewed_source_sha \}\}/u);
  assert.match(publishJob, /npm pack --ignore-scripts --pack-destination .*repacked/u);
  const expression = /spawnSync\('npm', (\['publish',[^\n]+?\]), \{ stdio: 'inherit' \}\)/u.exec(publishJob)?.[1];
  assert.ok(expression);
  const inputs = { version: '1.2.3', registry: 'https://registry.npmjs.org' };
  const archivePath = '/fictional/verified/aviaratech-ai-delivery-1.2.3.tgz';
  // Interpret only literal array arguments and the two known variables; no eval or npm execution.
  const args = expression
    .slice(1, -1)
    .split(',')
    .map((token) => {
      const value = token.trim();
      if (value === 'archivePath') return archivePath;
      if (value === 'registry') return inputs.registry;
      assert.match(value, /^'[^']*'$/u, 'Unexpected publication argument expression.');
      return value.slice(1, -1);
    });
  assert.deepEqual(args, [
    'publish',
    archivePath,
    '--ignore-scripts',
    '--access',
    'public',
    '--tag',
    'latest',
    '--registry',
    inputs.registry,
    '--provenance',
  ]);
  assert.match(publishJob, /const archivePath = resolve\(`\.\.\/\.\.\/aviaratech-ai-delivery-\$\{version\}\.tgz`\)/u);
  assert.match(publishJob, /readFileSync\(archivePath\)/u);
  assert.match(publishJob, /environment: npm-publish/u);
  assert.match(publishJob, /id-token: write/u);
  assert.match(publishJob, /Publication will not be repeated/u);
});
