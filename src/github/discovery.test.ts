import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { loadDeliveryConfig, type DeliveryOverrides } from '../config/deliveryConfig.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig, syntheticOverrides } from '../fixtures/discovery.js';
import { discoverDeliveryRouting, type DiscoveryClients } from './discovery.js';
import { resolveRepoFromRemote } from './repo.js';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function intercept(
  change: (query: string, variables: Record<string, unknown>, result: Record<string, unknown>) => unknown,
): DiscoveryClients {
  const base = syntheticDiscoveryClients();
  const graphql = async (query: string, variables: Record<string, unknown>): Promise<unknown> =>
    change(query, variables, record(await base.graphql(query, variables)));
  return { graphql: graphql as DiscoveryClients['graphql'] };
}
const overrides = syntheticOverrides(syntheticDiscoveryConfig);
const { project: _project, ...linked } = overrides;
const discover = (clients = syntheticDiscoveryClients(), selected: DeliveryOverrides = linked) =>
  discoverDeliveryRouting({ clients, repository: 'example/widget', overrides: selected });

test('discovery selects one linked Project and exposes exact native bindings and selection source', async () => {
  const result = await discover();
  assert.equal(result.repository, 'example/widget');
  assert.equal(result.projectSource, 'linked');
  assert.equal(result.projectId, 'PROJECT-1');
  assert.equal(result.native.points.databaseId, '101');
  assert.equal(result.statusOptionIds['In Progress'], 'STATUS-1');
  assert.equal(result.native.project.statuses.todo, 'Queued');
});

test('explicit selection does not depend on linked Projects', async () => {
  const result = await discover(
    intercept((query, _variables, result) => {
      assert.ok(!query.includes('projectsV2(first:'));
      return result;
    }),
    overrides,
  );
  assert.equal(result.projectSource, 'explicit');
});

test('all linked Project pages are read before choosing, including an empty first page', async () => {
  let pages = 0;
  const result = await discover(
    intercept((query, variables, result) => {
      if (!query.includes('projectsV2(first:')) return result;
      pages++;
      if (variables.cursor === null)
        return { repository: { projectsV2: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } } } };
      assert.equal(variables.cursor, 'next');
      return result;
    }),
  );
  assert.equal(pages, 2);
  assert.equal(result.projectId, 'PROJECT-1');
});

test('zero or multiple compatible Projects refuse selection before any mutation', async () => {
  for (const count of [0, 2]) {
    await assert.rejects(
      discover(
        intercept((query, variables, result) => {
          assert.ok(!query.includes('mutation'));
          if (query.includes('projectsV2(first:')) {
            const connection = record(record(result.repository).projectsV2);
            const [first] = connection.nodes as Record<string, unknown>[];
            connection.nodes = count === 0 ? [] : [first, { ...first, id: 'PROJECT-2', number: 2 }];
          }
          if (query.includes('query ProjectDeliveryConfiguration')) {
            const project = record(record(result.organization).projectV2);
            project.number = variables.number;
            project.id = `PROJECT-${String(variables.number)}`;
          }
          return result;
        }),
      ),
      new RegExp(`Discovered ${count} compatible linked Projects`, 'u'),
    );
  }
});

test('permission, partial-page and cursor failures never fall back to a candidate already found', async () => {
  await assert.rejects(
    discover(
      intercept((query, variables, result) => {
        if (query.includes('projectsV2(first:')) {
          if (variables.cursor !== null) throw new Error('Forbidden on second page');
          record(record(result.repository).projectsV2).pageInfo = { hasNextPage: true, endCursor: 'next' };
        }
        return result;
      }),
    ),
    /Forbidden/u,
  );
  await assert.rejects(
    discover(
      intercept((query, _variables, result) => {
        if (query.includes('projectsV2(first:')) record(record(result.repository).projectsV2).nodes = [null];
        return result;
      }),
    ),
    /Incomplete/u,
  );
  await assert.rejects(
    discover(
      intercept((query, _variables, result) => {
        if (query.includes('projectsV2(first:'))
          record(record(result.repository).projectsV2).pageInfo = { hasNextPage: true, endCursor: null };
        return result;
      }),
    ),
    /cursor/u,
  );
  await assert.rejects(
    discover(
      intercept((query, _variables, result) => {
        if (query.includes('query ProjectDeliveryConfiguration'))
          record(record(result.organization).projectV2).viewerCanUpdate = false;
        return result;
      }),
    ),
    /not writable/u,
  );
});

