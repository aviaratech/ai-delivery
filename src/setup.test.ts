import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, vi } from 'vitest';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import * as privateFiles from './delivery/common.js';
import { digestBytes } from './delivery/index.js';
import { syntheticDiscoveryClients, syntheticOverrides, syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { assertDeliveryRuntimeAdmitted, type RuntimeAdmission } from './services/deliveryAdmission.js';
import * as atomicJson from './utils/atomicJson.js';

const syncFailure = vi.hoisted(() => ({ directory: '' }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (
        syncFailure.directory &&
        actual.existsSync(syncFailure.directory) &&
        actual.fstatSync(fd).ino === actual.statSync(syncFailure.directory).ino
      )
        throw new Error('Synthetic directory durability unavailable');
      actual.fsyncSync(fd);
    },
  };
});

const actors = vi.hoisted(() => ({
  author: 'host-user',
  reviewer: 'reviewer[bot]',
  access: true,
  projectId: 'PROJECT-1',
}));
// Only GitHub HTTP/authentication is synthetic. Resolver, process ownership and file operations are real.
vi.mock('./github/client.js', async (original) => ({
  ...(await original<typeof import('./github/client.js')>()),
  createDeliveryGitHubClients: async (input: { role: string }) => ({
    ...syntheticDiscoveryClients(),
    graphql: async (query: string, variables: Record<string, unknown>) => {
      const result = await syntheticDiscoveryClients().graphql(query, variables);
      if (query.includes('ProjectDeliveryConfiguration'))
        (result as { organization: { projectV2: { id: string } } }).organization.projectV2.id = actors.projectId;
      return result;
    },
    authSource: input.role === 'author' ? 'personal' : 'app',
    credentialSource: input.role === 'author' ? 'env:AUTHOR_TOKEN' : 'app:reviewer',
    role: input.role,
    authenticatedAuthor: async () => ({ actorLogin: actors.author, credentialIdentity: 'user:37' }),
    appActorLogin: async () => actors.reviewer,
    rest: {
      repos: {
        get: async () => {
          if (!actors.access) throw new Error('Synthetic reviewer access denied');
          return { data: { full_name: 'example/widget' } };
        },
      },
      request: async () => {
        throw new Error('Synthetic rules visibility unavailable');
      },
    },
  }),
}));

