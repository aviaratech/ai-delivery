import assert from 'node:assert/strict';
import { test } from 'vitest';
import { getAiDeliveryMcpTool } from './mcp/tools.js';

test('read-only delivery health exposes an explicit bounded window through MCP', () => {
  const tool = getAiDeliveryMcpTool('delivery_health' as Parameters<typeof getAiDeliveryMcpTool>[0]);
  assert.ok(tool, 'delivery_health must be a public tool');
  assert.equal(tool.commandName, 'health');
  assert.equal(
    tool.inputSchema.safeParse({ repo: 'example/widget', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' })
      .success,
    true,
  );
  assert.equal(tool.inputSchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }).success, false);
});

import { deliveryHealth } from './services/deliveryHealthService.js';
import { historicalActivity, type IssueHistoryEvent } from './github/issueHistory.js';
import { issue63Fixture } from './fixtures/issue63.js';
const window = { repo: 'example/widget', from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z' };
const event = (
  type: IssueHistoryEvent['__typename'],
  id: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) => ({
  __typename: type,
  id,
  createdAt,
  ...extra,
});

test('health counts native events, deduplicates closed issues and records historical unknowns without writes', async () => {
  const f = issue63Fixture();
  f.history.push(
    event('AddedToProjectV2Event', 'M', '2026-01-01T00:00:00Z', { project: { id: 'PROJECT' } }),
    event('ProjectV2ItemStatusChangedEvent', 'S', '2026-01-01T01:00:00Z', {
      project: { id: 'PROJECT' },
      status: 'Active',
    }),
    event('BlockedByAddedEvent', 'A', '2026-01-02T01:00:00Z'),
    event('ClosedEvent', 'C1', '2026-01-02T02:00:00Z'),
    event('ClosedEvent', 'C2', '2026-01-02T03:00:00Z'),
    event('BlockedByAddedEvent', 'OUT', '2026-01-03T00:00:00Z'),
  );
  f.histories.set(18, []);
  f.histories.set(19, []);
  const result = await deliveryHealth(f.context, window);
  assert.equal(result.counts.opened, 0);
  assert.equal(result.counts.closed, 1);
  assert.equal(result.counts.active, 1);
  assert.deepEqual(result.counts.blockerAdditions, { total: 1, active: 1, inactive: 0, unknown: 0 });
  assert.equal(result.oldestActive[0]?.number, 17);
  assert.equal(result.snapshot.atomic, false);
  assert.deepEqual(f.writes, []);
  const unknown = issue63Fixture();
  unknown.history.push(event('BlockedByAddedEvent', 'A', '2026-01-02T01:00:00Z'));
  assert.equal((await deliveryHealth(unknown.context, window)).counts.blockerAdditions.unknown, 1);
});
test('historical classification requires membership and the latest preceding status with no equal timestamp guess', () => {
  const add = event('BlockedByAddedEvent', 'A', '2026-01-02T01:00:00Z');
  const membership = event('AddedToProjectV2Event', 'M', '2026-01-01T00:00:00Z', { project: { id: 'PROJECT' } });
  const active = event('ProjectV2ItemStatusChangedEvent', 'S1', '2026-01-01T01:00:00Z', {
    project: { id: 'PROJECT' },
    status: 'Active',
  });
  const inactive = event('ProjectV2ItemStatusChangedEvent', 'S2', '2026-01-01T02:00:00Z', {
    project: { id: 'PROJECT' },
    status: 'Queued',
  });
  assert.equal(
    historicalActivity({ complete: true, events: [membership, active, inactive] }, add, 'PROJECT', 'Active', [
      'Active',
      'Queued',
      'Waiting',
      'Shipped',
    ]),
    'inactive',
  );
  assert.equal(historicalActivity({ complete: true, events: [active] }, add, 'PROJECT', 'Active'), 'unknown');
  assert.equal(
    historicalActivity({ complete: false, events: [membership, active] }, add, 'PROJECT', 'Active'),
    'unknown',
  );
  assert.equal(
    historicalActivity(
      {
        complete: true,
        events: [
          membership,
          active,
          event('RemovedFromProjectV2Event', 'R', '2026-01-01T03:00:00Z', { project: { id: 'PROJECT' } }),
        ],
      },
      add,
      'PROJECT',
      'Active',
    ),
    'unknown',
  );
  assert.equal(
    historicalActivity(
      { complete: true, events: [membership, active, { ...inactive, createdAt: add.createdAt }] },
      add,
      'PROJECT',
      'Active',
    ),
    'unknown',
  );
});
test('health limits and timeline failures produce partial observed counts', async () => {
  const f = issue63Fixture();
  f.controls.timelineIncomplete = true;
  f.history.push(event('BlockedByAddedEvent', 'A', '2026-01-02T01:00:00Z'));
  const result = await deliveryHealth(f.context, { ...window, maxIssues: 1, maxTimelinePages: 1 });
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.issuesObserved, 1);
  assert.equal(result.counts.blockerAdditions.unknown, 1);
  assert.ok(result.completeness.limitations.length >= 2);
  assert.deepEqual(f.writes, []);
  await assert.rejects(deliveryHealth(f.context, { ...window, repo: 'wrong/repo' }), /selector/u);
  await assert.rejects(deliveryHealth(f.context, { ...window, to: window.from }));
});

