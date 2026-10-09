import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

type Member = { path: string; bytes: Buffer; mode: number; type?: string };
type Contract = {
  sourceRoot: string;
  archivePath: string;
  archiveSha256: string;
  sourceManifestSha256: string;
  sourceLockSha256: string;
  packageVersion: string;
  dryInventory: { path: string; size: number; mode: number }[];
  sourceCommit?: string;
  sourceTree?: string;
  node24?: string;
  node26?: string;
  npmCli?: string;
  producer?: {
    checksResultPath: string;
    checksResultSha256: string;
    artifactReceiptPath: string;
    artifactReceiptSha256: string;
  };
};
type Failure = Error & {
  code: string;
  evidence: { quiescent?: boolean; birth?: string; outputBytes?: number; observed?: Identity[] };
};
type Identity = { pid: number; birth: string; rssBytes: number };
type Receipt = {
  status: string;
  qualified: boolean;
  phases: unknown[];
  cleanup: { removed: boolean; quiescent: boolean; retainedDirectory?: string; failure?: string } | null;
  failure?: { code: string };
};
type Helper = {
  MCP_PROBE: string;
  ownedSignalTargets(observed: Identity[], current: Identity[] | null): { targets: Identity[]; unknown: boolean };
  withDisposableConsumer(
    source: string,
    executable: string,
    digest: string,
    receipt: Receipt,
    action: (context: {
      directory: string;
      consumer: string;
      env: Record<string, string>;
      setQuiescent(value: boolean): void;
    }) => Promise<Receipt>,
    options?: { fault?: (phase: string, directory: string) => void },
  ): Promise<Receipt>;
  sha256(bytes: Buffer | string): string;
  readArchive(bytes: Buffer, digest: string): unknown[];
  inspectCandidate(contract: Contract): { inventory: unknown[]; packageVersion: string; inventorySha256: string };
  verifyProducerJoin(contract: Contract, candidate: ReturnType<Helper['inspectCandidate']>): Record<string, unknown>;
  runCurrentConsumer(contract: Contract): Promise<{ status: string; qualified: boolean; reason: string }>;
  consumerEnvironment(directory: string, executable: string): Record<string, string>;
  resolutionGuard(consumer: string): string;
  parseJsonOutput(stdout: string): unknown;
  verifyInstalledPackage(root: string, inventory: unknown[]): void;
  runOwnedProcess(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      onSpawn?: (pid: number) => void;
    },
  ): Promise<{ stdout: string; evidence: { quiescent: boolean; [key: string]: unknown } }>;
};
const source =
  process.env['AI_DELIVERY_CURRENT_CONSUMER_SCRIPT'] ??
  fileURLToPath(new URL('../scripts/current-consumer.mjs', import.meta.url));
const api = (await import(pathToFileURL(source).href)) as Helper;
// Optional caller-owned local evidence. Child environments still use the helper's
// explicit allowlist and never inherit this path or ambient credentials.
const evidencePath = process.env['AI_DELIVERY_CURRENT_CONSUMER_EVIDENCE_FILE'];
function recordSynthetic(evidence: unknown): void {
  if (evidencePath)
    appendFileSync(evidencePath, JSON.stringify({ boundary: 'fictional synthetic fixture', evidence }) + '\n');
}
const helper: Helper = {
  ...api,
  runOwnedProcess: async (command, args, options) => {
    try {
      const result = await api.runOwnedProcess(command, args, options);
      recordSynthetic({ kind: 'process-result', stdoutSha256: api.sha256(result.stdout), ...result.evidence });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        const e = error as Failure;
        recordSynthetic({ kind: 'process-failure', code: e.code, evidence: e.evidence });
      }
      throw error;
    }
  },
};
const failure =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Error && (error as Failure).code === code;

