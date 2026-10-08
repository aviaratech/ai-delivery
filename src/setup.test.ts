import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  truncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { digestBytes, digestValue } from './delivery/index.js';
import { syntheticDiscoveryClients, syntheticOverrides, syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { assertDeliveryRuntimeAdmitted, type RuntimeAdmission } from './services/deliveryAdmission.js';
import * as atomicJson from './utils/atomicJson.js';

const syncFailure = vi.hoisted(() => ({ directory: '' }));
const sharedOutputRead = vi.hoisted(() => ({ path: '', unboundedReads: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (sharedOutputRead.path && String(args[0]) === sharedOutputRead.path) {
        sharedOutputRead.unboundedReads++;
        throw new Error('Unbounded shared command-output read attempted');
      }
      return actual.readFileSync(...args);
    },
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
  authorCalls: 0,
  reviewerCalls: 0,
  authorStarted: false,
  authorAborted: false,
  pauseAuthor: false,
}));
// Only GitHub HTTP/authentication is synthetic. Resolver, process ownership and file operations are real.
vi.mock('./github/client.js', async (original) => ({
  ...(await original<typeof import('./github/client.js')>()),
  createDeliveryGitHubClients: async (input: { role: string; signal?: AbortSignal }) => ({
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
    authenticatedAuthor: async (signal?: AbortSignal) => {
      actors.authorCalls++;
      actors.authorStarted = true;
      if (actors.pauseAuthor) {
        await new Promise<void>((resolve, reject) => {
          // A delayed HTTP response bounds this fixture's request, not the stage's elapsed duration.
          const response = setTimeout(resolve, 4_000);
          const abort = () => {
            clearTimeout(response);
            actors.authorAborted = true;
            reject(new Error('Synthetic author HTTP request aborted'));
          };
          const requestSignal = signal ?? input.signal;
          if (requestSignal?.aborted) abort();
          else requestSignal?.addEventListener('abort', abort, { once: true });
        });
      }
      return { actorLogin: actors.author, credentialIdentity: 'user:37' };
    },
    appActorLogin: async () => {
      actors.reviewerCalls++;
      return actors.reviewer;
    },
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
  nativePluginRoot?: string;
  signal?: AbortSignal;
  resourceBounds?: {
    maxAggregateRssBytes: number;
    minFreeDiskBytes: number;
    maxNewOutputBytes: number;
    maxCapturedOutputBytes?: number;
  };
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
async function fixture(native = false) {
  actors.author = 'host-user';
  actors.reviewer = 'reviewer[bot]';
  actors.access = true;
  actors.projectId = 'PROJECT-1';
  actors.authorCalls = 0;
  actors.reviewerCalls = 0;
  actors.authorStarted = false;
  actors.authorAborted = false;
  actors.pauseAuthor = false;
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
  if (native) {
    files['plugins/ai-delivery/runtime/package.json'] = files['package.json']!;
    files['plugins/ai-delivery/runtime/dist/cli.js'] = files['dist/cli.js']!;
    files['plugins/ai-delivery/README.md'] = 'Synthetic copied native plugin.\n';
  }
  for (const [relative, bytes] of Object.entries(files)) {
    const path = join(packageRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const archivePath = join(base, 'reviewed archive; inert.tgz');
  execFileSync('tar', ['-czf', archivePath, '-C', dirname(packageRoot), 'package']);
  const nativePluginRoot = join(base, 'native-plugin');
  if (native) cpSync(join(packageRoot, 'plugins', 'ai-delivery'), nativePluginRoot, { recursive: true });
  const bin = join(base, 'bin');
  mkdirSync(bin);
  const counter = join(base, 'installs');
  const marker = join(base, 'installer-running');
  // Synthetic installer boundary: the real owned command copies fixture bytes; no process manager is mocked.
  writeFileSync(
    join(bin, 'npm'),
    `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),path=require('path');\nconst args=process.argv.slice(2);\nif(args[0]!=='install'||!['--omit=dev','--ignore-scripts','--no-audit','--no-fund'].every(x=>args.includes(x)))process.exit(9);\nfs.appendFileSync(${JSON.stringify(counter)},'x');\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nconst prefix=args[args.indexOf('--prefix')+1],archive=args.at(-1);\nfs.writeFileSync(${JSON.stringify(join(base, 'installer-settings'))},JSON.stringify({args,cwd:process.cwd(),TMPDIR:process.env.TMPDIR,TMP:process.env.TMP,TEMP:process.env.TEMP}));\nfs.writeFileSync(${JSON.stringify(join(base, 'installer-archive'))},archive);\nconst original=${JSON.stringify(archivePath)},replacement=${JSON.stringify(join(base, 'replacement.tgz'))};\nconst saved=fs.existsSync(replacement)?fs.readFileSync(original):undefined;\nif(saved)fs.copyFileSync(replacement,original);\nconst target=path.join(prefix,'node_modules/@aviaratech/ai-delivery');fs.mkdirSync(target,{recursive:true});\ntry{cp.execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',target]);}finally{if(saved)fs.writeFileSync(original,saved);}\nfs.mkdirSync(path.join(prefix,'node_modules/.bin'),{recursive:true});\nfs.symlinkSync('../@aviaratech/ai-delivery/dist/cli.js',path.join(prefix,'node_modules/.bin/ai-delivery'));\nconst logs=${JSON.stringify(join(base, 'log-bytes'))};\nif(fs.existsSync(logs))process.stdout.write(Buffer.alloc(Number(fs.readFileSync(logs,'utf8')),65),()=>{if(fs.existsSync(${JSON.stringify(join(base, 'fail'))}))process.exit(7);});\nelse if(fs.existsSync(${JSON.stringify(join(base, 'fail'))}))process.exit(7);\nconst memory=${JSON.stringify(join(base, 'memory-bytes'))};\nif(fs.existsSync(memory)){globalThis.fixtureAllocation=Buffer.alloc(Number(fs.readFileSync(memory,'utf8')),1);setInterval(()=>{},1000);}\nif(fs.existsSync(${JSON.stringify(join(base, 'wait'))}))setInterval(()=>{},1000);\n`,
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
    ...(native ? { nativePluginRoot } : {}),
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
  const {
    archivePath: _archive,
    expectedArchiveSha256: _digest,
    packageVersion: _version,
    nativePluginRoot: _native,
    ...rest
  } = input;
  return { ...rest, authority: 'runtime:admit', stageId, expectedPriorAdmissionSha256: prior };
}

test('native stage binds exact copied runtime paths and bytes, reuses and admits only that completed stage', async () => {
  const f = await fixture(true);
  try {
    const api = await producer();
    const staged = await api.stageRuntime(f.input);
    assert.equal(staged.admission.cliPath, join(f.input.nativePluginRoot!, 'runtime', 'dist', 'cli.js'));
    assert.equal(staged.admission.mcpLauncherPath, join(f.input.nativePluginRoot!, 'dist', 'mcp-launcher.js'));
    const record = readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json'));
    assert.equal((await api.stageRuntime(f.input)).reused, true);
    assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), record);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    const other = join(f.base, 'other-native-plugin');
    cpSync(f.input.nativePluginRoot!, other, { recursive: true });
    await assert.rejects(api.stageRuntime({ ...f.input, nativePluginRoot: other }), /incompatible setup intent/u);
    const admitted = await api.admitRuntime(admitInput(f.input, staged.stageId));
    assert.equal(admitted.admission.admissionId, staged.admission.admissionId);
    assert.equal((await api.admitRuntime(admitInput(f.input, staged.stageId))).reused, true);
    const readback = await assertDeliveryRuntimeAdmitted({
      repoRoot: f.root,
      runtimeEntryPath: staged.admission.cliPath,
    });
    assert.equal(readback.admissionId, staged.admission.admissionId);
    writeFileSync(join(f.input.nativePluginRoot!, 'README.md'), 'Changed native plugin bytes.\n');
    await assert.rejects(api.stageRuntime(f.input), /native plugin.*reviewed/iu);
    await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /native plugin.*reviewed/iu);
  } finally {
    f.cleanup();
  }
});

test('native stage refuses unreviewed cache bytes without completing or mutating the cache', async () => {
  const f = await fixture(true);
  try {
    const api = await producer();
    const target = join(f.input.nativePluginRoot!, 'runtime', 'dist', 'cli.js');
    const altered = 'console.log("unreviewed");\n';
    writeFileSync(target, altered);
    await assert.rejects(api.stageRuntime(f.input), /native plugin.*reviewed/iu);
    assert.equal(readFileSync(target, 'utf8'), altered);
    assert.equal(existsSync(join(f.root, '.git', 'ai-delivery', 'runtime-admission.json')), false);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    f.cleanup();
  }
});

test('native stage rejects aliased or overlapping cache paths before installing', async () => {
  const f = await fixture(true);
  try {
    const api = await producer();
    const alias = join(f.base, 'native-alias');
    symlinkSync(f.input.nativePluginRoot!, alias);
    await assert.rejects(api.stageRuntime({ ...f.input, nativePluginRoot: alias }), /symbolic link/u);
    await assert.rejects(api.stageRuntime({ ...f.input, nativePluginRoot: f.base }), /overlap/iu);
    assert.equal(existsSync(f.counter), false);
  } finally {
    f.cleanup();
  }
});

test('runtime-stage controller memory is bounded before authenticated preflight', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: { maxAggregateRssBytes: 1, minFreeDiskBytes: 1, maxNewOutputBytes: 128 * 1024 ** 2 },
      }),
      /RSS.*limit|RSS.*bound/u,
    );
    assert.equal(actors.authorCalls, 0, 'over-budget controller must not start authenticated preflight');
    assert.equal(existsSync(f.counter), false);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    f.cleanup();
  }
});

