import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import * as settings from './config/deliveryConfig.js';
import * as issues from './issue.js';
import * as pr from './pr.js';
import { executeTool } from './dispatch.js';

const execution = { repoRoot: '/unrelated-launch-directory', repo: 'example/widget' };
const ids = { issueNumber: 17, prNumber: 23 };
afterEach(() => vi.restoreAllMocks());
function routes() {
  const config = {
    roles: { author: { identity: 'author', authSource: 'personal' }, reviewer: { identity: 'reviewer' } },
  };
  vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue(
    config as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>,
  );
  const load = vi.spyOn(issues, 'loadDeliveryContext').mockResolvedValue({} as issues.DeliveryContext);
  const create = vi.spyOn(pr, 'publishPr').mockResolvedValue({} as Awaited<ReturnType<typeof pr.publishPr>>);
  const review = vi
    .spyOn(pr, 'submitFormalReview')
    .mockResolvedValue({} as Awaited<ReturnType<typeof pr.submitFormalReview>>);
  return { load, create, review };
}

describe('validated PR mode dispatch', () => {
  it('accepts head/base with the legacy headBranch alias and rejects disagreement before credentials', async () => {
    const calls = routes();
    await executeTool('issue_pr_create', { issueNumber: 17, head: 'topic', base: 'main' }, execution);
    assert.deepEqual(calls.create.mock.calls[0]![1], {
      issueNumber: 17,
      headBranch: 'topic',
      baseBranch: 'main',
      draft: true,
      dryRun: false,
    });
    const previousLoads = calls.load.mock.calls.length;
    await assert.rejects(
      executeTool('issue_pr_create', { issueNumber: 17, head: 'topic', headBranch: 'other' }, execution),
      /same branch/u,
    );
    assert.equal(calls.load.mock.calls.length, previousLoads);
  });
  const action = {
    ...ids,
    nonClosing: true,
    reconcileNonClosingReference: true,
    expectedHeadSha: 'a'.repeat(40),
    expectedBaseSha: 'b'.repeat(40),
    body: 'References example/widget#17',
  };
  it('forwards the explicit exact-head/base action through the existing author owner', async () => {
    const calls = routes();
    await executeTool('issue_pr_create', action, execution);
    assert.deepEqual(calls.create.mock.calls[0]![1], { ...action, draft: true, dryRun: false });
    assert.equal(calls.load.mock.calls[0]![0].role, 'author');
  });
  for (const change of [
    { nonClosing: false },
    { draft: false },
    { body: undefined },
    { expectedHeadSha: undefined },
    { expectedBaseSha: undefined },
    { expectedHeadSha: 'bad' },
    { reconcileNonClosingReference: 'true' },
    { reconcileNonClosingReference: false },
  ]) {
    it(`rejects malformed or incompatible reference action ${JSON.stringify(change)} before credentials`, async () => {
      const calls = routes();
      await assert.rejects(executeTool('issue_pr_create', { ...action, ...change }, execution));
      assert.equal(calls.load.mock.calls.length + calls.create.mock.calls.length, 0);
    });
  }
  it('preserves explicit existing-PR selector and mode for create and review', async () => {
    const calls = routes();
    await executeTool(
      'issue_pr_create',
      {
        ...ids,
        nonClosing: true,
        draft: false,
        dryRun: true,
        body: 'References example/widget#17',
        headBranch: 'issue/17',
      },
      execution,
    );
    assert.deepEqual(calls.create.mock.calls[0]![1], {
      ...ids,
      nonClosing: true,
      draft: false,
      dryRun: true,
      body: 'References example/widget#17',
      headBranch: 'issue/17',
    });
    await executeTool('issue_pr_review', { ...ids, nonClosing: true, artifact: 'artifact', dryRun: true }, execution);
    assert.deepEqual(calls.review.mock.calls[0]![1], { ...ids, nonClosing: true, artifact: 'artifact', dryRun: true });
    assert.equal(calls.load.mock.calls[0]![0].role, 'author');
    assert.equal(calls.load.mock.calls[1]![0].role, 'reviewer');
    assert.ok(calls.load.mock.calls.every(([input]) => input.repository === 'example/widget'));
  });

  for (const nonClosing of [undefined, false]) {
    it(`preserves closing defaults for mode ${String(nonClosing)}`, async () => {
      const calls = routes();
      await executeTool('issue_pr_create', { issueNumber: 17, nonClosing }, execution);
      await executeTool('issue_pr_review', { ...ids, nonClosing, artifact: 'artifact' }, execution);
      assert.equal(calls.create.mock.calls[0]![1].nonClosing, nonClosing);
      assert.equal(calls.review.mock.calls[0]![1].nonClosing, nonClosing);
    });
  }
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '23', null]) {
    it(`rejects invalid existing-PR selector ${String(invalid)} before loading credentials`, async () => {
      const calls = routes();
      await assert.rejects(executeTool('issue_pr_create', { issueNumber: 17, prNumber: invalid }, execution));
      assert.equal(calls.load.mock.calls.length + calls.create.mock.calls.length, 0);
    });
  }
  for (const invalid of ['true', 1, null, {}]) {
    it(`rejects an invalid mode ${JSON.stringify(invalid)} on each PR dispatch`, async () => {
      const calls = routes();
      for (const tool of ['issue_pr_create', 'issue_pr_review'] as const)
        await assert.rejects(
          executeTool(
            tool,
            { ...ids, ...(tool === 'issue_pr_review' ? { artifact: 'artifact' } : {}), nonClosing: invalid },
            execution,
          ),
        );
      assert.equal(calls.load.mock.calls.length, 0);
      assert.equal(calls.create.mock.calls.length + calls.review.mock.calls.length, 0);
    });
  }
});