function archive(members: Member[]): Buffer {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(512);
    header.write(`package/${member.path}`, 0, 100);
    const number = (value: number, offset: number, length: number) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    number(member.mode, 100, 8);
    number(0, 108, 8);
    number(0, 116, 8);
    number(member.bytes.length, 124, 12);
    number(0, 136, 12);
    header.fill(32, 148, 156);
    header.write(member.type ?? '0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, member.bytes, Buffer.alloc((512 - (member.bytes.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-current-consumer-'));
  const root = join(directory, 'built');
  mkdirSync(root);
  const manifest = {
    name: '@aviaratech/ai-delivery',
    version: '0.0.0',
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
  const files = new Map<string, string>();
  files.set('package.json', JSON.stringify(manifest));
  for (const path of [
    'LICENSE',
    'README.md',
    'CONTRIBUTING.md',
    'dist/cli.js',
    'plugins/ai-delivery/dist/mcp-launcher.js',
    'plugins/ai-delivery/runtime/dist/cli.js',
    'plugins/ai-delivery/runtime/dist/THIRD-PARTY-NOTICES.md',
  ])
    files.set(path, 'synthetic inert file\n');
  for (const path of ['index', 'agent', 'delivery/index', 'mcp/index'])
    for (const ext of ['js', 'd.ts']) files.set(`dist/${path}.${ext}`, 'synthetic inert export\n');
  for (const path of ['plugins/ai-delivery/plugin.json', 'plugins/ai-delivery/.claude-plugin/plugin.json'])
    files.set(path, JSON.stringify({ name: 'ai-delivery', version: '0.0.0' }));
  files.set('plugins/ai-delivery/runtime/package.json', JSON.stringify({ version: '0.0.0' }));
  files.set(
    'plugins/ai-delivery/mcp.json',
    JSON.stringify({
      mcpServers: { 'ai-delivery': { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/dist/mcp-launcher.js'] } },
    }),
  );
  for (const skill of ['intake-create', 'worktree-lifecycle', 'pr-handoff'])
    files.set(
      `plugins/ai-delivery/skills/${skill}/SKILL.md`,
      `---\nname: "ai-delivery:${skill}"\ndescription: Synthetic fixture only\n---\n`,
    );
  const members = [...files].map(([path, text]) => ({
    path,
    bytes: Buffer.from(text),
    mode: path.endsWith('/cli.js') || path.endsWith('/mcp-launcher.js') ? 0o755 : 0o644,
  }));
  for (const member of members) {
    const path = join(root, member.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, member.bytes);
    chmodSync(path, member.mode);
  }
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, synthetic: true }),
  );
  const make = (items: Member[] = members): Contract => {
    const bytes = archive(items);
    const archivePath = join(directory, 'synthetic.tgz');
    writeFileSync(archivePath, bytes);
    const contract = {
      sourceRoot: root,
      archivePath,
      archiveSha256: helper.sha256(bytes),
      sourceManifestSha256: helper.sha256(readFileSync(join(root, 'package.json'))),
      sourceLockSha256: helper.sha256(readFileSync(join(root, 'package-lock.json'))),
      packageVersion: '0.0.0',
      dryInventory: items.map(({ path, bytes: data, mode }) => ({ path, size: data.length, mode })),
    };
    recordSynthetic({ kind: 'archive-contract', ...contract });
    return contract;
  };
  return { directory, root, members, make, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('synthetic current-layout archive binds all inventory bytes/modes; no actual candidate is qualified', async () => {
  const f = fixture();
  try {
    const contract = f.make();
    const result = helper.inspectCandidate(contract);
    assert.equal(result.inventory.length, f.members.length);
    assert.match(result.inventorySha256, /^[a-f0-9]{64}$/u);
    const deferred = await helper.runCurrentConsumer(contract);
    assert.equal(deferred.status, 'incomplete');
    assert.equal(deferred.qualified, false);
    assert.match(deferred.reason, /not been admitted/u);
    recordSynthetic({ kind: 'noninstalling-helper-result', receipt: deferred });
  } finally {
    f.cleanup();
  }
});

test.each(['../escape', '/absolute', 'dist/../../escape', 'dist\\escape', 'dist/.env', 'other/file'])(
  'synthetic unsafe inventory rejects %s',
  (path) => {
    const f = fixture();
    try {
      const contract = f.make([{ path, bytes: Buffer.from('unsafe'), mode: 0o644 }]);
      assert.throws(
        () => helper.readArchive(readFileSync(contract.archivePath), contract.archiveSha256),
        failure('unsafe-inventory'),
      );
    } finally {
      f.cleanup();
    }
  },
);

function producerFixture(): {
  f: ReturnType<typeof fixture>;
  contract: Contract;
  checks: Record<string, unknown>;
  artifact: Record<string, unknown>;
  persist: () => void;
} {
  const f = fixture();
  const contract = f.make();
  const init = spawnSync('git', ['init', '--quiet'], {
    cwd: f.root,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    encoding: 'utf8',
  });
  assert.equal(init.status, 0, init.stderr);
  contract.sourceCommit = 'a'.repeat(40);
  contract.sourceTree = 'b'.repeat(40);
  contract.node24 = process.execPath;
  contract.node26 = '/fictional/node26';
  contract.npmCli = '/fictional/npm-cli.js';
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: f.root,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    encoding: 'utf8',
  });
  assert.equal(files.status, 0);
  const fingerprint = {
    kind: 'working-copy',
    sha256: helper.sha256(
      JSON.stringify(
        [...new Set(files.stdout.split('\0').filter(Boolean))].sort().map((path) => ({
          path,
          executable: f.members.some((member) => member.path === path && (member.mode & 0o111) !== 0),
          sha256: helper.sha256(readFileSync(join(f.root, path))),
        })),
      ),
    ),
    fileCount: new Set(files.stdout.split('\0').filter(Boolean)).size,
  };
  const gates = ['format', 'lint', 'types', 'build', 'tests', 'inventory'];
  const checks: Record<string, unknown> = {
    schemaVersion: 'contributor-checks@1',
    runId: 'fictional-producer-run',
    scope: 'full',
    status: 'passed',
    fullSuccess: true,
    exitCode: 0,
    selectedTestFiles: ['dist/fictional.test.js'],
    tests: { files: 1, total: 1, passed: 1, skips: [] },
    gates,
    omitted: [],
    tree: fingerprint,
    commands: gates.map((stage) => ({ stage, status: 'passed', exitCode: 0, signal: null, cleanupConfirmed: true })),
    toolchain: {
      controller: { version: 'v24.21.0', executable: contract.node24 },
      npm: { version: '11.19.0', executable: contract.npmCli },
      libraryConsumer: { version: 'v26.2.0', executable: contract.node26 },
    },
    inventory: {
      kind: 'dry-inventory-only',
      name: '@aviaratech/ai-delivery',
      version: '0.0.0',
      fileCount: contract.dryInventory.length,
      files: contract.dryInventory,
    },
  };
  const artifact: Record<string, unknown> = {
    schemaVersion: 'ai-delivery.current-artifact-producer@1',
    status: 'passed',
    sourceCommit: contract.sourceCommit,
    sourceTree: contract.sourceTree,
    sourceManifestSha256: contract.sourceManifestSha256,
    sourceLockSha256: contract.sourceLockSha256,
    packageVersion: contract.packageVersion,
    archiveSha256: contract.archiveSha256,
    inventorySha256: helper.inspectCandidate(contract).inventorySha256,
    sourceFingerprint: fingerprint,
    pack: { status: 'passed', exitCode: 0, quiescent: true, archiveSha256: contract.archiveSha256 },
  };
  const persist = () => {
    const checksPath = join(f.directory, 'checks.json');
    writeFileSync(checksPath, JSON.stringify(checks));
    const digest = helper.sha256(readFileSync(checksPath));
    artifact['checksResultSha256'] = digest;
    const artifactPath = join(f.directory, 'producer.json');
    writeFileSync(artifactPath, JSON.stringify(artifact));
    contract.producer = {
      checksResultPath: checksPath,
      checksResultSha256: digest,
      artifactReceiptPath: artifactPath,
      artifactReceiptSha256: helper.sha256(readFileSync(artifactPath)),
    };
  };
  persist();
  return { f, contract, checks, artifact, persist };
}

