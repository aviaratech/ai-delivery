import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { UserDeliverySettings } from './config/deliveryConfig.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig } from './fixtures/discovery.js';

// Native selections, keys and HTTP responses below are fictional. This tests
// the selected-process contract, not a GUI or an authenticated live service.
const fixture = vi.hoisted(() => ({
  home: '',
  config: '',
  root: '',
  host: 'codex',
  enabled: true,
  mode: 'success',
  authCalls: 0,
  keyReads: 0,
  settingsReads: 0,
  commands: [] as { args: string[]; environment: Record<string, string | undefined> }[],
  requests: [] as string[],
  startupEnvironments: [] as Record<string, string>[],
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => fixture.home,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]) === fixture.config) fixture.settingsReads++;
      if (String(args[0]).endsWith('.pem')) fixture.keyReads++;
      return actual.readFileSync(...args);
    },
  };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: { env: Record<string, string> }) {
      fixture.startupEnvironments.push(options.env);
    }
    close() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect() {
      if (fixture.mode === 'startup_failed') throw new Error('fictional-upstream-secret');
    }
    getServerVersion() {
      return { version: '0.3.24' };
    }
    listTools() {
      return { tools: [] };
    }
    close() {}
  },
}));
vi.mock('./verification.js', async (original) => ({
  ...(await original<typeof import('./verification.js')>()),
  runStageCommand: (
    _root: string,
    args: string[],
    _signal: AbortSignal,
    _a: unknown,
    _b: unknown,
    _c: unknown,
    _d: unknown,
    _e: unknown,
    options: { environment: Record<string, string | undefined> },
  ) => {
    fixture.commands.push({ args, environment: options.environment });
    assert.deepEqual(
      args,
      fixture.host === 'codex'
        ? ['codex', 'plugin', 'list', '--marketplace', 'ai-delivery-user', '--available', '--json']
        : ['claude', 'plugin', 'list', '--json'],
    );
    const catalog = join(fixture.home, '.cache/ai-delivery/plugins', fixture.host, 'user/marketplace');
    const entry = { version: '0.3.24', enabled: fixture.enabled };
    return Buffer.from(
      JSON.stringify(
        fixture.host === 'codex'
          ? {
              installed: [
                {
                  ...entry,
                  pluginId: 'ai-delivery@ai-delivery-user',
                  marketplaceName: 'ai-delivery-user',
                  source: { source: 'local', path: join(catalog, 'versions/0.3.24/plugins/ai-delivery') },
                  marketplaceSource: { sourceType: 'local', source: catalog },
                },
              ],
              available: [],
            }
          : [
              {
                ...entry,
                id: 'ai-delivery@ai-delivery-user',
                scope: 'user',
                installPath: fixture.root,
                mcpServers: {
                  'ai-delivery': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/mcp-launcher.js'] },
                },
              },
            ],
      ),
    );
  },
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (
    binary: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; cwd: string; timeout: number; maxBuffer: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    assert.equal(binary, process.execPath);
    assert.deepEqual(args, [join(fixture.root, 'runtime/dist/cli.js'), '--repo', args[2], 'config:resolve']);
    assert.equal(options.timeout, 30000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    const forwarded = Object.keys(options.env).sort();
    assert.deepEqual(forwarded, [
      'AI_DELIVERY_CONFIG',
      'DELIVERY_AUTHOR_TOKEN',
      'DELIVERY_REVIEW_APP_ID',
      'DELIVERY_REVIEW_INSTALLATION_ID',
      'DELIVERY_REVIEW_KEY_PATH',
      'DISABLE_AUTOUPDATER',
      'NODE_OPTIONS',
      'PATH',
    ]);
    fixture.authCalls++;
    const run = async () => {
      if (fixture.mode === 'raw_failure') {
        callback(new Error('fictional-value-header'), 'fictional-value-body', 'fictional-value-key-path');
        return;
      }
      const ambient = process.env;
      process.env = { ...options.env };
      try {
        const { contextFor } = await import('./dispatch.js');
        const { preflightReviewRoute } = await import('./pr.js');
        const context = await contextFor({ repoRoot: options.cwd, repo: args[2]! }, 'config:resolve');
        const data = {
          routing: context.configuration!.routing,
          reviewRoute: await preflightReviewRoute(context, undefined, undefined, 'development'),
        };
        if (fixture.mode === 'wrong_repo') data.routing.repository = 'example/unselected';
        if (fixture.mode === 'same_actor') data.reviewRoute.reviewer.actorLogin = data.reviewRoute.author.actorLogin;
        if (fixture.mode === 'secret_actor') data.reviewRoute.author.actorLogin = options.env.DELIVERY_AUTHOR_TOKEN!;
        callback(
          null,
          JSON.stringify({
            ...data,
            untrustedBody: 'fictional-value-body',
            untrustedHeaders: 'fictional-value-header',
          }),
          'fictional-value-key-path',
        );
      } catch (error) {
        callback(
          new Error('Selected CLI failed'),
          '',
          `ai-delivery: ${error instanceof Error ? error.message : 'unknown'}\n`,
        );
      } finally {
        process.env = ambient;
      }
    };
    void run();
  },
}));
const { managePlugin } = await import('./pluginInstaller.js');

let settings: UserDeliverySettings;
function file(path: string, bytes: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}
function native(host = 'codex') {
  fixture.host = host;
  const directory = join(fixture.home, '.cache/ai-delivery/plugins', host, 'user');
  const catalog = join(directory, 'marketplace');
  const unit = join(catalog, 'versions/0.3.24');
  const source = join(unit, 'plugins/ai-delivery');
  const nativeHome = join(fixture.home, host === 'codex' ? '.codex' : '.claude');
  const cache = join(nativeHome, 'plugins/cache/ai-delivery-user/ai-delivery/0.3.24');
  fixture.root = host === 'codex' ? cache : source;
  const files = {
    'runtime/dist/cli.js': 'fictional selected CLI; execution simulated',
    'dist/mcp-launcher.js': 'fictional launcher',
    'skills/intake/SKILL.md': 'fictional skill',
  };
  for (const root of [source, cache]) for (const [name, bytes] of Object.entries(files)) file(join(root, name), bytes);
  const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  file(join(unit, 'archive.tgz'), 'fictional archive');
  file(
    join(unit, 'version.json'),
    JSON.stringify({
      owner: '@aviaratech/ai-delivery.plugin-version@1',
      version: '0.3.24',
      archiveSha256: hash('fictional archive'),
      files: Object.fromEntries(
        Object.entries(files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, bytes]) => [name, hash(bytes)]),
      ),
    }),
  );
  file(
    join(directory, 'state.json'),
    JSON.stringify({
      owner: '@aviaratech/ai-delivery.plugin@1',
      host,
      scope: 'user',
      projectRoot: null,
      nativeHome,
      marketplace: 'ai-delivery-user',
      currentVersion: '0.3.24',
      previousVersion: null,
      installedPath: cache,
    }),
  );
  if (host === 'claude-code') {
    file(
      join(nativeHome, 'plugins/known_marketplaces.json'),
      JSON.stringify({
        'ai-delivery-user': { source: { source: 'directory', path: catalog }, installLocation: catalog },
      }),
    );
    file(
      join(catalog, '.claude-plugin/marketplace.json'),
      JSON.stringify({
        name: 'ai-delivery-user',
        plugins: [{ name: 'ai-delivery', version: '0.3.24', source: './versions/0.3.24/plugins/ai-delivery' }],
      }),
    );
  }
}
beforeEach(() => {
  fixture.home = mkdtempSync(join(tmpdir(), 'ai-delivery-doctor-'));
  fixture.config = join(fixture.home, 'settings.json');
  fixture.enabled = true;
  fixture.mode = 'success';
  fixture.authCalls = 0;
  fixture.keyReads = 0;
  fixture.settingsReads = 0;
  fixture.commands = [];
  fixture.requests = [];
  fixture.startupEnvironments = [];
  vi.stubEnv('CODEX_HOME', join(fixture.home, '.codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(fixture.home, '.claude'));
  vi.stubEnv('AI_DELIVERY_CONFIG', fixture.config);
  settings = {
    schemaVersion: 'ai-delivery.user@1',
    roles: {
      author: { authSource: 'personal', identity: 'fixture-author', credentialEnv: { token: 'DELIVERY_AUTHOR_TOKEN' } },
      reviewer: {
        identity: 'fixture-reviewer',
        credentialEnv: {
          appId: 'DELIVERY_REVIEW_APP_ID',
          installationId: 'DELIVERY_REVIEW_INSTALLATION_ID',
          privateKeyPath: 'DELIVERY_REVIEW_KEY_PATH',
        },
      },
    },
    project: 1,
    checkoutRoots: [],
    pointsField: 'Estimate',
    priorityField: 'Urgency',
    statusField: 'Flow',
    statuses: syntheticDiscoveryConfig.native.project.statuses,
  };
  file(fixture.config, JSON.stringify(settings));
  vi.stubEnv('DELIVERY_AUTHOR_TOKEN', 'fictional-author-value');
  vi.stubEnv('DELIVERY_REVIEW_APP_ID', '654321');
  vi.stubEnv('DELIVERY_REVIEW_INSTALLATION_ID', '765432');
  const key = join(fixture.home, 'fictional-reviewer.pem');
  file(
    key,
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
  );
  vi.stubEnv('DELIVERY_REVIEW_KEY_PATH', key);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'UNRELATED_SERVICE_TOKEN', 'AI_DELIVERY_IDENTITY'])
    vi.stubEnv(name, 'fictional-unrelated-value');
  vi.stubGlobal('fetch', () => {
    throw new Error('Unexpected HTTP in a synthetic doctor fixture');
  });
  native();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(fixture.home, { recursive: true, force: true });
});
function http() {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    fixture.requests.push(`${method} ${path}`);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json', 'x-fixture-secret': 'fictional-value-header' },
      });
    if (path === '/graphql' && method === 'POST') {
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(init!.body as string) as { query: string; variables: { owner: string; repo: string } };
      assert.ok(!body.query.includes('mutation'));
      const config = { ...syntheticDiscoveryConfig, repository: `${body.variables.owner}/${body.variables.repo}` };
      return json({ data: await syntheticDiscoveryClients(config).graphql(body.query) });
    }
    if (method === 'POST' && path === '/app/installations/765432/access_tokens')
      return json({
        token: 'ghs_fictional_installation',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: { contents: 'read', pull_requests: 'write' },
      });
    assert.equal(method, 'GET');
    if (path === '/user')
      return fixture.mode === 'expired'
        ? json({ message: 'fictional-author-value' }, 401)
        : json({ id: 42, login: 'fixture-author-login' });
    if (path === '/app') return json({ id: 654321, slug: 'fixture-reviewer' });
    if (/^\/repos\/example\/(widget|service)$/u.test(path)) {
      if (fixture.mode === 'denied' && new Headers(init?.headers).get('authorization')?.includes('ghs_'))
        return json({ message: 'fictional-value-body' }, 403);
      return json({ full_name: path.slice(7), default_branch: 'main' });
    }
    if (path.endsWith('/rules/branches/main'))
      return fixture.mode === 'unknown_rules' ? json({ message: 'fictional-value-body' }, 403) : json([]);
    if (path.endsWith('/branches/main/protection'))
      return fixture.mode === 'unknown_rules' ? json({ message: 'fictional-value-body' }, 403) : json({});
    throw new Error('Unapproved endpoint in simulated doctor readback');
  });
}
function doctor(repo = 'example/widget', checkAuth = true) {
  return managePlugin({
    action: 'doctor',
    host: fixture.host,
    scope: 'user',
    repoRoot: fixture.home,
    ...(checkAuth ? { checkAuth, repo } : {}),
  });
}
test('default doctor has no settings, reference, key or authentication access; native inventory/startup exclude credentials', async () => {
  file(fixture.config, '{invalid fictional settings');
  const result = await doctor('example/widget', false);
  assert.equal(result.mcp?.startup, 'ready');
  assert.equal(result.authProbe, undefined);
  assert.equal(fixture.settingsReads, 0);
  assert.equal(fixture.keyReads, 0);
  assert.equal(fixture.authCalls, 0);
  assert.deepEqual(fixture.requests, []);
  for (const env of [...fixture.commands.map((c) => c.environment), ...fixture.startupEnvironments]) {
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.DELIVERY_AUTHOR_TOKEN, undefined);
    assert.equal(env.AI_DELIVERY_IDENTITY, undefined);
  }
});
test('auth opt-in requires an explicit valid repository, even outside Git or in dry-run', async () => {
  await assert.rejects(
    managePlugin({ action: 'doctor', host: 'codex', scope: 'user', repoRoot: fixture.home, checkAuth: true }),
    /requires explicit --repo/u,
  );
  await assert.rejects(doctor('invalid'), /Invalid string/u);
  assert.equal(fixture.commands.length, 0);
  const result = await managePlugin({
    action: 'doctor',
    host: 'codex',
    scope: 'user',
    repoRoot: fixture.home,
    checkAuth: true,
    repo: 'example/widget',
    dryRun: true,
  });
  assert.equal(result.authProbe?.reason, 'dry_run');
  assert.equal(fixture.settingsReads, 0);
});
test('invalid settings stop before reading a key or executing the authenticated child', async () => {
  file(
    fixture.config,
    JSON.stringify({
      ...settings,
      roles: { ...settings.roles, reviewer: { ...settings.roles.reviewer, identity: settings.roles.author.identity } },
    }),
  );
  const result = await doctor();
  assert.equal(result.authProbe?.settings, 'unavailable_or_invalid');
  assert.equal(fixture.keyReads, 0);
  assert.equal(fixture.authCalls, 0);
  assert.ok(!JSON.stringify(result.authProbe).includes(fixture.config));
});
test('all missing selected references gate both roles; unrelated legacy credentials cannot satisfy them', async () => {
  vi.stubEnv('DELIVERY_AUTHOR_TOKEN', '');
  vi.stubEnv('DELIVERY_REVIEW_APP_ID', '');
  const result = await doctor();
  assert.deepEqual(result.authProbe?.processReferences.missingNames, [
    'DELIVERY_AUTHOR_TOKEN',
    'DELIVERY_REVIEW_APP_ID',
  ]);
  assert.equal(result.authProbe?.authentication.status, 'not_checked');
  assert.equal(fixture.keyReads, 0);
  assert.equal(fixture.authCalls, 0);
  assert.ok(!JSON.stringify(result.authProbe).includes('fictional-unrelated-value'));
});
test('invalid App references and reserved runtime credential names stop before key/network access', async () => {
  vi.stubEnv('DELIVERY_REVIEW_INSTALLATION_ID', 'not-an-id');
  assert.equal((await doctor()).authProbe?.reason, 'invalid_references');
  vi.stubEnv('DELIVERY_REVIEW_INSTALLATION_ID', '765432');
  settings.roles.author.credentialEnv = { token: 'NODE_OPTIONS' };
  file(fixture.config, JSON.stringify(settings));
  vi.stubEnv('NODE_OPTIONS', 'fictional-runtime-value');
  assert.equal((await doctor()).authProbe?.reason, 'invalid_references');
  assert.equal(fixture.keyReads, 0);
  assert.equal(fixture.authCalls, 0);
});
test.each(['codex', 'claude-code'])(
  '%s synthetic selection outside Git probes A → B → A through existing read-only auth owners',
  async (host) => {
    native(host);
    http();
    for (const repo of ['example/widget', 'example/service', 'example/widget']) {
      const result = await doctor(repo);
      assert.equal(result.authProbe?.outcome, 'readback_complete');
      assert.deepEqual(result.authProbe?.authentication, {
        status: 'verified',
        author: { actorLogin: 'fixture-author-login', authSource: 'personal' },
        reviewer: { actorLogin: 'fixture-reviewer[bot]', authSource: 'app' },
      });
      assert.deepEqual(result.authProbe?.repositoryAccess, { repository: repo, status: 'verified' });
      assert.equal(result.authProbe?.nativeGuiPropagation, 'unverified');
      assert.equal(result.authProbe?.reviewRules?.approvalEligibility, 'unknown');
      assert.ok(!JSON.stringify(result).includes('fictional-author-value'));
      assert.ok(!JSON.stringify(result.authProbe).includes('fictional-reviewer.pem'));
    }
    assert.equal(fixture.authCalls, 3);
    assert.ok(fixture.requests.includes('POST /app/installations/765432/access_tokens'));
  },
);
test.each(['changed', 'disabled', 'startup_failed'])(
  'auth probe refuses %s selected native bytes/startup',
  async (mode) => {
    if (mode === 'changed') file(join(fixture.root, 'skills/intake/SKILL.md'), 'modified skill');
    if (mode === 'disabled') fixture.enabled = false;
    if (mode === 'startup_failed') fixture.mode = mode;
    const result = await doctor();
    assert.equal(result.authProbe?.reason, 'native_plugin_not_ready');
    assert.equal(fixture.authCalls, 0);
    assert.equal(fixture.keyReads, 0);
    assert.equal(fixture.settingsReads, 0);
    assert.ok(!JSON.stringify(result).includes('fictional-upstream-secret'));
  },
);
test.each(['expired', 'denied', 'raw_failure'])(
  'safe labelled %s failure does not reveal body/header/key-path sentinels or claim verified access',
  async (mode) => {
    fixture.mode = mode;
    http();
    const result = await doctor();
    assert.equal(result.authProbe?.outcome, 'failed');
    assert.equal(
      result.authProbe?.reason,
      mode === 'expired' ? 'authentication_failed' : mode === 'denied' ? 'repository_denied' : 'probe_failed',
    );
    assert.notEqual(result.authProbe?.authentication.status, 'verified');
    assert.notEqual(result.authProbe?.repositoryAccess.status, 'verified');
    for (const sentinel of [
      'fictional-author-value',
      'fictional-value-body',
      'fictional-value-header',
      'fictional-value-key-path',
    ])
      assert.ok(!JSON.stringify(result).includes(sentinel));
  },
);
test('hidden rules remain unknown after authenticated identity/repository reads; no counted approval is inferred', async () => {
  fixture.mode = 'unknown_rules';
  http();
  const result = await doctor();
  assert.equal(result.authProbe?.outcome, 'readback_complete');
  assert.deepEqual(result.authProbe?.reviewRules, {
    visibility: 'unknown',
    observedRequiredApprovals: null,
    approvalEligibility: 'unknown',
  });
});
test.each(['wrong_repo', 'same_actor', 'secret_actor'])(
  'rejects %s readback without reflecting unsafe identity data',
  async (mode) => {
    fixture.mode = mode;
    http();
    const result = await doctor();
    assert.equal(result.authProbe?.reason, 'invalid_readback');
    assert.equal(result.authProbe?.authentication.status, 'unverified');
    assert.ok(!JSON.stringify(result).includes('fictional-author-value'));
  },
);
test('synthetic doctor reads never change managed state or settings', async () => {
  http();
  const state = join(fixture.home, '.cache/ai-delivery/plugins/codex/user/state.json');
  const before = [readFileSync(state), readFileSync(fixture.config)];
  await doctor();
  assert.deepEqual([readFileSync(state), readFileSync(fixture.config)], before);
});
