import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

import {
  createDeliveryGitHubClients,
  hasBranchProtectionAbsence,
  retainMachineAuthorForConfiguration,
  withAuthorGitToken,
} from './client.js';
import { resolveRepoFromRemote } from './repo.js';
import { machineAuthorEligible, withMachineAuthorCredential } from './machineAuth.js';
import { syntheticDiscoveryConfig, syntheticDiscoveryClients } from '../fixtures/discovery.js';
import { contextFor } from '../dispatch.js';
import { printCommandError } from '../cliResult.js';
import { getMachineRequestDiagnostics } from '../errors.js';

// This executable and all account/token/HTTP responses are fictional. No real
// gh binary, home, configuration, keyring, GitHub session or network is used.
let home = '';
let binary = '';
let env: NodeJS.ProcessEnv;
const token = 'fictional_machine_token_not_a_real_credential';
const account = { host: 'github.com', active: true, state: 'success', login: 'fixture-user' };
const config = {
  roles: {
    author: { authSource: 'personal' as const, identity: 'fixture-author', credentialEnv: { token: 'GH_TOKEN' } },
    reviewer: {
      identity: 'fixture-reviewer',
      credentialEnv: {
        appId: 'FIXTURE_REVIEW_APP_ID',
        installationId: 'FIXTURE_REVIEW_INSTALLATION_ID',
        privateKeyPath: 'FIXTURE_REVIEW_KEY_PATH',
      },
    },
  },
};
const appConfig = {
  roles: {
    ...config.roles,
    author: {
      identity: 'fixture-app-author',
      credentialEnv: {
        appId: 'FIXTURE_AUTHOR_APP_ID',
        installationId: 'FIXTURE_AUTHOR_INSTALLATION_ID',
        privateKeyPath: 'FIXTURE_AUTHOR_KEY_PATH',
      },
    },
  },
};

function stub(input: { hosts?: unknown; statusRaw?: string; token?: string; fail?: 'status' | 'token' } = {}) {
  writeFileSync(
    binary,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(home, 'calls.jsonl'))},JSON.stringify({args,environmentNames:Object.keys(process.env).sort(),containsFictionalCredential:Object.values(process.env).includes(${JSON.stringify(token)}),coverageMatchesParent:process.env.NODE_V8_COVERAGE===${JSON.stringify(process.env.NODE_V8_COVERAGE)}})+'\\n');