test('synthetic canonical producer join accepts matching source and archive, but never qualifies without install admission', async () => {
  const { f, contract } = producerFixture();
  try {
    const joined = helper.verifyProducerJoin(contract, helper.inspectCandidate(contract));
    assert.equal(joined['actualArchiveSha256'], contract.archiveSha256);
    const result = await helper.runCurrentConsumer(contract);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.qualified, false);
    recordSynthetic({ kind: 'fictional-canonical-producer-join', joined, result, actualApplicationBoundary: false });
  } finally {
    f.cleanup();
  }
});

test.each([
  'scope',
  'status',
  'fullSuccess',
  'exitCode',
  'gates',
  'omitted',
  'tree',
  'commands',
  'toolchain',
  'inventory',
  'tests',
  'selectedTestFiles',
])('synthetic canonical %s incompleteness cannot qualify rebuilt artifact', (field) => {
  const { f, contract, checks, persist } = producerFixture();
  try {
    checks[field] = field === 'gates' || field === 'omitted' ? ['build'] : null;
    persist();
    assert.throws(() => helper.verifyProducerJoin(contract, helper.inspectCandidate(contract)), failure('producer'));
  } finally {
    f.cleanup();
  }
});

test.each([
  'sourceCommit',
  'sourceTree',
  'sourceManifestSha256',
  'sourceLockSha256',
  'packageVersion',
  'archiveSha256',
  'inventorySha256',
  'pack',
  'sourceFingerprint',
])('synthetic artifact producer %s drift cannot reuse old producer proof', (field) => {
  const { f, contract, artifact, persist } = producerFixture();
  try {
    artifact[field] = null;
    persist();
    assert.throws(() => helper.verifyProducerJoin(contract, helper.inspectCandidate(contract)), failure('producer'));
  } finally {
    f.cleanup();
  }
});