test('health excludes PRs, includes the start boundary, orders oldest ties and exposes missing anchors', async () => {
  const f = issue63Fixture();
  f.rows.get(17)!.created_at = window.from;
  f.statuses.set(18, 'Active');
  Object.assign(f.rows.get(19)!, { pull_request: {} });
  f.histories.set(17, [event('BlockedByAddedEvent', 'A17', '2026-01-02T00:00:00Z')]);
  f.histories.set(18, []);
  const result = await deliveryHealth(f.context, window);
  assert.equal(result.counts.opened, 1);
  assert.equal(result.completeness.issuesObserved, 2);
  assert.deepEqual(
    result.oldestActive.map((issue) => issue.number),
    [18, 17],
  );
  assert.equal(result.completeness.metricCoverage.historicalActivity, false);
  assert.equal(result.completeness.complete, false);
  assert.match(result.historicalUnknownReasons[0]!.reason, /membership/u);
});
test('unidentified Project evidence remains unknown and current status failures are explicit partial results', async () => {
  const f = issue63Fixture();
  f.history.push(
    event('AddedToProjectV2Event', 'M', '2026-01-01T00:00:00Z', { project: null }),
    event('BlockedByAddedEvent', 'A', '2026-01-02T01:00:00Z'),
  );
  f.controls.missingProjectIssue = 17;
  const result = await deliveryHealth(f.context, window);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.counts.currentStatusUnknown, 1);
  assert.equal(result.counts.blockerAdditions.unknown, 1);
  assert.ok(result.completeness.limitations.some((value) => value.scope === 'current Project status'));
  assert.match(result.historicalUnknownReasons[0]!.reason, /Project identity/u);
});

test('future-ending windows refuse before read-only collection begins', async () => {
  const f = issue63Fixture();
  let calls = 0;
  const original = f.context.clients.graphql;
  f.context.clients.graphql = (async () => {
    calls++;
    throw new Error('Unexpected collection');
  }) as unknown as typeof original;
  await assert.rejects(
    deliveryHealth(f.context, {
      repo: 'example/widget',
      from: new Date(Date.now() - 1000).toISOString(),
      to: new Date(Date.now() + 86400000).toISOString(),
    }),
    /collection time/u,
  );
  assert.equal(calls, 0);
});
test('unsupported historical status and equal instants with different ISO precision are unknown', () => {
  const member = event('AddedToProjectV2Event', 'M', '2026-01-01T00:00:00Z', { project: { id: 'PROJECT' } });
  const status = event('ProjectV2ItemStatusChangedEvent', 'S', '2026-01-01T01:00:00Z', {
    project: { id: 'PROJECT' },
    status: 'FormerActiveName',
  });
  const add = event('BlockedByAddedEvent', 'A', '2026-01-02T00:00:00Z');
  assert.equal(
    historicalActivity({ complete: true, events: [member, status] }, add, 'PROJECT', 'Active', [
      'Active',
      'Queued',
      'Waiting',
      'Shipped',
    ]),
    'unknown',
  );
  const active = { ...status, status: 'Active' };
  const sameInstant = { ...status, id: 'S2', status: 'Queued', createdAt: '2026-01-01T01:00:00.000Z' };
  assert.equal(
    historicalActivity({ complete: true, events: [member, active, sameInstant] }, add, 'PROJECT', 'Active', [
      'Active',
      'Queued',
    ]),
    'unknown',
  );
});