test('runtime-stage controller growth during preflight fails before installing', async () => {
  const api = await producer();
  const f = await fixture();
  const memoryUsage = process.memoryUsage.bind(process);
  const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
    ...memoryUsage(),
    rss: actors.authorCalls === 0 ? 64 * 1024 ** 2 : 1024 ** 3,
  }));
  try {
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
        },
      }),
      /RSS.*limit|RSS.*bound/u,
    );
    assert.ok(actors.authorCalls > 0);
    assert.equal(existsSync(f.counter), false, 'preflight failure must not release the npm command');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    memory.mockRestore();
    f.cleanup();
  }
});

for (const interruption of ['resource breach', 'caller cancellation'] as const) {
  test(`runtime-stage ${interruption} aborts a delayed preflight request and releases ownership before continuation`, async () => {
    const api = await producer();
    const f = await fixture();
    const cancellation = new AbortController();
    const actualMemory = process.memoryUsage.bind(process);
    const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
      ...actualMemory(),
      rss: interruption === 'resource breach' && actors.authorStarted ? 1024 ** 3 : 64 * 1024 ** 2,
    }));
    actors.pauseAuthor = true;
    try {
      const rejected = assert.rejects(
        api.stageRuntime({
          ...f.input,
          signal: cancellation.signal,
          resourceBounds: {
            maxAggregateRssBytes: 512 * 1024 ** 2,
            minFreeDiskBytes: 1,
            maxNewOutputBytes: 128 * 1024 ** 2,
            maxCapturedOutputBytes: 1024 ** 2,
          },
        }),
        interruption === 'resource breach' ? /aggregate RSS .* exceeded limit/u : /cancelled/u,
      );
      if (interruption === 'caller cancellation') {
        while (!actors.authorStarted) await new Promise((resolve) => setTimeout(resolve, 10));
        cancellation.abort();
      }
      await rejected;
      assert.equal(actors.authorAborted, true, 'in-flight author request must receive scope cancellation');
      assert.equal(actors.reviewerCalls, 0, 'reviewer preflight must not continue after detection');
      assert.equal(existsSync(f.counter), false);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
      assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
      memory.mockRestore();
      actors.pauseAuthor = false;
      const retry = await api.stageRuntime(f.input);
      assert.equal(retry.reused, false, 'cancelled preflight must release writer ownership for a clean retry');
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
    } finally {
      memory.mockRestore();
      f.cleanup();
    }
  });
}