test('synthetic producer hash and source-file drift are refused before any install', () => {
  const { f, contract, persist } = producerFixture();
  try {
    assert.ok(contract.producer);
    appendFileSync(contract.producer.checksResultPath, ' ');
    assert.throws(() => helper.verifyProducerJoin(contract, helper.inspectCandidate(contract)), failure('producer'));
    persist();
    writeFileSync(join(f.root, 'changed-untracked-source.ts'), 'synthetic new source');
    assert.throws(() => helper.verifyProducerJoin(contract, helper.inspectCandidate(contract)), failure('producer'));
    delete contract.producer;
    assert.throws(() => helper.verifyProducerJoin(contract, helper.inspectCandidate(contract)), failure('producer'));
  } finally {
    f.cleanup();
  }
});

test.each([
  'missing-gate',
  'duplicate-gate',
  'nonquiescent',
  'zero-tests',
  'zero-selection',
  'unexpected-skip',
  'dry-inventory-byte-drift',
])('synthetic canonical producer refuses %s despite a claimed full success', (kind) => {
  const { f, contract, checks, persist } = producerFixture();
  try {
    const steps = checks['commands'] as Record<string, unknown>[];
    if (kind === 'missing-gate') steps.pop();
    else if (kind === 'duplicate-gate') steps[5] = steps[4]!;
    else if (kind === 'nonquiescent') steps[3]!['cleanupConfirmed'] = false;
    else if (kind === 'zero-tests') checks['tests'] = { files: 1, total: 0, passed: 0, skips: [] };
    else if (kind === 'zero-selection') {
      checks['selectedTestFiles'] = [];
      checks['tests'] = { files: 0, total: 1, passed: 1, skips: [] };
    } else if (kind === 'unexpected-skip')
      checks['tests'] = {
        files: 1,
        total: 2,
        passed: 1,
        skips: [{ file: 'dist/fictional.test.js', title: 'unreviewed skip', kind: 'unreviewed' }],
      };
    else
      checks['inventory'] = {
        kind: 'dry-inventory-only',
        name: '@aviaratech/ai-delivery',
        version: '0.0.0',
        fileCount: 1,
        files: [{ path: 'package.json', size: 1, mode: 0o644 }],
      };
    persist();
    assert.throws(() => helper.verifyProducerJoin(contract, helper.inspectCandidate(contract)), failure('producer'));
  } finally {
    f.cleanup();
  }
});

test.each(['1', '2', '3', '6'])('synthetic tar link/special type %s cannot reach npm extraction', (type) => {
  const f = fixture();
  try {
    const contract = f.make([{ path: 'dist/link', bytes: Buffer.alloc(0), mode: 0o644, type }]);
    assert.throws(
      () => helper.readArchive(readFileSync(contract.archivePath), contract.archiveSha256),
      failure('unsafe-inventory'),
    );
  } finally {
    f.cleanup();
  }
});

