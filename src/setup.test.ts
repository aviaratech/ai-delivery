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
import { afterEach, test, vi } from 'vitest';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import * as privateFiles from './delivery/common.js';
import { digestBytes, digestValue } from './delivery/index.js';
import { syntheticDiscoveryClients, syntheticOverrides, syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { assertDeliveryRuntimeAdmitted, type RuntimeAdmission } from './services/deliveryAdmission.js';
import * as atomicJson from './utils/atomicJson.js';

afterEach(() => vi.unstubAllEnvs());

// These two unit scenarios isolate the synthetic controller RSS contract from host-wide PS latency.
// Every integration scenario retains native observation; this is never fallback for a failed native call.
const controllerObservation = vi.hoisted(() => ({
  mode: 'native' as 'native' | 'healthy-controller' | 'unavailable-controller',
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (controllerObservation.mode !== 'native')
        throw new Error('Controller unit fixture must not launch an owned child.');
      return actual.spawn(...args);
    },
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      if (controllerObservation.mode === 'native') return actual.spawnSync(...args);
      // Native synchronous probes (including inert Git config) retain their actual result and failure.
      const psCommand = args[0] === 'ps' || args[0].endsWith('/ps');
      if (!psCommand) return actual.spawnSync(...args);
      if (
        (args[0] !== '/usr/bin/ps' && args[0] !== '/bin/ps') ||
        !Array.isArray(args[1]) ||
        args[1].join('|') !== '-A|-o|pid=,ppid=,pgid=,rss=,stat=,lstart=' ||
        args[2]?.encoding !== 'utf8' ||
        args[2]?.timeout !== 1_000 ||
        args[2]?.maxBuffer !== 4 * 1024 ** 2
      )
        throw new Error('Controller unit fixture received an unsupported observation signature.');
      if (controllerObservation.mode === 'unavailable-controller')
        return {
          status: null,
          error: Object.assign(new Error('Synthetic controller observation unavailable'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
        };
      // This unit owns its own writer and gate; no real child is allowed in this one-controller universe.
      return {
        status: 0,
        signal: null,
        stdout: `${process.pid} 0 ${process.pid} 32 S controller unit birth\n`,
        stderr: '',
      };
    },
  };
});
function beginControllerObservation(mode: 'healthy-controller' | 'unavailable-controller'): void {
  assert.equal(controllerObservation.mode, 'native', 'a controller unit observation scope leaked');
  assert.equal(
    process.env.AI_DELIVERY_OUTPUT_OBSERVATION_GATE,
    undefined,
    'controller unit observation requires its own fixture gate',
  );
  controllerObservation.mode = mode;
}

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
  const {
    policy: _policy,
    repository: _repository,
    remote: _remote,
    schemaVersion: _schema,
    ...overrides
  } = syntheticOverrides(syntheticDiscoveryConfig);
  const userPath = join(base, 'user.json');
  writeFileSync(
    userPath,
    JSON.stringify({ schemaVersion: 'ai-delivery.user@1', roles, checkoutRoots: [], ...overrides }),
  );
  vi.stubEnv('AI_DELIVERY_CONFIG', userPath);
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
    `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),path=require('path');\nconst args=process.argv.slice(2);\nif(args[0]!=='install'||!['--omit=dev','--ignore-scripts','--no-audit','--no-fund'].every(x=>args.includes(x)))process.exit(9);\nfs.appendFileSync(${JSON.stringify(counter)},'x');\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nconst prefix=args[args.indexOf('--prefix')+1],archive=args.at(-1);\nfs.writeFileSync(${JSON.stringify(join(base, 'installer-settings'))},JSON.stringify({args,cwd:process.cwd(),TMPDIR:process.env.TMPDIR,TMP:process.env.TMP,TEMP:process.env.TEMP}));\nfs.writeFileSync(${JSON.stringify(join(base, 'installer-archive'))},archive);\nconst original=${JSON.stringify(archivePath)},replacement=${JSON.stringify(join(base, 'replacement.tgz'))};\nconst saved=fs.existsSync(replacement)?fs.readFileSync(original):undefined;\nif(saved)fs.copyFileSync(replacement,original);\nconst target=path.join(prefix,'node_modules/@aviaratech/ai-delivery');fs.mkdirSync(target,{recursive:true});\ntry{cp.execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',target]);}finally{if(saved)fs.writeFileSync(original,saved);}\nconst dependency={'@aviaratech/ai-delivery':'file:reviewed-archive.tgz'};fs.writeFileSync(path.join(prefix,'package.json'),JSON.stringify({dependencies:dependency}));\nif(!args.includes('--package-lock=false')){const targetPackage=JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')),integrity='sha512-'+require('node:crypto').createHash('sha512').update(fs.readFileSync(archive)).digest('base64');fs.writeFileSync(path.join(prefix,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:dependency},'node_modules/@aviaratech/ai-delivery':{version:targetPackage.version,resolved:'file:reviewed-archive.tgz',integrity}}}));}\nfs.mkdirSync(path.join(prefix,'node_modules/.bin'),{recursive:true});\nfs.symlinkSync('../@aviaratech/ai-delivery/dist/cli.js',path.join(prefix,'node_modules/.bin/ai-delivery'));\nconst logs=${JSON.stringify(join(base, 'log-bytes'))};\nif(fs.existsSync(logs))process.stdout.write(Buffer.alloc(Number(fs.readFileSync(logs,'utf8')),65),()=>{if(fs.existsSync(${JSON.stringify(join(base, 'fail'))}))process.exit(7);});\nelse if(fs.existsSync(${JSON.stringify(join(base, 'fail'))}))process.exit(7);\nconst memory=${JSON.stringify(join(base, 'memory-bytes'))};\nif(fs.existsSync(memory)){globalThis.fixtureAllocation=Buffer.alloc(Number(fs.readFileSync(memory,'utf8')),1);setInterval(()=>{},1000);}\nif(fs.existsSync(${JSON.stringify(join(base, 'wait'))}))setInterval(()=>{},1000);\n`,
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
    beginControllerObservation('healthy-controller');
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
    try {
      memory.mockRestore();
    } finally {
      try {
        f.cleanup();
      } finally {
        controllerObservation.mode = 'native';
      }
    }
  }
});

