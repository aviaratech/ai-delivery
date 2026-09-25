import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { assertDeliveryRolePermissions, createDeliveryGitHubClients } from '../github/client.js';
import { evaluateCommandIdentityPolicy } from '../github/commandIdentityPolicy.js';
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
    schemaVersion: 'ai-delivery.config@1',
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
        writeFileSync(join(root, 'policy.mjs'), 'export const contract = "RepositoryDeliveryPolicy@1";\n');
        writeFileSync(
          join(root, 'ai-delivery.config.json'),
          JSON.stringify(syntheticConfig({ owner, projectNumber, repo })),
        );
        git(['add', 'policy.mjs', 'ai-delivery.config.json'], { cwd: root });
        const loaded = loadDeliveryConfig(root);
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
      assert.throws(() => loadDeliveryConfig(temp), /Missing repository-root ai-delivery.config.json/u);
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
      writeFileSync(join(temp, 'ai-delivery.config.json'), JSON.stringify(base));
      git(['add', 'ai-delivery.config.json'], { cwd: temp });
      assert.throws(() => loadDeliveryConfig(temp), /must be source-controlled/u);
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
        /personal-token fallback/u,
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