test('runtime-stage failure logs honor the caller retained-output cap outside the stage', async () => {
  const api = await producer();
  const f = await fixture();
  const logLimit = 1024 ** 2;
  try {
    writeFileSync(join(f.base, 'log-bytes'), String(2 * logLimit));
    writeFileSync(join(f.base, 'fail'), 'go');
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
          maxCapturedOutputBytes: logLimit,
        },
      }),
      /captured output exceeded/u,
    );
    const outputDirectory = join(f.root, '.git/ai-delivery/verification@1/command-output');
    const logs = readdirSync(outputDirectory);
    assert.equal(logs.length, 1);
    assert.ok(lstatSync(join(outputDirectory, logs[0]!)).size <= logLimit);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
  } finally {
    f.cleanup();
  }
});

test('runtime-stage retries share the retained-output allowance and preserve earlier failure evidence', async () => {
  const api = await producer();
  const f = await fixture();
  const logLimit = 1024 ** 2;
  const input = {
    ...f.input,
    resourceBounds: {
      maxAggregateRssBytes: 512 * 1024 ** 2,
      minFreeDiskBytes: 1,
      maxNewOutputBytes: 128 * 1024 ** 2,
      maxCapturedOutputBytes: logLimit,
    },
  };
  const outputDirectory = join(f.root, '.git/ai-delivery/verification@1/command-output');
  try {
    writeFileSync(join(f.base, 'fail'), 'go');
    writeFileSync(join(f.base, 'log-bytes'), String(600 * 1024));
    await assert.rejects(api.stageRuntime(input), /failed/u);
    const prior = readdirSync(outputDirectory).map((name) => ({
      name,
      bytes: readFileSync(join(outputDirectory, name)),
    }));
    writeFileSync(join(f.base, 'log-bytes'), String(700 * 1024));
    await assert.rejects(api.stageRuntime(input), /failed|captured output exceeded/u);
    const total = readdirSync(outputDirectory).reduce(
      (bytes, name) => bytes + lstatSync(join(outputDirectory, name)).size,
      0,
    );
    assert.ok(total <= logLimit, `Retained retry logs ${total} exceed total allowance ${logLimit}.`);
    for (const evidence of prior) assert.deepEqual(readFileSync(join(outputDirectory, evidence.name)), evidence.bytes);
    assert.equal(readFileSync(f.counter, 'utf8'), 'xx');
    await assert.rejects(api.stageRuntime(input), /retained.*exhausted/u);
    assert.equal(readFileSync(f.counter, 'utf8'), 'xx', 'exhausted allowance must refuse another installer invocation');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
  } finally {
    f.cleanup();
  }
});

