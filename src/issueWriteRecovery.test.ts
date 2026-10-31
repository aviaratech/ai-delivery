import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createIssue, CreatedTrackingIssueError, canonicalIssueBody } from './issue.js';
import { issue63Fixture } from './fixtures/issue63.js';
import { parseIssueBody, validateIssue } from './issueContract.js';
import { inertTarget, fixtureFields } from './fixtures/inertTarget.js';

function fixture() {
  const f = issue63Fixture();
  let parent: number | null = null;
  let parentCleared = false;
  const nativeValues = new Map<number, Record<string, string>>();
  const rest = f.context.clients.rest;
  const originalRequest = rest.request.bind(rest);
  const originalGraphql = f.context.clients.graphql;
  const recovery = { member: false, failProject: false, lostCreateResponse: false };
  rest.paginate = (async () => (parent === 19 ? [f.rows.get(20)!] : [])) as unknown as typeof rest.paginate;
  rest.issues.addSubIssue = (async () => {
    f.writes.push('parent');
    parent = 19;
    return { data: {} };
  }) as unknown as typeof rest.issues.addSubIssue;
  rest.request = (async (
    route: string,
    args: { issue_number?: number; issue_field_values?: { field_id: number; value: string }[] },
  ) => {
    if (route.includes('/orgs/')) {
      const result = await originalRequest(route, args);
      return { data: [...(result.data as unknown[]), { id: 103, name: 'Start date', data_type: 'date' }] };
    }
    if (args.issue_number === 20) {
      const values = nativeValues.get(20)!;
      if (route.startsWith('POST')) {
        f.writes.push('metadata');
        for (const field of args.issue_field_values ?? []) values[String(field.field_id)] = field.value;
      }
      return {
        data: Object.entries(values).map(([id, value]) => ({
          issue_field_id: Number(id),
          issue_field_name: id === '101' ? 'Estimate' : id === '102' ? 'Urgency' : 'Start date',
          data_type: id === '103' ? 'date' : 'single_select',
          value,
        })),
      };
    }
    if (route.startsWith('DELETE')) {
      parentCleared = true;
      return { data: [] };
    }
    if (parentCleared && args.issue_number === 19) return { data: [] };
    return originalRequest(route, args);
  }) as typeof rest.request;
  f.context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
    if (query.includes('AddProjectDeliveryItem')) {
      recovery.member = true;
      f.writes.push('membership');
      return { addProjectV2ItemById: { item: { id: 'ITEM20' } } };
    }
    if (query.includes('UpdateProjectDeliveryStatus') && recovery.failProject)
      throw new Error('Synthetic Project write failure');
    const result = (await originalGraphql(query, variables)) as {
      repository: { issue: { parent: unknown; blockedBy: { nodes: { number: number; state: string }[] } } };
      node: { projectItems: { nodes: { id: string }[] } };
    };
    if (query.includes('ProjectDeliveryIssueItems') && !recovery.member)
      result.node.projectItems.nodes = result.node.projectItems.nodes.filter((row) => row.id !== 'ITEM20');
    if (query.includes('blockedBy(first:'))
      for (const blocker of result.repository.issue.blockedBy.nodes)
        blocker.state = f.rows.get(blocker.number)!.state.toUpperCase();
    if (query.includes('blockedBy(first:') && variables.number === 20 && parent !== null)
      result.repository.issue.parent = {
        id: 'ISSUE19',
        number: parent,
        repository: { nameWithOwner: 'example/widget' },
      };
    return result;
  }) as typeof originalGraphql;
  const originalCreate = rest.issues.create.bind(rest.issues);
  rest.issues.create = (async (input: Parameters<typeof originalCreate>[0]) => {
    const result = await originalCreate(input);
    Object.assign(f.rows.get(result.data.number)!, { user: { login: 'operator' } });
    nativeValues.set(result.data.number, {});
    if (recovery.lostCreateResponse) throw new Error('Synthetic lost creation response');
    return result;
  }) as typeof rest.issues.create;
  return { ...f, recovery, nativeValues, parent: () => parent };
}