type SetupInput = {
  authority: string;
  repoRoot: string;
  identity: string;
  archivePath: string;
  expectedArchiveSha256: string;
  packageVersion: string;
  expectedSourceCommit: string;
  expectedConfigDigest: string;
  runtimeDirectory: string;
  signal?: AbortSignal;
  resourceBounds?: { maxAggregateRssBytes: number; minFreeDiskBytes: number; maxNewOutputBytes: number };
};
type Stage = { stageId: string; admission: RuntimeAdmission; reused: boolean };
type Producer = {
  stageRuntime(input: SetupInput): Promise<Stage>;
  admitRuntime(
    input: Omit<SetupInput, 'archivePath' | 'expectedArchiveSha256' | 'packageVersion'> & {
      stageId: string;
      expectedPriorAdmissionSha256: string | null;
    },
  ): Promise<{ admission: RuntimeAdmission; reused: boolean }>;
};
async function producer(): Promise<Producer> {
  const modulePath = new URL('./setup.js', import.meta.url).href;
  const result = (await import(modulePath).catch(() => ({}))) as Partial<Producer>;
  assert.equal(typeof result.stageRuntime, 'function', 'supported producer stage API is missing');
  assert.equal(typeof result.admitRuntime, 'function', 'supported producer admission API is missing');
  return result as Producer;
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
async function fixture() {
  actors.author = 'host-user';
  actors.reviewer = 'reviewer[bot]';
  actors.access = true;
  actors.projectId = 'PROJECT-1';
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-setup-')));
  const root = join(base, 'consumer');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic Delivery');
  git(root, 'config', 'user.email', 'delivery@example.test');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/widget.git');
  writeFileSync(join(root, 'ai-delivery.config.json'), JSON.stringify(syntheticOverrides(syntheticDiscoveryConfig)));
  const roles = {
    author: { authSource: 'personal', identity: 'host-author', credentialEnv: { token: 'AUTHOR_TOKEN' } },
    reviewer: {
      identity: 'synthetic-reviewer',
      credentialEnv: {
        appId: 'REVIEWER_APP_ID',
        installationId: 'REVIEWER_INSTALLATION_ID',
        privateKeyPath: 'REVIEWER_KEY_PATH',
      },
    },
  };
  writeFileSync(
    join(root, 'policy.mjs'),
    `export const deliverySettings=${JSON.stringify({ roles, commandPolicy: { checks: { format: 'REQUIRED', gitClean: 'REQUIRED', lint: 'REQUIRED', test: 'REQUIRED', typecheck: 'REQUIRED' }, timeoutsMs: { lint: 60000, test: 60000, typecheck: 60000 } } })};\n`,
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Synthetic consumer');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const packageRoot = join(base, 'archive', 'package');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: '@aviaratech/ai-delivery',
      version: '0.3.5',
      type: 'module',
      bin: { 'ai-delivery': './dist/cli.js' },
    }),
    'dist/cli.js': "#!/usr/bin/env node\nconsole.log('0.3.5');\n",
    'dist/agent.js': 'export const proof = 2;\n',
    'plugins/ai-delivery/dist/mcp-launcher.js': '/* Synthetic launcher bytes */\n',
    'plugins/ai-delivery/.claude-plugin/plugin.json': JSON.stringify({
      name: 'ai-delivery',
      packageVersion: '0.3.5',
      deliveryCapabilityVersion: 2,
    }),
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const path = join(packageRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const archivePath = join(base, 'reviewed archive; inert.tgz');
  execFileSync('tar', ['-czf', archivePath, '-C', dirname(packageRoot), 'package']);
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const counter = join(base, 'installs');
  const marker = join(base, 'installer-running');
  // Synthetic installer boundary: the real owned command copies fixture bytes; no process manager is mocked.
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),path=require('path');\nconst args=process.argv.slice(2);\nif(args[0]!=='install'||!['--omit=dev','--ignore-scripts','--no-audit','--no-fund'].every(x=>args.includes(x)))process.exit(9);\nfs.appendFileSync(${JSON.stringify(counter)},'x');\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nconst prefix=args[args.indexOf('--prefix')+1],archive=args.at(-1);\nfs.writeFileSync(${JSON.stringify(join(base, 'installer-archive'))},archive);\nconst original=${JSON.stringify(archivePath)},replacement=${JSON.stringify(join(base, 'replacement.tgz'))};\nconst saved=fs.existsSync(replacement)?fs.readFileSync(original):undefined;\nif(saved)fs.copyFileSync(replacement,original);\nconst target=path.join(prefix,'node_modules/@aviaratech/ai-delivery');fs.mkdirSync(target,{recursive:true});\ntry{cp.execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',target]);}finally{if(saved)fs.writeFileSync(original,saved);}\nfs.mkdirSync(path.join(prefix,'node_modules/.bin'),{recursive:true});\nfs.symlinkSync('../@aviaratech/ai-delivery/dist/cli.js',path.join(prefix,'node_modules/.bin/ai-delivery'));\nif(fs.existsSync(${JSON.stringify(join(base, 'fail'))}))process.exit(7);\nif(fs.existsSync(${JSON.stringify(join(base, 'wait'))}))setInterval(()=>{},1000);\n`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  const input: SetupInput = {
    authority: 'runtime:stage',
    identity: 'host-author',
    repoRoot: root,
    archivePath,
    expectedArchiveSha256: digestBytes(readFileSync(archivePath)),
    packageVersion: '0.3.5',
    expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
    expectedConfigDigest: (await loadDeliveryConfig(root)).configDigest,
    runtimeDirectory: join(base, 'staged'),
  };
  return {
    base,
    root,
    input,
    counter,
    marker,
    cleanup: () => {
      process.env.PATH = previousPath;
      rmSync(base, { recursive: true, force: true });
    },
  };
}
function admitInput(input: SetupInput, stageId: string, prior: string | null = null) {
  const { archivePath: _archive, expectedArchiveSha256: _digest, packageVersion: _version, ...rest } = input;
  return { ...rest, authority: 'runtime:admit', stageId, expectedPriorAdmissionSha256: prior };
}

