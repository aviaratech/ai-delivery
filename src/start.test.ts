import assert from 'node:assert/strict';
import { afterEach, it, vi } from 'vitest';
import * as issue from './issue.js';
import { startTrackedIssue } from './dispatch.js';

afterEach(() => vi.restoreAllMocks());
it('recovers an unknown issue-create outcome by its remote request marker without another issue', async () => {
  const remote: Array<{ number: number; title: string; body: string; html_url: string; state: string }> = [];
  const context = {
    config: { repository: 'example/widget' },
    repo: { owner: 'example', repo: 'widget' },
    clients: { rest: { issues: { listForRepo: async () => ({ data: remote }) } } },
  } as unknown as issue.DeliveryContext;
  const create = vi.spyOn(issue, 'createIssue').mockImplementation(async (_context, input) => {
    remote.push({
      number: 17,
      title: input.title,
      body: input.body!,
      html_url: 'https://github.com/example/widget/issues/17',
      state: 'open',
    });
    throw new Error('Lost create response');
  });
  vi.spyOn(issue, 'resumeCreatedIssue').mockResolvedValue({} as Awaited<ReturnType<typeof issue.resumeCreatedIssue>>);
  vi.spyOn(issue, 'startIssueBranch').mockResolvedValue({
    issueNumber: 17,
    issueUrl: remote[0]?.html_url ?? '',
    branch: 'issue/17',
    headSha: 'a'.repeat(40),
    reused: true,
  });
  vi.spyOn(issue, 'journalIssueStart').mockResolvedValue({} as Awaited<ReturnType<typeof issue.journalIssueStart>>);
  await assert.rejects(
    startTrackedIssue(context, { title: 'Improve widget', requestId: 'request-17' }),
    /Lost create response/u,
  );
  const result = await startTrackedIssue(context, { title: 'Improve widget', requestId: 'request-17' });
  assert.ok('issueNumber' in result);
  assert.equal(result.issueNumber, 17);
  assert.equal(create.mock.calls.length, 1);
  await assert.rejects(
    startTrackedIssue(context, { title: 'Conflicting intent', requestId: 'request-17' }),
    /conflict/u,
  );
  assert.equal(create.mock.calls.length, 1);
});

it('reuses one linked branch and refuses an unselected conflict before branch creation', async () => {
  let mutations = 0;
  let branches = ['custom/17'];
  const context = {
    config: { repository: 'example/widget' },
    repo: { owner: 'example', repo: 'widget' },
    clients: {
      rest: { issues: { get: async () => ({ data: { number: 17, state: 'open', node_id: 'I', html_url: 'url' } }) } },
      graphql: async (query: string) => {
        if (query.includes('mutation')) mutations++;
        return {
          repository: {
            issue: {
              linkedBranches: {
                nodes: branches.map((name) => ({
                  ref: { name, target: { oid: 'a'.repeat(40) }, repository: { nameWithOwner: 'example/widget' } },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      },
    },
  } as unknown as issue.DeliveryContext;
  assert.equal((await issue.startIssueBranch(context, 17)).branch, 'custom/17');
  branches = ['one/17', 'two/17'];
  await assert.rejects(issue.startIssueBranch(context, 17), /Select exactly one/u);
  assert.equal((await issue.startIssueBranch(context, 17, 'two/17')).branch, 'two/17');
  assert.equal(mutations, 0);
});
