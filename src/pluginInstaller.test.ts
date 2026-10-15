import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as atomicJson from './utils/atomicJson.js';
import { processSnapshot, retainedWorktreeTransitionProducerDigest } from './verification.js';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';

type ObservedState = {
  pending: { targetVersion: string | null; command: { phase: string; tracked: { pid: number }[] } };
};

const fixture = vi.hoisted(() => ({
  home: '',
  commands: [] as string[],
  commandArguments: [] as string[][],
  realCommands: false,
  responses: [] as (string | ((args: string[]) => string))[],
  respond: undefined as ((args: string[]) => string | undefined) | undefined,
  packArchive: '',
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...parameters: Parameters<typeof actual.spawn>) => {
      if (fixture.realCommands) return actual.spawn(...parameters);
      const [binary, args] = parameters;
      fixture.commands.push(binary === '/bin/sh' ? args![3]! : binary);
      const commandArguments = binary === '/bin/sh' ? args!.slice(3) : [binary, ...(args ?? [])];
      fixture.commandArguments.push(commandArguments);
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      const queued = fixture.responses.shift() ?? fixture.respond;
      let response = typeof queued === 'function' ? queued(commandArguments) : queued;
      if (binary === '/bin/sh' && args?.[3] === 'npm' && fixture.packArchive) {
        const destination = args[args.indexOf('--pack-destination') + 1]!;
        const filename = 'aviaratech-ai-delivery-0.3.22.tgz';
        writeFileSync(join(destination, filename), readFileSync(fixture.packArchive), { mode: 0o600 });
        response = JSON.stringify([{ filename }]);
      }
      queueMicrotask(() => {
        if (response === undefined) {
          child.emit('error', new Error('Native fixture intentionally unavailable.'));
          child.emit('close', 1, null);
        } else {
          child.stdout.emit('data', Buffer.from(response));
          child.emit('close', 0, null);
        }
      });
      return child;
    },
  };
});
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => fixture.home,
}));
const { managePlugin } = await import('./pluginInstaller.js');

test('preview observes a Codex registration candidate without executing or changing its settings', async () => {
  const profile = join(fixture.home, '.codex');
  mkdirSync(profile);
  const config = join(profile, 'config.toml');
  const bytes = '[mcp_servers."ai-delivery"]\ncommand = "unknown-launcher"\nsecret = "fictional-private-value"\n';
  writeFileSync(config, bytes);
  const result = await managePlugin({ ...input(), action: 'preview', version: undefined });
  const report = Reflect.get(result, 'diagnostics');
  assert.ok(report);
  assert.equal(report.migration, 'refused');
  assert.equal(report.completeness, 'incomplete');
  assert.deepEqual(report.registrations, [
    { kind: 'standalone', scope: 'user', ownership: 'unknown', source: 'unknown', version: null, enabled: null },
  ]);
  assert.equal(JSON.stringify(result).includes('fictional-private-value'), false);
  assert.equal(JSON.stringify(result).includes('unknown-launcher'), false);
  assert.equal(readFileSync(config, 'utf8'), bytes);
  assert.deepEqual(fixture.commands, []);
  assert.equal(existsSync(join(fixture.home, '.cache')), false);
});

test('preview preserves Claude local/project/user registrations and permission preferences', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  const user = join(fixture.home, '.claude.json');
  const project = join(fixture.home, '.mcp.json');
  const settings = join(fixture.home, '.claude', 'settings.json');
  mkdirSync(dirname(settings));
  writeFileSync(
    user,
    JSON.stringify({
      mcpServers: { 'ai-delivery': { command: 'unknown-user' } },
      projects: {
        [fixture.home]: { mcpServers: { 'ai-delivery': { command: 'unknown-local' } } },
      },
    }),
  );
  writeFileSync(project, JSON.stringify({ mcpServers: { 'ai-delivery': { command: 'unknown-project' } } }));
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['mcp__ai-delivery__issue_info'] } }));
  const before = [user, project, settings].map((path) => readFileSync(path));
  const result = await managePlugin({ action: 'preview', host: 'claude-code', scope: 'user', repoRoot: fixture.home });
  assert.ok(result.diagnostics);
  assert.deepEqual(
    result.diagnostics.registrations.map((entry) => entry.scope),
    ['local', 'project', 'user'],
  );
  assert.equal(result.diagnostics.migration, 'refused');
  assert.deepEqual(
    [user, project, settings].map((path) => readFileSync(path)),
    before,
  );
  assert.deepEqual(fixture.commands, []);
  assert.equal(existsSync(join(fixture.home, '.cache')), false);
});

test('doctor reports an external native marketplace plugin without adopting or starting it', async () => {
  fixture.responses.push(
    JSON.stringify({
      installed: [
        {
          pluginId: 'ai-delivery@external-market',
          name: 'ai-delivery',
          marketplaceName: 'external-market',
          version: '0.3.24',
          enabled: true,
          source: { source: 'git', url: 'https://example.test/unknown' },
        },
      ],
      available: [],
    }),
  );
  const result = await managePlugin({ ...input(), action: 'doctor', version: undefined });
  assert.equal(result.installed, false);
  assert.ok(result.diagnostics);
  assert.ok(result.activation);
  assert.deepEqual(result.diagnostics.registrations, [
    { kind: 'plugin', scope: 'user', ownership: 'external', source: 'unknown', version: '0.3.24', enabled: true },
  ]);
  assert.equal(result.activation.loadedVersion, null);
  assert.equal(result.sourceIntegrity, undefined);
  assert.equal(result.mcp, undefined);
  assert.equal(existsSync(join(fixture.home, '.cache')), false);
});

test('preview refuses incomplete oversized configuration without writes or native calls', async () => {
  const profile = join(fixture.home, '.codex');
  mkdirSync(profile);
  const config = join(profile, 'config.toml');
  const bytes = '#'.repeat(1024 * 1024 + 1);
  writeFileSync(config, bytes);
  const result = await managePlugin({ ...input(), action: 'preview', version: undefined });
  assert.ok(result.diagnostics);
  assert.equal(result.diagnostics.migration, 'refused');
  assert.ok(result.diagnostics.findings.includes('configuration_unavailable'));
  assert.equal(readFileSync(config, 'utf8'), bytes);
  assert.deepEqual(fixture.commands, []);
  assert.equal(existsSync(join(fixture.home, '.cache')), false);
});

test('doctor retains distinct external marketplace observations with identical reported versions', async () => {
  doctorFixture(false);
  const selected = (JSON.parse(fixture.responses[0] as string) as { installed: Record<string, unknown>[] })
    .installed[0];
  fixture.responses.push(
    JSON.stringify({
      installed: [
        selected,
        { pluginId: 'ai-delivery@external-one', version: '0.3.24', enabled: true },
        { pluginId: 'ai-delivery@external-two', version: '0.3.24', enabled: true },
      ],
      available: [],
    }),
  );
  const result = await managePlugin({ ...input(), action: 'doctor', version: undefined });
  assert.ok(result.diagnostics);
  assert.equal(result.diagnostics.registrations.filter((entry) => entry.ownership === 'external').length, 2);
  assert.equal(result.diagnostics.nativeInventory, 'observed');
});

test('doctor observes external installations after retained managed removal without adopting them', async () => {
  mkdirSync(join(fixture.home, '.codex'));
  const statePath = writeState({ ...pendingState('remove', null), pending: undefined });
  const before = readFileSync(statePath);
  fixture.responses.push(
    JSON.stringify({
      installed: [{ pluginId: 'ai-delivery@external-market', version: '0.3.24', enabled: true }],
      available: [],
    }),
  );
  const result = await managePlugin({ ...input(), action: 'doctor', version: undefined });
  assert.ok(result.diagnostics);
  assert.deepEqual(result.diagnostics.registrations, [
    { kind: 'plugin', scope: 'user', ownership: 'external', source: 'unknown', version: '0.3.24', enabled: true },
  ]);
  assert.equal(result.installed, false);
  assert.equal(result.sourceIntegrity, undefined);
  assert.equal(result.mcp, undefined);
  assert.deepEqual(result.activation, { installedVersion: null, startupVersion: null, loadedVersion: null });
  assert.deepEqual(readFileSync(statePath), before);
  assert.deepEqual(fixture.commandArguments, [['codex', 'plugin', 'list', '--json']]);
});