test('public producer stages exact bytes, explicitly admits and reuses completed work without installing again', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const staged = await api.stageRuntime(f.input);
    const admissionPath = join(f.root, '.git/ai-delivery/runtime-admission.json');
    assert.equal(existsSync(admissionPath), false);
    assert.equal(staged.admission.sourceCommit, f.input.expectedSourceCommit);
    assert.equal(staged.admission.sourceArchiveSha256, f.input.expectedArchiveSha256);
    const admitted = await api.admitRuntime(admitInput(f.input, staged.stageId));
    assert.equal(
      (await assertDeliveryRuntimeAdmitted({ repoRoot: f.root, runtimeEntryPath: staged.admission.cliPath }))
        .admissionId,
      admitted.admission.admissionId,
    );
    assert.equal((await api.stageRuntime(f.input)).reused, true);
    assert.equal((await api.admitRuntime(admitInput(f.input, staged.stageId))).reused, true);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
  } finally {
    f.cleanup();
  }
});

test('archive replacement and restoration during install cannot admit alternate bytes under the reviewed digest', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const reviewed = readFileSync(f.input.archivePath);
    const cli = join(f.base, 'archive/package/dist/cli.js');
    const expectedCli = readFileSync(cli);
    writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('same version, alternate archive bytes');\n");
    execFileSync('tar', ['-czf', join(f.base, 'replacement.tgz'), '-C', join(f.base, 'archive'), 'package']);
    assert.notEqual(digestBytes(readFileSync(join(f.base, 'replacement.tgz'))), f.input.expectedArchiveSha256);
    // The separate installer process replaces the public pathname before extraction and restores A afterward.
    const staged = await api.stageRuntime(f.input);
    const admitted = await api.admitRuntime(admitInput(f.input, staged.stageId));
    assert.ok(
      readFileSync(f.input.archivePath).equals(reviewed),
      'the original archive was restored before revalidation',
    );
    assert.ok(
      readFileSync(admitted.admission.cliPath).equals(expectedCli),
      'alternate archive B was installed and admitted under reviewed archive A digest',
    );
    assert.equal(admitted.admission.sourceArchiveSha256, digestBytes(reviewed));
    assert.equal(admitted.admission.cliSha256, digestBytes(expectedCli));
    const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
    assert.equal(readFileSync(join(f.base, 'installer-archive'), 'utf8'), snapshot);
    assert.ok(readFileSync(snapshot).equals(reviewed));
    const metadata = lstatSync(snapshot);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal(metadata.nlink, 1);
    assert.equal((await api.stageRuntime(f.input)).reused, true);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    console.log(
      'ARCHIVE_SUBSTITUTION_RECEIPT',
      JSON.stringify({
        stageId: staged.stageId,
        archiveSha256: digestBytes(reviewed),
        installedCliSha256: digestBytes(expectedCli),
        originalRestored: true,
        privateSnapshotInstalled: true,
        completeRetrySkipped: true,
      }),
    );
  } finally {
    f.cleanup();
  }
});

