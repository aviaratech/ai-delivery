import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { executeTool } from './dispatch.js';
import { renderIssueBody } from './issueContract.js';
import * as github from './github/client.js';
import { issue63Fixture } from './fixtures/issue63.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig } from './fixtures/discovery.js';

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const execution = { repoRoot: '/unrelated', repo: 'example/widget' };
const routes = ['dispatch', 'MCP'] as const;
type Route = (typeof routes)[number];
type Tool = 'issue_info' | 'issue_update';
type NativeLabel = string | { name: string };

function fixture(
  labels: NativeLabel[] = [],
  milestone: { id: number; number: number } | null = null,
  metadata?: { points: number | null; issueType: string | null },
) {
  const f = issue63Fixture();
  const native = Object.assign(f.rows.get(17)!, { labels, milestone });
  const nativeMetadata = metadata ?? { points: 2, issueType: 'Task' };
  if (nativeMetadata.issueType === null) Reflect.deleteProperty(native, 'type');
  else native.type = { name: nativeMetadata.issueType };
  const metadataWrites: unknown[] = [];
  const originalRequest = f.context.clients.rest.request;
  const values = () =>
    nativeMetadata.points === null
      ? []
      : [
          {
            issue_field_id: 101,
            issue_field_name: 'Estimate',
            data_type: 'single_select',
            value: String(nativeMetadata.points),
            single_select_option: { name: String(nativeMetadata.points) },
          },
        ];
  f.context.clients.rest.request = (async (route: string, input: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') return { data: values() };
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') {
      const changes = input.issue_field_values as { field_id: number; value: string }[];
      metadataWrites.push(structuredClone(changes));
      for (const change of changes) if (change.field_id === 101) nativeMetadata.points = Number(change.value);
      return { data: values() };
    }
    return originalRequest(route, input);
  }) as typeof originalRequest;

  const available = ['Needs Review', 'MixedCase'];
  f.context.clients.rest.issues.listLabelsForRepo = vi.fn(async () => ({
    data: available.map((name) => ({ name })),
  })) as unknown as typeof f.context.clients.rest.issues.listLabelsForRepo;
  f.context.clients.rest.issues.update = vi.fn(async (input: Record<string, unknown>) => {
    f.writes.push('content');
    const { labels: assignedLabels, milestone: assignedMilestone, type, ...content } = input;
    Object.assign(native, content);
    if (type !== undefined) native.type = { name: type as string };
    if (assignedLabels !== undefined) native.labels = (assignedLabels as string[]).map((name) => ({ name }));
    if (assignedMilestone !== undefined)
      native.milestone = assignedMilestone === null ? null : { id: 9000, number: assignedMilestone as number };
    return { data: { ...native } };
  }) as unknown as typeof f.context.clients.rest.issues.update;

  const discovery = syntheticDiscoveryClients();
  const nativeGraphql = f.context.clients.graphql;
  f.context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
    if (query.includes('IssueClosureReadback')) {
      const reason: unknown = Reflect.get(native, 'state_reason');
      return {
        repository: {
          issue: {
            number: native.number,
            repository: { nameWithOwner: 'example/widget' },
            state: native.state.toUpperCase(),
            stateReason: typeof reason === 'string' ? reason.toUpperCase() : null,
            duplicateOf: null,
          },
        },
      };
    }

    if (
      /DeliveryRepository|ProjectDeliveryConfiguration|issueFields\(first:|issueTypes\(first:|projectsV2\(first:/u.test(
        query,
      )
    ) {
      const result = await discovery.graphql(query, variables);
      if (query.includes('ProjectDeliveryConfiguration')) {
        const project = (result as { organization: { projectV2: { id: string; fields: { nodes: unknown[] } } } })
          .organization.projectV2;
        project.id = 'PROJECT';
        const status = project.fields.nodes[0] as { options: { id: string; name: string }[] };
        const ids: Record<string, string> = { Queued: 'TODO', Active: 'ACTIVE', Waiting: 'BLOCKED', Shipped: 'DONE' };
        for (const option of status.options) option.id = ids[option.name]!;
      }
      return result;
    }
    if (query.includes('UpdateProjectDeliveryStatus') && variables.optionId === 'DONE') {
      f.statuses.set(Number(String(variables.itemId).replace('ITEM', '')), 'Shipped');
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
    }
    const result = await nativeGraphql(query, variables);
    if (query.includes('ProjectDeliveryItems'))
      for (const item of (
        result as {
          organization: { projectV2: { items: { nodes: { fieldValueByName: { name: string; optionId: string } }[] } } };
        }
      ).organization.projectV2.items.nodes)
        if (item.fieldValueByName.name === 'Shipped') item.fieldValueByName.optionId = 'DONE';
    if (
      query.includes('ProjectDeliveryItemReadback') &&
      f.statuses.get(Number(String(variables.itemId).replace('ITEM', ''))) === 'Shipped'
    )
      Object.assign((result as { node: { fieldValueByName: object } }).node.fieldValueByName, {
        name: 'Shipped',
        optionId: 'DONE',
      });
    if (metadata !== undefined && query.includes('blockedBy(') && variables.number === 17)
      (result as { repository: { issue: { parent: unknown } } }).repository.issue.parent = {
        id: 'ISSUE2',
        number: 2,
        repository: { nameWithOwner: 'example/widget' },
      };
    return result;
  }) as typeof f.context.clients.graphql;
  vi.spyOn(github, 'createDeliveryGitHubClients').mockResolvedValue(f.context.clients);
  const root = mkdtempSync(join(tmpdir(), 'issue-info-readback-'));
  temporaryRoots.push(root);
  const configPath = join(root, 'auth-settings.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 'ai-delivery.user@1',
      roles: {
        author: { identity: 'author', authSource: 'personal', credentialEnv: { token: 'SYNTHETIC_AUTHOR' } },
        reviewer: {
          identity: 'reviewer',
          credentialEnv: {
            appId: 'SYNTHETIC_APP',
            installationId: 'SYNTHETIC_INSTALLATION',
            privateKeyPath: 'SYNTHETIC_KEY',
          },
        },
      },
      project: 1,
      pointsField: 'Estimate',
      priorityField: 'Urgency',
      statusField: 'Flow',
      statuses: syntheticDiscoveryConfig.native.project.statuses,
      issueTypes: ['Task'],
      checkoutRoots: [],
    }),
  );
  vi.stubEnv('AI_DELIVERY_CONFIG', configPath);
  return { ...f, native, metadataWrites };
}