if(args[0]!=='auth')process.exit(91);
if(args[1]===${JSON.stringify(input.fail ?? '')}){process.stderr.write('fictional_error_token_private_key_path_header');process.exit(1);}
if(args[1]==='status'){
 if(JSON.stringify(args)!==JSON.stringify(['auth','status','--hostname','github.com','--active','--json','hosts']))process.exit(92);
 process.stdout.write(${JSON.stringify(input.statusRaw ?? JSON.stringify({ hosts: input.hosts ?? { 'github.com': [account] } }))});
}else if(args[1]==='token'){
 if(JSON.stringify(args)!==JSON.stringify(['auth','token','--hostname','github.com','--user','fixture-user']))process.exit(93);
 process.stdout.write(${JSON.stringify(input.token ?? token)}+'\\n');
}else process.exit(94);
`,
    { mode: 0o755 },
  );
}
function calls(): {
  args: string[];
  environmentNames: string[];
  containsFictionalCredential: boolean;
  coverageMatchesParent: boolean;
}[] {
  try {
    return readFileSync(join(home, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            environmentNames: string[];
            containsFictionalCredential: boolean;
            coverageMatchesParent: boolean;
          },
      );
  } catch {
    return [];
  }
}
function identity(status = 200, login = 'fixture-user', type = 'User') {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(init?.method ?? 'GET', 'GET');
    return new Response(JSON.stringify(status === 200 ? { id: 42, login, type } : { message: token }), {
      status,
      headers: { 'content-type': 'application/json', 'x-fictional-header': token },
    });
  });
}
function author(selectedEnv = env) {
  return createDeliveryGitHubClients({ config, env: selectedEnv, role: 'author', identity: 'fixture-author' });
}
async function safeFailure(operation: Promise<unknown>, expected: RegExp) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, expected);
    assert.ok(!JSON.stringify(error).includes(token));
    assert.ok(!error.message.includes('fictional_error_token_private_key_path_header'));
    assert.equal(error.cause, undefined);
    return true;
  });
}
function renderFailure(error: unknown): string {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exitCode = process.exitCode;
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    stderr.push(String(value));
    return true;
  });
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    stdout.push(String(value));
    return true;
  });
  try {
    printCommandError(error);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(stdout, []);
    return stderr.join('');
  } finally {
    err.mockRestore();
    out.mockRestore();
    process.exitCode = exitCode;
  }
}
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-machine-session-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  binary = join(bin, 'gh');
  env = { HOME: home, PATH: bin };
  stub();
  vi.stubGlobal('fetch', () => {
    throw new Error('Unexpected network in synthetic machine-session fixture.');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('the absent conventional reference selects a pinned healthy account and proves its actual user', async () => {
  identity();
  const clients = await author();
  assert.equal(clients.authSource, 'personal');
  assert.equal(clients.credentialSource, `gh:github.com:${binary}`);
  assert.deepEqual(await clients.authenticatedAuthor!(), { actorLogin: 'fixture-user', credentialIdentity: 'user:42' });
  assert.equal(await withAuthorGitToken(clients, (value) => value === token), true);
  assert.deepEqual(
    calls().map((x) => x.args),
    [
      ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'],
      ['auth', 'token', '--hostname', 'github.com', '--user', 'fixture-user'],
    ],
  );
});
test('inactive bad accounts do not invalidate or replace the healthy selected user', async () => {
  stub({
    hosts: { 'github.com': [account, { ...account, active: false, state: 'error', login: 'fixture-bot[bot]' }] },
  });
  identity();
  await author();
  assert.equal(calls().length, 2);
});
test.each([
  ['missing', {}],
  ['expired', { 'github.com': [{ ...account, state: 'error' }] }],
  ['timeout', { 'github.com': [{ ...account, state: 'timeout' }] }],
  ['no active', { 'github.com': [{ ...account, active: false }] }],
  ['ambiguous', { 'github.com': [account, { ...account, login: 'other-user' }] }],
  ['wrong host', { 'enterprise.example': [{ ...account, host: 'enterprise.example' }] }],
  ['mismatched entry host', { 'github.com': [{ ...account, host: 'enterprise.example' }] }],
  ['active bot', { 'github.com': [{ ...account, login: 'fixture-bot[bot]' }] }],
])('%s status is refused even though JSON status exits zero', async (_label, hosts) => {
  stub({ hosts });
  await safeFailure(author(), /no unambiguous healthy active/u);
  assert.equal(calls().length, 1);
});
test('malformed status never reaches token acquisition', async () => {
  stub({ statusRaw: '{invalid fictional token body' });
  await safeFailure(author(), /no unambiguous healthy active/u);
  assert.equal(calls().length, 1);
});
test.each(['status', 'token'] as const)('%s failure with opaque stderr remains secret-safe', async (fail) => {
  stub({ fail });
  await safeFailure(author(), /Machine GitHub session/u);
});
test('empty token output is refused without user lookup', async () => {
  stub({ token: '' });
  await safeFailure(author(), /token is unavailable or invalid/u);
});
test('explicit token precedence does not call gh or preempt authentication readback', async () => {
  const clients = await author({ ...env, GH_TOKEN: 'fictional_explicit_token', GITHUB_TOKEN: token });
  assert.equal(clients.credentialSource, 'env:GH_TOKEN');
  assert.deepEqual(calls(), []);
  identity(401);
  await safeFailure(clients.authenticatedAuthor!(), /Configured personal author token is invalid or expired/u);
  assert.deepEqual(calls(), []);
});
test.each(['', '   ', 'malformed token\nvalue'])(
  'present invalid explicit input %j never falls back',
  async (value) => {
    await safeFailure(author({ ...env, GH_TOKEN: value }), /Missing personal author token|malformed/u);
    assert.deepEqual(calls(), []);
  },
);
test('an intentionally configured alternate reference does not use gh or unrelated tokens', async () => {
  await safeFailure(
    createDeliveryGitHubClients({
      config: {
        roles: {
          ...config.roles,
          author: { ...config.roles.author, credentialEnv: { token: 'ALTERNATE_AUTHOR_TOKEN' } },
        },
      },
      env: { ...env, GITHUB_TOKEN: token },
      identity: 'fixture-author',
      role: 'author',
    }),
    /Missing personal author token in ALTERNATE_AUTHOR_TOKEN/u,
  );
  assert.deepEqual(calls(), []);
});
test('a missing explicit personal override for an App role refuses machine fallback', async () => {
  await safeFailure(
    createDeliveryGitHubClients({
      config: appConfig,
      env,
      role: 'author',
      identity: 'personal',
      personalAuth: { enabled: true },
    }),
    /no token was supplied/u,
  );
  assert.deepEqual(calls(), []);
});
test('empty highest-precedence explicit override does not silently select a lower token', async () => {
  await safeFailure(
    createDeliveryGitHubClients({
      config: appConfig,
      env: { ...env, GH_TOKEN: token },
      role: 'author',
      identity: 'personal',
      personalAuth: { enabled: true, token: '' },
    }),
    /no token was supplied/u,
  );
  assert.deepEqual(calls(), []);
});
test.each([
  ['other-user', 'User'],
  ['fixture-user', 'Bot'],
])('user %s/%s mismatch refuses before repository use', async (login, type) => {
  identity(200, login, type);
  await safeFailure(author(), /identity does not match/u);
});
test('expired selected machine token never switches to another session', async () => {
  identity(401);
  await safeFailure(author(), /Machine GitHub session is invalid or expired/u);
  assert.equal(calls().length, 2);
});
test('unsupported explicit enterprise host is refused before launching gh, even with a token', async () => {
  for (const selected of [env, { ...env, GH_TOKEN: token }])
    await safeFailure(author({ ...selected, GH_HOST: 'enterprise.example' }), /supports github.com only/u);
  assert.deepEqual(calls(), []);
  assert.throws(() => resolveRepoFromRemote(home, 'origin'), /remote/u);
});
test('GUI-style missing PATH and non-executable gh are actionable without shell fallback', async () => {
  await safeFailure(author({ HOME: home, PATH: `.${delimiter}${join(home, 'missing')}` }), /gh is unavailable/u);
  chmodSync(binary, 0o600);
  await safeFailure(author(), /gh is unavailable/u);
  assert.deepEqual(calls(), []);
});
test('explicit unavailable configuration/home selectors are not replaced by another profile', async () => {
  for (const name of ['HOME', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME'])
    await safeFailure(author({ ...env, [name]: join(home, 'absent') }), /selector is unavailable or invalid/u);
  assert.deepEqual(calls(), []);
});
test('only non-secret supported selectors reach gh; ambient tokens, injection and debugging are excluded', async () => {
  identity();
  await author({
    ...env,
    GITHUB_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_ENTERPRISE_TOKEN: token,
    UNRELATED_TOKEN: token,
    NODE_OPTIONS: token,
    NODE_V8_COVERAGE: token,
    GH_DEBUG: 'api',
    DEBUG: '1',
    GH_REPO: 'enterprise.example/other/repo',
  });
  for (const call of calls()) {
    assert.equal(call.containsFictionalCredential, false);
    assert.equal(call.coverageMatchesParent, true);
    // Node propagates its parent's coverage selector even with an explicit
    // child environment. Preserve canonical instrumentation, while proving
    // the supplied fictional selector/credential never reaches the child.
    // Darwin's additional platform name remains observed but unattributed.
    assert.deepEqual(
      call.environmentNames.filter(
        (name) =>
          !(process.platform === 'darwin' && name === '__CF_USER_TEXT_ENCODING') &&
          !(process.env.NODE_V8_COVERAGE !== undefined && name === 'NODE_V8_COVERAGE'),
      ),
      [
        'GH_HOST',
        'GH_NO_EXTENSION_UPDATE_NOTIFIER',
        'GH_NO_UPDATE_NOTIFIER',
        'GH_PROMPT_DISABLED',
        'GH_TELEMETRY',
        'HOME',
        'PATH',
      ],
    );
  }
});
test('repository read and simulated write permission refusal preserve status and never switch actors or leak upstream data', async () => {
  identity();
  const clients = await author();
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ message: token }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'x-fictional-credential': token },
      }),
  );
  await safeFailure(
    clients.rest.repos.get({ owner: 'example', repo: 'widget' }),
    /cannot access the selected repository or operation/u,
  );
  // Fake HTTP refusal only: the stub has no issue/project/Git state or network.
  await safeFailure(
    clients.rest.issues.create({ owner: 'example', repo: 'widget', title: 'fictional denied operation' }),
    /cannot access/u,
  );
  await safeFailure(clients.graphql('query { repository(owner:"example",name:"widget") { id } }'), /cannot access/u);
  assert.equal(calls().length, 2);
});

test('machine REST request diagnostics reach the real CLI renderer without private response data', async () => {
  identity();
  const clients = await author();
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ message: token, private: 'fictional_private_body' }), {
        status: 500,
        headers: {
          'content-type': 'application/json',
          'x-github-request-id': 'ABCD:1234:5678:9ABC:DEF0',
          'x-private-header': token,
        },
      }),
  );
  await assert.rejects(
    clients.rest.pulls.merge({ owner: 'example', repo: 'widget', pull_number: 17, sha: 'a'.repeat(40) }),
    (error: unknown) => {
      const output = renderFailure(error);
      assert.equal(
        output,
        'ai-delivery: request phase=rest.request; endpoint=pulls.merge; status=500; code=UNKNOWN; requestId=ABCD:1234:5678:9ABC:DEF0\nai-delivery: Machine GitHub request failed; verify the selected account and repository access.\n',
      );
      assert.equal(output.includes(token), false);
      assert.equal(output.includes('fictional_private'), false);
      assert.equal(JSON.stringify(error).includes(token), false);
      return true;
    },
  );
  assert.equal(calls().length, 2);
});

test('only the original real machine protection failure proves absence for its selected client and target', async () => {
  identity();
  const clients = await author();
  const other = await author();
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const response = new Response(JSON.stringify({ message: 'Branch not protected', private: token }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'x-private-header': token },
    });
    Object.defineProperty(response, 'url', { value: input instanceof Request ? input.url : String(input) });
    return response;
  });
  let absence: unknown;
  await assert.rejects(
    clients.rest.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner: 'example',
      repo: 'widget',
      branch: 'release/next',
    }),
    (error: unknown) => {
      absence = error;
      assert.equal(
        hasBranchProtectionAbsence(error, clients, { owner: 'example', repo: 'widget' }, 'release/next'),
        true,
      );
      assert.equal(
        hasBranchProtectionAbsence(error, other, { owner: 'example', repo: 'widget' }, 'release/next'),
        false,
      );
      assert.equal(
        hasBranchProtectionAbsence(error, clients, { owner: 'other', repo: 'widget' }, 'release/next'),
        false,
      );
      assert.equal(
        hasBranchProtectionAbsence(error, clients, { owner: 'example', repo: 'other' }, 'release/next'),
        false,
      );
      assert.equal(hasBranchProtectionAbsence(error, clients, { owner: 'example', repo: 'widget' }, 'main'), false);
      assert.equal(getMachineRequestDiagnostics(error)?.endpoint, 'UNKNOWN');
      assert.equal(renderFailure(error).includes(token), false);
      assert.equal(renderFailure(error).includes('Branch not protected'), false);
      assert.equal(JSON.stringify(error).includes(token), false);
      assert.equal(Object.hasOwn(error as object, 'response'), false);
      assert.equal(Object.hasOwn(error as object, 'cause'), false);
      return true;
    },
  );
  const forged = {
    ...(absence as object),
    status: 404,
    response: { status: 404, data: { message: 'Branch not protected' } },
  };
  assert.equal(
    hasBranchProtectionAbsence(forged, clients, { owner: 'example', repo: 'widget' }, 'release/next'),
    false,
  );
  assert.equal(
    hasBranchProtectionAbsence(
      new Proxy(absence as object, {}),
      clients,
      { owner: 'example', repo: 'widget' },
      'release/next',
    ),
    false,
  );
});

test('machine absence classification rejects hostile and foreign request metadata without invoking accessors', async () => {
  identity();
  const clients = await author();
  const options = clients.rest.request.endpoint.merge('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
    owner: 'example',
    repo: 'widget',
    branch: 'main',
  });
  const raw = {
    status: 404,
    response: {
      status: 404,
      url: 'https://api.github.com/repos/example/widget/branches/main/protection',
      data: { message: 'Branch not protected', private: token },
    },
  };
  let reads = 0;
  const getter = (source: object, key: string) =>
    Object.defineProperty({ ...source }, key, {
      get() {
        reads++;
        throw new Error(token);
      },
    });
  const cases: [unknown, unknown][] = [
    [{ status: 404, response: { status: 404, data: { message: 'Not Found' } } }, options],
    [{ ...raw, status: 403 }, options],
    [{ ...raw, response: { ...raw.response, status: 403 } }, options],
    [getter(raw, 'status'), options],
    [getter(raw, 'response'), options],
    [{ ...raw, response: getter(raw.response, 'status') }, options],
    [{ ...raw, response: { ...raw.response, data: getter(raw.response.data, 'message') } }, options],
    [new Proxy(raw, {}), options],
    [{ ...raw, response: new Proxy(raw.response, {}) }, options],
    [{ ...raw, response: getter(raw.response, 'url') }, options],
    [
      {
        ...raw,
        response: { ...raw.response, url: 'https://foreign.invalid/repos/example/widget/branches/main/protection' },
      },
      options,
    ],
    [
      {
        ...raw,
        response: { ...raw.response, url: 'https://api.github.com/repos/other/widget/branches/main/protection' },
      },
      options,
    ],
    [
      {
        ...raw,
        response: { ...raw.response, url: 'https://api.github.com/repos/example/widget/branches/other/protection' },
      },
      options,
    ],
    [raw, { ...options, method: 'POST' }],
    [raw, { ...options, url: '/repos/example/widget/issues/17' }],
    [raw, { ...options, baseUrl: 'https://foreign.invalid' }],
    [raw, { ...options, url: 'https://foreign.invalid/repos/example/widget/branches/main/protection' }],
    [raw, { ...options, url: 'https://private@api.github.com/repos/example/widget/branches/main/protection' }],
    [raw, { ...options, url: '/repos/example/widget/branches/main/protection?private=value' }],
    [raw, getter(options, 'url')],
    [raw, getter(options, 'branch')],
    [
      raw,
      {
        ...options,
        branch: {
          toString() {
            reads++;
            return 'main';
          },
        },
      },
    ],
  ];
  for (const [error, metadata] of cases) {
    const request = { ...options };
    await assert.rejects(
      clients.rest.hook(
        'request',
        async () => {
          // Introduce hostile metadata at the external request failure boundary,
          // after the SDK has prepared auth from the ordinary request options.
          Object.defineProperties(request, Object.getOwnPropertyDescriptors(metadata));
          throw error;
        },
        request as never,
      ),
      (safe: unknown) => {
        assert.equal(hasBranchProtectionAbsence(safe, clients, { owner: 'example', repo: 'widget' }, 'main'), false);
        assert.equal(renderFailure(safe).includes(token), false);
        assert.equal(JSON.stringify(safe).includes(token), false);
        return true;
      },
    );
  }
  assert.equal(reads, 0);
});

test.each([500, 200])(
  'machine GraphQL status %s diagnostics reach the real CLI renderer without query or data errors',
  async (status) => {
    identity();
    const clients = await author();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: token, extensions: { private: 'fictional_private_data' } }],
            data: { private: token },
          }),
          {
            status,
            headers: {
              'content-type': 'application/json',
              'x-github-request-id': 'ABCD:1234:5678:9ABC:DEF0',
              'x-private-header': token,
            },
          },
        ),
    );
    await assert.rejects(
      clients.graphql('query FictionalPrivate($value:String!){ repository(owner:$value,name:"widget"){id} }', {
        value: 'fictional_private_variables',
      }),
      (error: unknown) => {
        const output = renderFailure(error);
        assert.equal(
          output,
          `ai-delivery: request phase=graphql.request; endpoint=graphql; status=${status === 500 ? '500' : 'UNKNOWN'}; code=UNKNOWN; requestId=ABCD:1234:5678:9ABC:DEF0\nai-delivery: Machine GitHub request failed; verify the selected account and repository access.\n`,
        );
        assert.equal(output.includes(token), false);
        assert.equal(output.includes('fictional_private'), false);
        assert.equal(output.includes('FictionalPrivate'), false);
        assert.equal(JSON.stringify(error).includes(token), false);
        return true;
      },
    );
    assert.equal(calls().length, 2);
  },
);

test('real machine REST failures classify only the finite guarded-delivery endpoints', async () => {
  identity();
  const clients = await author();
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ message: token }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const operations: [string, () => Promise<unknown>][] = [
    ['pulls.merge', () => clients.rest.pulls.merge({ owner: 'example', repo: 'widget', pull_number: 17 })],
    ['pulls.get', () => clients.rest.pulls.get({ owner: 'example', repo: 'widget', pull_number: 17 })],
    ['pulls.listReviews', () => clients.rest.pulls.listReviews({ owner: 'example', repo: 'widget', pull_number: 17 })],
    [
      'pulls.getReview',
      () => clients.rest.pulls.getReview({ owner: 'example', repo: 'widget', pull_number: 17, review_id: 42 }),
    ],
    [
      'git.getCommit',
      () => clients.rest.git.getCommit({ owner: 'example', repo: 'widget', commit_sha: 'a'.repeat(40) }),
    ],
    ['git.getRef', () => clients.rest.git.getRef({ owner: 'example', repo: 'widget', ref: 'heads/issue/17' })],
    ['issues.get', () => clients.rest.issues.get({ owner: 'example', repo: 'widget', issue_number: 17 })],
    [
      'issues.update',
      () =>
        clients.rest.issues.update({ owner: 'example', repo: 'widget', issue_number: 17, title: 'fictional title' }),
    ],
  ];
  for (const [endpoint, operation] of operations)
    await assert.rejects(operation(), (error: unknown) => {
      assert.equal(getMachineRequestDiagnostics(error)?.endpoint, endpoint);
      assert.equal(getMachineRequestDiagnostics(error)?.requestId, 'UNKNOWN');
      assert.equal(renderFailure(error).includes(token), false);
      return true;
    });
  assert.equal(calls().length, 2);
});

test.each([401, 403, 404])(
  'machine status %s preserves exact refusal and legacy status through the real renderer',
  async (status) => {
    identity();
    const clients = await author();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ message: token }), { status, headers: { 'content-type': 'application/json' } }),
    );
    await assert.rejects(
      clients.rest.pulls.get({ owner: 'example', repo: 'widget', pull_number: 17 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(Reflect.get(error, 'status'), status);
        const message =
          status === 401
            ? 'Machine GitHub session is invalid or expired; verify the selected github.com account.'
            : 'Machine GitHub session cannot access the selected repository or operation; verify its existing permissions.';
        assert.equal(error.message, message);
        assert.equal(renderFailure(error).trimEnd().split('\n').at(-1), `ai-delivery: ${message}`);
        return true;
      },
    );
    assert.equal(calls().length, 2);
  },
);

test.each([
  'GET https://private.invalid/fictional_private_path',
  'DELETE /repos/example/widget/pulls/17/merge',
  'GET /repos/example/widget/pulls/17/unknown',
])('unknown request %s remains UNKNOWN and withholds arbitrary metadata', async (route) => {
  identity();
  const clients = await author();
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ message: token, code: 'ENOTFOUND', cause: token }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'x-github-request-id': token, 'x-private-header': token },
      }),
  );
  await assert.rejects(clients.rest.request(route), (error: unknown) => {
    assert.deepEqual(getMachineRequestDiagnostics(error), {
      phase: 'rest.request',
      endpoint: 'UNKNOWN',
      status: 500,
      code: 'UNKNOWN',
      requestId: 'UNKNOWN',
    });
    const output = renderFailure(error);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes('fictional_private_path'), false);
    assert.equal(output.includes('ENOTFOUND'), false);
    return true;
  });
});
test('repository discovery and subsequent command construction retain one selected machine account', async () => {
  identity();
  const clients = await author();
  const original = process.env;
  process.env = env;
  try {
    retainMachineAuthorForConfiguration(config, clients);
    stub({ hosts: { 'github.com': [{ ...account, login: 'other-user' }] } });
    assert.equal(await createDeliveryGitHubClients({ config, identity: 'fixture-author', role: 'author' }), clients);
    assert.equal(calls().length, 2);
    const explicit = await createDeliveryGitHubClients({
      config: structuredClone(config),
      identity: 'fixture-author',
      role: 'author',
      env: { GH_TOKEN: 'fictional_override' },
    });
    assert.equal(explicit.credentialSource, 'env:GH_TOKEN');
  } finally {
    process.env = original;
  }
});
test('the existing delivery context uses one central machine account across actual configuration discovery and operation', async () => {
  const settingsPath = join(home, 'user.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      schemaVersion: 'ai-delivery.user@1',
      roles: config.roles,
      project: 1,
      checkoutRoots: [],
      pointsField: 'Estimate',
      priorityField: 'Urgency',
      statusField: 'Flow',
      statuses: syntheticDiscoveryConfig.native.project.statuses,
    }),
  );
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url === 'https://api.github.com/user')
      return new Response(JSON.stringify({ id: 42, login: 'fixture-user', type: 'User' }), {
        headers: { 'content-type': 'application/json' },
      });
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(typeof init?.body, 'string');
    const body = JSON.parse(init!.body as string) as { query: string };
    assert.ok(!body.query.includes('mutation'));
    // A later active-account change cannot silently rebind this command.
    stub({ hosts: { 'github.com': [{ ...account, login: 'other-user' }] } });
    return new Response(JSON.stringify({ data: await syntheticDiscoveryClients().graphql(body.query) }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const original = process.env;
  process.env = { ...env, AI_DELIVERY_CONFIG: settingsPath };
  try {
    const context = await contextFor({ repoRoot: home, repo: 'example/widget' }, 'config:resolve');
    assert.equal(context.config.repository, 'example/widget');
    assert.equal(context.clients.credentialSource, `gh:github.com:${binary}`);
    assert.deepEqual(await context.clients.authenticatedAuthor!(), {
      actorLogin: 'fixture-user',
      credentialIdentity: 'user:42',
    });
    assert.equal(calls().length, 2);
    assert.ok(requests.includes('https://api.github.com/graphql'));
  } finally {
    process.env = original;
  }
});
test.each(['GH_TOKEN', 'GH_CONFIG_DIR'] as const)(
  'a %s change during actual repository discovery cannot replace the selected machine author',
  async (selector) => {
    const settingsPath = join(home, 'user.json');
    const alternateProfile = join(home, 'alternate-profile');
    mkdirSync(alternateProfile);
    writeFileSync(
      settingsPath,
      JSON.stringify({
        schemaVersion: 'ai-delivery.user@1',
        roles: config.roles,
        project: 1,
        checkoutRoots: [],
        pointsField: 'Estimate',
        priorityField: 'Urgency',
        statusField: 'Flow',
        statuses: syntheticDiscoveryConfig.native.project.statuses,
      }),
    );
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url === 'https://api.github.com/user')
        return new Response(JSON.stringify({ id: 42, login: 'fixture-user', type: 'User' }), {
          headers: { 'content-type': 'application/json' },
        });
      assert.equal(url, 'https://api.github.com/graphql');
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(init!.body as string) as { query: string };
      assert.ok(!body.query.includes('mutation'));
      process.env[selector] = selector === 'GH_TOKEN' ? 'fictional_alternate_author_token' : alternateProfile;
      return new Response(JSON.stringify({ data: await syntheticDiscoveryClients().graphql(body.query) }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const original = process.env;
    process.env = { ...env, AI_DELIVERY_CONFIG: settingsPath };
    try {
      await safeFailure(
        contextFor({ repoRoot: home, repo: 'example/widget' }, 'config:resolve'),
        /environment changed after repository selection/u,
      );
      assert.equal(requests.filter((url) => url === 'https://api.github.com/user').length, 1);
      assert.ok(requests.includes('https://api.github.com/graphql'));
      assert.equal(calls().length, 2);
    } finally {
      process.env = original;
    }
  },
);
test('reviewer and App author missing credentials never inherit the personal session', async () => {
  for (const role of ['author', 'reviewer'] as const)
    await safeFailure(
      createDeliveryGitHubClients({ config: appConfig, env, identity: appConfig.roles[role].identity, role }),
      /Missing GitHub App credentials/u,
    );
  assert.deepEqual(calls(), []);
});
test('helper cancellation does not deliver an account/token to its recipient', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withMachineAuthorCredential(env, controller.signal, async () => {
      throw new Error('Recipient must not run.');
    }),
  );
  assert.deepEqual(calls(), []);
});
test('only an absent conventional reference is eligible, independent of unrelated values', () => {
  assert.equal(machineAuthorEligible('GH_TOKEN', {}), true);
  assert.equal(machineAuthorEligible('GH_TOKEN', { GH_TOKEN: '' }), false);
  assert.equal(machineAuthorEligible('ALTERNATE_AUTHOR_TOKEN', {}), false);
});