test('runtime-stage unavailable initial controller observation refuses preflight and installer release', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    beginControllerObservation('unavailable-controller');
    await assert.rejects(
      api.stageRuntime({
        ...f.input,
        resourceBounds: {
          maxAggregateRssBytes: 512 * 1024 ** 2,
          minFreeDiskBytes: 1,
          maxNewOutputBytes: 128 * 1024 ** 2,
        },
      }),
      {
        name: 'DeliveryError',
        message:
          'Owned process resource observation failed. {"status":null,"errorCode":"ETIMEDOUT","signal":"SIGTERM","stdoutPresent":true,"stdoutTerminated":false}',
      },
    );
    assert.equal(actors.authorCalls, 0, 'unavailable observation must refuse before authenticated preflight');
    assert.equal(existsSync(f.counter), false, 'unavailable observation must not release the npm command');
    assert.equal(existsSync(f.input.runtimeDirectory), false);
  } finally {
    try {
      f.cleanup();
    } finally {
      controllerObservation.mode = 'native';
    }
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

test('real npm keeps the reviewed tarball closure after hidden-lock invalidation and completed reuse', async () => {
  const api = await producer();
  const realPath = process.env.PATH;
  const f = await fixture();
  try {
    const npmRoot = join(dirname(process.execPath), '../lib/node_modules/npm');
    const npmCli = join(npmRoot, 'bin/npm-cli.js');
    assert.equal(
      (JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')) as { version: string }).version,
      '11.19.0',
    );
    const bin = join(f.base, 'real-npm-bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'npm'),
      `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='install')fs.appendFileSync(${JSON.stringify(f.counter)},'x');require(${JSON.stringify(npmCli)});\n`,
    );
    chmodSync(join(bin, 'npm'), 0o755);
    process.env.PATH = `${bin}:${realPath ?? ''}`;
    const manifestPath = join(f.base, 'archive/package/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.scripts = { preinstall: 'node -e "process.exit(91)"', install: 'node -e "process.exit(92)"' };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    execFileSync('tar', ['-czf', f.input.archivePath, '-C', join(f.base, 'archive'), 'package']);
    f.input.expectedArchiveSha256 = digestBytes(readFileSync(f.input.archivePath));
    const installed = join(f.input.runtimeDirectory, 'node_modules');
    const hidden = join(installed, '.package-lock.json');
    const stage = await api.stageRuntime(f.input);
    const completeBytes = readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json'));
    const metadataPaths = ['package.json', 'package-lock.json'].map((name) => join(f.input.runtimeDirectory, name));
    const metadataBytes = metadataPaths.map((path) => readFileSync(path));
    const inspectClosure = () =>
      spawnSync(
        process.execPath,
        [npmCli, 'ls', '--prefix', f.input.runtimeDirectory, '--omit=dev', '--all', '--json', '--logs-max', '0'],
        { cwd: f.root, encoding: 'utf8', maxBuffer: 1024 ** 2 },
      );
    const closure = () => {
      const result = inspectClosure();
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const graph = JSON.parse(result.stdout) as {
        problems?: string[];
        dependencies: Record<string, { version: string; resolved?: string; invalid?: boolean; missing?: boolean }>;
      };
      assert.equal(graph.problems, undefined);
      const target = graph.dependencies['@aviaratech/ai-delivery']!;
      assert.equal(target.version, '0.3.5');
      assert.equal(target.invalid, undefined);
      assert.equal(target.missing, undefined);
      assert.equal(target.resolved, `file:${join(f.input.runtimeDirectory, 'reviewed-archive.tgz')}`);
    };
    closure();
    const lockTime = lstatSync(hidden).mtime;
    utimesSync(installed, new Date(lockTime.getTime() + 2000), new Date(lockTime.getTime() + 2000));
    assert.ok(lstatSync(installed).mtimeMs > lstatSync(hidden).mtimeMs);
    closure();
    assert.deepEqual(await api.stageRuntime(f.input), { ...stage, reused: true });
    assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), completeBytes);
    assert.deepEqual(
      metadataPaths.map((path) => readFileSync(path)),
      metadataBytes,
    );
    rmSync(hidden);
    closure();
    assert.deepEqual(await api.stageRuntime(f.input), { ...stage, reused: true });
    await api.admitRuntime(admitInput(f.input, stage.stageId));
    assert.equal(readFileSync(f.counter, 'utf8'), 'x', 'completed reuse must never reinstall');
    assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), completeBytes);
    assert.deepEqual(
      metadataPaths.map((path) => readFileSync(path)),
      metadataBytes,
    );
    const admissionPath = join(f.root, '.git/ai-delivery/runtime-admission.json');
    const admissionBytes = readFileSync(admissionPath);
    for (const { field, edges, problem } of [
      { field: 'optionalDependencies', edges: { '@aviaratech/ai-delivery': 'file:other.tgz' }, problem: /invalid:/u },
      { field: 'peerDependencies', edges: { 'missing-runtime-stage-peer': '1.0.0' }, problem: /missing:/u },
    ]) {
      const changed = JSON.parse(metadataBytes[0]!.toString('utf8')) as Record<string, unknown>;
      changed[field] = edges;
      writeFileSync(metadataPaths[0]!, JSON.stringify(changed));
      const damaged = readFileSync(metadataPaths[0]!);
      const native = inspectClosure();
      assert.equal(native.error, undefined);
      assert.equal(native.status, 1, native.stderr + native.stdout);
      const graph = JSON.parse(native.stdout) as { error?: { code: string }; problems?: string[] };
      assert.equal(graph.error?.code, 'ELSPROBLEMS');
      assert.ok(graph.problems?.some((entry) => problem.test(entry)));
      await assert.rejects(api.stageRuntime(f.input), /dependency metadata/iu);
      await assert.rejects(api.admitRuntime(admitInput(f.input, stage.stageId)), /dependency metadata/iu);
      assert.deepEqual(readFileSync(metadataPaths[0]!), damaged);
      assert.deepEqual(readFileSync(metadataPaths[1]!), metadataBytes[1]);
      assert.deepEqual(readFileSync(join(f.input.runtimeDirectory, 'runtime-stage.json')), completeBytes);
      assert.deepEqual(readFileSync(admissionPath), admissionBytes);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      writeFileSync(metadataPaths[0]!, metadataBytes[0]!);
    }
  } finally {
    f.cleanup();
    process.env.PATH = realPath;
  }
});