test('synthetic corruption, duplicates, inventory omissions and built-byte drift fail closed', () => {
  const f = fixture();
  try {
    let contract = f.make();
    assert.throws(
      () => helper.readArchive(readFileSync(contract.archivePath), 'a'.repeat(64)),
      failure('archive-digest'),
    );
    contract = f.make([...f.members, f.members[0]!]);
    assert.throws(() => helper.inspectCandidate(contract), failure('unsafe-inventory'));
    contract = f.make();
    contract.dryInventory.pop();
    assert.throws(() => helper.inspectCandidate(contract), failure('inventory-mismatch'));
    contract = f.make();
    writeFileSync(join(f.root, 'README.md'), 'changed');
    assert.throws(() => helper.inspectCandidate(contract), failure('built-bytes'));
  } finally {
    f.cleanup();
  }
});

test('synthetic installed package rejects unexpected files beyond the accepted inventory', () => {
  const f = fixture();
  try {
    const candidate = helper.inspectCandidate(f.make());
    rmSync(join(f.root, 'package-lock.json'));
    helper.verifyInstalledPackage(f.root, candidate.inventory);
    writeFileSync(join(f.root, 'dist', 'unexpected.js'), 'unexpected');
    assert.throws(() => helper.verifyInstalledPackage(f.root, candidate.inventory), failure('installed-bytes'));
  } finally {
    f.cleanup();
  }
});

test.each([
  'dist/index.js',
  'plugins/ai-delivery/runtime/dist/cli.js',
  'plugins/ai-delivery/skills/intake-create/SKILL.md',
])('synthetic missing packaged entry %s fails inspection', (path) => {
  const f = fixture();
  try {
    assert.throws(
      () => helper.inspectCandidate(f.make(f.members.filter((member) => member.path !== path))),
      failure('missing-file'),
    );
  } finally {
    f.cleanup();
  }
});

test.each(['name', 'version', 'runtime'])('synthetic wrong package %s cannot pass', (kind) => {
  const f = fixture();
  try {
    const member = f.members.find((item) => item.path === 'package.json')!;
    const pkg = JSON.parse(member.bytes.toString()) as { name: string; version: string; engines: { node: string } };
    if (kind === 'name') pkg.name = 'other';
    else if (kind === 'version') pkg.version = '0.0.1';
    else pkg.engines.node = '>=20';
    member.bytes = Buffer.from(JSON.stringify(pkg));
    assert.throws(
      () => helper.inspectCandidate(f.make()),
      failure(kind === 'runtime' ? 'runtime' : 'package-identity'),
    );
  } finally {
    f.cleanup();
  }
});

test('synthetic environment never borrows ambient author/reviewer/preload or npm configuration', () => {
  const f = fixture();
  try {
    const env = helper.consumerEnvironment(f.directory, process.execPath);
    for (const name of [
      'GH_TOKEN',
      'GH_APP_ID_GPT_REVIEWER',
      'GH_INSTALLATION_ID_GPT_REVIEWER',
      'GH_PRIVATE_KEY_GPT_REVIEWER',
      'NODE_PATH',
      'NODE_OPTIONS',
      'AI_DELIVERY_CONFIG',
    ])
      assert.equal(env[name], undefined);
    assert.equal(readFileSync(env['npm_config_userconfig']!, 'utf8'), '');
    assert.notEqual(env['npm_config_userconfig'], env['npm_config_globalconfig']);
  } finally {
    f.cleanup();
  }
});

