import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Script } from 'node:vm';
import { test } from 'vitest';

type Json = { [key: string]: unknown };
type Inputs = { source: string; version: string; digest: string };
type DispatchInputs = Inputs & { qualificationOnly: string; artifactId: string };
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
};
const gates = ['format', 'lint', 'types', 'build', 'tests', 'inventory'];

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
    directory,
    source,
    results,
    output,
    inputs,
    archivePath,
    consumerDirectory,
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

test('fresh outer resume selects and portably verifies original qualified bytes without replay', () => {
  const f = fixture();
  try {
    const originalResult = readFileSync(join(f.results, 'result.json'));
    const originalArchive = readFileSync(f.archivePath);
    const outer = join(f.directory, 'resumed-outer');
    mkdirSync(outer);
    f.save(join(outer, 'result.json'), { ...f.overall, resultsDir: outer });
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
