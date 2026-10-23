import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { fixtureGit, inertTarget, queueScenario } from './fixtures/inertTarget.js';
import { resolveCheckout } from './github/repo.js';
import { recordedZeroApproval } from './fixtures/recordedGitHubFlows.js';
import { digestValue } from './delivery/common.js';
import { contextFor } from './dispatch.js';
import { enqueuePr, queueStatus, runQueue } from './mergeQueue.js';
import * as verification from './verification.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('queue refuses rebinding while the drained writer is still held', { timeout: 0 }, async ({ signal }) => {
  const f = inertTarget(signal),
    s = queueScenario(f, 2),
    linked = f.worktree();
  const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
  await enqueuePr(context, { prNumber: 23 }, { root: linked });
  const held = barrier(),
    release = barrier();
  const original = vi.mocked(verification.withRuntimeSetupWriter).getMockImplementation()!;
  vi.mocked(verification.withRuntimeSetupWriter).mockImplementation((root, operation, scope) =>
    original(
      root,
      async (runner) => {
        const result = await operation(runner);
        held.resolve();
        await release.promise;
        return result;
      },
      scope,
    ),
  );
  const running = runQueue(context, { root: f.root, signal: f.signal });
  try {
    await held.promise;
    await assert.rejects(enqueuePr(context, { prNumber: 24 }, { root: f.root }), /lock|writer absence/iu);
    assert.equal((await queueStatus(context, { root: f.root })).leaseRoot, linked);
  } finally {
    release.resolve();
    await running;
    vi.mocked(verification.withRuntimeSetupWriter).mockImplementation(original);
  }
  await enqueuePr(context, { prNumber: 24 }, { root: f.root });
  assert.equal((await queueStatus(context, { root: f.root })).leaseRoot, f.root);
  await runQueue(context, { root: f.root, signal: f.signal });
  assert.deepEqual(
    s.events.filter((e) => e.startsWith('native.merge')),
    ['native.merge:23', 'native.merge:24'],
  );
  f.assertInert();
});

test('queue chooses the current lease after delayed authentication', { timeout: 0 }, async ({ signal }) => {
  const f = inertTarget(signal),
    s = queueScenario(f, 2),
    linked = f.worktree();
  const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
  await enqueuePr(context, { prNumber: 23 }, { root: linked });
  await runQueue(context, { root: f.root, signal: f.signal });
  const held = barrier(),
    release = barrier();
  const original = context.clients.authenticatedAuthor!;
  Object.assign(context.clients, {
    authenticatedAuthor: async () => {
      held.resolve();
      await release.promise;
      return original();
    },
  });
  const running = runQueue(context, { root: f.root, signal: f.signal });
  // The historical drained queue must still authenticate and recover its writer.
  await Promise.race([held.promise, running.then(() => assert.fail('drained queue skipped writer recovery'))]);
  Object.assign(context.clients, { authenticatedAuthor: original });
  try {
    await enqueuePr(context, { prNumber: 24 }, { root: f.root });
  } finally {
    release.resolve();
  }
  await running;
  assert.equal(s.events.filter((e) => e.startsWith('writer:')).at(-1), `writer:${f.root}`);
  assert.equal(s.prs[1]!.merged, true);
  f.assertInert();
});

test(
  'queue refuses a lease changed before the runtime writer claim without touching queue state',
  { timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      linked = f.worktree();
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: linked });
    await runQueue(context, { root: f.root, signal: f.signal });
    const held = barrier(),
      release = barrier();
    const original = vi.mocked(verification.withRuntimeSetupWriter).getMockImplementation()!;
    vi.mocked(verification.withRuntimeSetupWriter).mockImplementation(async (root, operation, scope) => {
      held.resolve();
      await release.promise;
      return original(root, operation, scope);
    });
    const running = runQueue(context, { root: f.root, signal: f.signal });
    await Promise.race([held.promise, running.then(() => assert.fail('drained queue skipped writer recovery'))]);
    let before: Awaited<ReturnType<typeof queueStatus>>;
    try {
      await enqueuePr(context, { prNumber: 24 }, { root: f.root });
      before = await queueStatus(context, { root: f.root });
    } finally {
      release.resolve();
    }
    await assert.rejects(running, /lease root changed/iu);
    assert.deepEqual(await queueStatus(context, { root: f.root }), before);
    vi.mocked(verification.withRuntimeSetupWriter).mockImplementation(original);
    await runQueue(context, { root: f.root, signal: f.signal });
    assert.equal(s.prs[1]!.merged, true);
    f.assertInert();
  },
);