for (const corruption of ['missing', 'corrupt', 'symlink', 'hardlink'] as const) {
  test(`completed snapshot ${corruption} rejects reuse and admission while preserving current admission`, async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const staged = await api.stageRuntime(f.input);
      await api.admitRuntime(admitInput(f.input, staged.stageId));
      const admissionPath = join(f.root, '.git/ai-delivery/runtime-admission.json');
      const prior = readFileSync(admissionPath);
      const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
      assert.ok(existsSync(snapshot), 'completed stage must retain its verified archive snapshot');
      if (corruption === 'corrupt') writeFileSync(snapshot, 'alternate bytes');
      else {
        rmSync(snapshot);
        if (corruption === 'symlink') symlinkSync(f.input.archivePath, snapshot);
        if (corruption === 'hardlink') linkSync(f.input.archivePath, snapshot);
      }
      await assert.rejects(api.stageRuntime(f.input));
      await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)));
      assert.ok(readFileSync(admissionPath).equals(prior));
      assert.equal(existsSync(f.input.runtimeDirectory), true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      f.cleanup();
    }
  });
}

test('archive snapshot consumes the bounded stage output allowance before running npm', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 1024 ** 3,
          minFreeDiskBytes: 256 * 1024 ** 2,
          maxNewOutputBytes: readFileSync(f.input.archivePath).length - 1,
        },
      }),
      /output.*limit|allowance/u,
    );
    assert.equal(existsSync(f.counter), false);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
  } finally {
    f.cleanup();
  }
});

test('snapshot durability failure removes the owned partial copy and preserves the original and unrelated files', async () => {
  const api = await producer();
  const f = await fixture();
  const actual = privateFiles.writeCreateOnly;
  const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
  const unrelated = join(f.base, 'unrelated');
  try {
    writeFileSync(unrelated, 'keep');
    const write = vi.spyOn(privateFiles, 'writeCreateOnly').mockImplementation((path, bytes, digest) => {
      if (path === snapshot) syncFailure.directory = dirname(path);
      try {
        return actual(path, bytes, digest);
      } finally {
        syncFailure.directory = '';
      }
    });
    await assert.rejects(api.stageRuntime(f.input), /durability unavailable/u);
    write.mockRestore();
    assert.equal(existsSync(f.counter), false);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
    assert.equal(readFileSync(unrelated, 'utf8'), 'keep');
    const stage = await api.stageRuntime(f.input);
    assert.equal(stage.reused, false);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
  } finally {
    syncFailure.directory = '';
    vi.restoreAllMocks();
    f.cleanup();
  }
});

for (const denied of [
  'authority',
  'archive',
  'version',
  'source',
  'config',
  'identity',
  'same-actor',
  'reviewer-access',
  'unowned',
] as const) {
  test(`stage rejects ${denied} before adopting or publishing a runtime`, async () => {
    const api = await producer();
    const f = await fixture();
    try {
      const input = { ...f.input };
      if (denied === 'authority') input.authority = '';
      if (denied === 'archive') writeFileSync(input.archivePath, 'corrupt archive');
      if (denied === 'version') input.packageVersion = '0.3.4';
      if (denied === 'source') input.expectedSourceCommit = 'a'.repeat(40);
      if (denied === 'config') input.expectedConfigDigest = `sha256:${'a'.repeat(64)}`;
      if (denied === 'identity') input.identity = 'ambient-author';
      if (denied === 'same-actor') actors.reviewer = actors.author;
      if (denied === 'reviewer-access') actors.access = false;
      if (denied === 'unowned') {
        mkdirSync(input.runtimeDirectory);
        writeFileSync(join(input.runtimeDirectory, 'preserve'), 'unrelated');
      }
      await assert.rejects(api.stageRuntime(input));
      assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
      if (denied === 'unowned')
        assert.equal(readFileSync(join(input.runtimeDirectory, 'preserve'), 'utf8'), 'unrelated');
      else assert.equal(existsSync(input.runtimeDirectory), false);
    } finally {
      f.cleanup();
    }
  });
}