for (const existing of ['oversized', 'corrupt', 'valid', 'empty'] as const) {
  test(`runtime-stage first publication bounds ${existing} shared output absent from its ledger`, async () => {
    const api = await producer();
    const f = await fixture();
    const bytes = Buffer.alloc(existing === 'empty' ? 0 : 100 * 1024, 65);
    const digest = digestBytes(bytes);
    const directory = join(f.root, '.git/ai-delivery/verification@1/command-output');
    const evidence = join(directory, `${digest.slice(7)}.bin`);
    const ledgerDirectory = join(
      f.root,
      '.git/ai-delivery/verification@1/runtime-output',
      digestValue(f.root).slice(7),
    );
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(evidence, existing === 'corrupt' ? Buffer.alloc(bytes.length, 66) : bytes, { mode: 0o600 });
      if (existing === 'oversized') truncateSync(evidence, 9 * 1024 ** 2);
      const originalDigest = digestBytes(readFileSync(evidence));
      const originalIdentity = lstatSync(evidence);
      assert.equal(existsSync(ledgerDirectory), false, 'shared evidence must precede this stage ledger');
      writeFileSync(join(f.base, 'fail'), 'go');
      writeFileSync(join(f.base, 'log-bytes'), String(bytes.length));
      sharedOutputRead.path = evidence;
      sharedOutputRead.unboundedReads = 0;
      await assert.rejects(api.stageRuntime(f.input), /exit 7/u);
      assert.equal(sharedOutputRead.unboundedReads, 0, 'publication must bound existing evidence before reading it');
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      const ledgerPath = join(ledgerDirectory, readdirSync(ledgerDirectory)[0]!);
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
        outputs: { digest: string; bytes: number; status: string }[];
      };
      const refused = existing === 'oversized' || existing === 'corrupt';
      assert.deepEqual(ledger.outputs, [{ digest, bytes: bytes.length, status: refused ? 'reserved' : 'complete' }]);
      const retainedLedger = readFileSync(ledgerPath);
      await assert.rejects(api.stageRuntime(f.input), refused ? /corrupt|size.*bound/u : /exit 7/u);
      assert.equal(readFileSync(f.counter, 'utf8'), refused ? 'x' : 'xx');
      assert.equal(sharedOutputRead.unboundedReads, 0);
      assert.deepEqual(
        readFileSync(ledgerPath),
        retainedLedger,
        'retry must preserve the existing reservation or completed charge',
      );
      sharedOutputRead.path = '';
      assert.equal(
        digestBytes(readFileSync(evidence)),
        originalDigest,
        'existing shared evidence must remain immutable',
      );
      const after = lstatSync(evidence);
      assert.equal(after.ino, originalIdentity.ino);
      assert.equal(after.size, originalIdentity.size);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
    } finally {
      sharedOutputRead.path = '';
      sharedOutputRead.unboundedReads = 0;
      f.cleanup();
    }
  });
}

for (const fault of [
  'corrupt ledger',
  'incompatible controller',
  'missing evidence',
  'corrupt evidence',
  'oversized evidence',
] as const) {
  test(`runtime-stage retained-output ${fault} refuses another installer without resetting its allowance`, async () => {
    const api = await producer();
    const f = await fixture();
    try {
      writeFileSync(join(f.base, 'fail'), 'go');
      writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
      await assert.rejects(api.stageRuntime(f.input), /exit 7/u);
      const directory = join(f.root, '.git/ai-delivery/verification@1/runtime-output', digestValue(f.root).slice(7));
      const path = join(directory, readdirSync(directory)[0]!);
      const ledger = JSON.parse(readFileSync(path, 'utf8')) as {
        contentDigest: string;
        producerDigest: string;
        outputs: { digest: string }[];
      };
      const evidence = join(
        f.root,
        '.git/ai-delivery/verification@1/command-output',
        `${ledger.outputs[0]!.digest.slice(7)}.bin`,
      );
      if (fault === 'corrupt ledger') {
        ledger.contentDigest = `sha256:${'0'.repeat(64)}`;
        writeFileSync(path, JSON.stringify(ledger));
      } else if (fault === 'incompatible controller') {
        ledger.producerDigest = `sha256:${'0'.repeat(64)}`;
        const { contentDigest: _digest, ...content } = ledger;
        ledger.contentDigest = digestValue(content);
        writeFileSync(path, JSON.stringify(ledger));
      } else if (fault === 'missing evidence') rmSync(evidence);
      else if (fault === 'oversized evidence') truncateSync(evidence, 9 * 1024 ** 2);
      else writeFileSync(evidence, 'changed immutable output');
      const retained = readFileSync(path);
      await assert.rejects(api.stageRuntime(f.input), /corrupt|incompatible|ENOENT|size.*bound/u);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      assert.deepEqual(readFileSync(path), retained, 'failed integrity check must preserve the charged ledger');
      assert.equal(readdirSync(directory).length, 1);
      assert.equal(existsSync(f.input.runtimeDirectory), false);
    } finally {
      f.cleanup();
    }
  });
}