test('synthetic resolver demonstrates a borrowing false positive, then rejects external and undeclared hoisted dependencies', async () => {
  const f = fixture();
  try {
    const consumer = join(f.directory, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module', dependencies: {} }));
    const borrowed = join(f.directory, 'node_modules', 'borrowed-only');
    mkdirSync(borrowed, { recursive: true });
    writeFileSync(
      join(borrowed, 'package.json'),
      JSON.stringify({ name: 'borrowed-only', type: 'module', exports: './index.js' }),
    );
    writeFileSync(join(borrowed, 'index.js'), 'export const borrowed=true;');
    const env = helper.consumerEnvironment(f.directory, process.execPath);
    const probe = join(consumer, 'owned-probe.mjs');
    writeFileSync(probe, "console.log((await import('borrowed-only')).borrowed)");
    const args = [probe];
    assert.equal((await helper.runOwnedProcess(process.execPath, args, { cwd: consumer, env })).stdout.trim(), 'true');
    const guard = join(consumer, 'owned-guard.mjs');
    writeFileSync(guard, helper.resolutionGuard(consumer));
    await assert.rejects(
      helper.runOwnedProcess(process.execPath, ['--import', guard, ...args], { cwd: consumer, env }),
      failure('isolation'),
    );
    const hoisted = join(consumer, 'node_modules', 'borrowed-only');
    mkdirSync(hoisted, { recursive: true });
    writeFileSync(join(hoisted, 'package.json'), readFileSync(join(borrowed, 'package.json')));
    writeFileSync(join(hoisted, 'index.js'), 'export const borrowed=true;');
    await assert.rejects(
      helper.runOwnedProcess(process.execPath, ['--import', guard, ...args], { cwd: consumer, env }),
      failure('dependency'),
    );
  } finally {
    f.cleanup();
  }
});

test.each(['network', 'permission', 'process'])(
  'synthetic external %s failure retains bounded quiescent evidence',
  async (kind) => {
    const f = fixture();
    try {
      const env = helper.consumerEnvironment(f.directory, process.execPath);
      const text = kind === 'network' ? 'ENOTFOUND' : kind === 'permission' ? 'EACCES' : 'synthetic npm failure';
      await assert.rejects(
        helper.runOwnedProcess(
          process.execPath,
          ['-e', `process.stderr.write(${JSON.stringify(text)});process.exit(1)`],
          { cwd: f.directory, env },
        ),
        (error: unknown) => failure(kind)(error) && (error as Failure).evidence.quiescent === true,
      );
      assert.throws(() => helper.parseJsonOutput('startup banner\n{}'), failure('schema'));
    } finally {
      f.cleanup();
    }
  },
);

test('synthetic interrupted owned child is quiescent before disposable fixture cleanup', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  try {
    const env = helper.consumerEnvironment(f.directory, process.execPath);
    await assert.rejects(
      helper.runOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: f.directory,
        env,
        signal: cancellation.signal,
        onSpawn: () => setTimeout(() => cancellation.abort(), 50),
      }),
      (error: unknown) => {
        assert.equal((error as Failure).code, 'cancelled');
        assert.equal((error as Failure).evidence.quiescent, true);
        assert.ok((error as Failure).evidence.birth);
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

test('synthetic bounded-output failure never becomes successful stdout/schema proof', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      helper.runOwnedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], {
        cwd: f.directory,
        env: helper.consumerEnvironment(f.directory, process.execPath),
        maxOutputBytes: 128,
      }),
      failure('output-bound'),
    );
  } finally {
    f.cleanup();
  }
});

test.each([
  '---\nname: "ai-delivery:intake-create"\ndescription: Synthetic fixture only\n',
  '---\nother: Header\n---\nname: "ai-delivery:intake-create"\ndescription: Body only\n',
])('synthetic malformed skill frontmatter fails within the delimited header', (text) => {
  const f = fixture();
  try {
    const member = f.members.find((item) => item.path === 'plugins/ai-delivery/skills/intake-create/SKILL.md')!;
    member.bytes = Buffer.from(text);
    assert.throws(() => helper.inspectCandidate(f.make()), failure('schema'));
  } finally {
    f.cleanup();
  }
});