const intent = { opId: 'synthetic-187', parentIssueNumber: 19, blockedBy: [18] };

test('create establishes Project status before parent and blockers and reuses completed opId', async () => {
  const f = fixture();
  const input = { ...f.ready, ...intent };
  const result = await createIssue(f.context, input);
  assert.equal(result.created.number, 20);
  assert.equal(f.parent(), 19);
  assert.deepEqual([...f.edges.get(20)!], [18]);
  assert.ok(f.writes.indexOf('membership') < f.writes.indexOf('status'));
  assert.ok(f.writes.indexOf('status') < f.writes.indexOf('parent'));
  const writes = [...f.writes];
  await createIssue(f.context, input);
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
  assert.deepEqual(f.writes, writes, 'a completed retry must not repeat native writes');
});

test('same opId completes a failed dependency step once and identifies remaining work', async () => {
  const f = fixture();
  f.controls.failAdd = true;
  const input = { ...f.ready, ...intent };
  await assert.rejects(createIssue(f.context, input), (error) => {
    assert.ok(error instanceof CreatedTrackingIssueError);
    assert.equal(error.created.number, 20);
    assert.match(error.message, /blockers/u);
    assert.match(error.message, /opId/u);
    return true;
  });
  f.controls.failAdd = false;
  await createIssue(f.context, input);
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
  assert.equal(f.writes.filter((x) => x === 'parent').length, 1);
  assert.equal(f.writes.filter((x) => x === 'add').length, 1);
});

test('opId refuses changed intent, duplicate markers and foreign authors without writes', async () => {
  for (const mode of ['intent', 'duplicate', 'author'] as const) {
    const f = fixture();
    const input = { ...f.ready, ...intent };
    await createIssue(f.context, input);
    if (mode === 'duplicate') f.rows.set(21, { ...f.rows.get(20)!, number: 21 });
    if (mode === 'author') Object.assign(f.rows.get(20)!, { user: { login: 'someone-else' } });
    const writes = [...f.writes];
    await assert.rejects(
      createIssue(f.context, { ...input, ...(mode === 'intent' ? { priority: 'High' } : {}) }),
      /conflict|author/iu,
    );
    assert.deepEqual(f.writes, writes);
  }
});

