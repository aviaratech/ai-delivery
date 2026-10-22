import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Script } from 'node:vm';
import { test } from 'vitest';

type Json = { [key: string]: unknown };
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
  RELEASE_CASES: { file: string; title: string; kind: 'mandatory' | 'external-historical-qualification' }[];
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

function diagnosticFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-diagnostic-')));
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
        name: join('/synthetic/source', entry.file),
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
  const execute = (outcome = 'failure') => {
    const step = diagnosticStep('Prepare failed qualification diagnostics');
    const script = /node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS/u.exec(step)?.[1];
    assert.ok(script);
    const program = script.replace(/^\s*import .+;\n/gmu, '');
    const output = join(root, 'output');
    writeFileSync(output, '');
    new Script(program).runInNewContext({
      constants,
      closeSync,
      fstatSync,
      lstatSync,
      mkdirSync,
      mkdtempSync,
      openSync,
      readFileSync,
      readSync,
      realpathSync,
      writeFileSync,
      appendFileSync: (path: string, value: string) => {
        assert.equal(path, output);
        writeFileSync(path, value, { flag: 'a' });
      },
      basename,
      dirname,
      join,
      resolve,
      Buffer,
      RELEASE_CASES: laneChecks.RELEASE_CASES,
      process: {
        env: {
          RUNNER_TEMP: root,
          GITHUB_WORKSPACE: '/synthetic/source',
          GITHUB_OUTPUT: output,
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '1',
          REVIEWED_SOURCE_SHA: 'a'.repeat(40),
          QUALIFICATION_OUTCOME: outcome,
          SECRET_VALUE: sensitive,
        },
      },
    });
    const path = /^file=(.+)\n$/u.exec(readFileSync(output, 'utf8'))?.[1];
    assert.ok(path);
    assert.equal(dirname(dirname(path)), root);
    const bytes = readFileSync(path, 'utf8');
    assert.ok(Buffer.byteLength(bytes) <= 64 * 1024);
    assert.ok(!bytes.includes(sensitive));
    return JSON.parse(bytes) as Json;
  };
  return { root, qualificationRoot, releaseDirectory, runId, save, execute, sensitive };
}

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
            name: join('/synthetic/source', entry.file),
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
    selectedTestFiles: ['dist/fictional.test.js'],
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
      files: 4,
      total: 24,
      passed: 23,
      skips: laneChecks.RELEASE_CASES.filter((test) => test.kind === 'external-historical-qualification'),
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
    const files = [
      'dist/setup.test.js',
      'dist/lifecycle.test.js',
      'dist/targetPolicyLocal.test.js',
      'dist/pluginPackaging.test.js',
    ];
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
          numTotalTests: 24,
          numPassedTests: 23,
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
      writeFileSync(stdoutPath, '');
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
    assert.equal(report.tests?.passed, 23);
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
    const contents = JSON.stringify(report);
    bundle.records['releaseTests'] = { contents, sha256: canonical.sha256(contents) };
    const overall = JSON.parse(bundle.records['overall']!.contents) as Json;
    (overall['releaseTests'] as Json)['sha256'] = canonical.sha256(contents);
    const overallContents = JSON.stringify(overall);
    bundle.records['overall'] = { contents: overallContents, sha256: canonical.sha256(overallContents) };
    f.save(path, bundle);
    assert.throws(() => api.verifyReleaseArtifact(f.output, f.inputs));
  } finally {
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