test('synthetic nested type-only manifest uses the installed package declaration owner', async () => {
  const f = fixture();
  try {
    const consumer = join(f.directory, 'consumer');
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'fictional-consumer', type: 'module', dependencies: { '@fictional/sdk': '0' } }),
    );
    const sdk = join(consumer, 'node_modules', '@fictional', 'sdk');
    const esm = join(sdk, 'dist', 'esm');
    mkdirSync(esm, { recursive: true });
    writeFileSync(
      join(sdk, 'package.json'),
      JSON.stringify({
        name: '@fictional/sdk',
        type: 'module',
        exports: './dist/esm/index.js',
        dependencies: { 'declared-only': '0' },
      }),
    );
    writeFileSync(join(esm, 'package.json'), '{"type":"module"}');
    const dep = join(sdk, 'node_modules', 'declared-only');
    mkdirSync(dep, { recursive: true });
    writeFileSync(
      join(dep, 'package.json'),
      JSON.stringify({ name: 'declared-only', type: 'module', exports: './index.js' }),
    );
    writeFileSync(join(dep, 'index.js'), 'export const value=true;');
    writeFileSync(join(esm, 'index.js'), "import {value} from 'declared-only';console.log(value);");
    const guard = join(consumer, 'owned-guard.mjs');
    writeFileSync(guard, helper.resolutionGuard(consumer));
    const env = helper.consumerEnvironment(f.directory, process.execPath);
    const probe = join(consumer, 'owned-probe.mjs');
    writeFileSync(probe, "await import('@fictional/sdk')");
    const args = ['--import', guard, probe];
    assert.equal((await helper.runOwnedProcess(process.execPath, args, { cwd: consumer, env })).stdout.trim(), 'true');
    writeFileSync(join(esm, 'index.js'), "await import('missing-only');");
    await assert.rejects(helper.runOwnedProcess(process.execPath, args, { cwd: consumer, env }), failure('dependency'));
    const hoisted = join(consumer, 'node_modules', 'undeclared-only');
    mkdirSync(hoisted, { recursive: true });
    writeFileSync(
      join(hoisted, 'package.json'),
      JSON.stringify({ name: 'undeclared-only', type: 'module', exports: './index.js' }),
    );
    writeFileSync(join(hoisted, 'index.js'), 'export const value=true;');
    writeFileSync(join(esm, 'index.js'), "await import('undeclared-only');");
    await assert.rejects(helper.runOwnedProcess(process.execPath, args, { cwd: consumer, env }), failure('dependency'));
  } finally {
    f.cleanup();
  }
});

test('synthetic cancellation kills an observed resistant descendant after its parent exits', async () => {
  const f = fixture();
  const cancellation = new AbortController();
  let quiescent = false;
  try {
    const env = helper.consumerEnvironment(f.directory, process.execPath);
    const descendant = join(f.directory, 'descendant.cjs');
    writeFileSync(
      descendant,
      "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('ready',String(process.pid));setInterval(()=>{},1000);",
    );
    const parent = join(f.directory, 'parent.cjs');
    writeFileSync(
      parent,
      "require('node:child_process').spawn(process.execPath,[process.argv[2]],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000);",
    );
    const running = helper.runOwnedProcess(process.execPath, [parent, descendant], {
      cwd: f.directory,
      env,
      signal: cancellation.signal,
    });
    // Synchronize to the child's ready marker; allow one 50ms identity sample.
    for (let i = 0; i < 100; i++) {
      try {
        readFileSync(join(f.directory, 'ready'));
        break;
      } catch {
        await delay(10);
      }
    }
    await delay(150);
    cancellation.abort();
    await assert.rejects(running, (error: unknown) => {
      const e = error as Failure;
      quiescent = e.evidence.quiescent === true;
      assert.equal(e.code, 'cancelled');
      assert.equal(quiescent, true);
      assert.ok((e.evidence.observed?.length ?? 0) >= 2);
      return true;
    });
  } finally {
    if (quiescent) f.cleanup();
  }
}, 5000);

test('synthetic unknown or reused process identity is refused rather than signaled', () => {
  const known = [{ pid: 1, birth: 'first', rssBytes: 0 }];
  assert.deepEqual(helper.ownedSignalTargets(known, null), { targets: [], unknown: true });
  assert.deepEqual(helper.ownedSignalTargets(known, [{ pid: 1, birth: 'reused', rssBytes: 0 }]), {
    targets: [],
    unknown: true,
  });
});

test.each(['created', 'prepared', 'cleanup', 'unknown-quiescence'])(
  'synthetic disposable %s failure preserves receipt and owned cleanup evidence',
  async (kind) => {
    const f = fixture();
    let retained: string | undefined;
    try {
      const receipt: Receipt = {
        status: 'incomplete',
        qualified: false,
        phases: [{ phase: 'prior', synthetic: true }],
        cleanup: null,
      };
      const result = await helper.withDisposableConsumer(
        f.root,
        process.execPath,
        'a'.repeat(64),
        receipt,
        async (context) => {
          if (kind === 'unknown-quiescence') context.setQuiescent(false);
          return receipt;
        },
        {
          fault: (phase, directory) => {
            retained = directory;
            if (kind === 'cleanup' && phase === 'cleanup')
              writeFileSync(join(directory, 'owned.json'), 'corrupt marker');
            if (kind === phase && (kind === 'created' || kind === 'prepared'))
              throw Object.assign(new Error('fictional permission failure'), { code: 'EACCES' });
          },
        },
      );
      assert.equal(result.status, 'incomplete');
      assert.equal(result.qualified, false);
      assert.deepEqual(result.phases, [{ phase: 'prior', synthetic: true }]);
      assert.equal(result.cleanup?.removed, kind === 'created' || kind === 'prepared');
      if (kind === 'cleanup') assert.ok(result.cleanup?.failure);
      if (kind === 'unknown-quiescence') assert.equal(result.cleanup?.quiescent, false);
    } finally {
      // These are explicit injected filesystem/quiescence faults with no processes.
      if (retained) rmSync(retained, { recursive: true, force: true });
      f.cleanup();
    }
  },
);

