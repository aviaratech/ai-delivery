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
  const merge = vi.spyOn(pr, 'mergePr').mockResolvedValue({} as Awaited<ReturnType<typeof pr.mergePr>>);
  const finish = vi.spyOn(pr, 'finishIssue').mockResolvedValue({} as Awaited<ReturnType<typeof pr.finishIssue>>);
  return { load, create, review, merge, finish };
}

describe('validated PR mode dispatch', () => {
  it('preserves explicit existing-PR selector and mode for create, review and guarded merge', async () => {
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
    await executeTool(
      'issue_pr_merge',
      { ...ids, nonClosing: true, strategy: 'squash', reviewedHeadSha: 'a'.repeat(40), dryRun: true },
      execution,
    );
    assert.deepEqual(calls.merge.mock.calls[0]![1], {
      ...ids,
      nonClosing: true,
      strategy: 'squash',
      reviewedHeadSha: 'a'.repeat(40),
      dryRun: true,
    });
    assert.equal(calls.load.mock.calls[0]![0].role, 'author');
    assert.equal(calls.load.mock.calls[1]![0].role, 'reviewer');
    assert.equal(calls.load.mock.calls[2]![0].role, 'author');
    assert.ok(calls.load.mock.calls.every(([input]) => input.repository === 'example/widget'));
  });

  for (const nonClosing of [undefined, false]) {
    it(`preserves closing defaults for mode ${String(nonClosing)}`, async () => {
      const calls = routes();
      await executeTool('issue_pr_create', { issueNumber: 17, nonClosing }, execution);
      await executeTool('issue_pr_review', { ...ids, nonClosing, artifact: 'artifact' }, execution);
      await executeTool('issue_pr_merge', { ...ids, nonClosing }, execution);
      await executeTool('issue_finish', { ...ids, nonClosing }, execution);
      assert.equal(calls.create.mock.calls[0]![1].nonClosing, nonClosing);
      assert.equal(calls.review.mock.calls[0]![1].nonClosing, nonClosing);
      assert.equal(calls.merge.mock.calls[0]![1].nonClosing, nonClosing);
      assert.equal(calls.finish.mock.calls[0]![1].nonClosing, nonClosing);
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
      for (const tool of ['issue_pr_create', 'issue_pr_review', 'issue_pr_merge', 'issue_finish'] as const)
        await assert.rejects(
          executeTool(
            tool,
            { ...ids, ...(tool === 'issue_pr_review' ? { artifact: 'artifact' } : {}), nonClosing: invalid },
            execution,
          ),
        );
      assert.equal(calls.load.mock.calls.length, 0);
      assert.equal(
        calls.create.mock.calls.length +
          calls.review.mock.calls.length +
          calls.merge.mock.calls.length +
          calls.finish.mock.calls.length,
        0,
      );
    });
  }
  it('refuses explicit non-closing finish with zero context or lifecycle calls', async () => {
    const calls = routes();
    await assert.rejects(executeTool('issue_finish', { ...ids, nonClosing: true }, execution), /cannot finish/u);
    assert.equal(calls.load.mock.calls.length + calls.finish.mock.calls.length + calls.merge.mock.calls.length, 0);
  });
});