test('completed stages refuse missing, corrupt or incompatible dependency metadata without reinstalling or rewriting', async () => {
  const api = await producer();
  const f = await fixture();
  try {
    const staged = await api.stageRuntime(f.input);
    const record = join(f.input.runtimeDirectory, 'runtime-stage.json');
    const complete = readFileSync(record);
    const paths = ['package.json', 'package-lock.json'].map((name) => join(f.input.runtimeDirectory, name));
    const retained = paths.map((path) => (existsSync(path) ? readFileSync(path) : undefined));
    for (const [index, path] of paths.entries()) {
      for (const fault of [
        'missing',
        'corrupt',
        'incompatible',
        'symlink',
        'hardlink',
        'fifo',
        ...(index === 1 ? ['version', 'resolved', 'integrity'] : []),
      ]) {
        const sentinel = join(f.base, `unrelated-metadata-${index}-${fault}`);
        if (fault === 'missing') rmSync(path, { force: true });
        else if (fault === 'symlink' || fault === 'hardlink') {
          writeFileSync(sentinel, retained[index]!);
          rmSync(path);
          if (fault === 'symlink') symlinkSync(sentinel, path);
          else linkSync(sentinel, path);
        } else if (fault === 'fifo') {
          rmSync(path);
          execFileSync('mkfifo', [path]);
        } else if (['version', 'resolved', 'integrity'].includes(fault)) {
          const lock = JSON.parse(retained[index]!.toString('utf8')) as {
            packages: Record<string, Record<string, unknown>>;
          };
          lock.packages['node_modules/@aviaratech/ai-delivery']![fault] = 'incompatible';
          writeFileSync(path, JSON.stringify(lock));
        } else
          writeFileSync(
            path,
            fault === 'corrupt'
              ? '{'
              : JSON.stringify(
                  index === 0
                    ? { dependencies: { '@aviaratech/ai-delivery': 'file:other.tgz' } }
                    : { lockfileVersion: 99, packages: {} },
                ),
          );
        const damaged = fault !== 'fifo' && existsSync(path) ? readFileSync(path) : undefined;
        await assert.rejects(
          api.stageRuntime(f.input),
          fault === 'symlink' ? /symbolic link/iu : fault === 'fifo' ? /unsupported file/iu : /dependency metadata/iu,
        );
        await assert.rejects(api.admitRuntime(admitInput(f.input, staged.stageId)), /dependency metadata/iu);
        assert.deepEqual(readFileSync(record), complete);
        if (fault === 'fifo') assert.equal(lstatSync(path).isFIFO(), true);
        else assert.deepEqual(existsSync(path) ? readFileSync(path) : undefined, damaged);
        if (fault === 'symlink' || fault === 'hardlink') {
          assert.deepEqual(readFileSync(sentinel), retained[index]);
          assert.equal(lstatSync(path).isSymbolicLink(), fault === 'symlink');
        }
        assert.equal(readFileSync(f.counter, 'utf8'), 'x', 'metadata refusal must not reinstall');
        rmSync(path, { force: true });
        if (retained[index] !== undefined) writeFileSync(path, retained[index]!);
      }
    }
  } finally {
    f.cleanup();
  }
});