test('epic true is an unsized Ready contract and survives canonical roundtrip', () => {
  const f = fixture();
  const { points: _points, ...ready } = f.ready;
  const result = validateIssue({ ...ready, issueType: 'Feature', epic: true }, true);
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  assert.ok(result.issue);
  // Canonical body generation must not force an epic to become a parked draft.
  const input = { ...ready, issueType: 'Feature', epic: true as const };
  const body = canonicalIssueBody(input);
  assert.match(body, /## Status\n\nReady/u);
  assert.doesNotMatch(body, /Draft — parked/u);
  assert.equal(Reflect.get(parseIssueBody(body, { title: ready.title }).issue, 'epic'), true);
  assert.equal(
    validateIssue(ready, true).failures.some((x) => x.code === 'points'),
    true,
  );
});

test.each(['project', 'acknowledgement'] as const)(
  'same opId resumes after %s failure without another issue',
  async (stage) => {
    const f = fixture();
    const input = { ...f.ready, ...intent };
    f.recovery.failProject = stage === 'project';
    f.recovery.lostCreateResponse = stage === 'acknowledgement';
    await assert.rejects(
      createIssue(f.context, input),
      stage === 'project' ? /Failed step: project/u : /lost creation response/u,
    );
    f.recovery.failProject = false;
    f.recovery.lostCreateResponse = false;
    await createIssue(f.context, input);
    assert.equal(f.writes.filter((x) => x === 'create').length, 1);
    assert.equal(f.writes.filter((x) => x === 'membership').length, 1);
    assert.equal(f.parent(), 19);
    assert.deepEqual([...f.edges.get(20)!], [18]);
  },
);

test.each(['completed', 'partial'] as const)(
  'create retry preserves independently changed native values after %s operation',
  async (stage) => {
    for (const [field, value] of [
      ['101', '4'],
      ['102', 'Low'],
      ['103', '2026-02-02'],
    ] as const) {
      const f = fixture();
      const input = { ...f.ready, ...intent, priority: 'High', startDate: '2026-01-01' };
      f.controls.failAdd = stage === 'partial';
      if (stage === 'partial') await assert.rejects(createIssue(f.context, input));
      else await createIssue(f.context, input);
      f.controls.failAdd = false;
      f.nativeValues.get(20)![field] = value;
      const writes = [...f.writes];
      await assert.rejects(createIssue(f.context, input), /conflict/iu);
      assert.equal(f.nativeValues.get(20)![field], value);
      assert.deepEqual(f.writes, writes);
    }
  },
);

test('partial create reports only the requested remaining operations', async () => {
  const f = fixture();
  f.recovery.failProject = true;
  await assert.rejects(createIssue(f.context, { ...f.ready, opId: 'synthetic-simple' }), (error) => {
    assert.ok(error instanceof CreatedTrackingIssueError);
    assert.deepEqual(error.remainingSteps, ['project', 'readback']);
    return true;
  });
});

test('same opId preserves independently added closed blocker relationships', async () => {
  const f = fixture();
  const input = { ...f.ready, ...intent };
  await createIssue(f.context, input);
  f.rows.get(19)!.state = 'closed';
  f.edges.get(20)!.add(19);
  const writes = [...f.writes];
  await assert.rejects(createIssue(f.context, input), /conflict/iu);
  assert.deepEqual([...f.edges.get(20)!], [18, 19]);
  assert.deepEqual(f.writes, writes);
});

for (const mode of ['partial', 'epic'] as const) {
  test(`MCP ${mode} create retains retry identity across compact and verbose output`, async ({ signal }) => {
    const f = inertTarget(signal);
    const originalGet = f.rest.issues.get;
    f.rest.issues.get = async (input) => ({
      data: { ...(await originalGet(input)).data, user: { login: 'operator' } },
    });
    const originalList = f.rest.issues.listForRepo;
    f.rest.issues.listForRepo = async (input) => ({
      data: (await originalList(input)).data.map((row) => ({ ...row, user: { login: 'operator' } })),
    });
    const originalRequest = f.rest.request;
    let fail = mode === 'partial';
    f.rest.request = async (route, args) => {
      const result = await originalRequest(route, args);
      if (fail && route.startsWith('POST') && route.includes('/issue-field-values')) {
        fail = false;
        throw new Error('Synthetic metadata acknowledgement lost');
      }
      return result;
    };
    const { points: _points, ...unsized } = fixtureFields;
    const input = { ...(mode === 'epic' ? { ...unsized, epic: true } : fixtureFields), opId: `synthetic-mcp-${mode}` };
    const connection = await f.connect();
    try {
      if (mode === 'partial') {
        const partial = await connection.call('issue_create', input);
        assert.equal(partial.response.isError, true);
        assert.match(partial.text, /Issue #17.*Failed step: metadata.*same opId/u);
      }
      const compact = await connection.call('issue_create', input);
      assert.notEqual(compact.response.isError, true, compact.text);
      assert.deepEqual(compact.value?.created, {
        number: 17,
        title: fixtureFields.title,
        url: 'https://github.com/example/widget/issues/17',
      });
      assert.equal(Object.hasOwn(compact.value!, 'body'), false);
      assert.ok(Array.isArray(compact.value?.warnings));
      const verbose = await connection.call('issue_create', { ...input, verbose: true });
      assert.notEqual(verbose.response.isError, true, verbose.text);
      assert.match(String(verbose.value?.body), /State:\*\* Ready/u);
      if (mode === 'epic')
        assert.equal(parseIssueBody(String(verbose.value?.body), { title: fixtureFields.title }).issue.epic, true);
      assert.equal(f.calls.filter((call) => call.name === 'issues.create').length, 1);
      assert.equal(
        f.calls.filter((call) => call.name.startsWith('POST') && call.name.includes('/issue-field-values')).length,
        mode === 'partial' ? 1 : 0,
      );
    } finally {
      await f.dispose(connection);
    }
  });
}
