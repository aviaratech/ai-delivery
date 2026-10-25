import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import { loadDeliveryConfig } from '../config/deliveryConfig.js';
import { digestBytes } from '../delivery/index.js';
import { syntheticDiscoveryClients, syntheticOverrides, syntheticDiscoveryConfig } from './discovery.js';
import type { RuntimeAdmission } from '../services/deliveryAdmission.js';

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
const retirementFailure = vi.hoisted(() => ({ directory: '', error: undefined as Error | undefined, hits: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    rmdirSync: (...args: Parameters<typeof actual.rmdirSync>) => {
      const result = actual.rmdirSync(...args);
      const path = String(args[0]);
      if (
        retirementFailure.error !== undefined &&
        dirname(dirname(path)) === retirementFailure.directory &&
        /^[a-f0-9]{64}[/\\][a-f0-9-]{36}$/u.test(path.slice(retirementFailure.directory.length + 1))
      ) {
        retirementFailure.hits++;
        const error = retirementFailure.error;
        retirementFailure.error = undefined;
        throw error;
      }
      return result;
    },
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
  authorDelayMs: 4_000,
}));
// Only GitHub HTTP/authentication is synthetic. Resolver, process ownership and file operations are real.
vi.mock('../github/client.js', async (original) => ({
  ...(await original<typeof import('../github/client.js')>()),
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
          const response = setTimeout(resolve, actors.authorDelayMs);
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
  const modulePath = new URL('../setup.js', import.meta.url).href;
  const result = (await import(modulePath).catch(() => ({}))) as Partial<Producer>;
  assert.equal(typeof result.stageRuntime, 'function', 'supported producer stage API is missing');
  assert.equal(typeof result.admitRuntime, 'function', 'supported producer admission API is missing');
  return result as Producer;
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
async function fixture(native = false, parent = tmpdir()) {
  actors.author = 'host-user';
  actors.reviewer = 'reviewer[bot]';
  actors.access = true;
  actors.projectId = 'PROJECT-1';
  actors.authorCalls = 0;
  actors.reviewerCalls = 0;
  actors.authorStarted = false;
  actors.authorAborted = false;
  actors.pauseAuthor = false;
  actors.authorDelayMs = 4_000;
  const base = realpathSync(mkdtempSync(join(parent, 'ai-delivery-setup-')));
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
    `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),path=require('path');\nconst args=process.argv.slice(2);\nif(args[0]!=='install'||!['--omit=dev','--ignore-scripts','--no-audit','--no-fund'].every(x=>args.includes(x)))process.exit(9);\nfs.appendFileSync(${JSON.stringify(counter)},'x');\nfs.writeFileSync(${JSON.stringify(marker)},String(process.pid));\nconst prefix=args[args.indexOf('--prefix')+1],archive=args.at(-1);\nfs.writeFileSync(${JSON.stringify(join(base, 'installer-settings'))},JSON.stringify({args,cwd:process.cwd(),TMPDIR:process.env.TMPDIR,TMP:process.env.TMP,TEMP:process.env.TEMP}));\nfs.writeFileSync(${JSON.stringify(join(base, 'installer-archive'))},archive);\nconst original=${JSON.stringify(archivePath)},replacement=${JSON.stringify(join(base, 'replacement.tgz'))};\nconst saved=fs.existsSync(replacement)?fs.readFileSync(original):undefined;\nif(saved)fs.copyFileSync(replacement,original);\nconst target=path.join(prefix,'node_modules/@aviaratech/ai-delivery');fs.mkdirSync(target,{recursive:true});\ntry{cp.execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',target]);}finally{if(saved)fs.writeFileSync(original,saved);}\nconst dependency={'@aviaratech/ai-delivery':'file:reviewed-archive.tgz'};fs.writeFileSync(path.join(prefix,'package.json'),JSON.stringify({dependencies:dependency}));\nif(!args.includes('--package-lock=false')){const targetPackage=JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')),integrity='sha512-'+require('node:crypto').createHash('sha512').update(fs.readFileSync(archive)).digest('base64');fs.writeFileSync(path.join(prefix,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:dependency},'node_modules/@aviaratech/ai-delivery':{version:targetPackage.version,resolved:'file:reviewed-archive.tgz',integrity}}}));}\nfs.mkdirSync(path.join(prefix,'node_modules/.bin'),{recursive:true});\nfs.symlinkSync('../@aviaratech/ai-delivery/dist/cli.js',path.join(prefix,'node_modules/.bin/ai-delivery'));\nconst logs=${JSON.stringify(join(base, 'log-bytes'))};\nif(fs.existsSync(logs))process.stdout.write(Buffer.alloc(Number(fs.readFileSync(logs,'utf8')),65),()=>{if(fs.existsSync(${JSON.stringify(join(base, 'fail'))}))process.exit(7);});\nelse if(fs.existsSync(${JSON.stringify(join(base, 'fail'))}))process.exit(7);\nconst memory=${JSON.stringify(join(base, 'memory-bytes'))};\nif(fs.existsSync(memory)){globalThis.fixtureAllocation=Buffer.alloc(Number(fs.readFileSync(memory,'utf8')),1);setInterval(()=>{},1000);}\nif(fs.existsSync(${JSON.stringify(join(base, 'wait'))}))setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(base, 'wait-noise'))})){fs.appendFileSync(${JSON.stringify(join(base, 'noise-writes'))},'x');process.stdout.write('pending installer heartbeat\\n');}},1000);\n`,
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
    cleanup: (retainFiles = false) => {
      process.env.PATH = previousPath;
      if (!retainFiles) rmSync(base, { recursive: true, force: true });
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

export { producer, fixture, git, admitInput, beginControllerObservation };
export type { SetupInput, Stage };
export const runtimeSetupState = { actors, controllerObservation, syncFailure, sharedOutputRead, retirementFailure };
