import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  loadDeliveryConfig,
  loadDeliverySettings,
  resolveDeliveryRoleCredentials,
  type UserDeliverySettings,
} from './config/deliveryConfig.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { createDeliveryGitHubClients, withAuthorGitToken } from './github/client.js';

// These are fictional settings/environment contracts. They do not launch a native
// host, contact GitHub, or establish authenticated/native installation readiness.
function settings(root: string): UserDeliverySettings {
  return {
    schemaVersion: 'ai-delivery.user@1',
    roles: {
      author: {
        authSource: 'personal',
        identity: 'fixture-author',
        credentialEnv: { token: 'DELIVERY_AUTHOR_TOKEN' },
      },
      reviewer: {
        identity: 'fixture-reviewer',
        credentialEnv: {
          appId: 'DELIVERY_REVIEWER_APP_ID',
          installationId: 'DELIVERY_REVIEWER_INSTALLATION_ID',
          privateKeyPath: 'DELIVERY_REVIEWER_KEY_PATH',
        },
      },
    },
    project: syntheticDiscoveryConfig.native.project.number,
    checkoutRoots: [join(root, 'clones')],
    pointsField: syntheticDiscoveryConfig.native.points.name,
    priorityField: syntheticDiscoveryConfig.native.priority.name,
    statusField: syntheticDiscoveryConfig.native.project.statusField,
    statuses: syntheticDiscoveryConfig.native.project.statuses,
    issueTypes: syntheticDiscoveryConfig.native.issueTypes,
  };
}

