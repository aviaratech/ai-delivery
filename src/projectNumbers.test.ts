import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { graphql as GraphQLType } from '@octokit/graphql';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { projectTradePatch, readProjectTradeFieldIds, setProjectTradeNumbers } from './github/projectNumbers.js';
import { inertTarget } from './fixtures/inertTarget.js';

const EXPECTED = { id: 'F_EXPECTED', name: 'Expected trades/day', dataType: 'NUMBER' };
const MEASURED = { id: 'F_MEASURED', name: 'Measured trades/day', dataType: 'NUMBER' };

/** A Project item holding one number per field name; records every mutation it receives. */
function fakeProject(options: { fields?: object[]; stuck?: boolean } = {}) {
  const values = new Map<string, number>([['F_MEASURED', 7]]);
  const mutations: { name: string; variables: Record<string, unknown> }[] = [];
  const graphql = (async (query: string, variables: Record<string, unknown>) => {
    if (query.includes('ProjectNumberFields'))
      return { node: { fields: { nodes: options.fields ?? [EXPECTED, MEASURED] } } };
    if (query.includes('SetProjectNumber') || query.includes('ClearProjectNumber')) {
      const set = query.includes('SetProjectNumber');
      mutations.push({ name: set ? 'set' : 'clear', variables });
      if (options.stuck !== true) {
        if (set) values.set(variables.fieldId as string, variables.value as number);
        else values.delete(variables.fieldId as string);
      }
      return {};
    }
    const number = (id: string) => (values.has(id) ? { number: values.get(id) } : null);
    return { node: { expectedTradesPerDay: number('F_EXPECTED'), measuredTradesPerDay: number('F_MEASURED') } };
  }) as unknown as typeof GraphQLType;
  return { graphql, mutations };
}

async function write(project: ReturnType<typeof fakeProject>, patch: ReturnType<typeof projectTradePatch>) {
  const fieldIds = await readProjectTradeFieldIds({
    graphql: project.graphql,
    keys: Object.keys(patch) as ('expectedTradesPerDay' | 'measuredTradesPerDay')[],
    projectId: 'PROJECT',
  });
  return setProjectTradeNumbers({ fieldIds, graphql: project.graphql, itemId: 'ITEM', patch, projectId: 'PROJECT' });
}

test('the helper writes and reads back the Project trades/day numbers', async () => {
  const project = fakeProject();
  const result = await write(project, projectTradePatch({ expectedTradesPerDay: 12.5 }));
  assert.deepEqual(result, { expectedTradesPerDay: 12.5, measuredTradesPerDay: 7 });
  assert.deepEqual(
    project.mutations.map(({ name, variables }) => [name, variables.fieldId, variables.value]),
    [['set', 'F_EXPECTED', 12.5]],
    'only the requested field is written; the other number is preserved',
  );
});

test('a null trades/day number clears only that field', async () => {
  const project = fakeProject();
  const result = await write(project, projectTradePatch({ measuredTradesPerDay: null }));
  assert.deepEqual(result, { expectedTradesPerDay: null, measuredTradesPerDay: null });
  assert.deepEqual(
    project.mutations.map(({ name }) => name),
    ['clear'],
  );
});

test('the helper refuses a missing, duplicated or non-number Project field and a readback that differs', async () => {
  const patch = { expectedTradesPerDay: 3 };
  for (const fields of [[MEASURED], [EXPECTED, EXPECTED, MEASURED], [{ ...EXPECTED, dataType: 'TEXT' }, MEASURED]])
    await assert.rejects(
      write(fakeProject({ fields }), patch),
      /one Project number field named Expected trades\/day\. Add it to the Project as a Number field/u,
    );
  await assert.rejects(write(fakeProject({ stuck: true }), patch), /Expected trades\/day readback differs/u);
});

test('the issue_update schema takes finite non-negative trades/day numbers and null; issue_batch_update refuses them', () => {
  const schema = getAiDeliveryMcpTool('issue_update')!.inputSchema;
  assert.ok(schema.safeParse({ issueNumber: 1, expectedTradesPerDay: 0, measuredTradesPerDay: null }).success);
  for (const [key, value] of [
    ['expectedTradesPerDay', -1],
    ['measuredTradesPerDay', Number.NaN],
    ['expectedTradesPerDay', '3'],
  ] as const)
    assert.throws(() => schema.safeParse({ issueNumber: 1, [key]: value }), new RegExp(key, 'u'));
  // A batch item never writes the numbers, so it must not accept them and report success.
  const batch = getAiDeliveryMcpTool('issue_batch_update')!.inputSchema;
  assert.throws(
    () => batch.safeParse({ items: [{ issueNumber: 1, expectedTradesPerDay: 2 }] }),
    /Unknown argument key\. Accepted keys/u,
  );
});

test('MCP issue_update sets the numbers alone without touching the issue, and after the fields in a mixed call', async () => {
  const f = inertTarget();
  const c = await f.connect();
  try {
    const only = await c.call('issue_update', { issueNumber: 17, expectedTradesPerDay: 4 });
    assert.equal(only.response.isError, undefined, only.text);
    assert.deepEqual(only.value!.projectNumbers, { expectedTradesPerDay: 4, measuredTradesPerDay: null });
    assert.equal(
      f.calls.some((call) => call.name === 'issues.update'),
      false,
      'a numbers-only call writes no issue field',
    );

    f.calls.length = 0;
    const mixed = await c.call('issue_update', {
      issueNumber: 17,
      title: 'Retitled for trades',
      measuredTradesPerDay: 5,
    });
    assert.equal(mixed.response.isError, undefined, mixed.text);
    assert.deepEqual(mixed.value!.projectNumbers, { expectedTradesPerDay: 4, measuredTradesPerDay: 5 });
    const order = f.calls.map((call) => call.name);
    assert.ok(order.indexOf('issues.update') < order.indexOf('SetProjectNumber'), order.join(', '));

    f.calls.length = 0;
    const plain = await c.call('issue_update', { issueNumber: 17, title: 'Retitled again' });
    assert.equal(plain.response.isError, undefined, plain.text);
    assert.equal(plain.value!.projectNumbers, undefined);
    assert.equal(
      f.calls.some((call) => call.name.includes('ProjectNumber')),
      false,
      'with no number given, the Project number fields are never read or written',
    );
  } finally {
    await f.dispose(c);
  }
});
