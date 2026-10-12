import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test, vi } from 'vitest';
import * as githubClients from './github/client.js';
import * as repository from './github/repo.js';
import * as settings from './config/deliveryConfig.js';
import * as issues from './issue.js';
import { inertTarget, type PolicyState } from './fixtures/inertTarget.js';

type Fixture = ReturnType<typeof inertTarget>;
type Connection = Awaited<ReturnType<Fixture['connect']>>;

function assertRealContext() {
  assert.equal(vi.isMockFunction(settings.loadDeliverySettings), false);
  assert.equal(vi.isMockFunction(settings.loadDeliveryConfig), false);
  assert.equal(vi.isMockFunction(issues.loadDeliveryContext), false);
}

/** Extend only the fixture's synthetic GitHub timeline port; discovery and health stay real. */
function healthTimeline(f: Fixture) {
  const factory = vi.mocked(githubClients.createDeliveryGitHubClients);
  const create = factory.getMockImplementation();
  assert.ok(create);
  f.state.projectOption = 'STATUS-1';
  factory.mockImplementation(async (input) => {
    const clients = await create(input);
    const graphql = (async (query: string, variables: Record<string, unknown> = {}) => {
      if (!query.includes('NativeIssueHistory')) return clients.graphql(query, variables);
      assert.equal(variables.number, 17);
      f.calls.push({ name: 'NativeIssueHistory', input: variables });
      return {
        repository: {
          nameWithOwner: 'example/widget',
          issue: {
            id: 'ISSUE17',
            number: 17,
            repository: { nameWithOwner: 'example/widget' },
            timelineItems: {
              nodes: [
                {
                  __typename: 'AddedToProjectV2Event',
                  id: 'MEMBER',
                  createdAt: '2026-01-01T00:00:00Z',
                  project: { id: 'PROJECT-1' },
                },
                {
                  __typename: 'ProjectV2ItemStatusChangedEvent',
                  id: 'ACTIVE',
                  createdAt: '2026-01-01T01:00:00Z',
                  project: { id: 'PROJECT-1' },
                  status: 'Active',
                },
                { __typename: 'BlockedByAddedEvent', id: 'BLOCKER', createdAt: '2026-01-02T01:00:00Z' },
                { __typename: 'ClosedEvent', id: 'CLOSED', createdAt: '2026-01-02T02:00:00Z' },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    }) as typeof clients.graphql;
    return { ...clients, graphql };
  });
}

for (const kind of ['tracked', 'edited'] satisfies PolicyState[]) {
  test(`public MCP health reaches its bounded owner with real context and ${kind} policy`, async ({ signal }) => {
    const f = inertTarget(signal);
    let connection: Connection | undefined;
    try {
      f.policy(kind);
      assertRealContext();
      healthTimeline(f);
      connection = await f.connect();
      const result = await connection.call('delivery_health', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
        maxIssues: 1,
        maxTimelinePages: 1,
        maxProjectPages: 1,
        oldestLimit: 1,
      });
      assert.notEqual(result.response.isError, true, result.text);
      assert.equal(result.value!.repository, 'example/widget');
      assert.deepEqual(result.value!.counts, {
        opened: 1,
        closed: 1,
        active: 1,
        currentStatusUnknown: 0,
        blockerAdditions: { total: 1, active: 1, inactive: 0, unknown: 0 },
      });
      assert.equal((result.value!.completeness as { complete: boolean }).complete, true);
      assert.equal((result.value!.oldestActive as { number: number }[])[0]!.number, 17);
      assert.ok(f.calls.some((call) => call.name === 'issues.listForRepo'));
      assert.ok(f.calls.some((call) => call.name === 'ProjectDeliveryItems'));
      assert.equal(f.calls.filter((call) => call.name === 'NativeIssueHistory').length, 1);
      assert.equal(
        f.calls.some((call) => /create|update|merge|^mutation/iu.test(call.name)),
        false,
      );
      assert.equal(f.comments.length, 0);
      f.assertInert();
    } finally {
      await f.dispose(connection);
    }
  }, 5_000);

  test(`public MCP omitted-repo fallback reaches actual origin discovery with ${kind} policy`, async ({ signal }) => {
    const descriptor = Object.getOwnPropertyDescriptor(InMemoryTransport.prototype, 'send');
    assert.ok(descriptor);
    assert.equal(typeof descriptor.value, 'function');
    const send = descriptor.value as InMemoryTransport['send'];
    const f = inertTarget(signal);
    // A spy delegates to the original resolver: it observes real protected system-Git origin probes.
    const origin = vi.spyOn(repository, 'resolveRepoFromRemote');
    const transport = vi.spyOn(InMemoryTransport.prototype, 'send');
    const delivered: Record<string, unknown>[] = [];
    transport.mockImplementation(function (this: InMemoryTransport, message, options) {
      if ('method' in message && message.method === 'tools/call' && message.params?.name === 'issue_info') {
        // Serialize the actual request sent to the paired transport, not an unrelated copy.
        const request = JSON.parse(JSON.stringify(message)) as typeof message;
        const args = request.params?.arguments as Record<string, unknown>;
        assert.deepEqual(args, { issueNumber: 17 });
        assert.equal(Object.hasOwn(args, 'repo'), false);
        delivered.push(args);
        return send.call(this, request, options);
      }
      return send.call(this, message, options);
    });
    let connection: Connection | undefined;
    try {
      f.policy(kind);
      assertRealContext();
      connection = await f.connect();
      // The delegating transport serializes this actual request and witnesses repo omission.
      const input: Record<string, unknown> = { issueNumber: 17, repo: undefined };
      const result = await connection.call('issue_info', input);
      assert.deepEqual(delivered, [{ issueNumber: 17 }]);
      assert.notEqual(result.response.isError, true, result.text);
      assert.equal(result.value!.issueNumber, 17);
      assert.equal(result.value!.points, 2);
      assert.deepEqual(origin.mock.calls, [[f.root, 'origin']]);
      assert.deepEqual(
        origin.mock.results.map(({ type, value }) => ({ type, value: value as unknown })),
        [{ type: 'return', value: { owner: 'example', repo: 'widget' } }],
      );
      assert.ok(f.calls.some((call) => call.name === 'issues.get'));
      f.assertInert();
    } finally {
      try {
        await f.dispose(connection);
      } finally {
        transport.mockRestore();
        origin.mockRestore();
      }
    }
  }, 5_000);
}