test('runtime-stage explicitly isolates npm cache, logs, configuration and temporary destinations', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    await api.stageRuntime(f.input);
    const settings = JSON.parse(readFileSync(join(f.base, 'installer-settings'), 'utf8')) as {
      args: string[];
      cwd: string;
      TMPDIR: string;
      TMP: string;
      TEMP: string;
    };
    const stage = f.input.runtimeDirectory;
    for (const option of ['--cache', '--logs-dir', '--userconfig', '--globalconfig']) {
      assert.ok(settings.args.includes(option), `missing explicit npm ${option}`);
      const value = settings.args[settings.args.indexOf(option) + 1]!;
      assert.ok(value.startsWith(`${stage}/`), `npm ${option} must stay inside the owned stage`);
      assert.ok(existsSync(value));
    }
    assert.equal(settings.cwd, stage);
    for (const key of ['TMPDIR', 'TMP', 'TEMP'] as const) {
      assert.ok(settings[key].startsWith(`${stage}/`), `${key} must stay inside the owned stage`);
      assert.ok(existsSync(settings[key]));
    }
    assert.equal((await api.stageRuntime(f.input)).reused, true);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
  } finally {
    f.cleanup();
  }
});

test('runtime-stage cancellation shares prior failure charges and identical evidence is reused', async () => {
  const api = await producer();
  const f = await fixture();
  const cancellation = new AbortController();
  const input = {
    ...f.input,
    resourceBounds: {
      maxAggregateRssBytes: 512 * 1024 ** 2,
      minFreeDiskBytes: 1,
      maxNewOutputBytes: 128 * 1024 ** 2,
      maxCapturedOutputBytes: 1024 ** 2,
    },
  };
  const directory = join(f.root, '.git/ai-delivery/verification@1/command-output');
  const write = process.stderr.write.bind(process.stderr);
  let sawCaptured = false;
  const observation = vi.spyOn(process.stderr, 'write').mockImplementation((chunk, ...args) => {
    const text = String(chunk);
    if (text.startsWith('ai-delivery.verify ')) {
      const value = JSON.parse(text.slice('ai-delivery.verify '.length)) as { capturedOutputBytes?: number };
      if (value.capturedOutputBytes === 200 * 1024) {
        sawCaptured = true;
        cancellation.abort();
      }
    }
    return write(chunk, ...args);
  });
  try {
    writeFileSync(join(f.base, 'fail'), 'go');
    writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
    await assert.rejects(api.stageRuntime(input), /exit 7/u);
    await assert.rejects(api.stageRuntime(input), /exit 7/u);
    assert.equal(readdirSync(directory).length, 1, 'identical complete command evidence must be reused');
    const prior = readFileSync(join(directory, readdirSync(directory)[0]!));
    rmSync(join(f.base, 'fail'));
    writeFileSync(join(f.base, 'wait'), 'go');
    writeFileSync(join(f.base, 'log-bytes'), String(200 * 1024));
    await assert.rejects(api.stageRuntime({ ...input, signal: cancellation.signal }), /cancelled/u);
    assert.equal(sawCaptured, true, 'cancel only after the full owned output is captured');
    assert.ok(readdirSync(directory).some((name) => readFileSync(join(directory, name)).equals(prior)));
    const ledgerRoot = join(f.root, '.git/ai-delivery/verification@1/runtime-output', digestValue(f.root).slice(7));
    const ledger = JSON.parse(readFileSync(join(ledgerRoot, readdirSync(ledgerRoot)[0]!), 'utf8')) as {
      outputs: { bytes: number }[];
    };
    assert.equal(
      ledger.outputs.reduce((total, output) => total + output.bytes, 0),
      300 * 1024,
    );
    assert.equal(readFileSync(f.counter, 'utf8'), 'xxx');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    cancellation.abort();
    observation.mockRestore();
    f.cleanup();
  }
});

