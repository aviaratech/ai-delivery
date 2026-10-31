import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import { recordedIssue233Links, recordedPr235Summary } from './fixtures/readView.js';
import * as projectDelivery from './github/projectDelivery.js';
import type { DeliveryContext } from './issue.js';
import * as prs from './pr.js';
import { latestJournal, prView, readIssueLinks, readPrSummary, summarizePr } from './readView.js';

const pr235 = recordedPr235Summary.repository.pullRequest;
const context = (response: unknown) =>
  ({
    repo: { owner: 'aviaratech', repo: 'ai-delivery' },
    clients: { graphql: async () => response },
  }) as unknown as DeliveryContext;

test('a merged, approved PR reports state, passing checks and a current approval', () => {
  assert.deepEqual(summarizePr(pr235), {
    number: 235,
    url: 'https://github.com/aviaratech/ai-delivery/pull/235',
    state: 'merged',
    draft: false,
    mergeState: 'unknown',
    checks: { state: 'success', failing: [], pending: [] },
    reviews: { decision: 'approved', latest: [{ by: 'at-gpt-reviewer', state: 'approved', current: true }] },
  });
});

// Synthetic edits of the recorded PR: GitHub's own states, changed one field at a time.
const rollup = (state: string, contexts: unknown[]) => ({
  ...pr235,
  commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: contexts } } } }] },
});
const run = (name: string, status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
});

test('failing and pending checks are named; a missing rollup is none', () => {
  const failing = summarizePr(
    rollup('FAILURE', [run('checks', 'COMPLETED', 'FAILURE'), run('secrets', 'IN_PROGRESS', null)]),
  );
  assert.deepEqual(failing.checks, { state: 'failure', failing: ['checks'], pending: ['secrets'] });
  const status = summarizePr(
    rollup('PENDING', [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' }]),
  );
  assert.deepEqual(status.checks.pending, ['ci/legacy']);
  assert.equal(
    summarizePr({ ...pr235, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }).checks.state,
    'none',
  );
});

test('an approval of an older head is not current', () => {
  const stale = summarizePr({
    ...pr235,
    reviewDecision: 'REVIEW_REQUIRED',
    latestReviews: { nodes: [{ author: { login: 'reviewer' }, state: 'APPROVED', commit: { oid: 'a'.repeat(40) } }] },
  });
  assert.deepEqual(stale.reviews, {
    decision: 'review_required',
    latest: [{ by: 'reviewer', state: 'approved', current: false }],
  });
});

test('a response that drifts from the expected shape is refused, not guessed', () => {
  assert.throws(() => summarizePr({ ...pr235, isDraft: 'no' }));
});

test('the latest typed journal wins over later plain comments', () => {
  const [journal] = recordedIssue233Links.repository.issue.comments.nodes;
  const plain = {
    author: { login: 'someone' },
    body: 'LGTM',
    createdAt: '2026-10-29T00:00:00Z',
    url: 'https://example.test/c/2',
  };
  assert.deepEqual(latestJournal([journal!, plain]), {
    by: 'PaulSavignano',
    url: journal!.url,
    createdAt: journal!.createdAt,
    preview: 'Work started on Lead typed journal comments with status and next step.',
  });
  assert.equal(latestJournal([plain]), null);
  assert.equal(latestJournal([]), null);
});

test('issue links list the PRs that reference the issue, with their checks and reviews', async () => {
  const links = await readIssueLinks(context(recordedIssue233Links), 233);
  assert.equal(links.state, 'closed');
  assert.deepEqual(
    links.pullRequests.map((pr) => [pr.number, pr.state, pr.reviews.decision, pr.checks.state]),
    [[235, 'merged', 'approved', 'success']],
  );
  assert.equal(links.latestJournal?.createdAt, '2026-10-28T22:10:18Z');
});

test('issue links ignore references from other repositories', async () => {
  const [event] = recordedIssue233Links.repository.issue.timelineItems.nodes;
  const foreign = {
    repository: {
      issue: {
        ...recordedIssue233Links.repository.issue,
        timelineItems: {
          nodes: [{ source: { ...event!.source, repository: { nameWithOwner: 'example/other' } } }],
        },
      },
    },
  };
  assert.deepEqual((await readIssueLinks(context(foreign), 233)).pullRequests, []);
});

test('a PR summary reports its closing issues in this repository only', async () => {
  const summary = await readPrSummary(context(recordedPr235Summary), 235);
  assert.deepEqual(summary.closes, [233]);
  assert.equal(summary.state, 'merged');
  // Synthetic edit: GitHub also lists issues a PR closes in other repositories.
  const pull = recordedPr235Summary.repository.pullRequest;
  const crossRepo = {
    repository: {
      pullRequest: {
        ...pull,
        closingIssuesReferences: {
          nodes: [...pull.closingIssuesReferences.nodes, { number: 7, repository: { nameWithOwner: 'example/other' } }],
        },
      },
    },
  };
  assert.deepEqual((await readPrSummary(context(crossRepo), 235)).closes, [233]);
});

test('a missing issue is one plain sentence, not a schema dump', async () => {
  await assert.rejects(readIssueLinks(context({ repository: { issue: null } }), 999), /Issue #999 was not found/u);
});

afterEach(() => vi.restoreAllMocks());

test('a linked issue keeps the In Review flag of its Project item', async () => {
  vi.spyOn(prs, 'prInfo').mockResolvedValue({ prNumber: 235 } as Awaited<ReturnType<typeof prs.prInfo>>);
  vi.spyOn(projectDelivery, 'projectSettingsFromDeliveryConfig').mockReturnValue(
    {} as ReturnType<typeof projectDelivery.projectSettingsFromDeliveryConfig>,
  );
  vi.spyOn(projectDelivery, 'getIssueProjectStatus').mockResolvedValue({
    itemId: 'ITEM233',
    status: 'In Progress',
    review: true,
  });
  const graphql = async (query: string) =>
    query.includes('ReadPrSummary') ? recordedPr235Summary : recordedIssue233Links;
  const view = await prView(
    {
      ...context(null),
      config: { native: { organization: 'aviaratech' } },
      clients: { graphql },
    } as unknown as DeliveryContext,
    { prNumber: 235, issueNumber: 233 },
  );
  assert.deepEqual(
    view.issues.map((issue) => [issue.number, issue.projectStatus, 'inReview' in issue ? issue.inReview : undefined]),
    [[233, 'In Progress', true]],
  );
});
