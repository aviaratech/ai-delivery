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
import { test } from 'vitest';

type Json = { [key: string]: unknown };
type Inputs = { source: string; version: string; digest: string };
type Bundle = {
  archive: { filename: string; sha256: string };
  records: Record<string, { sha256: string; contents: string }>;
};
type Api = {
  selectReleaseArtifact(root: string, output: string, inputs: Inputs, cwd: string): Bundle;
  verifyReleaseArtifact(root: string, inputs: Inputs): string;
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

test.each([
  'missing',
  'incomplete',
  'unqualified',
  'exit',
  'omission',
  'wrong-source',
  'wrong-version',
  'wrong-digest',
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
    if (failure === 'wrong-digest') f.inputs.digest = '0'.repeat(64);
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
  assert.match(packageJob, /npm run checks -- --results-dir "\$RUNNER_TEMP\/release-qualification"/u);
  assert.match(
    packageJob,
    /release-artifact\.mjs select "\$RUNNER_TEMP\/release-qualification" "\$RUNNER_TEMP\/release-artifact"/u,
  );
  assert.match(packageJob, /path: \$\{\{ runner\.temp \}\}\/release-artifact\//u);
  assert.doesNotMatch(packageJob, /npm run build|npm pack/u);
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