test('runtime-stage post-install preflight growth cannot publish completion', async () => {
  const api = await producer();
  const f = await fixture();
  const memoryUsage = process.memoryUsage.bind(process);
  const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => ({
    ...memoryUsage(),
    rss: actors.authorCalls < 2 ? 64 * 1024 ** 2 : 1024 ** 3,
  }));
  try {
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
        },
      }),
      /RSS.*limit|RSS.*bound/u,
    );
    assert.equal(readFileSync(f.counter, 'utf8'), 'x', 'installation must finish before the failing final preflight');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
  } finally {
    memory.mockRestore();
    f.cleanup();
  }
});

test('runtime-stage bounds actual controller and npm memory and preserves an unrelated live peer', async () => {
  const api = await producer();
  const f = await fixture();
  const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const closed = new Promise<void>((resolve) => peer.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      peer.once('spawn', () => resolve());
      peer.once('error', reject);
    });
    writeFileSync(join(f.base, 'memory-bytes'), String(512 * 1024 ** 2));
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
          maxCapturedOutputBytes: 1024 ** 2,
        },
      }),
      /aggregate RSS .* exceeded limit/u,
    );
    const ownedPid = Number(readFileSync(f.marker, 'utf8'));
    assert.throws(() => process.kill(ownedPid, 0), { code: 'ESRCH' });
    assert.equal(peer.exitCode, null);
    process.kill(peer.pid!, 0);
    assert.equal(existsSync(f.input.runtimeDirectory), false);
    assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
    assert.equal(digestBytes(readFileSync(f.input.archivePath)), f.input.expectedArchiveSha256);
  } finally {
    peer.kill('SIGKILL');
    await closed;
    f.cleanup();
  }
});

test('runtime-stage changed resource intent preserves compatible completed bytes without reinstalling', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const stage = await api.stageRuntime(f.input);
    const path = join(f.input.runtimeDirectory, 'runtime-stage.json');
    const completion = readFileSync(path);
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
          maxCapturedOutputBytes: 512 * 1024,
        },
      }),
      /incompatible setup intent/u,
    );
    assert.deepEqual(readFileSync(path), completion);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    assert.equal((await api.stageRuntime(f.input)).stageId, stage.stageId);
  } finally {
    f.cleanup();
  }
});