test('admission rejects CAS and actual byte or actor drift while preserving the prior record', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const staged = await api.stageRuntime(f.input);
    const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'prior admission\n', { mode: 0o600 });
    await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /prior|conflict|compare/u);
    const prior = digestBytes(readFileSync(path));
    actors.author = 'changed-host-user';
    await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId, prior)), /actor|route/u);
    actors.author = 'host-user';
    writeFileSync(staged.admission.cliPath, 'changed bytes');
    await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId, prior)), /source|bytes|admission/u);
    assert.equal(readFileSync(path, 'utf8'), 'prior admission\n');
  } finally {
    f.cleanup();
  }
});

test('post-rename errors reconcile desired bytes and never overwrite third-party replacement', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const staged = await api.stageRuntime(f.input);
    const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
    const actual = atomicJson.writePrivateJsonFileAtomically;
    const write = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((target, value) => {
      actual(target, value);
      if (target === path) throw new Error('Synthetic response lost after rename');
    });
    assert.equal(
      (await api.admitRuntime(admitInput(f.input, staged.stageId))).admission.admissionId,
      staged.admission.admissionId,
    );
    write.mockRestore();
    assert.equal((await api.admitRuntime(admitInput(f.input, staged.stageId))).reused, true);
    rmSync(path);
    const replacement = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((target, value) => {
      actual(target, value);
      if (target === path) {
        writeFileSync(path, 'third-party replacement\n');
        throw new Error('Synthetic concurrent replacement');
      }
    });
    await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /conflict|replacement/u);
    replacement.mockRestore();
    assert.equal(readFileSync(path, 'utf8'), 'third-party replacement\n');
  } finally {
    vi.restoreAllMocks();
    f.cleanup();
  }
});

test('failure and cancellation remove only the owned incomplete stage and preserve unrelated output', async () => {
  const api = await producer();
  const f = await fixture();
  const controller = new AbortController();
  try {
    const unrelated = join(f.base, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'keep'), 'keep');
    writeFileSync(join(f.base, 'fail'), 'go');
    await assert.rejects(api.stageRuntime(f.input), /exit 7/u);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    rmSync(join(f.base, 'fail'));
    writeFileSync(join(f.base, 'wait'), 'go');
    const running = api.stageRuntime({ ...f.input, signal: controller.signal });
    void running.catch(() => undefined);
    for (let i = 0; i < 100 && !existsSync(join(f.input.runtimeDirectory, 'node_modules/.bin/ai-delivery')); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      digestBytes(readFileSync(join(f.input.runtimeDirectory, 'reviewed-archive.tgz'))),
      f.input.expectedArchiveSha256,
    );
    controller.abort();
    await assert.rejects(running, /cancelled/u);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(readFileSync(join(unrelated, 'keep'), 'utf8'), 'keep');
    assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
  } finally {
    controller.abort();
    f.cleanup();
  }
});

test('admission reports unknown durability with exact same-stage reconciliation and preserves desired bytes', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const stage = await api.stageRuntime(f.input);
    const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
    syncFailure.directory = dirname(path);
    await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /commit-status-unknown.*same stage/u);
    const desired = readFileSync(path, 'utf8');
    assert.equal((JSON.parse(desired) as RuntimeAdmission).admissionId, stage.admission.admissionId);
    syncFailure.directory = '';
    assert.equal((await api.admitRuntime(admitInput(f.input, stage.stageId))).reused, true);
    assert.equal(readFileSync(path, 'utf8'), desired);
  } finally {
    syncFailure.directory = '';
    f.cleanup();
  }
});

