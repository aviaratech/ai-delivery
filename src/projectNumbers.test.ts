import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { graphql as GraphQLType } from '@octokit/graphql';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { projectTradePatch, setProjectTradeNumbers } from './github/projectNumbers.js';

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

test('issue_update writes and reads back the Project trades/day numbers', async () => {
  const project = fakeProject();
  const result = await setProjectTradeNumbers({
    graphql: project.graphql,
    itemId: 'ITEM',
    patch: projectTradePatch({ expectedTradesPerDay: 12.5 }),
    projectId: 'PROJECT',
  });
  assert.deepEqual(result, { expectedTradesPerDay: 12.5, measuredTradesPerDay: 7 });
  assert.deepEqual(
    project.mutations.map(({ name, variables }) => [name, variables.fieldId, variables.value]),
    [['set', 'F_EXPECTED', 12.5]],
    'only the requested field is written; the other number is preserved',
  );
});

test('a null trades/day number clears only that field', async () => {
  const project = fakeProject();
  const result = await setProjectTradeNumbers({
    graphql: project.graphql,
    itemId: 'ITEM',
    patch: projectTradePatch({ measuredTradesPerDay: null }),
    projectId: 'PROJECT',
  });
  assert.deepEqual(result, { expectedTradesPerDay: null, measuredTradesPerDay: null });
  assert.deepEqual(
    project.mutations.map(({ name }) => name),
    ['clear'],
  );
});

test('the trades/day write refuses a missing, duplicated or non-number Project field and a readback that differs', async () => {
  const write = (project: ReturnType<typeof fakeProject>) =>
    setProjectTradeNumbers({
      graphql: project.graphql,
      itemId: 'ITEM',
      patch: { expectedTradesPerDay: 3 },
      projectId: 'PROJECT',
    });
  await assert.rejects(
    write(fakeProject({ fields: [MEASURED] })),
    /one Project number field named Expected trades\/day/u,
  );
  await assert.rejects(
    write(fakeProject({ fields: [EXPECTED, EXPECTED, MEASURED] })),
    /one Project number field named Expected trades\/day/u,
  );
  await assert.rejects(
    write(fakeProject({ fields: [{ ...EXPECTED, dataType: 'TEXT' }, MEASURED] })),
    /one Project number field named Expected trades\/day/u,
  );
  await assert.rejects(write(fakeProject({ stuck: true })), /Expected trades\/day readback differs/u);
});

test('the issue_update schema accepts finite non-negative trades/day numbers and null, and refuses the rest', () => {
  const schema = getAiDeliveryMcpTool('issue_update')!.inputSchema;
  assert.ok(schema.safeParse({ issueNumber: 1, expectedTradesPerDay: 0, measuredTradesPerDay: null }).success);
  for (const [key, value] of [
    ['expectedTradesPerDay', -1],
    ['measuredTradesPerDay', Number.NaN],
    ['expectedTradesPerDay', '3'],
  ] as const)
    assert.throws(() => schema.safeParse({ issueNumber: 1, [key]: value }), new RegExp(key, 'u'));
});