test(
  'queue recovers an orphaned writer even when its historical entries are drained',
  { timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal);
    queueScenario(f, 1);
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    await runQueue(context, { root: f.root, signal: f.signal });
    const writerPath = join(f.root, '.git', 'ai-delivery', 'writers@1', `${digestValue(f.root).slice(7)}.json`);
    const crash = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import {withRuntimeSetupWriter} from ${JSON.stringify(new URL('./verification.js', import.meta.url).href)};
    await withRuntimeSetupWriter(${JSON.stringify(f.root)}, async () => process.exit(73));
  `,
      ],
      { cwd: f.root, env: { PATH: process.env.PATH }, encoding: 'utf8', maxBuffer: 64 * 1024 },
    );
    assert.equal(crash.status, 73, crash.stderr);
    assert.equal(existsSync(writerPath), true);
    await runQueue(context, { root: f.root, signal: f.signal });
    assert.equal(existsSync(writerPath), false);
    f.assertInert();
  },
);

test('queue keeps its process lease root across linked worktrees', { timeout: 0 }, async ({ signal }) => {
  const f = inertTarget(signal),
    s = queueScenario(f, 2),
    linked = f.worktree();
  const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
  await enqueuePr(context, { prNumber: 23 }, { root: linked, signal: f.signal });
  assert.equal(
    ((await queueStatus(context, { root: f.root })) as unknown as Record<string, unknown>).leaseRoot,
    linked,
  );
  await runQueue(context, { root: f.root, signal: f.signal });
  assert.ok(s.events.includes(`writer:${linked}`));
  fixtureGit(f.root, 'worktree', 'remove', linked);
  await enqueuePr(context, { prNumber: 24 }, { root: f.root, signal: f.signal });
  assert.equal(
    ((await queueStatus(context, { root: f.root })) as unknown as Record<string, unknown>).leaseRoot,
    f.root,
  );
  await runQueue(context, { root: f.root, signal: f.signal });
  assert.ok(s.events.includes(`writer:${f.root}`));
  assert.deepEqual(
    s.events.filter((e) => e.startsWith('native.merge')),
    ['native.merge:23', 'native.merge:24'],
  );
  f.assertInert();
});

test('queue enqueue is durable and idempotent while status never advances it', async ({ signal }) => {
  const f = inertTarget(signal);
  const connection = await f.connect();
  try {
    const empty = await connection.call('issue_pr_merge_queue_status', {});
    assert.notEqual(empty.response.isError, true, empty.text);
    assert.deepEqual(empty.value?.entries, []);
    assert.equal(existsSync(join(f.root, '.git', 'ai-delivery', 'merge-queue')), false);
    const first = await connection.call('issue_pr_merge', { issueNumber: 17, prNumber: 23, queue: true });
    assert.notEqual(first.response.isError, true, first.text);
    assert.equal(first.value?.position, 1);
    const again = await connection.call('issue_pr_merge', { issueNumber: 17, prNumber: 23, queue: true });
    assert.equal(again.value?.position, 1);
    const status = await connection.call('issue_pr_merge_queue_status', {});
    assert.ok(status.value);
    assert.equal((status.value.entries as { head: string }[])[0]?.head, f.head);
    assert.equal(
      f.calls.some((c) => c.name === 'pulls.merge'),
      false,
    );
    f.assertInert();
  } finally {
    await f.dispose(connection);
  }
});

test(
  'foreground queue squashes three real Git trees in order and waits for native owner refresh',
  { timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal);
    const s = queueScenario(f);
    s.controls.strict = true;
    s.controls.freshNativeAfterRefresh = true;
    const connection = await f.connect();
    for (const pr of s.prs) {
      const r = await connection.call('issue_pr_merge', {
        issueNumber: pr.issueNumber,
        prNumber: pr.number,
        queue: true,
      });
      assert.notEqual(r.response.isError, true, r.text);
    }
    const running = connection.call('issue_pr_merge_queue_run', {});
    const waitFront = (prNumber: number, nativeState: 'behind' | 'blocked' = 'behind') =>
      vi.waitFor(
        async () => {
          const status = await connection.call('issue_pr_merge_queue_status', {});
          const entry = (status.value!.entries as { prNumber: number; state: string; reason?: string }[]).find(
            (e) => e.prNumber === prNumber,
          )!;
          assert.equal(entry.state, 'waiting');
          assert.ok((entry.reason ?? '').includes(`eligibility is ${nativeState}`), entry.reason);
        },
        { timeout: 120000 },
      );
    await Promise.race([running.then((r) => assert.notEqual(r.response.isError, true, r.text)), waitFront(24)]);
    assert.deepEqual(
      s.events.filter((e) => e.startsWith('native.merge')),
      ['native.merge:23'],
    );
    s.refresh(24);
    await waitFront(24, 'blocked');
    assert.equal(s.prs[1]!.merged, false);
    s.qualifyNative(24, s.prs[1]!.head);
    await waitFront(25);
    assert.ok(s.events.includes('native.merge:24'));
    s.refresh(25);
    await waitFront(25, 'blocked');
    assert.equal(s.prs[2]!.merged, false);
    s.qualifyNative(25, s.prs[2]!.head);
    const result = await running;
    assert.notEqual(result.response.isError, true, result.text);
    assert.ok(f.observations.some((event) => typeof event === 'object' && event !== null && 'queueProgress' in event));
    assert.deepEqual(
      s.events.filter((e) => e.startsWith('native.merge')),
      ['native.merge:23', 'native.merge:24', 'native.merge:25'],
    );
    const entries = result.value?.entries as { state: string; merge: { sha: string; tree: string } }[];
    assert.deepEqual(
      entries.map((e) => e.state),
      ['merged', 'merged', 'merged'],
    );
    for (const entry of entries) assert.equal(s.object(entry.merge.sha).tree.sha, entry.merge.tree);
    assert.equal(fixtureGit(s.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/ai-delivery/queue/'), '');
    f.assertInert();
  },
);

test(
  'queue waits for complete current checks and native review, invalidating head/base predictions',
  { timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      c = await f.connect();
    s.controls.missing = true;
    await c.call('issue_pr_merge', { prNumber: 23, queue: true });
    const running = c.call('issue_pr_merge_queue_run', {});
    const entry = async () =>
      (
        (await c.call('issue_pr_merge_queue_status', {})).value!.entries as {
          head: string;
          reason?: string;
          prediction?: { base: string; sha: string };
        }[]
      )[0]!;
    const waitReason = (pattern: RegExp) =>
      vi.waitFor(async () => assert.match((await entry()).reason ?? '', pattern), { timeout: 60000 });
    await waitReason(/not reported/u);
    assert.equal(s.prs[0]!.merged, false);
    const appended = await c.call('issue_pr_merge', { prNumber: 24, queue: true });
    assert.notEqual(appended.response.isError, true, appended.text);
    assert.equal(appended.value?.position, 2);
    const original = (await entry()).prediction!.sha;
    s.controls.missing = false;
    s.controls.wrongSource = true;
    await waitReason(/required source/u);
    s.controls.partial = true;
    await waitReason(/incompletely discovered/u);
    s.controls.partial = false;
    s.controls.wrongSource = false;
    s.controls.pendingChecks = true;
    await waitReason(/pending/u);
    s.refresh(23, true);
    s.outside();
    await vi.waitFor(
      async () => {
        const e = await entry();
        assert.equal(e.head, s.prs[0]!.head);
        assert.equal(e.prediction!.base, s.main());
        assert.notEqual(e.prediction!.sha, original);
      },
      { timeout: 60000 },
    );
    s.controls.reviewDecision = 'REVIEW_REQUIRED';
    s.controls.pendingChecks = false;
    await vi.waitFor(() => assert.ok(f.calls.some((call) => call.name === 'DeliveryReviewDecision')), {
      timeout: 60000,
    });
    assert.equal(s.prs[0]!.merged, false);
    // Reuse the recorded observed-null value; CLEAN/non-draft/checks here are explicitly synthetic.
    s.controls.reviewDecision = recordedZeroApproval.repository.pullRequest.reviewDecision;
    const result = await running;
    assert.notEqual(result.response.isError, true, result.text);
    assert.equal(s.prs[0]!.merged, true);
    assert.equal(s.prs[1]!.merged, true);
    f.assertInert();
  },
);

test(
  'cancel/resume skips completed merges and rejects corrupt or incompatible state',
  { timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      c = await f.connect();
    s.controls.pendingFor.add(24);
    for (const pr of s.prs) await c.call('issue_pr_merge', { prNumber: pr.number, queue: true });
    const stop = new AbortController(),
      driver = await f.connect({ signal: stop.signal });
    const running = driver.call('issue_pr_merge_queue_run', {}).then(
      () => undefined,
      () => undefined,
    );
    await vi.waitFor(
      async () => {
        const status = await c.call('issue_pr_merge_queue_status', {});
        assert.equal((status.value!.entries as { state: string }[])[0]!.state, 'merged');
      },
      { timeout: 60000 },
    );
    stop.abort();
    await running;
    await driver.close();
    const path = join(f.root, '.git', 'ai-delivery', 'merge-queue', 'queue.json');
    const bytes = readFileSync(path);
    const broken = JSON.parse(bytes.toString()) as { binding: string; stateId: string };
    broken.binding = 'different-runtime';
    const { stateId: _prior, ...content } = broken;
    broken.stateId = digestValue(content);
    writeFileSync(path, JSON.stringify(broken), { mode: 0o600 });
    const refused = await c.call('issue_pr_merge_queue_run', {});
    assert.equal(refused.response.isError, true);
    assert.match(refused.text, /incompatible/u);
    broken.stateId = 'corrupt';
    writeFileSync(path, JSON.stringify(broken), { mode: 0o600 });
    assert.equal((await c.call('issue_pr_merge_queue_status', {})).response.isError, true);
    writeFileSync(path, bytes, { mode: 0o600 });
    s.controls.pendingFor.clear();
    const result = await c.call('issue_pr_merge_queue_run', {});
    assert.notEqual(result.response.isError, true, result.text);
    assert.equal(s.events.filter((e) => e === 'native.merge:23').length, 1);
    assert.equal(s.events.filter((e) => e === 'native.merge:24').length, 1);
    assert.equal(existsSync(join(f.root, '.git', 'ai-delivery', 'merge-queue', 'objects.git')), false);
    f.assertInert();
  },
);

test(
  'a conflicting PR is removed with file diagnostics while its successor is rebuilt',
  { timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 3),
      c = await f.connect();
    for (const pr of s.prs.slice(0, 2)) {
      fixtureGit(s.author, 'checkout', pr.ref);
      writeFileSync(join(s.author, 'shared.txt'), `${pr.number}\n`);
      fixtureGit(s.author, 'add', '.');
      fixtureGit(s.author, 'commit', '-qm', 'Shared path conflict');
      pr.head = fixtureGit(s.author, 'rev-parse', 'HEAD');
      fixtureGit(s.author, 'push', s.remote, `${pr.head}:refs/heads/${pr.ref}`);
    }
    for (const pr of s.prs) await c.call('issue_pr_merge', { prNumber: pr.number, queue: true });
    const result = await c.call('issue_pr_merge_queue_run', {});
    assert.notEqual(result.response.isError, true, result.text);
    assert.deepEqual(
      (result.value!.entries as { state: string }[]).map((e) => e.state),
      ['merged', 'removed', 'merged'],
    );
    assert.ok(f.comments.some((c) => /shared\.txt/u.test(c.body)));
    assert.deepEqual(
      s.events.filter((e) => e.startsWith('native.merge')),
      ['native.merge:23', 'native.merge:25'],
    );
    assert.equal(fixtureGit(s.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/ai-delivery/queue/'), '');
    f.assertInert();
  },
);

for (const mode of ['failed-check', 'lost-merge-ack', 'lost-push-ack', 'outside-race'] as const) {
  test(`queue reconciles ${mode} without stale proof or duplicate merge`, async ({ signal }) => {
    const f = inertTarget(signal);
    const s = queueScenario(f, 2);
    const c = await f.connect();
    if (mode === 'failed-check') s.failed.add(23);
    if (mode === 'lost-merge-ack') s.controls.loseMergeAck = true;
    if (mode === 'lost-push-ack') s.controls.losePushAck = true;
    if (mode === 'outside-race') s.controls.outsideAtMerge = true;
    for (const pr of s.prs)
      await c.call('issue_pr_merge', { issueNumber: pr.issueNumber, prNumber: pr.number, queue: true });
    const first = await c.call('issue_pr_merge_queue_run', {});
    if (mode === 'outside-race') {
      assert.match(first.text, /mismatch|unexpected|parent/iu);
      assert.deepEqual(
        s.events.filter((e) => e.startsWith('native.merge')),
        ['native.merge:23'],
      );
    } else {
      if (mode !== 'failed-check') {
        const resumed = await c.call('issue_pr_merge_queue_run', {});
        assert.notEqual(resumed.response.isError, true, resumed.text);
      }
      assert.equal(s.events.filter((e) => e === 'native.merge:24').length, 1);
      assert.equal(s.events.filter((e) => e === 'native.merge:23').length, mode === 'failed-check' ? 0 : 1);
      if (mode === 'failed-check') assert.ok(f.comments.some((comment) => /checks/u.test(comment.body)));
      assert.equal(fixtureGit(s.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/ai-delivery/queue/'), '');
    }
    f.assertInert();
  });
}

test('canonical queue selection refuses independent configured clones even in a matching cwd', async ({ signal }) => {
  const f = inertTarget(signal);
  const other = join(f.base, 'other');
  fixtureGit(f.base, 'clone', '--no-hardlinks', f.root, other);
  fixtureGit(other, 'remote', 'set-url', 'origin', 'https://github.com/example/widget.git');
  const input = {
    repository: 'example/widget',
    launchDirectory: f.root,
    checkoutRoots: [f.root, other],
    canonical: true,
  };
  assert.throws(() => resolveCheckout(input), /ambiguous|canonical/iu);
});