test.each([
  'startup',
  'schema',
  'matching-schema',
  'resistant-startup',
  'resistant-schema',
  'resistant-matching-schema',
])('synthetic packaged stdio MCP %s exercises its explicit mocked schema and shutdown boundary', async (kind) => {
  const f = fixture();
  let quiescent = true;
  try {
    const consumer = join(f.directory, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module' }));
    const pkg = join(consumer, 'node_modules', '@aviaratech', 'ai-delivery');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@aviaratech/ai-delivery', type: 'module', exports: { './mcp': './mcp.js' } }),
    );
    writeFileSync(join(pkg, 'mcp.js'), 'export const AI_DELIVERY_MCP_TOOLS=[];');
    const zod = join(pkg, 'node_modules', 'zod');
    mkdirSync(zod, { recursive: true });
    writeFileSync(join(zod, 'package.json'), JSON.stringify({ name: 'zod', main: 'index.cjs' }));
    writeFileSync(join(zod, 'index.cjs'), 'exports.toJSONSchema=()=>({});');
    const launcher = join(consumer, 'fictional-packaged-launcher.cjs');
    const startup = kind === 'startup';
    const resistant = kind.startsWith('resistant-');
    const tools = ['matching-schema', 'resistant-matching-schema'].includes(kind)
      ? []
      : [{ name: 'unexpected', inputSchema: {} }];
    const server = `process.on('SIGTERM',${resistant ? '()=>{}' : '()=>process.exit(0)'});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{serverInfo:{version:'0.0.0'}}}));
 if(m.id===2)console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:${JSON.stringify(tools)}}}));
});`;
    writeFileSync(
      launcher,
      startup
        ? 'process.exit(1);'
        : kind === 'resistant-startup'
          ? "process.on('SIGTERM',()=>{});console.log('fictional startup banner');setInterval(()=>{},1000);"
          : server,
    );
    const probe = join(consumer, 'owned-mcp.mjs');
    writeFileSync(probe, helper.MCP_PROBE);
    quiescent = false;
    const running = helper.runOwnedProcess(process.execPath, [probe, launcher, '0.0.0'], {
      cwd: consumer,
      env: helper.consumerEnvironment(f.directory, process.execPath),
    });
    if (kind === 'matching-schema') {
      const result = await running;
      quiescent = result.evidence.quiescent;
      assert.deepEqual(helper.parseJsonOutput(result.stdout), {
        toolCount: 0,
        schemas: [],
        protocol: 'stdio initialize/tools/list',
        version: '0.0.0',
      });
      assert.equal(result.evidence.quiescent, true);
    } else
      await assert.rejects(running, (error: unknown) => {
        quiescent = (error as Failure).evidence.quiescent === true;
        return failure(kind === 'resistant-matching-schema' ? 'cleanup' : 'schema')(error) && quiescent;
      });
  } finally {
    if (quiescent) f.cleanup();
    else recordSynthetic({ kind: 'fixture-retained', directory: f.directory, quiescent: false });
  }
});

test.each(['sourceManifestSha256', 'sourceLockSha256'] as const)(
  'synthetic integrated %s digest drift cannot reuse an older archive as candidate proof',
  (field) => {
    const f = fixture();
    try {
      const contract = f.make();
      contract[field] = 'a'.repeat(64);
      assert.throws(() => helper.inspectCandidate(contract), failure('source-identity'));
    } finally {
      f.cleanup();
    }
  },
);