for (const mode of ['success', 'failure', 'cancel'] as const) {
  test(`real npm ${mode} disables file logs and preserves unrelated host destinations`, async () => {
    const api = await producer();
    const realPath = process.env.PATH;
    const f = await fixture();
    const cancellation = new AbortController();
    let operation: Promise<Stage> | undefined;
    const previous = {
      cache: process.env.npm_config_cache,
      logs: process.env.npm_config_logs_dir,
      userconfig: process.env.npm_config_userconfig,
    };
    try {
      process.env.PATH = realPath;
      const outside = join(f.base, 'unrelated-host');
      mkdirSync(outside);
      const cache = join(outside, 'cache');
      const logs = join(outside, 'logs');
      for (const path of [cache, logs]) {
        mkdirSync(path);
        writeFileSync(join(path, 'keep'), 'unrelated');
      }
      const userconfig = join(outside, 'user.npmrc');
      const config = `cache=${cache}\nlogs-dir=${logs}\n`;
      writeFileSync(userconfig, config);
      const nativeBin = join(f.base, 'native-bin');
      mkdirSync(nativeBin);
      const probe = join(f.base, 'native-npm-observation.json');
      const npmRoot = join(dirname(process.execPath), '../lib/node_modules/npm');
      writeFileSync(
        join(nativeBin, 'npm'),
        `#!${process.execPath}\nconst fs=require('node:fs'),os=require('node:os'),path=require('node:path');\nconst observation={args:process.argv.slice(2),cwd:process.cwd(),tmpdir:os.tmpdir(),npmVersion:require(${JSON.stringify(join(npmRoot, 'package.json'))}).version};\nconst LogFile=require(${JSON.stringify(join(npmRoot, 'lib/utils/log-file.js'))}),load=LogFile.prototype.load;\nconst observe=()=>{const directory=path.join(process.cwd(),'.npm/logs');observation.fileLogs=fs.existsSync(directory)?fs.readdirSync(directory):[];observation.fileLogBytes=observation.fileLogs.reduce((sum,name)=>sum+fs.statSync(path.join(directory,name)).size,0);fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify(observation),{mode:0o600});};\nLogFile.prototype.load=function(options){const result=load.call(this,options);observation.logsMax=options.logsMax;observe();${mode === 'cancel' ? 'setInterval(observe,20);' : ''}return result;};\nprocess.on('exit',observe);\n${mode === 'failure' ? 'process.argv[2]="synthetic-unknown-command";' : ''}\nrequire(${JSON.stringify(join(npmRoot, 'bin/npm-cli.js'))});\n`,
      );
      chmodSync(join(nativeBin, 'npm'), 0o755);
      process.env.PATH = `${nativeBin}:${realPath ?? ''}`;
      process.env.npm_config_cache = cache;
      process.env.npm_config_logs_dir = logs;
      process.env.npm_config_userconfig = userconfig;
      operation = api.stageRuntime({
        ...f.input,
        signal: cancellation.signal,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
          maxCapturedOutputBytes: 1024 ** 2,
        },
      });
      void operation.catch(() => undefined);
      if (mode === 'cancel') {
        for (let i = 0; i < 1000 && !existsSync(probe); i++) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(existsSync(probe), true, 'actual npm log configuration was not observed');
        cancellation.abort();
        await assert.rejects(operation, /cancelled/u);
      } else if (mode === 'failure') await assert.rejects(operation, /exit 1/u);
      else {
        const stage = await operation;
        assert.equal(existsSync(f.counter), false, 'synthetic npm must not execute');
        assert.equal(
          execFileSync(process.execPath, [stage.admission.cliPath, '--version'], { encoding: 'utf8' }).trim(),
          '0.3.5',
        );
        assert.ok(readdirSync(join(f.input.runtimeDirectory, '.npm/cache')).length > 0);
        assert.deepEqual(readdirSync(join(f.input.runtimeDirectory, '.npm/logs')), []);
      }
      const native = JSON.parse(readFileSync(probe, 'utf8')) as {
        args: string[];
        cwd: string;
        tmpdir: string;
        npmVersion: string;
        logsMax: number;
        fileLogs: string[];
        fileLogBytes: number;
      };
      assert.equal(native.npmVersion, '11.19.0');
      assert.equal(native.cwd, f.input.runtimeDirectory);
      assert.equal(native.tmpdir, join(f.input.runtimeDirectory, '.npm/tmp'));
      assert.equal(native.logsMax, 0);
      assert.equal(native.fileLogBytes, 0);
      assert.deepEqual(native.fileLogs, []);
      if (mode !== 'success') assert.equal(existsSync(f.input.runtimeDirectory), false);
      for (const option of ['--cache', '--logs-dir', '--userconfig', '--globalconfig']) {
        assert.ok(native.args.includes(option));
        assert.ok(native.args[native.args.indexOf(option) + 1]!.startsWith(`${f.input.runtimeDirectory}/`));
      }
      assert.deepEqual(readdirSync(cache), ['keep']);
      assert.deepEqual(readdirSync(logs), ['keep']);
      assert.equal(readFileSync(userconfig, 'utf8'), config);
      assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
      console.log(
        'REAL_NPM_ISOLATION_RECEIPT',
        JSON.stringify({
          mode,
          npmFileLogBytes: native.fileLogBytes,
          npmFileLogsDisabled: true,
          temporaryAndConfigInsideStage: true,
          unrelatedHostPreserved: true,
          controllerInclusiveMemoryBytes: 512 * 1024 ** 2,
          retainedLogCapBytes: 1024 ** 2,
          hostActivated: false,
          sharedAdmissionWritten: false,
        }),
      );
    } finally {
      cancellation.abort();
      await operation?.catch(() => undefined);
      for (const [name, value] of [
        ['npm_config_cache', previous.cache],
        ['npm_config_logs_dir', previous.logs],
        ['npm_config_userconfig', previous.userconfig],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      f.cleanup();
    }
  });
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

for (const native of [false, true]) {
  test(`${native ? 'native ' : ''}failure and cancellation remove only the owned incomplete stage and preserve unrelated output`, async () => {
    const api = await producer();
    const f = await fixture(native);
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
      if (native)
        assert.equal(
          readFileSync(join(f.input.nativePluginRoot!, 'README.md'), 'utf8'),
          'Synthetic copied native plugin.\n',
        );
    } finally {
      controller.abort();
      f.cleanup();
    }
  });
}

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
  const phase = process.env.AI_DELIVERY_SETUP_LOG_INTERRUPT_PHASE;
  if (phase) {
    const actual = atomicJson.writePrivateJsonFileAtomically;
    vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
      const record = value as { outputs?: { status: string }[] };
      const interrupt =
        path.includes('/runtime-output/') &&
        record.outputs?.[0]?.status === (phase === 'reservation' ? 'reserved' : 'complete');
      if (!(interrupt && phase === 'publication')) actual(path, value);
      if (interrupt) {
        writeFileSync(
          process.env.AI_DELIVERY_SETUP_LOG_INTERRUPT_MARKER!,
          JSON.stringify({ phase, path, owner: process.pid }),
        );
        process.kill(process.pid, 'SIGKILL');
      }
    });
  }
  await api.stageRuntime(JSON.parse(process.env.AI_DELIVERY_SETUP_INTERRUPT_INPUT!) as SetupInput);
});