for (const metadata of ['package.json', 'package-lock.json']) {
  test(`lost completion response refuses ${metadata} drift during final preflight without reinstalling`, async () => {
    const api = await producer();
    const f = await fixture();
    let operation: Promise<Stage> | undefined;
    try {
      const record = join(f.input.runtimeDirectory, 'runtime-stage.json');
      const target = join(f.input.runtimeDirectory, metadata);
      let complete: Buffer | undefined;
      let notifyWritten: (() => void) | undefined;
      const written = new Promise<void>((resolve) => {
        notifyWritten = resolve;
      });
      const actual = atomicJson.writePrivateJsonFileAtomically;
      vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
        actual(path, value);
        if (path === record && (value as { status?: string }).status === 'complete') {
          complete = readFileSync(record);
          actors.authorStarted = false;
          actors.pauseAuthor = true;
          notifyWritten!();
          throw new Error('Synthetic completion response lost after durable write');
        }
      });
      operation = api.stageRuntime(f.input);
      const settled = operation.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      const prematurelySettled = settled.then((result) => {
        if (result.status === 'rejected') throw result.error;
        throw new Error('Stage completed before the recovery fault was injected.');
      });
      await Promise.race([written, prematurelySettled]);
      while (!actors.authorStarted)
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 10)), prematurelySettled]);
      assert.ok(complete);
      assert.equal((JSON.parse(complete.toString('utf8')) as { status: string }).status, 'complete');
      if (metadata === 'package.json') rmSync(target);
      else writeFileSync(target, '{');
      const damaged = existsSync(target) ? readFileSync(target) : undefined;
      await assert.rejects(operation, /dependency metadata/iu);
      assert.deepEqual(readFileSync(record), complete);
      assert.deepEqual(existsSync(target) ? readFileSync(target) : undefined, damaged);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
    } finally {
      await operation?.catch(() => undefined);
      actors.pauseAuthor = false;
      vi.restoreAllMocks();
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
        const userPath = process.env.AI_DELIVERY_CONFIG!;
        const settings = JSON.parse(readFileSync(userPath, 'utf8')) as { roles: { author: { identity: string } } };
        settings.roles.author.identity = 'changed-author';
        writeFileSync(userPath, JSON.stringify(settings));
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
      const recovered = await api.stageRuntime(f.input).catch((error: unknown) => {
        if (error instanceof Error)
          error.message += ` Fictional setup interruption phase=orphan-recovery; native=${native}.`;
        throw error;
      });
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

const stageAdmitCase = 'CLI stage and admit execute the same public producer with explicit authority and prior absence';
type CliPhase = { phase: string; event: 'start' | 'end' | 'settled' | 'pending'; atMs: number };
type CliScenario = 'normal' | 'budget' | 'unfinished' | 'installer-failure' | 'admission-stall';
type CliTraceFault = 'missing' | 'oversized' | 'records' | 'write';
type CliCaseFailure = Error & {
  root: string;
  nativeIdle: boolean;
  cleanupState: import('./verification.js').OwnedProcessState | undefined;
  receiptFailure: string | undefined;
  residualInstaller: { pid: number; counter: string } | undefined;
  retainedPhaseCount: number;
  traceFaultInjected: boolean;
  restoredGlobalsWithPending: boolean;
};

// Re-enter this same case so cancellation can contain synchronous CLI work as well as promises.
// The existing producer supervisor owns the native process; these callbacks only retain its observations.
async function observeStageAdmitCase(scenario: CliScenario = 'normal', traceFault?: CliTraceFault) {
  const { runStageCommand } = await import('./verification.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-cli-case-')));
  const tracePath = join(root, 'phases.json');
  const cancellation = new AbortController();
  let idle = false;
  let cleanupFailure: string | undefined;
  let receiptFailure: string | undefined;
  let lastPhase: CliPhase[] = [];
  let deadline = performance.now() + 15_000;
  const active = new Map<string, number>();
  let seen = 0;
  let cancelledPhase: string | undefined;
  let failure: string | undefined;
  let failedBytes: Buffer | undefined;
  let owned: unknown;
  const identities = new Map<string, { pid: number; identity: string; pgid: number }>();
  let residualInstaller: { pid: number; counter: string } | undefined;
  let cleanupState: import('./verification.js').OwnedProcessState | undefined;
  let traceFaultInjected = false;
  let unreadableSince: number | undefined;
  const readPhases = (): CliPhase[] => {
    const value: unknown = JSON.parse(
      privateFiles.assertPrivateFile(tracePath, { maxBytes: 64 * 1024 }).toString('utf8'),
    );
    assert.ok(Array.isArray(value) && value.length <= 64, 'CLI phase count exceeded its bound');
    let previous = -1;
    for (const item of value as unknown[]) {
      assert.ok(
        item !== null && typeof item === 'object' && Object.keys(item).length === 3,
        'CLI phase entry is invalid',
      );
      const entry = item as Partial<CliPhase>;
      assert.ok(
        typeof entry.phase === 'string' &&
          entry.phase.length <= 64 &&
          ['start', 'end', 'settled', 'pending'].includes(entry.event ?? '') &&
          typeof entry.atMs === 'number' &&
          Number.isFinite(entry.atMs) &&
          entry.atMs >= 0 &&
          entry.atMs >= previous,
        'CLI phase entry is invalid',
      );
      previous = entry.atMs;
    }
    const phases = value as CliPhase[];
    assert.ok(
      phases.length >= lastPhase.length &&
        lastPhase.every((entry, index) => {
          const current = phases[index]!;
          return current.phase === entry.phase && current.event === entry.event && current.atMs === entry.atMs;
        }),
      'CLI phase history changed after observation',
    );
    return phases;
  };
  const save = (): void => {
    try {
      writeFileSync(join(root, 'ownership.json'), JSON.stringify({ idle, owned, cleanupFailure, receiptFailure }), {
        mode: 0o600,
      });
    } catch (error) {
      receiptFailure = error instanceof Error ? error.message : String(error);
      cancellation.abort();
    }
  };
  const watch = setInterval(() => {
    try {
      if (existsSync(tracePath)) {
        const phases = readPhases();
        unreadableSince = undefined;
        lastPhase = phases;
        for (const entry of phases.slice(seen)) {
          if (entry.event === 'start')
            active.set(
              entry.phase,
              performance.now() + (scenario === 'unfinished' && entry.phase === 'runtime:stage' ? 30_000 : 15_000),
            );
          else if (entry.event === 'end' || entry.event === 'settled') active.delete(entry.phase);
        }
        if (phases.length > seen) deadline = performance.now() + 15_000;
        seen = phases.length;
        if (traceFault !== undefined && traceFault !== 'write' && !traceFaultInjected) {
          const fixtureRoot = readdirSync(root).find((name) => name.startsWith('ai-delivery-setup-'));
          const marker = fixtureRoot === undefined ? undefined : join(root, fixtureRoot, 'installer-running');
          if (marker !== undefined && existsSync(marker)) {
            assert.equal(readFileSync(join(dirname(marker), 'installs'), 'utf8'), 'x');
            traceFaultInjected = true;
            if (traceFault === 'missing') rmSync(tracePath);
            else if (traceFault === 'oversized') {
              writeFileSync(tracePath, Buffer.alloc(64 * 1024 + 1, 32));
              sharedOutputRead.path = tracePath;
            } else writeFileSync(tracePath, JSON.stringify(Array.from({ length: 65 }, () => phases[0])));
          }
        }
      } else if (seen > 0) throw new Error('CLI phase evidence disappeared after observation');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Atomic replacement can race an identity-bound read. Retry only that bounded observation,
      // while operation deadlines continue to run; missing, oversized or invalid history fails immediately.
      const changing =
        /identity changed before its bounded read|truncated during its bounded read|bytes are missing, corrupt or changed during its bounded read/u.test(
          message,
        );
      if (changing) unreadableSince ??= performance.now();
      if (!changing || performance.now() - unreadableSince! >= 1_000) {
        receiptFailure ??= message;
        cancellation.abort();
      }
    }
    const overdue = [...active].find(([, limit]) => performance.now() >= limit);
    if (overdue !== undefined || (active.size === 0 && performance.now() >= deadline)) {
      cancelledPhase ??= overdue?.[0] ?? (seen === 0 ? 'bootstrap' : 'native-drain');
      cancellation.abort();
    }
  }, 50);
  try {
    const output = await runStageCommand(
      process.cwd(),
      [
        process.execPath,
        join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
        'run',
        'dist/setup.test.js',
        '-t',
        `^${stageAdmitCase}$`,
      ],
      cancellation.signal,
      undefined,
      // This bounded synthetic case uses the fixture floor, not a local host's 100 GiB reserve.
      { maxAggregateRssBytes: 3 * 1024 ** 3, minFreeDiskBytes: 256 * 1024 ** 2 },
      undefined,
      undefined,
      {
        starting: () => {
          idle = false;
          save();
        },
        observed: (state) => {
          cleanupState = { ...state, tracked: new Map(state.tracked) };
          for (const member of state.tracked.values()) {
            if (identities.size >= 512 && !identities.has(`${member.pid}:${member.identity}`)) {
              receiptFailure ??= 'CLI ownership observation count exceeded its bound';
              cancellation.abort();
              break;
            }
            identities.set(`${member.pid}:${member.identity}`, {
              pid: member.pid,
              identity: member.identity,
              pgid: member.pgid,
            });
          }
          owned = {
            rootPid: state.rootPid,
            rootIdentity: state.rootIdentity,
            sampled: state.sampled,
            tracked: [...identities.values()],
          };
          save();
        },
        idle: () => {
          idle = true;
          save();
        },
        assertQuiescent: () => assert.ok(idle && cleanupFailure === undefined),
      },
      {
        environment: {
          ...process.env,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          AI_DELIVERY_STAGE_ADMIT_CHILD: tracePath,
          AI_DELIVERY_STAGE_ADMIT_SCENARIO: scenario,
          AI_DELIVERY_STAGE_ADMIT_TRACE_FAULT: traceFault ?? '',
        },
        maxCapturedOutputBytes: 32 * 1024 ** 2,
        includeControllerTree: true,
        failedOutput: (bytes) => {
          failedBytes = bytes;
          if (bytes.includes(Buffer.from('SETUP_CLI_TRACE_WRITE_FAULT_WITH_PENDING'))) traceFaultInjected = true;
          if (bytes.includes(Buffer.from('SETUP_CLI_TRACE_FAILURE'))) receiptFailure ??= 'Child CLI phase write failed';
          return ` CLI case output ${digestBytes(bytes)} (${bytes.length} bytes).`;
        },
        onCleanupFailure: (reason) => {
          cleanupFailure = reason;
          save();
        },
      },
    );
    if (output.includes(Buffer.from('SETUP_CLI_TRACE_FAILURE'))) receiptFailure ??= 'Child CLI phase write failed';
    process.stdout.write(output);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (failedBytes !== undefined) process.stdout.write(failedBytes);
  } finally {
    clearInterval(watch);
    try {
      lastPhase = readPhases();
    } catch (error) {
      receiptFailure ??= error instanceof Error ? error.message : String(error);
    }
    if (idle && cleanupFailure === undefined) {
      try {
        for (const name of readdirSync(root).filter((name) => name.startsWith('ai-delivery-setup-'))) {
          const base = join(root, name);
          const marker = join(base, 'installer-running');
          if (existsSync(marker)) {
            assert.ok(lstatSync(marker).size <= 64 && lstatSync(join(base, 'installs')).size <= 64);
            residualInstaller = {
              pid: Number(readFileSync(marker, 'utf8')),
              counter: readFileSync(join(base, 'installs'), 'utf8'),
            };
          }
        }
      } catch (error) {
        receiptFailure ??= error instanceof Error ? error.message : String(error);
      }
    }
    process.stdout.write(
      'SETUP_CLI_PHASE_RECEIPT ' +
        JSON.stringify({
          scenario,
          traceFault,
          traceFaultInjected,
          phases: lastPhase,
          nativeIdle: idle,
          cancelledPhase,
          failure,
          cleanupFailure,
          receiptFailure,
          owned,
          root,
          residualInstaller,
        }) +
        '\n',
    );
  }
  if (!idle || cleanupFailure !== undefined || receiptFailure !== undefined)
    throw Object.assign(new Error(`CLI case ownership unresolved; preserve ${root}`), {
      root,
      nativeIdle: idle,
      cleanupState,
      receiptFailure,
      residualInstaller,
      retainedPhaseCount: lastPhase.length,
      traceFaultInjected,
      restoredGlobalsWithPending: failedBytes?.includes(Buffer.from('SETUP_CLI_ENV_RESTORED_WITH_PENDING')) ?? false,
    });
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, 'Owned CLI case root was not removed');
  return {
    phases: lastPhase,
    nativeIdle: idle,
    cancelledPhase,
    failure,
    rootRemoved: true,
    residualInstaller,
    identities: [...identities.values()],
    installerFailureReported: failedBytes?.includes(Buffer.from('exit 7')) ?? false,
  };
}