test('partial Project field metadata cannot exclude a candidate and manufacture uniqueness', async () => {
  for (const missing of ['id', 'name', 'fullDatabaseId', 'options']) {
    await assert.rejects(
      discover(
        intercept((query, variables, result) => {
          if (query.includes('projectsV2(first:')) {
            const connection = record(record(result.repository).projectsV2);
            const [first] = connection.nodes as Record<string, unknown>[];
            connection.nodes = [first, { ...first, id: 'PROJECT-2', number: 2 }];
          }
          if (query.includes('query ProjectDeliveryConfiguration') && variables.number === 2) {
            const project = record(record(result.organization).projectV2);
            project.id = 'PROJECT-2';
            project.number = 2;
            const fields = record(project.fields).nodes as Record<string, unknown>[];
            const bound = fields.find((field) => field.isIssueField === true);
            assert.ok(bound);
            delete record(bound.issueField)[missing];
          }
          return result;
        }),
      ),
      /omitted|malformed/u,
    );
  }
});

test('forks require an explicit remote choice and repository identity must agree', async () => {
  const fork = intercept((query, _variables, result) => {
    if (query.includes('query DeliveryRepository')) record(result.repository).isFork = true;
    return result;
  });
  await assert.rejects(discover(fork), /fork requires an explicit remote/u);
  assert.equal((await discover(fork, { ...linked, remote: 'origin' })).repository, 'example/widget');
  await assert.rejects(
    discover(
      intercept((query, _variables, result) => {
        if (query.includes('query DeliveryRepository')) record(result.repository).nameWithOwner = 'other/widget';
        return result;
      }),
    ),
    /does not match/u,
  );
});

test('custom meanings need explicit mapping and independent Project fields cannot masquerade as native fields', async () => {
  await assert.rejects(discover(syntheticDiscoveryClients(), { project: 1 }), /unambiguous native/u);
  await assert.rejects(
    discover(
      intercept((query, _variables, result) => {
        if (query.includes('query ProjectDeliveryConfiguration')) {
          const fields = record(record(record(result.organization).projectV2).fields).nodes as Record<
            string,
            unknown
          >[];
          const points = fields.find((field) => field.name === 'Estimate');
          assert.ok(points);
          points.isIssueField = false;
        }
        return result;
      }),
      overrides,
    ),
    /organization issue field/u,
  );
});

test('standard discovery needs no JSON file and effective Project identity changes the admission digest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-discovery-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/example/widget.git');
    const roles = Object.fromEntries(
      ['author', 'reviewer'].map((role) => [
        role,
        {
          identity: role,
          credentialEnv: {
            appId: `${role.toUpperCase()}_APP_ID`,
            installationId: `${role.toUpperCase()}_INSTALLATION_ID`,
            privateKeyPath: `${role.toUpperCase()}_KEY_PATH`,
          },
        },
      ]),
    );
    writeFileSync(
      join(root, 'ai-delivery.policy.mjs'),
      `export const deliverySettings = ${JSON.stringify({
        roles,
        commandPolicy: {
          checks: {
            format: 'REQUIRED',
            gitClean: 'REQUIRED',
            lint: 'REQUIRED',
            test: 'REQUIRED',
            typecheck: 'REQUIRED',
          },
          timeoutsMs: { lint: 1000, test: 1000, typecheck: 1000 },
        },
      })};`,
    );
    git('add', 'ai-delivery.policy.mjs');
    const standard = structuredClone(syntheticDiscoveryConfig);
    standard.native.points.name = 'Points';
    standard.native.priority.name = 'Priority';
    standard.native.project.statusField = 'Status';
    standard.native.project.statuses = { todo: 'Todo', inProgress: 'In Progress', blocked: 'Blocked', done: 'Done' };
    const clients = syntheticDiscoveryClients(standard);
    const first = await loadDeliveryConfig(root, { clients });
    assert.equal(first.configPath, null);
    assert.equal(first.routing.projectSource, 'linked');
    const changed = structuredClone(standard);
    changed.native.project.number = 2;
    const second = await loadDeliveryConfig(root, { clients: syntheticDiscoveryClients(changed) });
    assert.notEqual(first.configDigest, second.configDigest);
    git('remote', 'add', 'upstream', 'https://github.com/upstream/widget.git');
    assert.throws(() => resolveRepoFromRemote(root), /multiple remotes/u);
    assert.deepEqual(resolveRepoFromRemote(root, 'origin'), { owner: 'example', repo: 'widget' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