for (const phase of ['reservation', 'publication'] as const) {
  test(`runtime-stage retained-output recovery preserves charges after hard interruption at ${phase}`, async () => {
    const api = await producer();
    const f = await fixture();
    const marker = join(f.base, 'log-interruption-marker');
    const input = {
      ...f.input,
      resourceBounds: {
        maxAggregateRssBytes: 512 * 1024 ** 2,
        minFreeDiskBytes: 1,
        maxNewOutputBytes: 128 * 1024 ** 2,
        maxCapturedOutputBytes: 1024 ** 2,
      },
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      writeFileSync(join(f.base, 'fail'), 'go');
      writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
      child = spawn(
        process.execPath,
        [
          join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
          'run',
          new URL(import.meta.url).pathname,
          '-t',
          '^setup interruption child$',
          '--maxWorkers=1',
          '--no-file-parallelism',
        ],
        {
          env: {
            ...process.env,
            AI_DELIVERY_SETUP_INTERRUPT_INPUT: JSON.stringify(input),
            AI_DELIVERY_SETUP_LOG_INTERRUPT_PHASE: phase,
            AI_DELIVERY_SETUP_LOG_INTERRUPT_MARKER: marker,
          },
          stdio: 'ignore',
        },
      );
      await new Promise<void>((resolve) => child!.once('close', () => resolve()));
      assert.equal(existsSync(marker), true, 'hard interruption must occur at the selected durable log boundary');
      const writerPath = join(f.root, '.git/ai-delivery/writers@1', `${digestValue(f.root).slice(7)}.json`);
      const stale = new Date(Date.now() - 20_000);
      utimesSync(`${writerPath}.lock`, stale, stale);
      const { path } = JSON.parse(readFileSync(marker, 'utf8')) as { path: string };
      const prior = JSON.parse(readFileSync(path, 'utf8')) as {
        outputs: { bytes: number; digest: string; status: string }[];
      };
      assert.equal(prior.outputs[0]!.status, 'reserved');
      assert.equal(prior.outputs[0]!.bytes, 100 * 1024);
      const outputDirectory = join(f.root, '.git/ai-delivery/verification@1/command-output');
      const priorOutput = join(outputDirectory, `${prior.outputs[0]!.digest.slice(7)}.bin`);
      assert.equal(existsSync(priorOutput), phase === 'publication');
      const preserved = phase === 'publication' ? readFileSync(priorOutput) : undefined;
      writeFileSync(join(f.base, 'log-bytes'), String(128 * 1024));
      await assert.rejects(api.stageRuntime(input), /exit 7/u);
      const recovered = JSON.parse(readFileSync(path, 'utf8')) as typeof prior;
      assert.equal(
        recovered.outputs.reduce((total, output) => total + output.bytes, 0),
        228 * 1024,
      );
      assert.equal(recovered.outputs[0]!.status, phase === 'publication' ? 'complete' : 'reserved');
      if (preserved) assert.deepEqual(readFileSync(priorOutput), preserved);
      if (phase === 'reservation') {
        writeFileSync(join(f.base, 'log-bytes'), String(100 * 1024));
        await assert.rejects(api.stageRuntime(input), /identical output cannot be rewritten/u);
        assert.equal(
          existsSync(priorOutput),
          false,
          'unresolved reservation must not authorize a second raw-log write',
        );
      }
      rmSync(join(f.base, 'fail'));
      rmSync(join(f.base, 'log-bytes'));
      const completed = await api.stageRuntime(input);
      const count = readFileSync(f.counter, 'utf8');
      assert.equal(completed.reused, false);
      assert.equal((await api.stageRuntime(input)).reused, true);
      assert.equal(readFileSync(f.counter, 'utf8'), count, 'completed recovered stage must skip the installer');
      assert.equal(readFileSync(completed.admission.cliPath, 'utf8'), "#!/usr/bin/env node\nconsole.log('0.3.5');\n");
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      f.cleanup();
    }
  });
}

for (const native of [false, true]) {
  test(`${native ? 'native ' : ''}stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install`, async () => {
    const api = await producer();
    const f = await fixture(native);
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
      // Bound this cold installer-start observation, not the recovery run.
      for (let i = 0; i < 1000; i++) {
        if (existsSync(writerPath)) record = JSON.parse(readFileSync(writerPath, 'utf8')) as typeof record;
        if (record?.command.phase === 'running' && existsSync(f.marker)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(record?.command.phase, 'running');
      assert.equal(existsSync(f.marker), true, 'interrupt only after the owned installer actually starts');
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
          nativePluginRoot: f.input.nativePluginRoot ?? null,
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
  });
}

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