async function caller(route: Route) {
  if (route === 'dispatch')
    return {
      call: async (name: Tool, args: Record<string, unknown>) =>
        (await executeTool(name, args, execution)) as Record<string, unknown>,
      close: async () => {},
    };
  const server = createAiDeliveryMcpServer(execution);
  const client = new Client({ name: 'issue-readback-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: async (name: Tool, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: { repo: execution.repo, ...args } });
      const content = result.content as { type: string; text: string }[];
      assert.equal(content[0]!.type, 'text');
      if (result.isError) throw new Error(content[0]!.text);
      return JSON.parse(content[0]!.text) as Record<string, unknown>;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

for (const route of routes) {
  for (const representation of ['strings', 'objects'] as const) {
    test(`${route} info returns ${representation} label names and repository milestone number`, async () => {
      const names = ['Needs Review', 'MixedCase'];
      const f = fixture(representation === 'strings' ? names : names.map((name) => ({ name })), {
        id: 9000,
        number: 7,
      });
      const api = await caller(route);
      try {
        const result = await api.call('issue_info', { issueNumber: 17 });
        assert.deepEqual(result.labels, names);
        assert.equal(result.milestone, 7);
        assert.deepEqual(f.writes, []);
      } finally {
        await api.close();
      }
    });
  }

  test(`${route} info returns empty labels and null for an unassigned milestone`, async () => {
    fixture();
    const api = await caller(route);
    try {
      const result = await api.call('issue_info', { issueNumber: 17 });
      assert.deepEqual(result.labels, []);
      assert.equal(result.milestone, null);
    } finally {
      await api.close();
    }
  });

  test(`${route} info tolerates omitted native labels and milestone`, async () => {
    const f = fixture();
    Reflect.deleteProperty(f.native, 'labels');
    Reflect.deleteProperty(f.native, 'milestone');
    const api = await caller(route);
    try {
      const result = await api.call('issue_info', { issueNumber: 17 });
      assert.deepEqual(result.labels, []);
      assert.equal(result.milestone, null);
    } finally {
      await api.close();
    }
  });

  test(`${route} update readback preserves native set, omitted and cleared values`, async () => {
    const f = fixture();
    const api = await caller(route);
    try {
      const set = await api.call('issue_update', { issueNumber: 17, labels: ['MixedCase'], milestone: 7 });
      assert.deepEqual(set.labels, ['MixedCase']);
      assert.equal(set.milestone, 7);
      assert.deepEqual(f.native.labels, [{ name: 'MixedCase' }]);
      assert.deepEqual(f.native.milestone, { id: 9000, number: 7 });
      const read = await api.call('issue_info', { issueNumber: 17 });
      assert.deepEqual(read.labels, set.labels);
      assert.equal(read.milestone, set.milestone);
      const omitted = await api.call('issue_update', { issueNumber: 17 });
      assert.deepEqual(omitted.labels, ['MixedCase']);
      assert.equal(omitted.milestone, 7);
      assert.deepEqual(f.native.labels, [{ name: 'MixedCase' }]);
      assert.deepEqual(f.native.milestone, { id: 9000, number: 7 });
      const cleared = await api.call('issue_update', { issueNumber: 17, labels: [], milestone: null });
      assert.deepEqual(cleared.labels, []);
      assert.equal(cleared.milestone, null);
      assert.deepEqual(f.native.labels, []);
      assert.equal(f.native.milestone, null);
      const after = await api.call('issue_info', { issueNumber: 17 });
      assert.deepEqual(after.labels, []);
      assert.equal(after.milestone, null);
    } finally {
      await api.close();
    }
  });

  test(`${route} unknown label still refuses before native mutation`, async () => {
    const f = fixture(['Needs Review'], { id: 9000, number: 7 });
    const api = await caller(route);
    try {
      await assert.rejects(
        api.call('issue_update', { issueNumber: 17, labels: ['Unknown Label'], milestone: 8 }),
        /Unknown repository label/u,
      );
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.native.labels, ['Needs Review']);
      assert.deepEqual(f.native.milestone, { id: 9000, number: 7 });
    } finally {
      await api.close();
    }
  });
}

// Replay the documented before/patch/readback combination from #224;
// repository identifiers and status prose are deidentified, not historical-writer attribution.
for (const mode of ['recorded-close', 'divergent-history'] as const) {
  test(`MCP ${mode} preserves omitted native metadata and relationships`, async () => {
    const points = mode === 'recorded-close' ? null : 2;
    const issueType = mode === 'recorded-close' ? null : 'Bug';
    const f = fixture([], null, { points, issueType });
    if (mode === 'divergent-history')
      f.native.body = renderIssueBody({
        ...f.ready,
        points: 1,
        bug: {
          steps: ['Update status.'],
          expected: 'Keep native fields.',
          actual: 'Rewrites native fields.',
          reproducibility: 'Every update.',
          environment: 'Synthetic MCP server.',
        },
      });
    const api = await caller('MCP');
    try {
      const before = await api.call('issue_info', { issueNumber: 17 });
      const patch = mode === 'recorded-close' ? { state: 'closed', closeReason: 'completed' } : {};
      await api.call('issue_update', {
        issueNumber: 17,
        ...patch,
        status: { nextMilestone: 'Complete', latestJournal: 'Recorded display update.' },
        preserveHistory: true,
      });
      const after = await api.call('issue_info', { issueNumber: 17 });
      assert.equal(after.points ?? null, points);
      assert.equal(after.issueType, issueType);
      assert.deepEqual(after.fields, before.fields);
      assert.deepEqual(after.blockedBy, before.blockedBy);
      assert.equal(after.parentIssueNumber, before.parentIssueNumber);
      assert.deepEqual(f.metadataWrites, []);
    } finally {
      await api.close();
    }
  });
}

test('MCP explicit native metadata still updates and configured-value refusals write nothing', async () => {
  const f = fixture([], null, { points: null, issueType: null });
  const api = await caller('MCP');
  try {
    await api.call('issue_update', { issueNumber: 17, points: 2, issueType: 'Task' });
    const after = await api.call('issue_info', { issueNumber: 17 });
    assert.equal(after.points, 2);
    assert.equal(after.issueType, 'Task');
    assert.equal(f.metadataWrites.length, 1);
    const before = [...f.writes];
    await assert.rejects(api.call('issue_update', { issueNumber: 17, points: 99 }));
    await assert.rejects(api.call('issue_update', { issueNumber: 17, issueType: 'Unconfigured' }));
    assert.deepEqual(f.writes, before);
    assert.equal(f.metadataWrites.length, 1);
  } finally {
    await api.close();
  }
});
