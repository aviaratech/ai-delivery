import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readIssueHistory } from './github/issueHistory.js';
import { issue63Fixture } from './fixtures/issue63.js';

test('native history refuses changed issue node identity and reports repeated cursors', async () => {
  const f = issue63Fixture();
  await assert.rejects(readIssueHistory(f.context, 17, 2, 'OTHER'), /node identity/u);
  f.controls.timelineIncomplete = true;
  const history = await readIssueHistory(f.context, 17, 3, 'ISSUE17');
  assert.equal(history.complete, false);
  assert.match(history.reason!, /Repeated/u);
});
test('unavailable removal identity cannot establish the no-removal episode', async () => {
  const f = issue63Fixture();
  f.history.push({
    __typename: 'BlockedByRemovedEvent',
    id: 'R',
    createdAt: '2026-01-01T00:00:00Z',
    blockingIssue: null,
  });
  const result = await readIssueHistory(f.context, 17, 2, 'ISSUE17');
  assert.equal(result.complete, false);
  assert.match(result.reason!, /blocker identity/u);
  assert.equal(result.events.length, 1);
});
test('timeline identity remains bound across pages and API errors cannot become empty complete history', async () => {
  const f = issue63Fixture();
  const original = f.context.clients.graphql;
  let calls = 0;
  f.context.clients.graphql = (async (query: string, values: Record<string, unknown>) => {
    const response = (await original(query, values)) as {
      repository: {
        issue: { id: string; timelineItems: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      };
    };
    calls++;
    if (calls === 1) response.repository.issue.timelineItems.pageInfo = { hasNextPage: true, endCursor: 'first' };
    else response.repository.issue.id = 'CHANGED';
    return response;
  }) as unknown as typeof original;
  await assert.rejects(readIssueHistory(f.context, 17, 2, 'ISSUE17'), /node identity/u);
  f.context.clients.graphql = (async () => {
    throw new Error('Timeline unavailable');
  }) as unknown as typeof original;
  await assert.rejects(readIssueHistory(f.context, 17), /Timeline unavailable/u);
});