test('compiled preview never invokes native tools or creates installer state', () => {
  const profile = join(fixture.home, '.codex');
  const bin = join(fixture.home, 'bin');
  const marker = join(fixture.home, 'native-called');
  mkdirSync(profile);
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf called > '${marker}'\n`, { mode: 0o755 });
  writeFileSync(join(profile, 'config.toml'), '[mcp_servers.ai-delivery]\ncommand="untrusted"\n');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const stdout = execFileSync(process.execPath, [cli, 'plugin', 'preview', '--host', 'codex', '--json'], {
    cwd: fixture.home,
    env: { ...process.env, HOME: fixture.home, CODEX_HOME: profile, PATH: bin },
    encoding: 'utf8',
  });
  const result = JSON.parse(stdout) as Awaited<ReturnType<typeof managePlugin>>;
  assert.ok(result.diagnostics);
  assert.equal(result.action, 'preview');
  assert.equal(result.diagnostics.migration, 'refused');
  assert.deepEqual(result.diagnostics.plannedChanges, []);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(fixture.home, '.cache')), false);
});

test('preview refuses a symlinked configuration without following its target', async () => {
  const profile = join(fixture.home, '.codex');
  const target = join(fixture.home, 'protected.pem');
  mkdirSync(profile);
  writeFileSync(target, '[mcp_servers.ai-delivery]\nsecret="fictional-sensitive-content"\n');
  symlinkSync(target, join(profile, 'config.toml'));
  const result = await managePlugin({ ...input(), action: 'preview', version: undefined });
  assert.ok(result.diagnostics);
  assert.ok(result.diagnostics.findings.includes('configuration_unavailable'));
  assert.deepEqual(result.diagnostics.registrations, []);
  assert.equal(JSON.stringify(result).includes('fictional-sensitive-content'), false);
  assert.deepEqual(fixture.commands, []);
  assert.equal(existsSync(join(fixture.home, '.cache')), false);
});

test.each(['codex', 'claude-code'])('preview refuses a FIFO configuration without blocking in %s', (host) => {
  const profile = join(fixture.home, '.codex');
  mkdirSync(profile);
  const config = host === 'codex' ? join(profile, 'config.toml') : join(fixture.home, '.mcp.json');
  execFileSync('/usr/bin/mkfifo', [config]);
  const metadata = lstatSync(config);
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  // Bound only the known FIFO-open stall and reap this test-owned child.
  const child = spawnSync(process.execPath, [cli, 'plugin', 'preview', '--host', host, '--json'], {
    cwd: fixture.home,
    env: { ...process.env, HOME: fixture.home, CODEX_HOME: profile },
    encoding: 'utf8',
    timeout: 3000,
    killSignal: 'SIGKILL',
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout) as Awaited<ReturnType<typeof managePlugin>>;
  assert.ok(result.diagnostics);
  assert.ok(result.diagnostics.findings.includes('configuration_unavailable'));
  assert.deepEqual(result.diagnostics.registrations, []);
  assert.equal(lstatSync(config).ino, metadata.ino);
  assert.equal(existsSync(join(fixture.home, '.cache')), false);
});

test.each(['migrate', 'apply', 'retire', 'restore-settings'])(
  'unsupported %s never enables host mutation',
  async (action) => {
    await assert.rejects(managePlugin({ ...input(), action, version: undefined }));
    assert.deepEqual(fixture.commands, []);
    assert.deepEqual(readdirSync(fixture.home), []);
  },
);

beforeEach(() => {
  fixture.home = mkdtempSync(join(tmpdir(), 'ai-delivery-installer-'));
  vi.stubEnv('CODEX_HOME', join(fixture.home, '.codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(fixture.home, '.claude'));
  fixture.commands = [];
  fixture.commandArguments = [];
  fixture.realCommands = false;
  fixture.responses = [];
  fixture.respond = undefined;
  fixture.packArchive = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixture.home, { recursive: true, force: true });
  for (const args of fixture.commandArguments)
    if (args[1] === 'plugin' && args[2] === 'list')
      assert.deepEqual(
        args,
        args[0] === 'codex' && args.includes('--marketplace')
          ? ['codex', 'plugin', 'list', '--marketplace', 'ai-delivery-user', '--available', '--json']
          : args[0] === 'codex'
            ? ['codex', 'plugin', 'list', '--json']
            : ['claude', 'plugin', 'list', '--json'],
      );
});

function pendingState(action: string, version: string | null) {
  return {
    owner: '@aviaratech/ai-delivery.plugin@1',
    host: 'codex',
    scope: 'user',
    projectRoot: null,
    nativeHome: join(fixture.home, '.codex'),
    marketplace: 'ai-delivery-user',
    currentVersion: null,
    previousVersion: null,
    installedPath: null,
    pending: {
      action,
      targetVersion: version,
      producerDigest: retainedWorktreeTransitionProducerDigest(dirname(fileURLToPath(import.meta.url))),
      owner: { pid: 2_000_000_000, birth: 'old owner' },
      command: { phase: 'idle' },
    },
  };
}
function writeState(value: unknown, host = 'codex'): string {
  const directory = join(fixture.home, '.cache/ai-delivery/plugins', host, 'user');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json');
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

function doctorFixture(enabled: boolean, host = 'codex') {
  const version = '0.3.21',
    catalog = join(fixture.home, '.cache/ai-delivery/plugins', host, 'user/marketplace');
  const unit = join(catalog, 'versions', version),
    source = join(unit, 'plugins/ai-delivery');
  const nativeHome = join(fixture.home, host === 'codex' ? '.codex' : '.claude');
  const cache = join(nativeHome, 'plugins/cache/ai-delivery-user/ai-delivery', version);
  const files = { 'mcp.json': '{"ai-delivery":{"command":"node"}}', 'skills/intake/SKILL.md': 'owned skill bytes' };
  for (const root of [source, cache])
    for (const [name, bytes] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600 });
    }
  const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(unit, 'archive.tgz'), 'captured archive', { mode: 0o600 });
  writeFileSync(
    join(unit, 'version.json'),
    JSON.stringify({
      owner: '@aviaratech/ai-delivery.plugin-version@1',
      version,
      archiveSha256: hash('captured archive'),
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])),
    }),
    { mode: 0o600 },
  );
  writeState(
    {
      ...pendingState('install', version),
      host,
      nativeHome,
      pending: undefined,
      currentVersion: version,
      installedPath: cache,
    },
    host,
  );
  for (const [relative, content] of [
    [
      '.agents/plugins/marketplace.json',
      {
        name: 'ai-delivery-user',
        interface: { displayName: 'ai-delivery' },
        plugins: [
          {
            name: 'ai-delivery',
            source: { source: 'local', path: `./versions/${version}/plugins/ai-delivery` },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      },
    ],
    [
      '.claude-plugin/marketplace.json',
      {
        name: 'ai-delivery-user',
        owner: { name: 'AviaraTech' },
        plugins: [{ name: 'ai-delivery', source: `./versions/${version}/plugins/ai-delivery`, version }],
      },
    ],
  ] as const) {
    const path = join(catalog, relative);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(content), { mode: 0o600 });
  }
  if (host === 'codex') {
    fixture.responses.push(
      JSON.stringify({
        installed: [
          {
            pluginId: 'ai-delivery@ai-delivery-user',
            marketplaceName: 'ai-delivery-user',
            version,
            enabled,
            source: { source: 'local', path: source },
            marketplaceSource: { sourceType: 'local', source: catalog },
          },
        ],
        available: [],
      }),
    );
  } else {
    const path = join(nativeHome, 'plugins/known_marketplaces.json');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      JSON.stringify({
        'ai-delivery-user': { source: { source: 'directory', path: catalog }, installLocation: catalog },
      }),
      { mode: 0o600 },
    );
    fixture.responses.push(
      JSON.stringify([
        {
          id: 'ai-delivery@ai-delivery-user',
          version,
          scope: 'user',
          enabled,
          installPath: cache,
          mcpServers: { 'ai-delivery': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp-launcher.js'] } },
        },
      ]),
    );
  }
  return cache;
}

function nativeArchiveFixture(): void {
  const root = join(fixture.home, 'synthetic-package'),
    version = '0.3.22';
  const files = {
    'package.json': JSON.stringify({ name: '@aviaratech/ai-delivery', version }),
    'plugins/ai-delivery/plugin.json': JSON.stringify({ name: 'ai-delivery', version }),
    'plugins/ai-delivery/.claude-plugin/plugin.json': JSON.stringify({
      name: 'ai-delivery',
      version,
      packageVersion: version,
      deliveryCapabilityVersion: 2,
    }),
    'plugins/ai-delivery/runtime/package.json': JSON.stringify({ name: '@aviaratech/ai-delivery', version }),
    'plugins/ai-delivery/runtime/dist/cli.js': `process.stdout.write('${version}\\n');`,
    'plugins/ai-delivery/skills/intake/SKILL.md': 'synthetic released skill bytes',
  };
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  }
  const configuration = join(fixture.home, 'empty.npmrc'),
    globalConfiguration = join(fixture.home, 'global.npmrc');
  writeFileSync(configuration, '', { mode: 0o600 });
  writeFileSync(globalConfiguration, '', { mode: 0o600 });
  const packed = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--logs-max',
        '0',
        '--cache',
        join(fixture.home, 'npm-cache'),
        '--userconfig',
        configuration,
        '--globalconfig',
        globalConfiguration,
        '--pack-destination',
        fixture.home,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  ) as { filename: string }[];
  fixture.packArchive = join(fixture.home, packed[0]!.filename);
}

function oversizedCatalogue(entries: Record<string, unknown>[]): (args: string[]) => string {
  const filtered = JSON.stringify({ installed: entries, available: [] });
  const unfiltered = JSON.stringify({
    installed: entries,
    available: [{ pluginId: 'unrelated@remote', description: 'x'.repeat(1024 * 1024) }],
  });
  assert.ok(Buffer.byteLength(unfiltered) > 1024 * 1024);
  assert.ok(Buffer.byteLength(filtered) < 1024 * 1024);
  return (args) => (args[args.indexOf('--marketplace') + 1] === 'ai-delivery-user' ? filtered : unfiltered);
}

function installationFixture(
  action: 'install' | 'update',
  readback: (entry: Record<string, unknown>) => Record<string, unknown>[] = (entry) => [entry],
) {
  let previous: Record<string, unknown>[] = [];
  if (action === 'update') {
    doctorFixture(true);
    const response = fixture.responses.shift();
    assert.ok(typeof response === 'string');
    previous = (JSON.parse(response) as { installed: Record<string, unknown>[] }).installed;
  }
  nativeArchiveFixture();
  const catalog = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/marketplace'),
    source = join(catalog, 'versions/0.3.22/plugins/ai-delivery'),
    cache = join(fixture.home, '.codex/plugins/cache/ai-delivery-user/ai-delivery/0.3.22');
  const entry = {
    pluginId: 'ai-delivery@ai-delivery-user',
    marketplaceName: 'ai-delivery-user',
    version: '0.3.22',
    enabled: true,
    source: { source: 'local', path: source },
    marketplaceSource: { sourceType: 'local', source: catalog },
  };
  fixture.responses.push(
    'codex-cli 0.162.1',
    oversizedCatalogue(previous),
    '',
    '0.3.22',
    ...(action === 'install' ? ['{}'] : []),
    (args) => {
      assert.deepEqual(args, ['codex', 'plugin', 'add', 'ai-delivery@ai-delivery-user', '--json']);
      mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
      cpSync(source, cache, { recursive: true });
      return JSON.stringify({ installedPath: cache });
    },
    oversizedCatalogue(readback(entry)),
  );
  return { entry, cache, catalog, source };
}

function replacementFixture(preferences: unknown = { issue_info: { approval: 'fictional-explicit-allow' } }) {
  const { entry, cache, catalog } = installationFixture('update');
  fixture.responses = [];
  const selector = 'ai-delivery@ai-delivery-user';
  const policy: Record<string, unknown> = {
    [selector]: { enabled: true, preferences },
    'private-unrelated@other': { sentinel: 'fictional-private-value', enabled: false },
  };
  const before = structuredClone(policy);
  const native = {
    selected: [
      {
        ...entry,
        version: '0.3.21',
        source: { source: 'local', path: join(catalog, 'versions/0.3.21/plugins/ai-delivery') },
      },
    ],
    version: 'codex-cli 0.162.1',
    selectionCalls: 0,
    loseAck: false,
    failSelection: false,
  };
  fixture.respond = (args) => {
    if (args[0] === 'npm') return '';
    if (args[0] === process.execPath) return '0.3.22';
    if (args[1] === '--version') return native.version;
    if (args[2] === 'list') return JSON.stringify({ installed: native.selected, available: [] });
    if (args[2] === 'marketplace') return '{}';
    if (args[2] === 'remove') {
      // Pinned Codex remove clears the complete qualified plugin table.
      delete policy[selector];
      native.selected = [];
      return '{}';
    }
    if (args[2] === 'add') {
      assert.deepEqual(args, ['codex', 'plugin', 'add', selector, '--json']);
      native.selectionCalls++;
      if (native.failSelection) return undefined;
      // Pinned add retains existing fields but can evict older native caches.
      policy[selector] = { ...(policy[selector] as object | undefined), enabled: true };
      const offered = JSON.parse(readFileSync(join(catalog, '.agents/plugins/marketplace.json'), 'utf8')) as {
        plugins: { source: { path: string } }[];
      };
      const offeredPath = offered.plugins[0]!.source.path;
      const version = /^\.\/versions\/([^/]+)\/plugins\/ai-delivery$/u.exec(offeredPath)![1]!;
      const selectedCache = join(dirname(cache), version);
      mkdirSync(dirname(selectedCache), { recursive: true, mode: 0o700 });
      cpSync(join(catalog, offeredPath), selectedCache, { recursive: true });
      for (const old of readdirSync(dirname(cache)))
        if (old !== version) rmSync(join(dirname(cache), old), { recursive: true });
      native.selected = [{ ...entry, version, source: { source: 'local', path: join(catalog, offeredPath) } }];
      return native.loseAck ? undefined : JSON.stringify({ installedPath: selectedCache });
    }
    return undefined;
  };
  return { catalog, policy, before, native };
}

test.each([
  { issue_info: { approval: 'fictional-explicit-allow' }, unknown: { nested: ['retain', null] } },
  { unknown: { nested: ['retain', null] } },
  { issue_info: null, unknown: { nested: ['retain', null] } },
])(
  'managed replacement preserves fictional tool preferences %j without clearing the plugin entry',
  async (preferences) => {
    const { policy, before } = replacementFixture(preferences);
    const result = await managePlugin({ ...input(), action: 'update', version: '0.3.22' });
    assert.equal(result.version, '0.3.22');
    assert.deepEqual(policy, before);
    assert.equal(
      fixture.commandArguments.some((args) => ['remove', 'uninstall'].includes(args[2] ?? '')),
      false,
    );
  },
);

test('installing a different owned version cannot bypass the preserving replacement path', async () => {
  const { policy, before } = replacementFixture();
  await managePlugin({ ...input(), action: 'install', version: '0.3.22' });
  assert.deepEqual(policy, before);
  assert.equal(
    fixture.commandArguments.some((args) => args[2] === 'remove'),
    false,
  );
});

test('an exact same-version owned selection is reused without invoking native add', async () => {
  const { native } = replacementFixture();
  const result = await managePlugin({ ...input(), action: 'update', version: '0.3.21' });
  assert.equal(result.changed, false);
  assert.equal(native.selectionCalls, 0);
});

test.each([
  'disabled',
  'missing selection',
  'unregistered catalog',
  'foreign source',
  'changed cache',
  'changed catalog',
  'catalog symlink',
  'read-only catalog',
  'unqualified native',
  'unqualified newer native',
])('replacement refuses %s before preparing a new version', async (fault) => {
  const { native, catalog, policy, before } = replacementFixture();
  if (fault === 'disabled') native.selected[0]!.enabled = false;
  if (fault === 'missing selection') native.selected = [];
  if (fault === 'unregistered catalog')
    native.selected[0]!.marketplaceSource.source = join(fixture.home, 'foreign-marketplace');
  if (fault === 'foreign source') native.selected[0]!.source.path = join(fixture.home, 'unowned');
  if (fault === 'changed cache')
    writeFileSync(
      join(fixture.home, '.codex/plugins/cache/ai-delivery-user/ai-delivery/0.3.21/skills/intake/SKILL.md'),
      'changed',
    );
  if (fault === 'changed catalog') writeFileSync(join(catalog, '.agents/plugins/marketplace.json'), '{}');
  const unrelatedCatalog = join(fixture.home, 'unrelated-catalog');
  if (fault === 'catalog symlink') {
    writeFileSync(unrelatedCatalog, 'unrelated catalog sentinel');
    rmSync(join(catalog, '.agents/plugins/marketplace.json'));
    symlinkSync(unrelatedCatalog, join(catalog, '.agents/plugins/marketplace.json'));
  }
  if (fault === 'read-only catalog') chmodSync(join(catalog, '.agents/plugins/marketplace.json'), 0o400);
  if (fault === 'unqualified native') native.version = 'codex-cli 0.153.0';
  if (fault === 'unqualified newer native') native.version = 'codex-cli 0.162.2';
  await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }));
  assert.equal(native.selectionCalls, 0);
  assert.equal(existsSync(join(catalog, 'versions/0.3.22')), false);
  assert.deepEqual(policy, before);
  if (fault === 'catalog symlink') assert.equal(readFileSync(unrelatedCatalog, 'utf8'), 'unrelated catalog sentinel');
});

test.each(['update', 'install', 'rollback'])(
  'Claude owned %s refuses unqualified preservation before catalog or selection changes',
  async (action) => {
    doctorFixture(true, 'claude-code');
    fixture.responses.unshift('2.1.296', '--keep-data');
    const catalog = join(fixture.home, '.cache/ai-delivery/plugins/claude-code/user/marketplace');
    if (action === 'rollback') {
      const path = join(dirname(catalog), 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8')) as { previousVersion: string | null };
      state.previousVersion = '0.3.20';
      writeState(state, 'claude-code');
    }
    const paths = ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'].map((name) =>
      join(catalog, name),
    );
    const before = paths.map((path) => readFileSync(path));
    await assert.rejects(
      managePlugin({ ...input(), host: 'claude-code', action, version: action === 'rollback' ? undefined : '0.3.22' }),
      /preserv.*unqualified/iu,
    );
    assert.deepEqual(
      paths.map((path) => readFileSync(path)),
      before,
    );
    assert.equal(
      fixture.commandArguments.some(
        (args) => ['update', 'install', 'uninstall'].includes(args[2] ?? '') && !args.includes('--help'),
      ),
      false,
    );
  },
);

test('lost native acknowledgement remains a failure, then exact target postimage resumes without selecting twice', async () => {
  const { native, policy, before, catalog } = replacementFixture();
  native.loseAck = true;
  await assert.rejects(
    managePlugin({ ...input(), action: 'update', version: '0.3.22' }),
    /Native fixture intentionally unavailable/u,
  );
  assert.deepEqual(policy, before);
  const path = join(dirname(catalog), 'state.json');
  const interrupted = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof pendingState>;
  assert.equal(interrupted.currentVersion, '0.3.21');
  assert.equal(interrupted.pending.targetVersion, '0.3.22');
  interrupted.pending.owner = { pid: 2_000_000_000, birth: 'old owner' };
  writeState(interrupted);
  native.loseAck = false;
  const result = await managePlugin({ ...input(), action: 'update', version: '0.3.22' });
  assert.equal(result.version, '0.3.22');
  assert.equal(native.selectionCalls, 1);
  assert.deepEqual(policy, before);
  const finished = JSON.parse(readFileSync(path, 'utf8')) as {
    currentVersion: string;
    previousVersion: string;
    pending?: unknown;
  };
  assert.equal(finished.currentVersion, '0.3.22');
  assert.equal(finished.previousVersion, '0.3.21');
  assert.equal(finished.pending, undefined);
});

test('a target catalog with prior native selection and an idle pending command refuses ambiguous replay', async () => {
  const { native, catalog } = replacementFixture();
  native.failSelection = true;
  await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }));
  const path = join(dirname(catalog), 'state.json');
  const interrupted = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof pendingState>;
  interrupted.pending.owner = { pid: 2_000_000_000, birth: 'old owner' };
  writeState(interrupted);
  native.failSelection = false;
  await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }), /ambiguous/u);
  assert.equal(native.selectionCalls, 1);
  assert.equal(
    (JSON.parse(readFileSync(path, 'utf8')) as { pending: { targetVersion: string } }).pending.targetVersion,
    '0.3.22',
  );
});

test('recovery rejects a corrupted completed unit before reusing the selected target', async () => {
  const { native, catalog } = replacementFixture();
  native.loseAck = true;
  await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }));
  const statePath = join(dirname(catalog), 'state.json');
  const pending = JSON.parse(readFileSync(statePath, 'utf8')) as ReturnType<typeof pendingState>;
  pending.pending.owner = { pid: 2_000_000_000, birth: 'terminated selected owner' };
  writeState(pending);
  const archive = join(catalog, 'versions/0.3.22/archive.tgz');
  writeFileSync(archive, 'corrupted completed archive');
  native.loseAck = false;
  await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }));
  assert.equal(native.selectionCalls, 1);
  assert.equal(readFileSync(archive, 'utf8'), 'corrupted completed archive');
  assert.ok((JSON.parse(readFileSync(statePath, 'utf8')) as { pending?: unknown }).pending);
});

test('qualified Codex rollback uses the retained immutable unit and preserves later unrelated edits', async () => {
  const { native, catalog, policy, before } = replacementFixture();
  await managePlugin({ ...input(), action: 'update', version: '0.3.22' });
  assert.equal(existsSync(join(fixture.home, '.codex/plugins/cache/ai-delivery-user/ai-delivery/0.3.21')), false);
  assert.equal(existsSync(join(catalog, 'versions/0.3.21/version.json')), true);
  policy.later = { sentinel: 'keep later edit' };
  const rolled = await managePlugin({ ...input(), action: 'rollback', version: undefined });
  assert.equal(rolled.version, '0.3.21');
  assert.equal(native.selectionCalls, 2);
  assert.deepEqual(policy, { ...before, later: { sentinel: 'keep later edit' } });
});

test('rollback of a removed managed selection refuses rather than reinstalling it', async () => {
  const { catalog, native, policy } = replacementFixture();
  const path = join(dirname(catalog), 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    currentVersion: string | null;
    previousVersion: string | null;
    installedPath: string | null;
  };
  state.currentVersion = null;
  state.previousVersion = '0.3.21';
  state.installedPath = null;
  writeState(state);
  native.selected = [];
  delete policy['ai-delivery@ai-delivery-user'];
  const before = structuredClone(policy);
  await assert.rejects(
    managePlugin({ ...input(), action: 'rollback', version: undefined }),
    /current managed selection/u,
  );
  assert.deepEqual(fixture.commandArguments, []);
  assert.deepEqual(policy, before);
});

test('rollback refuses a target superseded by the managed writer ahead of its lock', async () => {
  const { catalog, native } = replacementFixture();
  const path = join(dirname(catalog), 'state.json');
  const initial = JSON.parse(readFileSync(path, 'utf8')) as { previousVersion: string | null };
  initial.previousVersion = '0.3.20';
  writeState(initial);
  const respond = fixture.respond!;
  let queuedRollback: Promise<unknown> | undefined;
  fixture.respond = (args) => {
    const output = respond(args);
    if (args[2] === 'list' && native.selected[0]?.version === '0.3.22' && !queuedRollback)
      queuedRollback = managePlugin({ ...input(), action: 'rollback', version: undefined }).then(
        () => undefined,
        (error: unknown) => error,
      );
    return output;
  };
  await managePlugin({ ...input(), action: 'update', version: '0.3.22' });
  assert.ok(queuedRollback);
  const error = await queuedRollback;
  assert.ok(error instanceof Error);
  assert.match(error.message, /rollback target changed before/u);
  assert.equal(native.selectionCalls, 1);
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { currentVersion: string }).currentVersion, '0.3.22');
});

test('a partial catalog publication resumes with reused units and matches an uninterrupted update', async () => {
  const first = replacementFixture();
  await managePlugin({ ...input(), action: 'update', version: '0.3.22' });
  const statePath = join(dirname(first.catalog), 'state.json');
  const uninterrupted: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
  const { catalog, native, policy, before } = replacementFixture();
  const immutableArchive = join(catalog, 'versions/0.3.22/archive.tgz');
  const archiveBefore = readFileSync(immutableArchive);
  const actual = atomicJson.writePrivateJsonFileAtomically;
  let interrupt = true;
  vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
    if (interrupt && path === join(catalog, '.claude-plugin/marketplace.json')) {
      interrupt = false;
      throw new Error('Synthetic catalog publication interruption');
    }
    actual(path, value);
  });
  await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }), /publication interruption/u);
  assert.equal(native.selectionCalls, 0);
  assert.equal(
    (
      JSON.parse(readFileSync(join(catalog, '.claude-plugin/marketplace.json'), 'utf8')) as {
        plugins: { version: string }[];
      }
    ).plugins[0]!.version,
    '0.3.21',
  );
  assert.match(readFileSync(join(catalog, '.agents/plugins/marketplace.json'), 'utf8'), /versions\/0\.3\.22/u);
  const pending = JSON.parse(readFileSync(statePath, 'utf8')) as ReturnType<typeof pendingState>;
  pending.pending.owner = { pid: 2_000_000_000, birth: 'terminated publication owner' };
  writeState(pending);
  fixture.commands = [];
  await managePlugin({ ...input(), action: 'update', version: '0.3.22' });
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), uninterrupted);
  assert.deepEqual(readFileSync(immutableArchive), archiveBefore);
  assert.equal(fixture.commands.includes('npm'), false);
  assert.equal(native.selectionCalls, 1);
  assert.deepEqual(policy, before);
});

test('a failed managed-state commit retains selection and resumes without selecting again', async () => {
  const { native, catalog, policy, before } = replacementFixture();
  const actual = atomicJson.writePrivateJsonFileAtomically;
  const fault = vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
    const state = value as { currentVersion?: string; pending?: unknown };
    if (path.endsWith('/state.json') && state.currentVersion === '0.3.22' && !state.pending)
      throw new Error('Synthetic final state commit failure');
    actual(path, value);
  });
  await assert.rejects(
    managePlugin({ ...input(), action: 'update', version: '0.3.22' }),
    /final state commit failure/u,
  );
  fault.mockRestore();
  const path = join(dirname(catalog), 'state.json');
  const pending = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof pendingState>;
  pending.pending.owner = { pid: 2_000_000_000, birth: 'terminated commit owner' };
  writeState(pending);
  await managePlugin({ ...input(), action: 'update', version: '0.3.22' });
  assert.equal(native.selectionCalls, 1);
  assert.deepEqual(policy, before);
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { pending?: unknown }).pending, undefined);
});

test.each(['bytes', 'mode'])(
  'managed state %s changed by another writer is not overwritten after native selection',
  async (change) => {
    const { catalog, native } = replacementFixture();
    const respond = fixture.respond!;
    const path = join(dirname(catalog), 'state.json');
    let changed: Buffer | undefined;
    fixture.respond = (args) => {
      const output = respond(args);
      if (args[2] === 'add') {
        if (change === 'mode') chmodSync(path, 0o400);
        else {
          const state = JSON.parse(readFileSync(path, 'utf8')) as { previousVersion: string };
          state.previousVersion = '0.3.19';
          writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
        }
        changed = readFileSync(path);
      }
      return output;
    };
    await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }), /Managed state changed/u);
    assert.equal(native.selectionCalls, 1);
    assert.ok(changed);
    assert.deepEqual(readFileSync(path), changed);
    if (change === 'mode') assert.equal(lstatSync(path).mode & 0o777, 0o400);
  },
);

test('catalog custody changed during preparation refuses before selection without repairing it', async () => {
  const { catalog, native, policy, before } = replacementFixture();
  const respond = fixture.respond!;
  const path = join(catalog, '.agents/plugins/marketplace.json');
  fixture.respond = (args) => {
    const output = respond(args);
    if (args[0] === process.execPath) chmodSync(path, 0o644);
    return output;
  };
  await assert.rejects(managePlugin({ ...input(), action: 'update', version: '0.3.22' }), /catalog.*changed/u);
  assert.equal(native.selectionCalls, 0);
  assert.equal(lstatSync(path).mode & 0o777, 0o644);
  assert.deepEqual(policy, before);
});

for (const action of ['install', 'update'] as const)
  test(`${action} reads back its managed version without capturing an unrelated catalogue over 1 MiB`, async () => {
    const { entry, cache, catalog } = installationFixture(action);
    const data = join(fixture.home, 'unrelated-native-data');
    writeFileSync(data, 'preserve native data');
    const result = await managePlugin({ ...input(), action, version: '0.3.22' });
    assert.equal(result.installed, true);
    assert.equal(result.changed, true);
    assert.equal(result.version, '0.3.22');
    assert.equal(result.nativePluginRoot, cache);
    assert.equal(readFileSync(join(cache, 'skills/intake/SKILL.md'), 'utf8'), 'synthetic released skill bytes');
    const state = JSON.parse(readFileSync(join(dirname(catalog), 'state.json'), 'utf8')) as {
      pending?: unknown;
      currentVersion: string;
      previousVersion: string | null;
    };
    assert.equal(state.pending, undefined);
    assert.equal(state.currentVersion, '0.3.22');
    assert.equal(state.previousVersion, action === 'update' ? '0.3.21' : null);
    const mutation = fixture.commandArguments.find(
      (args) => args[2] === (action === 'install' ? 'marketplace' : 'add'),
    );
    assert.deepEqual(
      mutation,
      action === 'install'
        ? ['codex', 'plugin', 'marketplace', 'add', catalog, '--json']
        : ['codex', 'plugin', 'add', 'ai-delivery@ai-delivery-user', '--json'],
    );
    assert.equal(
      fixture.commandArguments.some((args) => args[2] === 'remove'),
      false,
    );
    fixture.responses.push(oversizedCatalogue([{ ...entry, enabled: false }]));
    const doctor = await managePlugin({ ...input(), action: 'doctor', version: undefined });
    assert.equal(doctor.installed, true);
    assert.equal(doctor.sourceIntegrity, true);
    assert.deepEqual(doctor.mcp, { configuration: 'disabled', startup: 'not_checked' });
    assert.equal(readFileSync(data, 'utf8'), 'preserve native data');
    assert.equal(fixture.commandArguments.filter((args) => args[2] === 'list').length, 4);
  });

test('the filtered managed catalogue still enforces the 1 MiB capture ceiling', async () => {
  doctorFixture(false);
  fixture.responses[0] = JSON.stringify({ installed: [], available: [{ description: 'x'.repeat(1024 * 1024) }] });
  await assert.rejects(
    managePlugin({ ...input(), action: 'doctor', version: undefined }),
    /captured output exceeded 1048576 bytes/u,
  );
});

for (const [name, readback, error] of [
  [
    'missing registration',
    (entry: Record<string, unknown>) => [{ ...entry, marketplaceName: 'unrelated' }],
    /registration is missing/u,
  ],
  [
    'wrong marketplace source',
    (entry: Record<string, unknown>) => [
      { ...entry, marketplaceSource: { sourceType: 'local', source: join(fixture.home, 'unmanaged') } },
    ],
    /unmanaged source/u,
  ],
  [
    'wrong version source',
    (entry: Record<string, unknown>) => [
      { ...entry, source: { source: 'local', path: join(fixture.home, 'unmanaged') } },
    ],
    /source differs/u,
  ],
  ['duplicate native selection', (entry: Record<string, unknown>) => [entry, entry], /ambiguous/u],
  [
    'disabled native selection',
    (entry: Record<string, unknown>) => [{ ...entry, enabled: false }],
    /selection is disabled/u,
  ],
] as const)
  test(`filtered installation refuses ${name} and retains its interrupted intent`, async () => {
    const { catalog } = installationFixture('install', readback);
    await assert.rejects(managePlugin({ ...input(), version: '0.3.22' }), error);
    const state = JSON.parse(readFileSync(join(dirname(catalog), 'state.json'), 'utf8')) as {
      currentVersion: string | null;
      pending: { targetVersion: string };
    };
    assert.equal(state.currentVersion, null);
    assert.equal(state.pending.targetVersion, '0.3.22');
  });

test('filtered readback refuses changed native bytes without adopting the selected version', async () => {
  const { cache, catalog } = installationFixture('install');
  const add = fixture.responses[5]!;
  assert.ok(typeof add === 'function');
  fixture.responses[5] = (args) => {
    const result = add(args);
    writeFileSync(join(cache, 'skills/intake/SKILL.md'), 'unexpected native bytes');
    return result;
  };
  await assert.rejects(managePlugin({ ...input(), version: '0.3.22' }), /native plugin bytes/u);
  const state = JSON.parse(readFileSync(join(dirname(catalog), 'state.json'), 'utf8')) as {
    currentVersion: null;
    pending: unknown;
  };
  assert.equal(state.currentVersion, null);
  assert.ok(state.pending);
  assert.equal(readFileSync(join(cache, 'skills/intake/SKILL.md'), 'utf8'), 'unexpected native bytes');
});

test('interrupted filtered readback resumes the original install without fetching or losing native data', async () => {
  const { entry, cache, catalog } = installationFixture('install');
  fixture.responses.pop();
  await assert.rejects(managePlugin({ ...input(), version: '0.3.22' }), /Native fixture intentionally unavailable/u);
  const statePath = join(dirname(catalog), 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { pending: { owner: { pid: number; birth: string } } };
  state.pending.owner = { pid: 2_000_000_000, birth: 'terminated fixture owner' };
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  const before = readFileSync(join(cache, 'skills/intake/SKILL.md'));
  fixture.responses.push('codex-cli 0.153.0', oversizedCatalogue([entry]), oversizedCatalogue([entry]));
  const result = await managePlugin({ ...input(), version: '0.3.22' });
  assert.equal(result.installed, true);
  assert.equal(result.version, '0.3.22');
  assert.equal((JSON.parse(readFileSync(statePath, 'utf8')) as { pending?: unknown }).pending, undefined);
  assert.deepEqual(readFileSync(join(cache, 'skills/intake/SKILL.md')), before);
  assert.equal(fixture.commands.filter((command) => command === 'npm').length, 1);
});

test('filtered inventory does not adopt a manual install even when its marketplace source matches', async () => {
  const cache = doctorFixture(true);
  const response = fixture.responses.shift()!;
  assert.ok(typeof response === 'string');
  const directory = join(fixture.home, '.cache/ai-delivery/plugins/codex/user');
  rmSync(directory, { recursive: true });
  const before = readFileSync(join(cache, 'skills/intake/SKILL.md'));
  fixture.responses.push('codex-cli 0.153.0', response);
  await assert.rejects(managePlugin(input()), /not owned by managed state/u);
  assert.deepEqual(fixture.commands, ['codex', 'codex']);
  const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')) as {
    currentVersion: null;
    installedPath: null;
    pending?: unknown;
  };
  assert.equal(state.currentVersion, null);
  assert.equal(state.installedPath, null);
  assert.equal(state.pending, undefined);
  assert.deepEqual(readFileSync(join(cache, 'skills/intake/SKILL.md')), before);
});

test('Claude doctor retains its unfiltered native inventory and disabled selection readback', async () => {
  doctorFixture(false, 'claude-code');
  const result = await managePlugin({ ...input(), host: 'claude-code', action: 'doctor', version: undefined });
  assert.equal(result.installed, true);
  assert.equal(result.enabled, false);
  assert.equal(result.sourceIntegrity, true);
  assert.deepEqual(result.mcp, { configuration: 'disabled', startup: 'not_checked' });
  assert.deepEqual(fixture.commandArguments, [['claude', 'plugin', 'list', '--json']]);
});

test('Claude doctor binds managed provenance to the verified scope and source, excluding other projects', async () => {
  doctorFixture(false, 'claude-code');
  const entries = JSON.parse(fixture.responses[0] as string) as Record<string, unknown>[];
  const selected = entries[0]!;
  entries.push(
    { ...selected, scope: 'project', projectPath: fixture.home, version: '0.3.24', installPath: '/unverified' },
    { ...selected, scope: 'local', projectPath: fixture.home, installPath: '/unverified' },
    { ...selected, scope: 'project', projectPath: join(fixture.home, 'other-project') },
    { ...selected, scope: 'local' },
  );
  fixture.responses[0] = JSON.stringify(entries);
  const result = await managePlugin({ ...input(), host: 'claude-code', action: 'doctor', version: undefined });
  assert.equal(result.sourceIntegrity, true);
  assert.ok(result.diagnostics);
  assert.deepEqual(result.diagnostics.registrations, [
    {
      kind: 'plugin',
      scope: 'user',
      ownership: 'managed',
      source: 'managed_archive',
      version: '0.3.21',
      enabled: false,
    },
    { kind: 'plugin', scope: 'project', ownership: 'external', source: 'unknown', version: '0.3.24', enabled: false },
    { kind: 'plugin', scope: 'local', ownership: 'external', source: 'unknown', version: '0.3.21', enabled: false },
    { kind: 'plugin', scope: 'local', ownership: 'external', source: 'unknown', version: '0.3.21', enabled: false },
  ]);
  assert.ok(result.diagnostics.findings.includes('native_registration_project_unverified'));
  assert.deepEqual(fixture.commandArguments, [['claude', 'plugin', 'list', '--json']]);
});

test('doctor refuses a same-version native cache with changed skill bytes before starting MCP', async () => {
  const cache = doctorFixture(true);
  writeFileSync(join(cache, 'skills/intake/SKILL.md'), 'unexpected native bytes');
  const before = readFileSync(join(cache, 'skills/intake/SKILL.md'));
  const result = await managePlugin({ ...input(), action: 'doctor', version: undefined });
  assert.equal(result.installed, true);
  assert.equal(result.sourceIntegrity, false);
  assert.equal(result.mcp?.startup, 'not_checked');
  assert.match(result.mcp?.error ?? '', /native plugin bytes/u);
  assert.deepEqual(fixture.commands, ['codex', 'codex']);
  assert.deepEqual(readFileSync(join(cache, 'skills/intake/SKILL.md')), before);
});

test('doctor reports a disabled native plugin separately and does not start its MCP server', async () => {
  doctorFixture(false);
  const result = await managePlugin({ ...input(), action: 'doctor', version: undefined });
  assert.equal(result.installed, true);
  assert.equal(result.enabled, false);
  assert.equal(result.sourceIntegrity, true);
  assert.deepEqual(result.mcp, { configuration: 'disabled', startup: 'not_checked' });
  assert.deepEqual(fixture.commands, ['codex', 'codex']);
});

test('doctor refuses a Claude catalog pointing at a different same-version source before startup', async () => {
  doctorFixture(true, 'claude-code');
  const catalog = join(fixture.home, '.cache/ai-delivery/plugins/claude-code/user/marketplace');
  const other = join(catalog, 'unexpected-source');
  mkdirSync(other, { mode: 0o700 });
  writeFileSync(join(other, 'plugin.json'), JSON.stringify({ name: 'ai-delivery', version: '0.3.21' }));
  const path = join(catalog, '.claude-plugin/marketplace.json');
  writeFileSync(
    path,
    JSON.stringify({
      name: 'ai-delivery-user',
      plugins: [{ name: 'ai-delivery', version: '0.3.21', source: './unexpected-source' }],
    }),
  );
  const before = readFileSync(path);
  const result = await managePlugin({ ...input(), host: 'claude-code', action: 'doctor', version: undefined });
  assert.equal(result.sourceIntegrity, false);
  assert.equal(result.mcp?.startup, 'not_checked');
  assert.match(result.mcp?.error ?? '', /catalog source/u);
  assert.deepEqual(fixture.commands, ['claude']);
  assert.deepEqual(readFileSync(path), before);
});

test('a different native profile cannot reconcile or overwrite the original ownership record', async () => {
  const profileA = join(fixture.home, 'profile-a'),
    profileB = join(fixture.home, 'profile-b');
  mkdirSync(profileA, { mode: 0o700 });
  const marker = join(profileA, 'plugin-selection');
  writeFileSync(marker, 'profile A stays installed');
  const value = pendingState('install', '0.3.21');
  const statePath = writeState({ ...value, pending: undefined, currentVersion: '0.3.21', nativeHome: profileA });
  const before = readFileSync(statePath);
  vi.stubEnv('CODEX_HOME', profileB);
  await assert.rejects(managePlugin({ ...input(), action: 'remove', version: undefined }), /different native profile/u);
  assert.deepEqual(fixture.commands, []);
  assert.deepEqual(readFileSync(statePath), before);
  assert.equal(readFileSync(marker, 'utf8'), 'profile A stays installed');
});

test('an absent native profile beneath a symlink keeps its identity after creation', async () => {
  const parent = join(fixture.home, 'native-profiles'),
    alias = join(fixture.home, 'native-profile-alias');
  mkdirSync(parent, { mode: 0o700 });
  symlinkSync(parent, alias);
  const profile = join(alias, 'new-profile');
  vi.stubEnv('CODEX_HOME', profile);
  await assert.rejects(managePlugin(input()), /Native fixture intentionally unavailable/u);
  const statePath = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json');
  const before = readFileSync(statePath);
  const state = JSON.parse(before.toString()) as { nativeHome: string };
  assert.equal(state.nativeHome, join(parent, 'new-profile'));
  mkdirSync(profile, { mode: 0o700 });
  const result = await managePlugin({ ...input(), action: 'doctor', version: undefined });
  assert.equal(result.recoveryRequired, false);
  assert.deepEqual(readFileSync(statePath), before);
  assert.equal(result.diagnostics?.nativeInventory, 'unavailable');
  assert.deepEqual(fixture.commands, ['codex', 'codex']);
});

test('a definitive version preparation failure preserves selection and permits a different valid request', async () => {
  const cache = doctorFixture(true);
  const response = fixture.responses[0]!;
  fixture.responses.unshift('codex-cli 0.162.1');
  const catalog = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/marketplace');
  const catalogPath = join(catalog, '.agents/plugins/marketplace.json');
  mkdirSync(dirname(catalogPath), { recursive: true, mode: 0o700 });
  const before = readFileSync(catalogPath);
  const data = join(fixture.home, 'native-data');
  writeFileSync(data, 'preserve native data');
  await assert.rejects(
    managePlugin({ ...input(), action: 'update', version: '0.3.22' }),
    /Native fixture intentionally unavailable/u,
  );
  const statePath = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    pending?: unknown;
    currentVersion: string;
    installedPath: string;
  };
  assert.equal(state.pending, undefined);
  assert.equal(state.currentVersion, '0.3.21');
  assert.equal(state.installedPath, cache);
  assert.deepEqual(readFileSync(catalogPath), before);
  assert.equal(readFileSync(data, 'utf8'), 'preserve native data');
  assert.equal(readFileSync(join(cache, 'skills/intake/SKILL.md'), 'utf8'), 'owned skill bytes');
  fixture.responses.push('codex-cli 0.162.1', response, response);
  const reused = await managePlugin({ ...input(), action: 'update', version: '0.3.21' });
  assert.equal(reused.changed, false);
  assert.equal(fixture.commands.filter((command) => command === 'npm').length, 1);
});

test('failure after catalog selection retains pending recovery before another version', async () => {
  const { native } = replacementFixture();
  native.failSelection = true;
  await assert.rejects(
    managePlugin({ ...input(), action: 'update', version: '0.3.22' }),
    /Native fixture intentionally unavailable/u,
  );
  const statePath = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    pending?: { targetVersion: string };
  };
  assert.equal(state.pending?.targetVersion, '0.3.22');
  const before = [...fixture.commandArguments];
  await assert.rejects(
    managePlugin({ ...input(), action: 'update', version: '0.3.23' }),
    /A live plugin installer still owns this target|Resume the interrupted original plugin command/u,
  );
  assert.deepEqual(fixture.commandArguments, before);
});

test('definitive preparation reports pending-state cleanup failure and preserves its recovery intent', async () => {
  const actual = atomicJson.writePrivateJsonFileAtomically;
  vi.spyOn(atomicJson, 'writePrivateJsonFileAtomically').mockImplementation((path, value) => {
    if (path.endsWith('/state.json') && !(value as { pending?: unknown }).pending)
      throw new Error('Synthetic pending-state durability failure');
    actual(path, value);
  });
  await assert.rejects(managePlugin(input()), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /pending-state cleanup also failed/u);
    assert.equal(error.errors.length, 2);
    return true;
  });
  const path = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json');
  assert.equal(
    (JSON.parse(readFileSync(path, 'utf8')) as { pending: { targetVersion: string } }).pending.targetVersion,
    '0.3.21',
  );
});

test('an unsupported version archive leaves selection intact and permits a valid version request', async () => {
  const cache = doctorFixture(true);
  const response = fixture.responses[0]!;
  fixture.responses.unshift('codex-cli 0.162.1');
  const root = join(fixture.home, 'unsupported/package');
  const files = {
    'package.json': { name: '@aviaratech/ai-delivery', version: '0.3.22' },
    'plugins/ai-delivery/plugin.json': { name: 'ai-delivery', version: '0.3.22' },
    'plugins/ai-delivery/.claude-plugin/plugin.json': {
      name: 'ai-delivery',
      version: '0.3.22',
      packageVersion: '0.3.22',
      deliveryCapabilityVersion: 1,
    },
    'plugins/ai-delivery/runtime/package.json': { name: '@aviaratech/ai-delivery', version: '0.3.22' },
  };
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  }
  const configuration = join(fixture.home, 'empty.npmrc');
  const globalConfiguration = join(fixture.home, 'global.npmrc');
  writeFileSync(configuration, '', { mode: 0o600 });
  writeFileSync(globalConfiguration, '', { mode: 0o600 });
  const packed = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--logs-max',
        '0',
        '--cache',
        join(fixture.home, 'npm-cache'),
        '--userconfig',
        configuration,
        '--globalconfig',
        globalConfiguration,
        '--pack-destination',
        fixture.home,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  ) as { filename: string }[];
  fixture.packArchive = join(fixture.home, packed[0]!.filename);
  await assert.rejects(
    managePlugin({ ...input(), action: 'update', version: '0.3.22' }),
    /coherent self-contained native plugin/u,
  );
  const statePath = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
    pending?: unknown;
    currentVersion: string;
    installedPath: string;
  };
  assert.equal(state.pending, undefined);
  assert.equal(state.currentVersion, '0.3.21');
  assert.equal(state.installedPath, cache);
  assert.equal(readFileSync(join(cache, 'skills/intake/SKILL.md'), 'utf8'), 'owned skill bytes');
  assert.equal(
    existsSync(join(fixture.home, '.cache/ai-delivery/plugins/codex/user/marketplace/versions/0.3.22')),
    false,
  );
  fixture.packArchive = '';
  fixture.responses.push('codex-cli 0.162.1', response, response);
  const reused = await managePlugin({ ...input(), action: 'update', version: '0.3.21' });
  assert.equal(reused.changed, false);
  assert.equal(fixture.commands.filter((command) => command === 'npm').length, 1);
});

test('recovery removes only its recorded incomplete staging directory', async () => {
  const version = '0.3.21',
    directory = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/marketplace/versions');
  const owned = join(directory, '.stage-11111111-1111-1111-1111-111111111111'),
    peer = join(directory, '.stage-peer');
  for (const path of [owned, peer]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(path, 'partial'), 'preserve-or-recover');
  }
  const metadata = lstatSync(owned),
    value = pendingState('install', version);
  writeState({
    ...value,
    pending: { ...value.pending, staging: { path: owned, device: metadata.dev, inode: metadata.ino } },
  });
  await assert.rejects(managePlugin(input()), /Native fixture intentionally unavailable/u);
  assert.equal(existsSync(owned), false);
  assert.equal(readFileSync(join(peer, 'partial'), 'utf8'), 'preserve-or-recover');
});

test('recovery rejects incompatible controllers without starting native commands', async () => {
  const value = pendingState('install', '0.3.21');
  writeState({ ...value, pending: { ...value.pending, producerDigest: `sha256:${'0'.repeat(64)}` } });
  await assert.rejects(managePlugin(input()), /different controller/u);
  assert.deepEqual(fixture.commands, []);
});

test('cancellation kills recorded detached descendants and preserves an unrelated process', async () => {
  fixture.realCommands = true;
  const bin = join(fixture.home, 'bin'),
    marker = join(fixture.home, 'descendant');
  mkdirSync(bin);
  const childScript =
    "require('fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  writeFileSync(
    join(bin, 'codex'),
    `#!${process.execPath}\nconst {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(childScript)},${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const preload = fixturePreload();
  const cli = spawn(
    process.execPath,
    [
      '--import',
      preload,
      join(dirname(fileURLToPath(import.meta.url)), 'cli.js'),
      '--repo-root',
      fixture.home,
      'plugin',
      'install',
      '--host',
      'codex',
      '--scope',
      'user',
      '--version',
      '0.3.21',
      '--json',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  for (const stream of [cli.stdout, cli.stderr])
    stream!.on('data', (bytes: Buffer) => {
      if (Buffer.byteLength(output) + bytes.length <= 1024 * 1024) output += bytes.toString();
    });
  const closed = new Promise<number | null>((done) => cli.once('close', (code) => done(code)));
  let descendant: number | undefined;
  try {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (cli.exitCode !== null || cli.signalCode !== null) break;
      if (existsSync(marker)) {
        descendant = Number(readFileSync(marker, 'utf8'));
        const path = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json');
        const pending = (JSON.parse(readFileSync(path, 'utf8')) as ObservedState).pending;
        if (
          pending.command.phase === 'running' &&
          pending.command.tracked.some((entry: { pid: number }) => entry.pid === descendant)
        )
          break;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.ok(descendant, `native fixture started its detached child: ${output}`);
    const state = JSON.parse(
      readFileSync(join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json'), 'utf8'),
    ) as ObservedState;
    assert.ok(
      state.pending.command.tracked.some((entry: { pid: number }) => entry.pid === descendant),
      'durable receipt captured child identity',
    );
    cli.kill('SIGTERM');
    assert.equal(await closed, 1);
    assert.match(output, /cancelled/u);
    const observed = processSnapshot().get(descendant);
    assert.ok(!observed || observed.status.startsWith('Z'));
    assert.ok(processSnapshot().has(peer.pid!));
    assert.equal(
      (
        JSON.parse(
          readFileSync(join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json'), 'utf8'),
        ) as ObservedState
      ).pending.command.phase,
      'idle',
    );
  } finally {
    cli.kill('SIGTERM');
    await closed;
    peer.kill('SIGKILL');
    await new Promise<void>((done) => {
      if (peer.exitCode !== null || peer.signalCode !== null) done();
      else peer.once('close', () => done());
    });
  }
});
const input = () => ({ action: 'install', host: 'codex', scope: 'user', version: '0.3.21', repoRoot: fixture.home });

function fixturePreload(): string {
  const path = join(fixture.home, 'home.mjs');
  writeFileSync(
    path,
    `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(fixture.home)};syncBuiltinESMExports();`,
  );
  return path;
}

test('compiled plugin CLI consumes its local version and emits the promised JSON dry-run', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      fixturePreload(),
      cli,
      '--repo-root',
      fixture.home,
      'plugin',
      'install',
      '--host',
      'codex',
      '--version',
      '0.3.21',
      '--dry-run',
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout) as { action: string; version: string; dryRun: boolean };
  assert.equal(value.action, 'install');
  assert.equal(value.version, '0.3.21');
  assert.equal(value.dryRun, true);
  assert.ok(!existsSync(join(fixture.home, '.cache')));
});

test('compiled doctor CLI requires explicit repository for auth and keeps dry-run credential-free', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const invoke = (prefix: string[], suffix: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        fixturePreload(),
        cli,
        '--repo-root',
        fixture.home,
        ...prefix,
        'plugin',
        'doctor',
        '--host',
        'codex',
        ...suffix,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
  const missing = invoke([], ['--check-auth', '--dry-run', '--json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires explicit --repo owner\/name/u);
  const selected = invoke(['--repo', 'example/widget'], ['--check-auth', '--dry-run', '--json']);
  assert.equal(selected.status, 0, selected.stderr);
  const value = JSON.parse(selected.stdout) as {
    authProbe: { settings: string; reason: string; repositoryAccess: { repository: string } };
  };
  assert.equal(value.authProbe.settings, 'not_checked');
  assert.equal(value.authProbe.reason, 'dry_run');
  assert.equal(value.authProbe.repositoryAccess.repository, 'example/widget');
  const defaultDoctor = invoke([], ['--dry-run', '--json']);
  assert.equal(defaultDoctor.status, 0, defaultDoctor.stderr);
  assert.equal((JSON.parse(defaultDoctor.stdout) as { authProbe?: unknown }).authProbe, undefined);
  assert.ok(!existsSync(join(fixture.home, '.cache')));
});

test('plugin management rejects unsupported native scopes and nonliteral versions before writing', async () => {
  for (const value of [
    { ...input(), scope: 'project' },
    { ...input(), host: 'claude-code', scope: 'managed' },
    { ...input(), version: 'latest' },
    { ...input(), version: undefined },
    { ...input(), version: '0.3.21 --ignore-scripts=false' },
  ])
    await assert.rejects(managePlugin(value));
  assert.deepEqual(readdirSync(fixture.home), []);
});

test('plugin dry-run describes the exact selected native target without creating a profile or fetching', async () => {
  const result = await managePlugin({ ...input(), dryRun: true });
  assert.equal(result.action, 'install');
  assert.equal(result.host, 'codex');
  assert.equal(result.scope, 'user');
  assert.equal(result.version, '0.3.21');
  assert.equal(result.changed, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(readdirSync(fixture.home), []);
});

test('doctor of an unconfigured host is read-only and does not claim installation or admission', async () => {
  const result = await managePlugin({ action: 'doctor', host: 'claude-code', scope: 'local', repoRoot: fixture.home });
  assert.equal(result.changed, false);
  assert.equal(result.installed, false);
  assert.equal(result.repositoryAdmission, 'explicit_stage_and_admit_required');
  assert.deepEqual(readdirSync(fixture.home), []);
});

test('remove never touches an unmanaged native selector or creates managed state', async () => {
  const result = await managePlugin({ action: 'remove', host: 'codex', scope: 'user', repoRoot: fixture.home });
  assert.equal(result.changed, false);
  assert.deepEqual(fixture.commands, []);
  assert.deepEqual(readdirSync(fixture.home), []);
});

test('initial install refuses a marketplace-name collision before fetching or changing native selection', async () => {
  const unowned = join(fixture.home, 'unowned-marketplace');
  mkdirSync(unowned);
  const marker = join(unowned, 'configuration');
  writeFileSync(marker, 'unrelated native source');
  fixture.responses.push(
    'codex-cli 0.153.0',
    JSON.stringify({
      installed: [
        {
          pluginId: 'ai-delivery@ai-delivery-user',
          marketplaceName: 'ai-delivery-user',
          version: '0.3.21',
          enabled: true,
          source: { source: 'local', path: unowned },
          marketplaceSource: { sourceType: 'local', source: unowned },
        },
      ],
      available: [],
    }),
  );
  await assert.rejects(managePlugin(input()), /unmanaged source/u);
  assert.deepEqual(fixture.commands, ['codex', 'codex']);
  assert.equal(readFileSync(marker, 'utf8'), 'unrelated native source');
});

test('an interrupted managed removal resumes its null target before invoking native commands', async () => {
  const directory = join(fixture.home, '.cache/ai-delivery/plugins/codex/user');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json');
  writeFileSync(
    path,
    JSON.stringify({
      owner: '@aviaratech/ai-delivery.plugin@1',
      host: 'codex',
      scope: 'user',
      projectRoot: null,
      nativeHome: join(fixture.home, '.codex'),
      marketplace: 'ai-delivery-user',
      currentVersion: '0.3.21',
      previousVersion: null,
      installedPath: null,
      pending: {
        action: 'remove',
        targetVersion: null,
        producerDigest: retainedWorktreeTransitionProducerDigest(dirname(fileURLToPath(import.meta.url))),
        owner: { pid: 2_000_000_000, birth: 'old owner' },
        command: { phase: 'idle' },
      },
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    managePlugin({ action: 'remove', host: 'codex', scope: 'user', repoRoot: fixture.home }),
    /Native fixture intentionally unavailable/u,
  );
  assert.deepEqual(fixture.commands, ['codex']);
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as ObservedState).pending.targetVersion, null);
});