for (const denied of [
  'candidate',
  'symlink',
  'capability',
  'complete-corrupt',
  'archive-drift',
  'source-drift',
  'config-drift',
] as const) {
  test(`setup preserves completed output and admission on ${denied}`, async () => {
    const api = await producer();
    const f = await fixture();
    try {
      if (denied === 'candidate') {
        const candidate = join(f.base, 'candidate');
        git(f.root, 'worktree', 'add', '-qb', 'candidate', candidate);
        await assert.rejects(api.stageRuntime({ ...f.input, repoRoot: candidate }), /primary/u);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        return;
      }
      if (denied === 'symlink') {
        symlinkSync(f.base, join(f.base, 'alias'));
        await assert.rejects(
          api.stageRuntime({ ...f.input, runtimeDirectory: join(f.base, 'alias', 'stage') }),
          /symbolic link/u,
        );
        return;
      }
      if (denied === 'capability') {
        const manifest = join(f.base, 'archive/package/plugins/ai-delivery/.claude-plugin/plugin.json');
        writeFileSync(
          manifest,
          JSON.stringify({ name: 'ai-delivery', packageVersion: '0.3.5', deliveryCapabilityVersion: 1 }),
        );
        execFileSync('tar', ['-czf', f.input.archivePath, '-C', join(f.base, 'archive'), 'package']);
        f.input.expectedArchiveSha256 = digestBytes(readFileSync(f.input.archivePath));
        await assert.rejects(api.stageRuntime(f.input), /capability/u);
        assert.equal(existsSync(f.input.runtimeDirectory), false);
        return;
      }
      const stage = await api.stageRuntime(f.input);
      await api.admitRuntime(admitInput(f.input, stage.stageId));
      const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
      const before = readFileSync(path, 'utf8');
      if (denied === 'complete-corrupt')
        writeFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json'), 'corrupt completion');
      if (denied === 'archive-drift') writeFileSync(f.input.archivePath, 'changed archive');
      if (denied === 'source-drift') git(f.root, 'commit', '--allow-empty', '-qm', 'source drift');
      if (denied === 'config-drift') {
        writeFileSync(
          join(f.root, 'policy.mjs'),
          readFileSync(join(f.root, 'policy.mjs'), 'utf8') + 'deliverySettings.commandPolicy.checks.test="SKIP";\n',
        );
        git(f.root, 'add', '.');
        git(f.root, 'commit', '-qm', 'config drift');
        f.input.expectedSourceCommit = git(f.root, 'rev-parse', 'HEAD');
      }
      await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)));
      assert.equal(readFileSync(path, 'utf8'), before);
      assert.equal(existsSync(f.input.runtimeDirectory), true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    } finally {
      f.cleanup();
    }
  });
}

test('setup interruption child', { skip: !process.env.AI_DELIVERY_SETUP_INTERRUPT_INPUT }, async () => {
  const api = await producer();
  await api.stageRuntime(JSON.parse(process.env.AI_DELIVERY_SETUP_INTERRUPT_INPUT!) as SetupInput);
});