test(
  stageAdmitCase,
  async () => {
    const tracePath = process.env.AI_DELIVERY_STAGE_ADMIT_CHILD;
    if (tracePath === undefined) {
      const result = await observeStageAdmitCase();
      assert.equal(result.failure, undefined);
      return;
    }
    const scenario = process.env.AI_DELIVERY_STAGE_ADMIT_SCENARIO as CliScenario;
    const traceFault = process.env.AI_DELIVERY_STAGE_ADMIT_TRACE_FAULT as CliTraceFault;
    const phases: CliPhase[] = [];
    let activeCommands = 0;
    let traceFailure: Error | undefined;
    const phase = (name: string, event: CliPhase['event']): void => {
      if (traceFailure !== undefined) return;
      try {
        assert.ok(phases.length < 64, 'CLI phase count exceeded its bound');
        phases.push({ phase: name, event, atMs: performance.now() });
        if (traceFault === 'write' && name === 'import:runtime:stage' && event === 'end') {
          assert.ok(activeCommands > 0, 'Trace write fault requires an actually pending CLI command');
          process.stderr.write('SETUP_CLI_TRACE_WRITE_FAULT_WITH_PENDING\n');
          rmSync(tracePath);
          mkdirSync(tracePath);
        }
        atomicJson.writePrivateJsonFileAtomically(tracePath, phases);
      } catch (error) {
        traceFailure = error instanceof Error ? error : new Error(String(error));
        try {
          process.stderr.write('SETUP_CLI_TRACE_FAILURE\n');
        } catch {
          /* The parent also validates the retained trace. */
        }
      }
    };
    phase('preparation', 'start');
    if (scenario === 'budget') await new Promise((resolve) => setTimeout(resolve, 12_000));
    const f = await fixture();
    if (scenario === 'unfinished') writeFileSync(join(f.base, 'wait'), '');
    if (scenario === 'installer-failure') writeFileSync(join(f.base, 'fail'), '');
    phase('preparation', 'end');
    const argv = process.argv;
    const exitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, 'write');
    const pending: Promise<unknown>[] = [];
    const restoreAuthorObservations: (() => void)[] = [];
    const restoreEnvs = vi.unstubAllEnvs.bind(vi);
    const environmentProbe =
      traceFault === 'write'
        ? vi.spyOn(vi, 'unstubAllEnvs').mockImplementation(() => {
            if (activeCommands > 0) process.stderr.write('SETUP_CLI_ENV_RESTORED_WITH_PENDING\n');
            return restoreEnvs();
          })
        : undefined;
    try {
      const runCli = async (args: string[]): Promise<Record<string, unknown>> => {
        const begin = stdout.mock.calls.length;
        let settled = false;
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
        if (args[0] === 'runtime:admit') {
          const clientsModule = await import('./github/client.js');
          const create = clientsModule.createDeliveryGitHubClients;
          let authorChecks = 0;
          const clients = vi
            .spyOn(clientsModule, 'createDeliveryGitHubClients')
            .mockImplementation(async (...input) => {
              const client = await create(...input);
              const authenticatedAuthor = client.authenticatedAuthor;
              if (authenticatedAuthor !== undefined) {
                client.authenticatedAuthor = async (...request) => {
                  const name = `admit:author:${++authorChecks}${actors.pauseAuthor ? ':delayed' : ''}`;
                  phase(name, 'start');
                  try {
                    assert.ok(
                      scenario !== 'budget' || authorChecks === 1 || !actors.pauseAuthor,
                      'Budget fixture repeated its deliberate HTTP delay at another required authority check',
                    );
                    const response = await authenticatedAuthor(...request);
                    // This fictional HTTP port can withhold its response; the actual CLI parse remains pending.
                    if (scenario === 'admission-stall') await new Promise<void>(() => {});
                    return response;
                  } finally {
                    // The budget regression needs one four-second response, not one per required recheck.
                    if (scenario === 'budget') actors.pauseAuthor = false;
                    phase(name, 'end');
                  }
                };
              }
              return client;
            });
          restoreAuthorObservations.push(() => clients.mockRestore());
        }
        const { Command } = await import('commander');
        const descriptor = Object.getOwnPropertyDescriptor(Command.prototype, 'parseAsync');
        assert.equal(typeof descriptor?.value, 'function', 'Commander parse operation is unavailable');
        const parse = descriptor!.value as typeof Command.prototype.parseAsync;
        let command: Promise<import('commander').Command> | undefined;
        let observation: Promise<void> | undefined;
        const observe = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (
          this: import('commander').Command,
          ...input
        ) {
          phase(args[0]!, 'start');
          if (traceFailure !== undefined) throw traceFailure;
          const operation = parse.apply(this, input);
          activeCommands++;
          command = operation;
          observation = operation.then(
            () => {
              activeCommands--;
              settled = true;
              phase(args[0]!, 'settled');
            },
            () => {
              activeCommands--;
              settled = true;
              phase(args[0]!, 'settled');
            },
          );
          pending.push(operation, observation);
          // Retain observer failures for the explicit join without an interim unhandled rejection.
          void observation.catch(() => {});
          return operation;
        });
        try {
          phase(`import:${args[0]!}`, 'start');
          if (traceFailure !== undefined) throw traceFailure;
          await import('./cli.js');
          phase(`import:${args[0]!}`, 'end');
        } finally {
          observe.mockRestore();
        }
        assert.ok(command, 'CLI import did not start its actual parse operation');
        await command;
        await observation;
        if (traceFailure !== undefined) throw traceFailure;
        for (let i = 0; i < 300; i++) {
          const output = stdout.mock.calls
            .slice(begin)
            .map(([bytes]) => String(bytes))
            .find((bytes) => bytes.startsWith('{'));
          if (output) {
            phase(`return:${args[0]!}`, settled ? 'end' : 'pending');
            return JSON.parse(output) as Record<string, unknown>;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        phase(`return:${args[0]!}`, settled ? 'end' : 'pending');
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
      phase('assertions:stageId', 'start');
      assert.equal(typeof staged.stageId, 'string');
      phase('assertions:stageId', 'end');
      const authorCallsBeforeAdmission = actors.authorCalls;
      if (scenario === 'budget') actors.pauseAuthor = true;
      const admitted = await runCli([
        'runtime:admit',
        '--authorize-admit',
        '--stage-id',
        String(staged.stageId),
        '--expected-absent',
        ...common,
      ]);
      phase('assertions', 'start');
      assert.equal(
        actors.authorCalls - authorCallsBeforeAdmission,
        3,
        'Admission must authenticate at its initial, locked and final controller checks',
      );
      assert.equal((admitted.admission as RuntimeAdmission).sourceCommit, f.input.expectedSourceCommit);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      assert.equal(process.exitCode, exitCode);
      phase('assertions', 'end');
    } finally {
      phase('drain', 'start');
      await Promise.allSettled(pending);
      for (const restore of restoreAuthorObservations) restore();
      environmentProbe?.mockRestore();
      phase('drain', 'end');
      phase('cleanup', 'start');
      stdout.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
      f.cleanup();
      phase('cleanup', 'end');
    }
    if (traceFailure !== undefined) throw traceFailure;
  },
  // The parent supervises bootstrap, each overlapping phase, and native drain independently.
  // Cancellation may terminate this isolated process; it never proves JavaScript settlement.
  0,
);

test('CLI stage/admit preparation and commands retain separate finite budgets', async () => {
  const result = await observeStageAdmitCase('budget');
  const authorChecks = result.phases.filter(
    (entry) => entry.phase.startsWith('admit:author:') && entry.event === 'start',
  );
  assert.equal(authorChecks.length, 3, 'All three admission authority checks must execute');
  assert.equal(
    authorChecks.filter((entry) => entry.phase.endsWith(':delayed')).length,
    1,
    'The aggregate-budget regression must inject one delayed HTTP response, not repeat it for every authority check',
  );
  assert.equal(result.failure, undefined, 'A CLI operation failed; inspect the retained phase and ownership evidence');
  assert.ok(result.phases.at(-1)!.atMs - result.phases[0]!.atMs > 15_000);
  for (const entry of result.phases.filter((entry) => entry.event === 'start')) {
    const end = result.phases.find(
      (candidate) => candidate.phase === entry.phase && ['end', 'settled'].includes(candidate.event),
    );
    assert.ok(
      end !== undefined && end.atMs - entry.atMs < 15_000,
      `${entry.phase} did not complete within its own bound`,
    );
  }
});

test('CLI stage/admit keeps an unfinished real installer owned until native quiescence', async () => {
  const result = await observeStageAdmitCase('unfinished');
  assert.ok(result.failure !== undefined && result.nativeIdle && result.rootRemoved);
  assert.equal(result.residualInstaller?.counter, 'x', 'A real installer must execute exactly once');
  assert.ok(
    result.identities.some((member) => member.pid === result.residualInstaller?.pid),
    'Installer birth identity was not observed by the native supervisor',
  );
  assert.equal(
    result.phases.some((entry) => entry.event === 'pending'),
    false,
    'CLI caller relinquished an unfinished command',
  );
  assert.equal(result.cancelledPhase, 'runtime:stage');
  assert.equal(
    result.phases.some((entry) => entry.phase === 'cleanup'),
    false,
    'Child cleaned a fixture with active work',
  );
});

test('CLI stage/admit joins a failed real installer before restoring its fixture', async () => {
  const result = await observeStageAdmitCase('installer-failure');
  assert.ok(result.failure !== undefined && result.nativeIdle && result.rootRemoved);
  assert.equal(result.installerFailureReported, true, 'The real installer failure was not reported');
  const settled = result.phases.findIndex((entry) => entry.phase === 'runtime:stage' && entry.event === 'settled');
  const cleanup = result.phases.findIndex((entry) => entry.phase === 'cleanup' && entry.event === 'start');
  assert.ok(settled >= 0 && cleanup > settled, 'Failure cleanup preceded actual command settlement');
  assert.equal(
    result.phases.some((entry) => entry.phase === 'runtime:admit'),
    false,
  );
});

test('CLI stage/admit keeps a stalled admission response owned until native quiescence', async () => {
  const result = await observeStageAdmitCase('admission-stall');
  assert.ok(result.failure !== undefined && result.nativeIdle && result.rootRemoved);
  assert.equal(result.cancelledPhase, 'runtime:admit');
  assert.ok(result.phases.some((entry) => entry.phase === 'runtime:stage' && entry.event === 'settled'));
  assert.ok(result.phases.some((entry) => entry.phase === 'admit:author:1' && entry.event === 'start'));
  assert.equal(
    result.phases.some(
      (entry) =>
        entry.phase === 'cleanup' ||
        entry.phase === 'return:runtime:admit' ||
        (entry.phase === 'admit:author:1' && entry.event === 'end'),
    ),
    false,
    'The stalled HTTP response must keep the original command pending until native cancellation',
  );
});

test.each(['missing', 'oversized', 'records', 'write'] as const)(
  'CLI stage/admit preserves owned recovery evidence when its trace fails: %s',
  async (fault) => {
    let failure: CliCaseFailure | undefined;
    sharedOutputRead.unboundedReads = 0;
    try {
      try {
        await observeStageAdmitCase('unfinished', fault);
      } catch (error) {
        assert.ok(error instanceof Error);
        failure = error as CliCaseFailure;
      }
      assert.ok(failure?.receiptFailure, 'Unavailable phase evidence was accepted');
      assert.equal(failure.nativeIdle, true);
      assert.equal(failure.traceFaultInjected, true, 'The real pending CLI trace fault did not execute');
      assert.equal(existsSync(failure.root), true, 'Untrusted phase evidence was discarded before recovery');
      assert.ok(failure.retainedPhaseCount <= 64, 'Invalid final trace replaced validated bounded evidence');
      assert.equal(sharedOutputRead.unboundedReads, 0, 'Failure handling attempted an unbounded final trace read');
      assert.equal(failure.restoredGlobalsWithPending, false, 'Trace failure bypassed the actual command join');
      if (fault !== 'write') assert.equal(failure.residualInstaller?.counter, 'x');
    } finally {
      sharedOutputRead.path = '';
      if (failure?.nativeIdle && failure.cleanupState !== undefined) {
        const recorded = JSON.parse(
          privateFiles
            .assertPrivateFile(join(failure.root, 'ownership.json'), { maxBytes: 256 * 1024 })
            .toString('utf8'),
        ) as { idle: boolean; owned: { rootPid: number } };
        assert.equal(recorded.idle, true);
        assert.equal(recorded.owned.rootPid, failure.cleanupState.rootPid);
        const { confirmOwnedCleanup } = await import('./verification.js');
        await confirmOwnedCleanup(failure.cleanupState);
        rmSync(failure.root, { recursive: true, force: true });
        assert.equal(existsSync(failure.root), false);
        process.stdout.write(
          `SETUP_CLI_TRACE_RECOVERY ${JSON.stringify({ fault, root: failure.root, quiescenceRechecked: true, removed: true })}\n`,
        );
      }
      sharedOutputRead.unboundedReads = 0;
    }
  },
);

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