let home = '';
let configPath = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ai-delivery-credential-contract-'));
  configPath = join(home, 'operator-settings.json');
  vi.stubEnv('AI_DELIVERY_CONFIG', configPath);
  // Fail closed if any fixture accidentally reaches a real HTTP client. The
  // explicit readback cases replace this with their own in-memory responses.
  vi.stubGlobal('fetch', async () => {
    throw new Error('Unexpected network request in a synthetic credential fixture.');
  });
  writeFileSync(configPath, JSON.stringify(settings(home)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('synthetic native-plugin credential contract', () => {
  it.each(['codex', 'claude-code'])(
    '%s fixture uses one operator configuration outside Git and across repositories',
    async (host) => {
      const outsideGit = join(home, host, 'outside-git');
      mkdirSync(outsideGit, { recursive: true });
      // A launch-directory file must not replace the selected operator settings.
      writeFileSync(join(outsideGit, 'ai-delivery.config.json'), '{"roles":"untrusted fixture"}');
      const loaded = await loadDeliverySettings(outsideGit);
      assert.equal(loaded.configPath, configPath);
      assert.equal(loaded.roles.author.identity, 'fixture-author');
      assert.equal(loaded.roles.reviewer.identity, 'fixture-reviewer');
      for (const repository of ['example/widget', 'example/service', 'example/widget']) {
        const fixture = { ...syntheticDiscoveryConfig, repository };
        const resolved = await loadDeliveryConfig(outsideGit, {
          repository,
          clients: syntheticDiscoveryClients(fixture),
        });
        assert.equal(resolved.config.repository, repository);
        assert.deepEqual(resolved.config.roles, loaded.roles);
        assert.equal(resolved.configPath, configPath);
      }
    },
  );

  it('valid settings alone do not establish that the named credentials are available', async () => {
    const loaded = await loadDeliverySettings();
    await assert.rejects(
      createDeliveryGitHubClients({
        config: loaded,
        identity: loaded.roles.author.identity,
        role: 'author',
        env: {},
      }),
      /Missing personal author token in DELIVERY_AUTHOR_TOKEN/u,
    );
  });

  it('ignores unrelated tokens and reports the selected missing name without their values', async () => {
    const loaded = await loadDeliverySettings();
    const sentinel = 'fictional-unrelated-value-not-a-credential';
    await assert.rejects(
      createDeliveryGitHubClients({
        config: loaded,
        identity: loaded.roles.author.identity,
        role: 'author',
        env: { GH_TOKEN: sentinel, GITHUB_TOKEN: sentinel, UNRELATED_SERVICE_TOKEN: sentinel },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /DELIVERY_AUTHOR_TOKEN/u);
        assert.ok(!error.message.includes(sentinel));
        assert.ok(!error.message.includes('UNRELATED_SERVICE_TOKEN'));
        return true;
      },
    );
  });

  it('selects a supplied fictional author token without treating selection as authenticated readback', async () => {
    const loaded = await loadDeliverySettings();
    const token = 'fictional-selected-author-value';
    const author = await createDeliveryGitHubClients({
      config: loaded,
      identity: loaded.roles.author.identity,
      role: 'author',
      env: { DELIVERY_AUTHOR_TOKEN: token, GH_TOKEN: 'fictional-unselected-value' },
    });
    assert.equal(author.role, 'author');
    assert.equal(author.authSource, 'personal');
    assert.equal(author.credentialSource, 'env:DELIVERY_AUTHOR_TOKEN');
    assert.equal(await withAuthorGitToken(author, (selected) => selected === token), true);
    // No authenticatedAuthor/appActorLogin callback is invoked in this fixture.
    assert.equal(loaded.roles.reviewer.identity, 'fixture-reviewer');
  });

  it('requires a separate identity readback and uses only a GET in the simulated author probe', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(url, 'https://api.github.com/user');
      assert.equal(init?.method ?? 'GET', 'GET');
      requests.push(url);
      return new Response(JSON.stringify({ id: 42, login: 'fixture-authenticated-author' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const loaded = await loadDeliverySettings();
    const author = await createDeliveryGitHubClients({
      config: loaded,
      identity: loaded.roles.author.identity,
      role: 'author',
      env: { DELIVERY_AUTHOR_TOKEN: 'fictional-author-value' },
    });
    assert.deepEqual(requests, []);
    assert.ok(author.authenticatedAuthor);
    assert.deepEqual(await author.authenticatedAuthor(), {
      actorLogin: 'fixture-authenticated-author',
      credentialIdentity: 'user:42',
    });
    assert.deepEqual(requests, ['https://api.github.com/user']);
  });

  it('redacts a simulated authentication failure even when the upstream body contains fictional credential values', async () => {
    const sentinel = 'fictional-value-in-upstream-error';
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(url, 'https://api.github.com/user');
      assert.equal(init?.method ?? 'GET', 'GET');
      return new Response(JSON.stringify({ message: sentinel }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-fictional-credential': sentinel },
      });
    });
    const loaded = await loadDeliverySettings();
    const author = await createDeliveryGitHubClients({
      config: loaded,
      identity: loaded.roles.author.identity,
      role: 'author',
      env: { DELIVERY_AUTHOR_TOKEN: sentinel },
    });
    assert.ok(author.authenticatedAuthor);
    await assert.rejects(author.authenticatedAuthor(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Configured personal author token is invalid or expired/u);
      assert.ok(!error.message.includes(sentinel));
      return true;
    });
  });

  it('cannot use the configured author identity for the reviewer role', async () => {
    const loaded = await loadDeliverySettings();
    await assert.rejects(
      createDeliveryGitHubClients({
        config: loaded,
        identity: loaded.roles.author.identity,
        role: 'reviewer',
        env: { DELIVERY_AUTHOR_TOKEN: 'fictional-author-value' },
      }),
      /requires the configured reviewer identity/u,
    );
  });

  it('rejects App credential reuse before reading a key or requesting authentication', async () => {
    const fixture = settings(home);
    const roles = {
      ...fixture.roles,
      author: {
        authSource: 'app' as const,
        identity: 'fixture-app-author',
        credentialEnv: {
          appId: 'DELIVERY_AUTHOR_APP_ID',
          installationId: 'DELIVERY_AUTHOR_INSTALLATION_ID',
          privateKeyPath: 'DELIVERY_AUTHOR_KEY_PATH',
        },
      },
    };
    const fictionalPath = join(home, 'fictional-shared-key.pem');
    await assert.rejects(
      createDeliveryGitHubClients({
        config: { roles },
        identity: roles.author.identity,
        role: 'author',
        env: {
          DELIVERY_AUTHOR_APP_ID: '101',
          DELIVERY_AUTHOR_INSTALLATION_ID: '201',
          DELIVERY_AUTHOR_KEY_PATH: fictionalPath,
          DELIVERY_REVIEWER_APP_ID: '102',
          DELIVERY_REVIEWER_INSTALLATION_ID: '202',
          DELIVERY_REVIEWER_KEY_PATH: fictionalPath,
        },
      }),
      /Author and reviewer must use distinct GitHub App credentials/u,
    );
  });

  it('reports missing reviewer references without leaking a supplied key path or unrelated values', async () => {
    const loaded = await loadDeliverySettings();
    const fictionalPath = join(home, 'fictional-private-key.pem');
    assert.throws(
      () =>
        resolveDeliveryRoleCredentials({
          config: loaded,
          role: 'reviewer',
          env: { DELIVERY_REVIEWER_KEY_PATH: fictionalPath, UNRELATED_SERVICE_TOKEN: 'fictional-unrelated-value' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /DELIVERY_REVIEWER_APP_ID/u);
        assert.match(error.message, /DELIVERY_REVIEWER_INSTALLATION_ID/u);
        assert.ok(!error.message.includes(fictionalPath));
        assert.ok(!error.message.includes('fictional-unrelated-value'));
        return true;
      },
    );
  });

  it('rejects author/reviewer identity and reference collisions during settings validation', async () => {
    const fixture = settings(home);
    for (const reviewer of [
      { ...fixture.roles.reviewer, identity: fixture.roles.author.identity },
      {
        ...fixture.roles.reviewer,
        credentialEnv: { ...fixture.roles.reviewer.credentialEnv, appId: 'DELIVERY_AUTHOR_TOKEN' },
      },
    ]) {
      writeFileSync(configPath, JSON.stringify({ ...fixture, roles: { ...fixture.roles, reviewer } }));
      await assert.rejects(loadDeliverySettings(), /distinct/u);
    }
  });

  it('rejects malformed JSON without echoing its fictional contents', async () => {
    const sentinel = 'fictional-value-inside-malformed-json';
    writeFileSync(configPath, `{"unexpected":"${sentinel}"`);
    await assert.rejects(loadDeliverySettings(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid user configuration JSON/u);
      assert.ok(!error.message.includes(sentinel));
      return true;
    });
  });

  it('rejects non-reference credential fields and relative checkout roots without echoing values', async () => {
    const fixture = settings(home);
    const sentinel = 'fictional_value_not_an_env_name';
    writeFileSync(
      configPath,
      JSON.stringify({
        ...fixture,
        roles: { ...fixture.roles, author: { ...fixture.roles.author, credentialEnv: { token: sentinel } } },
      }),
    );
    await assert.rejects(loadDeliverySettings(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /roles.author.credentialEnv.token/u);
      assert.ok(!error.message.includes(sentinel));
      return true;
    });
    writeFileSync(configPath, JSON.stringify({ ...fixture, checkoutRoots: ['relative-clones'] }));
    await assert.rejects(loadDeliverySettings(), /Checkout roots must be absolute/u);
  });
});