test(
  'stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install',
  { timeout: 30_000 },
  async () => {
    const api = await producer();
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    let ownedPid: number | undefined;
    let ownedIdentity: string | undefined;
    let ownerPid: number | undefined;
    const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    try {
      writeFileSync(join(f.base, 'wait'), 'go');
      child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
          'run',
          'dist/setup.test.js',
          '-t',
          '^setup interruption child$',
        ],
        {
          cwd: process.cwd(),
          stdio: 'ignore',
          env: { ...process.env, AI_DELIVERY_SETUP_INTERRUPT_INPUT: JSON.stringify(f.input) },
        },
      );
      const closed = new Promise((resolve) => child!.once('close', resolve));
      const writerPath = join(
        f.root,
        '.git/ai-delivery/writers@1',
        `${(await import('./delivery/index.js')).digestValue(f.root).slice(7)}.json`,
      );
      let record:
        | { owner: { pid: number }; command: { phase: string; root?: { pid: number; identity: string } } }
        | undefined;
      for (let i = 0; i < 200; i++) {
        if (existsSync(writerPath)) record = JSON.parse(readFileSync(writerPath, 'utf8')) as typeof record;
        if (record?.command.phase === 'running' && existsSync(f.marker)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(record?.command.phase, 'running');
      const snapshot = join(f.input.runtimeDirectory, 'reviewed-archive.tgz');
      assert.equal(digestBytes(readFileSync(snapshot)), f.input.expectedArchiveSha256);
      ownerPid = record!.owner.pid;
      ownedPid = record!.command.root!.pid;
      ownedIdentity = record!.command.root!.identity;
      process.kill(ownerPid, 'SIGSTOP');
      const stale = new Date(Date.now() - 20_000);
      utimesSync(`${writerPath}.lock`, stale, stale);
      await assert.rejects(api.stageRuntime(f.input), /live verification writer/u);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      process.kill(ownerPid, 'SIGKILL');
      ownerPid = undefined;
      await closed;
      process.kill(ownedPid, 0);
      writeFileSync(snapshot, 'interrupted incomplete snapshot');
      rmSync(join(f.base, 'wait'));
      const recovered = await api.stageRuntime(f.input);
      assert.equal(recovered.reused, false);
      assert.equal(readFileSync(f.counter, 'utf8'), 'xx');
      assert.equal(existsSync(writerPath), false);
      assert.equal(digestBytes(readFileSync(snapshot)), f.input.expectedArchiveSha256);
      const completedSnapshot = lstatSync(snapshot);
      process.kill(peer.pid!, 0);
      const state = spawnSync('/bin/ps', ['-p', String(ownedPid), '-o', 'stat='], { encoding: 'utf8' });
      assert.ok(state.status === 1 || state.stdout.trim().startsWith('Z'));
      ownedPid = undefined;
      assert.equal((await api.stageRuntime(f.input)).reused, true);
      assert.equal(readFileSync(f.counter, 'utf8'), 'xx');
      assert.equal(lstatSync(snapshot).ino, completedSnapshot.ino);
      console.log(
        'SETUP_INTERRUPTION_RECEIPT',
        JSON.stringify({
          completedStageId: recovered.stageId,
          installerExecutions: 2,
          peerPreserved: true,
          ownedCleanupConfirmed: true,
          completedRetrySkipped: true,
          incompleteSnapshotRebuilt: true,
          completedSnapshotReused: true,
          archiveSha256: f.input.expectedArchiveSha256,
        }),
      );
    } finally {
      if (ownerPid !== undefined) {
        process.kill(ownerPid, 'SIGCONT');
        process.kill(ownerPid, 'SIGKILL');
      }
      if (
        ownedPid !== undefined &&
        spawnSync('/bin/ps', ['-p', String(ownedPid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim() ===
          ownedIdentity
      )
        process.kill(ownedPid, 'SIGKILL');
      if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL');
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      f.cleanup();
    }
  },
);

test('CLI stage and admit execute the same public producer with explicit authority and prior absence', async () => {
  const f = await fixture();
  const argv = process.argv;
  const exitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write');
  try {
    const runCli = async (args: string[]): Promise<Record<string, unknown>> => {
      const begin = stdout.mock.calls.length;
      process.argv = [
        process.execPath,
        join(process.cwd(), 'dist/cli.js'),
        '--repo-root',
        f.root,
        '--identity',
        'host-author',
        ...args,
      ];
      vi.resetModules();
      await import('./cli.js');
      for (let i = 0; i < 300; i++) {
        const output = stdout.mock.calls
          .slice(begin)
          .map(([bytes]) => String(bytes))
          .find((bytes) => bytes.startsWith('{'));
        if (output) return JSON.parse(output) as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('CLI completion output unavailable');
    };
    const common = [
      '--source-commit',
      f.input.expectedSourceCommit,
      '--config-digest',
      f.input.expectedConfigDigest,
      '--runtime-directory',
      f.input.runtimeDirectory,
    ];
    const staged = await runCli([
      'runtime:stage',
      '--authorize-stage',
      '--archive',
      f.input.archivePath,
      '--archive-sha256',
      f.input.expectedArchiveSha256,
      '--package-version',
      f.input.packageVersion,
      ...common,
    ]);
    assert.equal(typeof staged.stageId, 'string');
    const admitted = await runCli([
      'runtime:admit',
      '--authorize-admit',
      '--stage-id',
      String(staged.stageId),
      '--expected-absent',
      ...common,
    ]);
    assert.equal((admitted.admission as RuntimeAdmission).sourceCommit, f.input.expectedSourceCommit);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    assert.equal(process.exitCode, exitCode);
  } finally {
    stdout.mockRestore();
    process.argv = argv;
    process.exitCode = exitCode;
    f.cleanup();
  }
}, 15_000);

test(
  'actual reviewed 0.3.4 archive qualifies with real npm production installation in a temporary synthetic consumer',
  { skip: !process.env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE, timeout: 0 },
  async () => {
    const realPath = process.env.PATH;
    const api = await producer();
    const f = await fixture();
    try {
      process.env.PATH = realPath;
      const input = {
        ...f.input,
        archivePath: process.env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE!,
        packageVersion: '0.3.4',
        expectedArchiveSha256: 'sha256:4e5171a4d398dcc486852f08e58f2ef4267765e6f33a34a3ecd5e1ad01830e6d',
      };
      const stage = await api.stageRuntime(input);
      assert.equal(
        execFileSync(process.execPath, [stage.admission.cliPath, '--version'], { encoding: 'utf8' }).trim(),
        '0.3.4',
      );
      assert.equal(stage.admission.capability.mcp, 2);
      assert.equal(existsSync(f.counter), false);
      await api.admitRuntime(admitInput(input, stage.stageId));
      const installedValidatorUrl = new URL(
        `file://${join(dirname(stage.admission.cliPath), 'services/deliveryAdmission.js')}`,
      ).href;
      const installed = (await import(installedValidatorUrl)) as typeof import('./services/deliveryAdmission.js');
      const admitted = await installed.assertDeliveryRuntimeAdmitted({
        repoRoot: f.root,
        runtimeEntryPath: stage.admission.cliPath,
        configuration: await loadDeliveryConfig(f.root),
      });
      assert.equal(admitted.admissionId, stage.admission.admissionId);
      assert.equal((await api.stageRuntime(input)).reused, true);
      console.log(
        'REAL_INSTALLER_QUALIFICATION_RECEIPT',
        JSON.stringify({
          archiveSha256: input.expectedArchiveSha256,
          packageVersion: admitted.packageVersion,
          packageDistSha256: admitted.packageDistSha256,
          cliSha256: admitted.cliSha256,
          pluginManifestSha256: admitted.pluginManifestSha256,
          installedValidator: true,
          installer: 'real npm production dependencies; ignore-scripts',
          httpBoundary: 'synthetic GitHub authentication/discovery',
          temporaryConsumer: true,
          hostActivated: false,
          sharedAdmissionWritten: false,
        }),
      );
    } finally {
      f.cleanup();
    }
  },
);

test('live routing and reviewer access drift cannot replace an already admitted stage', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const stage = await api.stageRuntime(f.input);
    await api.admitRuntime(admitInput(f.input, stage.stageId));
    const path = join(f.root, '.git/ai-delivery/runtime-admission.json');
    const before = readFileSync(path);
    actors.projectId = 'PROJECT-2';
    await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /config digest/u);
    const changed = { ...f.input, expectedConfigDigest: (await loadDeliveryConfig(f.root)).configDigest };
    await assert.rejects(api.admitRuntime(admitInput(changed, stage.stageId)), /configuration/u);
    actors.projectId = 'PROJECT-1';
    actors.access = false;
    await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /cannot read/u);
    actors.access = true;
    await assert.rejects(api.admitRuntime({ ...admitInput(f.input, stage.stageId), authority: '' }), /authority/u);
    await assert.rejects(api.stageRuntime({ ...f.input, packageVersion: '0.3.4' }), /incompatible/u);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
  } finally {
    f.cleanup();
  }
});
