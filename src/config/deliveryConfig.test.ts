import { syntheticDiscoveryClients, syntheticOverrides } from '../fixtures/discovery.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { assertDeliveryRolePermissions, createDeliveryGitHubClients, withAuthorGitToken } from '../github/client.js';
import { evaluateCommandIdentityPolicy } from '../github/commandIdentityPolicy.js';
import { contextFor } from '../dispatch.js';
import {
  clearConfiguredNativeIssuePoints,
  nativeIssueSettingsFromDeliveryConfig,
  parseConfiguredNativeIssueMetadata,
  resolveNativeIssueFieldCatalog,
  setConfiguredNativeIssueMetadata,
  validateConfiguredNativeTracking,
} from '../github/nativeIssueMetadata.js';
import {
  PROJECT_DELIVERY_STATUSES,
  projectSettingsFromDeliveryConfig,
  resolveProjectDeliveryConfiguration,
  syncIssueProjectStatus,
} from '../github/projectDelivery.js';
import { resolveDeliveryRepo } from '../github/repo.js';
import { loadDeliveryConfig, parseDeliveryConfig, resolveDeliveryRoleCredentials } from './deliveryConfig.js';

function git(args: string[], options: { cwd?: string } = {}): void {
  const result = spawnSync('git', args, { ...options, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function syntheticConfig(input: { owner: string; projectNumber: number; repo: string }) {
  const { owner, projectNumber, repo } = input;
  const second = repo === 'service';
  return {
    commandPolicy: {
      checks: { format: 'REQUIRED', gitClean: 'REQUIRED', lint: 'REQUIRED', test: 'REQUIRED', typecheck: 'REQUIRED' },
      timeoutsMs: { lint: 60_000, test: 60_000, typecheck: 60_000 },
    },
    native: {
      issueTypes: ['Task', 'Defect'],
      milestones: 'repository',
      organization: owner,
      points: second
        ? { databaseId: '201', name: 'Complexity', values: ['1', '3', '6'] }
        : { databaseId: '101', name: 'Estimate', values: ['1', '2', '4'] },
      priority: second
        ? { databaseId: '202', name: 'Severity', values: ['Critical', 'Normal'] }
        : { databaseId: '102', name: 'Urgency', values: ['High', 'Low'] },
      project: {
        number: projectNumber,
        statuses: second
          ? { blocked: 'Held', done: 'Complete', inProgress: 'Doing', todo: 'Backlog' }
          : { blocked: 'Waiting', done: 'Shipped', inProgress: 'Active', todo: 'Queued' },
        statusField: second ? 'Stage' : 'Flow',
        title: 'Delivery',
      },
      relationships: { blockedBy: 'native', parent: 'native' },
    },
    policy: { contract: 'RepositoryDeliveryPolicy@1', module: './policy.mjs' },
    repository: `${owner}/${repo}`,
    roles: {
      author: {
        credentialEnv: {
          appId: 'AUTHOR_APP_ID',
          installationId: 'AUTHOR_INSTALLATION_ID',
          privateKeyPath: 'AUTHOR_KEY_PATH',
        },
        identity: 'synthetic-author',
      },
      reviewer: {
        credentialEnv: {
          appId: 'REVIEWER_APP_ID',
          installationId: 'REVIEWER_INSTALLATION_ID',
          privateKeyPath: 'REVIEWER_KEY_PATH',
        },
        identity: 'synthetic-reviewer',
      },
    },
    schemaVersion: 'ai-delivery.config@2',
  } as const;
}

function syntheticProject(config: ReturnType<typeof parseDeliveryConfig>) {
  const settings = projectSettingsFromDeliveryConfig(config);
  const field = (input: { databaseId: string; name: string; values: readonly string[] }) => ({
    __typename: 'ProjectV2SingleSelectField',
    id: `${input.name}-field`,
    isIssueField: true,
    issueField: {
      __typename: 'IssueFieldSingleSelect',
      fullDatabaseId: input.databaseId,
      name: input.name,
      options: input.values.map((value, index) => ({ id: String(index + 1), name: value })),
    },
    name: input.name,
    options: [],
  });
  return {
    fields: {
      nodes: [
        {
          __typename: 'ProjectV2SingleSelectField',
          id: 'flow-field',
          isIssueField: false,
          name: settings.statusField,
          options: PROJECT_DELIVERY_STATUSES.map((status, index) => ({
            id: `S${String(index)}`,
            name: settings.statuses[status],
          })),
        },
        field(settings.points),
        field(settings.priority),
      ],
    },
    id: 'project-node',
    number: settings.number,
    title: settings.title,
    viewerCanUpdate: true,
  };
}

describe('portable delivery configuration', () => {
  it('selects a configured personal author token without ambient fallback and keeps the reviewer App role', async () => {
    const base = syntheticConfig({ owner: 'sample', projectNumber: 7, repo: 'widget' });
    const config = parseDeliveryConfig({
      ...base,
      roles: {
        author: { authSource: 'personal', credentialEnv: { token: 'AUTHOR_TOKEN' }, identity: 'host-author' },
        reviewer: base.roles.reviewer,
      },
    });
    assert.equal(
      evaluateCommandIdentityPolicy({ commandName: 'pr:create', deliveryConfig: config, identity: 'host-author' })
        .error,
      null,
    );
    assert.equal(
      evaluateCommandIdentityPolicy({
        commandName: 'pr:review',
        deliveryConfig: config,
        identity: 'synthetic-reviewer',
      }).error,
      null,
    );
    await assert.rejects(
      createDeliveryGitHubClients({
        config,
        env: { GH_TOKEN: 'ambient-token' },
        identity: 'host-author',
        role: 'author',
      }),
      /AUTHOR_TOKEN/u,
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, init) => {
        assert.equal(new Headers(init?.headers).get('authorization'), 'token selected-token');
        return new Response(JSON.stringify({ id: 37, login: 'selected-user' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const clients = await createDeliveryGitHubClients({
        config,
        env: { AUTHOR_TOKEN: 'selected-token', GH_TOKEN: 'ambient-token' },
        identity: 'host-author',
        role: 'author',
      });
      assert.equal(clients.authSource, 'personal');
      assert.equal(await withAuthorGitToken(clients, (token) => token), 'selected-token');
      assert.deepEqual(await clients.authenticatedAuthor?.(), {
        actorLogin: 'selected-user',
        credentialIdentity: 'user:37',
      });
      globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      const expired = await createDeliveryGitHubClients({
        config,
        env: { AUTHOR_TOKEN: 'expired-token' },
        identity: 'host-author',
        role: 'author',
      });
      if (!expired.authenticatedAuthor) throw new Error('Personal author readback is unavailable.');
      await assert.rejects(expired.authenticatedAuthor(), /personal author token is invalid or expired/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels actual Octokit identity, REST and GraphQL requests through the selected scope signal', async () => {
    const base = syntheticConfig({ owner: 'sample', projectNumber: 7, repo: 'widget' });
    const config = parseDeliveryConfig({
      ...base,
      roles: {
        author: { authSource: 'personal', credentialEnv: { token: 'AUTHOR_TOKEN' }, identity: 'host-author' },
        reviewer: base.roles.reviewer,
      },
    });
    const originalFetch = globalThis.fetch;
    try {
      for (const operation of ['identity', 'rest', 'graphql'] as const) {
        const cancellation = new AbortController();
        let observedAbort = false;
        let started!: () => void;
        const requestStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        globalThis.fetch = async (_url, init) => {
          started();
          assert.equal(new Headers(init?.headers).get('authorization'), 'token selected-token');
          assert.equal(init?.signal, cancellation.signal);
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                reject(cancellation.signal.reason);
              },
              { once: true },
            );
          });
        };
        const clients = await createDeliveryGitHubClients({
          config,
          env: { AUTHOR_TOKEN: 'selected-token', GH_TOKEN: 'ambient-token' },
          identity: 'host-author',
          role: 'author',
          signal: cancellation.signal,
        });
        assert.ok(clients.authenticatedAuthor);
        const request =
          operation === 'identity'
            ? clients.authenticatedAuthor()
            : operation === 'rest'
              ? clients.rest.repos.get({ owner: 'sample', repo: 'widget' })
              : clients.graphql('query { viewer { login } }');
        const rejected = assert.rejects(request);
        await requestStarted;
        cancellation.abort();
        await rejected;
        assert.equal(observedAbort, true, `${operation} HTTP request must be cancelled`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels App installation authentication before either configured role can continue', async () => {
    const config = parseDeliveryConfig(syntheticConfig({ owner: 'sample', projectNumber: 7, repo: 'widget' }));
    const temp = mkdtempSync(join(tmpdir(), 'delivery-cancel-app-'));
    const originalFetch = globalThis.fetch;
    try {
      const env: NodeJS.ProcessEnv = {};
      for (const [index, role] of (['author', 'reviewer'] as const).entries()) {
        const path = join(temp, `${role}.pem`);
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
        const names = config.roles[role].credentialEnv;
        assert.ok('appId' in names, 'Synthetic role must use App credentials');
        env[names.appId] = String(42 + index);
        env[names.installationId] = String(52 + index);
        env[names.privateKeyPath] = path;
      }
      for (const role of ['author', 'reviewer'] as const) {
        const cancellation = new AbortController();
        let observedAbort = false;
        let started!: () => void;
        const requestStarted = new Promise<void>((resolve) => {
          started = resolve;
        });
        globalThis.fetch = async (_url, init) => {
          started();
          assert.equal(init?.signal, cancellation.signal);
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => {
                observedAbort = true;
                reject(cancellation.signal.reason);
              },
              { once: true },
            );
          });
        };
        const request = createDeliveryGitHubClients({
          config,
          env,
          identity: config.roles[role].identity,
          role,
          signal: cancellation.signal,
        });
        const rejected = assert.rejects(request, /GitHub App authentication failed/u);
        await requestStarted;
        cancellation.abort();
        await rejected;
        assert.equal(observedAbort, true, `${role} installation request must be cancelled`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('retains the configured personal author during configuration discovery with a legacy flag present', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'delivery-personal-config-'));
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AUTHOR_TOKEN;
    try {
      git(['init', '--quiet', temp]);
      git(['remote', 'add', 'origin', 'https://github.com/sample/widget.git'], { cwd: temp });
      const base = syntheticConfig({ owner: 'sample', projectNumber: 7, repo: 'widget' });
      const config = parseDeliveryConfig({
        ...base,
        roles: {
          author: { authSource: 'personal', credentialEnv: { token: 'AUTHOR_TOKEN' }, identity: 'host-author' },
          reviewer: base.roles.reviewer,
        },
      });
      writeFileSync(
        join(temp, 'policy.mjs'),
        `export const deliverySettings = ${JSON.stringify({ roles: config.roles, commandPolicy: config.commandPolicy })};\n`,
      );
      writeFileSync(join(temp, 'ai-delivery.config.json'), JSON.stringify(syntheticOverrides(config)));
      git(['add', 'policy.mjs', 'ai-delivery.config.json'], { cwd: temp });
      process.env.AUTHOR_TOKEN = 'selected-token';
      let selectedRequests = 0;
      globalThis.fetch = async (_url, init) => {
        assert.match(new Headers(init?.headers).get('authorization') ?? '', /selected-token/u);
        selectedRequests += 1;
        return new Response(JSON.stringify({ data: { repository: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      await assert.rejects(loadDeliveryConfig(temp, { personalAuth: true }), /Incomplete GitHub repository/u);
      assert.equal(selectedRequests, 1);
      globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      await assert.rejects(
        contextFor({ repoRoot: temp, identity: 'host-author' }, 'pr:create'),
        /Configured personal author token is invalid or expired/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.AUTHOR_TOKEN;
      else process.env.AUTHOR_TOKEN = originalToken;
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it('loads two independent repository roots and binds native metadata to each configuration', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'delivery-config-'));
    try {
      for (const [owner, repo, projectNumber] of [
        ['sample-one', 'widget', 7],
        ['sample-two', 'service', 12],
      ] as const) {
        const root = join(temp, repo);
        mkdirSync(root);
        git(['init', '--quiet', root]);
        git(['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`], { cwd: root });
        const configured = parseDeliveryConfig(syntheticConfig({ owner, projectNumber, repo }));
        writeFileSync(
          join(root, 'policy.mjs'),
          `export const deliverySettings = ${JSON.stringify({ roles: configured.roles, commandPolicy: configured.commandPolicy })};\n`,
        );
        writeFileSync(
          join(root, 'ai-delivery.config.json'),
          JSON.stringify(syntheticOverrides(parseDeliveryConfig(syntheticConfig({ owner, projectNumber, repo })))),
        );
        git(['add', 'policy.mjs', 'ai-delivery.config.json'], { cwd: root });
        const loaded = await loadDeliveryConfig(root, { clients: syntheticDiscoveryClients(configured) });
        assert.match(loaded.configDigest, /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(resolveDeliveryRepo(loaded.config, root), { owner, repo });
        assert.throws(
          () => resolveDeliveryRepo({ ...loaded.config, repository: `${owner}/foreign` }, root),
          /does not match remote/u,
        );
        const project = resolveProjectDeliveryConfiguration(syntheticProject(loaded.config), {
          requireWritable: true,
          settings: projectSettingsFromDeliveryConfig(loaded.config),
        });
        assert.equal(project.projectNumber, projectNumber);
        assert.equal(project.statusOptionIds['In Progress'], 'S1');
        const statusField = loaded.config.native.project.statusField;
        const inProgressName = loaded.config.native.project.statuses.inProgress;
        const graphql = (query: string, variables: Record<string, unknown>) => {
          if (query.includes('ProjectDeliveryItems')) {
            assert.equal(variables.number, projectNumber);
            assert.equal(variables.statusField, statusField);
            return Promise.resolve({
              organization: { projectV2: { items: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } } },
            });
          }
          if (query.includes('AddProjectDeliveryItem')) {
            return Promise.resolve({ addProjectV2ItemById: { item: { id: 'ITEM' } } });
          }
          if (query.includes('UpdateProjectDeliveryStatus')) {
            assert.equal(variables.optionId, 'S1');
            return Promise.resolve({ updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM' } } });
          }
          if (query.includes('ProjectDeliveryItemReadback')) {
            assert.equal(variables.statusField, statusField);
            return Promise.resolve({
              node: {
                content: { id: 'ISSUE' },
                fieldValueByName: { name: inProgressName, optionId: 'S1' },
                id: 'ITEM',
                isArchived: false,
                project: { id: 'project-node', number: projectNumber },
              },
            });
          }
          return Promise.reject(new Error('Unexpected synthetic GraphQL operation.'));
        };
        assert.deepEqual(
          await syncIssueProjectStatus({
            configuration: project,
            graphql: graphql as never,
            issueNodeId: 'ISSUE',
            org: owner,
            status: 'In Progress',
          }),
          { itemId: 'ITEM', status: 'In Progress' },
        );
        const settings = nativeIssueSettingsFromDeliveryConfig(loaded.config);
        const selectedPoints = settings.points.values.at(-1);
        const selectedPriority = settings.priority.values[0];
        assert.ok(selectedPoints !== undefined);
        assert.ok(selectedPriority !== undefined);
        const catalog = resolveNativeIssueFieldCatalog(
          [
            {
              data_type: 'single_select',
              id: Number(settings.points.databaseId),
              name: settings.points.name,
              options: [...settings.points.values].reverse().map((value) => ({ name: String(value) })),
            },
            {
              data_type: 'single_select',
              id: Number(settings.priority.databaseId),
              name: settings.priority.name,
              options: [...settings.priority.values].reverse().map((name) => ({ name })),
            },
          ],
          settings,
        );
        assert.equal(catalog.points.name, settings.points.name);
        assert.deepEqual(
          parseConfiguredNativeIssueMetadata(
            [
              {
                data_type: 'single_select',
                issue_field_id: Number(settings.points.databaseId),
                issue_field_name: settings.points.name,
                single_select_option: { name: String(selectedPoints) },
              },
              {
                data_type: 'single_select',
                issue_field_id: Number(settings.priority.databaseId),
                issue_field_name: settings.priority.name,
                single_select_option: { name: selectedPriority },
              },
            ],
            settings,
          ),
          { points: selectedPoints, priority: selectedPriority },
        );
        assert.doesNotThrow(() => {
          validateConfiguredNativeTracking({
            blockedBy: [17],
            config: loaded.config,
            issueNumber: 20,
            issueType: 'Defect',
            milestone: 3,
            parentIssueNumber: 15,
            points: selectedPoints,
            priority: selectedPriority,
          });
        });
      }
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it('rejects missing configuration, unsupported policy and role collisions without printing secrets', async () => {
    const base = syntheticConfig({ owner: 'sample', projectNumber: 7, repo: 'widget' });
    const temp = mkdtempSync(join(tmpdir(), 'delivery-invalid-'));
    try {
      await assert.rejects(loadDeliveryConfig(temp), /Missing repository delivery policy/u);
      assert.throws(
        () => parseDeliveryConfig({ ...base, policy: { ...base.policy, contract: 'wrong' } }),
        /policy.contract/u,
      );
      assert.throws(
        () =>
          parseDeliveryConfig({
            ...base,
            roles: { ...base.roles, reviewer: { ...base.roles.reviewer, identity: base.roles.author.identity } },
          }),
        /distinct/u,
      );
      assert.throws(
        () =>
          parseDeliveryConfig({
            ...base,
            roles: {
              ...base.roles,
              reviewer: { ...base.roles.reviewer, credentialEnv: base.roles.author.credentialEnv },
            },
          }),
        /environment names must be distinct/u,
      );
      assert.throws(
        () =>
          parseDeliveryConfig({
            ...base,
            native: {
              ...base.native,
              priority: { ...base.native.priority, databaseId: base.native.points.databaseId },
            },
          }),
        /field IDs must be distinct/u,
      );
      assert.throws(
        () => parseDeliveryConfig({ ...base, privateKey: 'synthetic-secret' }),
        (error) => {
          assert.doesNotMatch(String(error), /synthetic-secret/u);
          return true;
        },
      );
      const config = parseDeliveryConfig(base);
      assert.throws(
        () =>
          resolveProjectDeliveryConfiguration(
            { ...syntheticProject(config), viewerCanUpdate: false },
            { requireWritable: true, settings: projectSettingsFromDeliveryConfig(config) },
          ),
        /not writable/u,
      );
      git(['init', '--quiet', temp]);
      writeFileSync(join(temp, 'policy.mjs'), 'export const contract = "RepositoryDeliveryPolicy@1";\n');
      writeFileSync(
        join(temp, 'ai-delivery.config.json'),
        JSON.stringify(syntheticOverrides(parseDeliveryConfig(base))),
      );
      git(['add', 'ai-delivery.config.json'], { cwd: temp });
      await assert.rejects(loadDeliveryConfig(temp), /must be source-controlled/u);
      assert.throws(
        () => resolveDeliveryRoleCredentials({ config, env: {}, role: 'author' }),
        /Missing GitHub App credentials for author/u,
      );
      await assert.rejects(
        createDeliveryGitHubClients({ config, env: {}, identity: 'synthetic-reviewer', role: 'author' }),
        /requires the configured author identity/u,
      );
      await assert.rejects(
        createDeliveryGitHubClients({ config, env: {}, identity: 'personal', role: 'reviewer' }),
        /configured reviewer identity/u,
      );
      await assert.rejects(
        createDeliveryGitHubClients({ config, env: { GH_TOKEN: 'inert-token' }, identity: 'personal', role: 'author' }),
        /configured author identity/u,
      );
      await assert.rejects(
        createDeliveryGitHubClients({
          config,
          env: { GH_TOKEN: 'inert-token' },
          identity: 'synthetic-author',
          role: 'author',
        }),
        /Missing GitHub App credentials/u,
      );
      const personal = await createDeliveryGitHubClients({
        config,
        env: {},
        identity: 'personal',
        personalAuth: { enabled: true, token: 'inert-token' },
        role: 'author',
      });
      assert.equal(personal.authSource, 'personal');
      await assert.rejects(
        createDeliveryGitHubClients({
          config,
          env: { GH_TOKEN: 'inert-token' },
          identity: 'personal',
          personalAuth: { enabled: true },
          role: 'reviewer',
        }),
        /explicit personal author identity/u,
      );
      assert.throws(
        () =>
          assertDeliveryRolePermissions({
            permissions: { contents: 'read', issues: 'write', pull_requests: 'write' },
            role: 'author',
          }),
        /contents:write/u,
      );
      assert.throws(
        () =>
          assertDeliveryRolePermissions({
            permissions: { contents: 'write', issues: 'write', pull_requests: 'write' },
            role: 'author',
          }),
        /organization_projects:write/u,
      );
      const sameAppEnv = {
        AUTHOR_APP_ID: '101',
        AUTHOR_INSTALLATION_ID: '201',
        AUTHOR_KEY_PATH: join(temp, 'inert-author.pem'),
        REVIEWER_APP_ID: '101',
        REVIEWER_INSTALLATION_ID: '202',
        REVIEWER_KEY_PATH: join(temp, 'inert-reviewer.pem'),
      };
      await assert.rejects(
        createDeliveryGitHubClients({ config, env: sameAppEnv, identity: 'synthetic-author', role: 'author' }),
        /distinct GitHub App credentials/u,
      );
      assert.equal(
        evaluateCommandIdentityPolicy({
          commandName: 'pr:create',
          deliveryConfig: config,
          identity: 'synthetic-author',
        }).error,
        null,
      );
      assert.equal(
        evaluateCommandIdentityPolicy({
          commandName: 'pr:review',
          deliveryConfig: config,
          identity: 'synthetic-reviewer',
        }).error,
        null,
      );
      assert.match(
        evaluateCommandIdentityPolicy({
          commandName: 'pr:review',
          deliveryConfig: config,
          identity: 'synthetic-author',
        }).error ?? '',
        /configured reviewer identity/u,
      );
      assert.match(
        evaluateCommandIdentityPolicy({ commandName: 'pr:create', deliveryConfig: config, identity: 'personal' })
          .error ?? '',
        /personal-token override/u,
      );
      assert.throws(() => {
        validateConfiguredNativeTracking({ config, issueType: 'Task', points: 3, priority: 'High' });
      }, /Unsupported native Estimate/u);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  it('rejects a foreign cached field catalog before either configured native mutation', async () => {
    const config = parseDeliveryConfig(syntheticConfig({ owner: 'sample', projectNumber: 7, repo: 'widget' }));
    const settings = nativeIssueSettingsFromDeliveryConfig(config);
    const catalog = {
      points: { dataType: 'single_select' as const, id: 201, name: settings.points.name },
      priority: { dataType: 'single_select' as const, id: 102, name: settings.priority.name },
    };
    let mutations = 0;
    const rest = {
      request: (route: string) => {
        if (route.startsWith('GET ')) {
          return Promise.resolve({
            data: [
              {
                data_type: 'single_select',
                issue_field_id: 101,
                issue_field_name: settings.points.name,
                single_select_option: { name: '1' },
              },
            ],
          });
        }
        mutations += 1;
        return Promise.resolve({ data: [] });
      },
    };
    const input = { catalog, issueNumber: 17, org: 'sample', owner: 'sample', repo: 'widget', rest, settings };
    await assert.rejects(
      setConfiguredNativeIssueMetadata({ ...input, metadata: { points: 1 } }),
      /catalog does not match/u,
    );
    await assert.rejects(clearConfiguredNativeIssuePoints(input), /catalog does not match/u);
    assert.equal(mutations, 0);
  });
});
