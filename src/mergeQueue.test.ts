import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { fixtureGit, inertTarget, queueScenario } from './fixtures/inertTarget.js';
import { resolveCheckout } from './github/repo.js';
import { recordedZeroApproval, syntheticStandingApprovalRefusals } from './fixtures/recordedGitHubFlows.js';
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

test(
  'uncovered queue entry waits for approval without publishing or merging',
  { tags: ['release'] },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 1);
    f.comments.length = 0;
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    const stop = new AbortController();
    await runQueue(context, {
      root: f.root,
      signal: stop.signal,
      onProgress: async () => {
        stop.abort();
      },
    }).catch((error: unknown) => {
      if (!stop.signal.aborted) throw error;
    });
    const status = await queueStatus(context, { root: f.root });
    assert.equal(status.entries[0]!.state, 'needs-approval');
    assert.equal(s.prs[0]!.merged, false);
    assert.equal(s.events.includes('git.push'), false);
    assert.equal(f.comments.filter((c) => /needs approval/iu.test(c.body) && /maintainer/u.test(c.body)).length, 1);
    f.assertInert();
  },
);

for (const { kind, reason } of syntheticStandingApprovalRefusals) {
  test(`standing approval refuses ${kind} with one explanation`, { tags: ['release'] }, async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 1),
      a = s.approval;
    if (kind === 'non-approver') a.user.login = 'outsider';
    if (kind === 'expired') a.body = a.body.replace('2099-01-01', '2000-01-01');
    if (kind === 'same-second-edit') {
      a.lastEditedAt = a.created_at;
      a.editor = { login: 'maintainer' };
    }
    if (kind === 'missing-edit-proof') Reflect.deleteProperty(a, 'lastEditedAt');
    if (kind === 'unknown-condition') a.body = a.body.replace('current-queue-checks', 'execute-code()');
    if (kind === 'duplicate-pr') a.body = a.body.replace('pull-requests: 23', 'pull-requests: 23,23');
    if (kind === 'wrong-repository') a.body = a.body.replace('repository: example/widget', 'repository: example/other');
    if (kind === 'missing-predecessor') a.body = a.body.replace('pull-requests: 23', 'pull-requests: 23,24');
    if (kind === 'minimized') a.isMinimized = true;
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    // Observe the same refusal twice, across compatible explicit runs.
    for (let i = 0; i < 2; i++) {
      const stop = new AbortController();
      await runQueue(context, {
        root: f.root,
        signal: stop.signal,
        onProgress: async () => {
          stop.abort();
        },
      }).catch((error: unknown) => {
        if (!stop.signal.aborted) throw error;
      });
    }
    assert.equal((await queueStatus(context, { root: f.root })).entries[0]!.state, 'needs-approval');
    assert.ok((await queueStatus(context, { root: f.root })).entries[0]!.reason);
    assert.equal(f.comments.filter((c) => c.body.includes('ignored:') && c.body.includes(reason)).length, 1);
    assert.equal(s.events.includes('git.push'), false);
    assert.equal(s.prs[0]!.merged, false);
    f.assertInert();
  });
}

for (const mode of ['pagination', 'wrong-target', 'ambiguous', 'no-config', 'read-error'] as const) {
  test(`standing approval refuses ${mode} evidence`, { tags: ['release'] }, async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 1);
    if (mode === 'pagination' || mode === 'wrong-target' || mode === 'read-error') s.controls.approvalFault = mode;
    if (mode === 'ambiguous') s.approve();
    if (mode === 'no-config') {
      const path = join(f.base, 'user.json'),
        settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      delete settings.mergeQueueApprovers;
      writeFileSync(path, JSON.stringify(settings));
    }
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    const stop = new AbortController();
    await runQueue(context, {
      root: f.root,
      signal: stop.signal,
      onProgress: async () => {
        stop.abort();
      },
    }).catch((error: unknown) => {
      if (!stop.signal.aborted) throw error;
    });
    assert.equal((await queueStatus(context, { root: f.root })).entries[0]!.state, 'needs-approval');
    assert.equal(s.events.includes('git.push'), false);
    assert.equal(s.prs[0]!.merged, false);
    assert.doesNotMatch(JSON.stringify(f.comments), /Synthetic private diagnostic/u);
    f.assertInert();
  });
}

for (const phase of ['discovery', 'final-merge-gate', 'missing-metadata'] as const) {
  test(
    `unreadable competing approval refuses authority at ${phase}`,
    { tags: ['release'], timeout: 0 },
    async ({ signal }) => {
      const f = inertTarget(signal),
        s = queueScenario(f, 1);
      const addUnavailable = () => {
        const competing = s.approve();
        if (phase === 'missing-metadata') Reflect.deleteProperty(competing, 'lastEditedAt');
        else s.controls.unreadableApprovalIds.add(competing.node_id);
      };
      if (phase !== 'final-merge-gate') addUnavailable();
      const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
      await enqueuePr(context, { prNumber: 23 }, { root: f.root });
      const stop = new AbortController();
      let armed = phase !== 'final-merge-gate';
      await runQueue(context, {
        root: f.root,
        signal: stop.signal,
        onProgress: async () => {
          if (!armed) {
            addUnavailable();
            armed = true;
          } else stop.abort();
        },
      }).catch((error: unknown) => {
        if (!stop.signal.aborted) throw error;
      });
      const status = await queueStatus(context, { root: f.root });
      assert.equal(status.entries[0]!.state, 'needs-approval');
      assert.match(status.entries[0]!.reason!, /unavailable/u);
      assert.equal(s.prs[0]!.merged, false);
      if (phase !== 'final-merge-gate') assert.equal(s.events.includes('git.push'), false);
      f.assertInert();
    },
  );
}

for (const kind of ['non-approver', 'bot'] as const) {
  test(
    `a conclusively invalid ${kind} approval does not suppress a valid grant`,
    { tags: ['release'], timeout: 0 },
    async ({ signal }) => {
      const f = inertTarget(signal),
        s = queueScenario(f, 1),
        invalid = s.approve();
      if (kind === 'non-approver') invalid.user.login = 'outsider';
      else invalid.user.type = 'Bot';
      const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
      await enqueuePr(context, { prNumber: 23 }, { root: f.root });
      await runQueue(context, { root: f.root, signal: f.signal });
      assert.equal(s.prs[0]!.merged, true);
      assert.equal(s.events.filter((event) => event === 'native.merge:23').length, 1);
      assert.ok(f.comments.some((comment) => comment.body.includes('ignored:')));
      f.assertInert();
    },
  );
}

for (const outcome of ['present', 'absent', 'duplicate', 'spoofed', 'edited', 'same-second-restored'] as const) {
  test(
    `queue reconciles comment loss without duplicate POST, outcome=${outcome}`,
    { tags: ['release'], timeout: 0 },
    async ({ signal }) => {
      const f = inertTarget(signal),
        s = queueScenario(f, 1);
      const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
      await enqueuePr(context, { prNumber: 23 }, { root: f.root });
      s.controls.loseCommentAck = true;
      await assert.rejects(runQueue(context, { root: f.root, signal: f.signal }), /lost comment acknowledgement/u);
      const before = f.comments.filter((c) => c.user.login === 'operator');
      assert.equal(before.length, 1);
      const posted = before[0]!,
        writes = f.calls.filter((c) => c.name === 'issues.createComment').length;
      if (outcome !== 'present') {
        if (outcome === 'absent') f.comments.splice(f.comments.indexOf(posted), 1);
        if (outcome === 'duplicate') f.addComment(999999, posted.body, false, 23);
        if (outcome === 'spoofed') posted.user.login = 'outsider';
        if (outcome === 'edited') posted.body += '\nedited';
        if (outcome === 'same-second-restored') {
          posted.lastEditedAt = posted.created_at;
          posted.editor = { login: 'operator' };
        }
        await assert.rejects(
          runQueue(context, { root: f.root, signal: f.signal }),
          /acknowledgement is unknown|readback changed/u,
        );
        assert.equal(f.calls.filter((c) => c.name === 'issues.createComment').length, writes);
        assert.equal(s.prs[0]!.merged, false);
        assert.equal((await queueStatus(context, { root: f.root })).pending?.kind, 'comment');
      } else {
        await runQueue(context, { root: f.root, signal: f.signal });
        assert.equal(s.prs[0]!.merged, true);
        assert.equal(f.comments.filter((c) => c.body.includes('verifying')).length, 1);
        assert.equal(s.events.filter((e) => e === 'native.merge:23').length, 1);
      }
      f.assertInert();
    },
  );
}

test(
  'standing approval merges only its ordered prefix and mentions each native author',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 3);
    s.approval.body = s.approval.body.replace('23,24,25', '23,24');
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    for (const pr of s.prs) await enqueuePr(context, { prNumber: pr.number }, { root: f.root });
    const stop = new AbortController();
    await runQueue(context, {
      root: f.root,
      signal: stop.signal,
      onProgress: async () => {
        if (s.prs[1]!.merged) stop.abort();
      },
    }).catch((error: unknown) => {
      if (!stop.signal.aborted) throw error;
    });
    assert.deepEqual(
      s.events.filter((e) => e.startsWith('native.merge')),
      ['native.merge:23', 'native.merge:24'],
    );
    assert.equal((await queueStatus(context, { root: f.root })).entries[2]!.state, 'needs-approval');
    for (const pr of s.prs.slice(0, 2)) {
      const notices = f.comments.filter(
        (c) => c.user.login === 'operator' && c.issue_url.endsWith(`/issues/${pr.number}`),
      );
      // The second prediction is rebuilt after the first squash changes its base identity.
      for (const text of ['verifying', 'ready', `merged as ${pr.merge}`])
        assert.equal(
          notices.filter((c) => c.body.includes(text) && c.body.includes('@operator')).length,
          text.startsWith('merged') || pr.number === 23 ? 1 : 2,
        );
    }
    f.assertInert();
  },
);

test(
  'unchanged native eligibility waits do not repeat ready notices',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 1);
    s.controls.reviewDecision = 'REVIEW_REQUIRED';
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    const stop = new AbortController();
    let waits = 0;
    await runQueue(context, {
      root: f.root,
      signal: stop.signal,
      onProgress: async () => {
        if ((await queueStatus(context, { root: f.root })).entries[0]!.state === 'waiting' && ++waits === 3)
          stop.abort();
      },
    }).catch((error: unknown) => {
      if (!stop.signal.aborted) throw error;
    });
    assert.equal(waits, 3);
    assert.equal(s.prs[0]!.merged, false);
    assert.equal(f.comments.filter((c) => c.body.includes('PR #23 ready.')).length, 1);
    f.assertInert();
  },
);

test(
  'standing approval retains the same native approver across login casing changes',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 1);
    s.approval.user.login = 'Maintainer';
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    const stop = new AbortController();
    let changed = false;
    await runQueue(context, {
      root: f.root,
      signal: stop.signal,
      onProgress: async () => {
        if (!changed) {
          changed = true;
          s.approval.user.login = 'MAINTAINER';
        } else stop.abort();
      },
    }).catch((error: unknown) => {
      if (!stop.signal.aborted) throw error;
    });
    assert.equal(s.prs[0]!.merged, true);
    f.assertInert();
  },
);

test(
  'removed and re-enqueued entry cannot reuse an unconsumed old grant',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 1);
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    s.failed.add(23);
    await runQueue(context, { root: f.root, signal: f.signal });
    assert.equal((await queueStatus(context, { root: f.root })).entries[0]!.state, 'removed');
    s.failed.clear();
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    const stop = new AbortController();
    await runQueue(context, {
      root: f.root,
      signal: stop.signal,
      onProgress: async () => {
        stop.abort();
      },
    }).catch((error: unknown) => {
      if (!stop.signal.aborted) throw error;
    });
    assert.equal(s.prs[0]!.merged, false);
    assert.equal((await queueStatus(context, { root: f.root })).entries[1]!.state, 'needs-approval');
    s.approve();
    await runQueue(context, { root: f.root, signal: f.signal });
    assert.equal(s.prs[0]!.merged, true);
    assert.equal(s.events.filter((e) => e === 'native.merge:23').length, 1);
    f.assertInert();
  },
);

test(
  'standing approval discovery completes later native comment pages',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 1);
    f.comments.length = 0;
    for (let i = 0; i < 100; i++) f.addComment(900000 + i, 'ordinary discussion', false, 23);
    f.comments.push(s.approval);
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    await enqueuePr(context, { prNumber: 23 }, { root: f.root });
    await runQueue(context, { root: f.root, signal: f.signal });
    assert.equal(s.prs[0]!.merged, true);
    f.assertInert();
  },
);

for (const mode of ['expired', 'deleted', 'edited'] as const) {
  test(
    `standing approval ${mode} after first merge stops suffix and retains original receipt`,
    { tags: ['release'], timeout: 0 },
    async ({ signal }) => {
      const f = inertTarget(signal),
        s = queueScenario(f, 2);
      const observedNow = Date.now();
      let shift = 0,
        changed = false;
      const expires = new Date(observedNow + 120000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
      s.approval.body = s.approval.body.replace('2099-01-01T00:00:00Z', expires);
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => observedNow + shift);
      try {
        const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
        for (const pr of s.prs) await enqueuePr(context, { prNumber: pr.number }, { root: f.root });
        const stop = new AbortController();
        await runQueue(context, {
          root: f.root,
          signal: stop.signal,
          onProgress: async () => {
            if (s.prs[0]!.merged && !changed) {
              changed = true;
              if (mode === 'expired') shift = 120001;
              if (mode === 'deleted') f.comments.splice(f.comments.indexOf(s.approval), 1);
              if (mode === 'edited') s.approval.lastEditedAt = s.approval.created_at;
            }
            if (
              changed &&
              (await queueStatus(context, { root: f.root })).entries[1]!.state === 'needs-approval' &&
              f.comments.some((c) => c.body.includes('ignored:'))
            )
              stop.abort();
          },
        }).catch((error: unknown) => {
          if (!stop.signal.aborted) throw error;
        });
        assert.equal(changed, true);
        assert.deepEqual(
          s.events.filter((e) => e.startsWith('native.merge')),
          ['native.merge:23'],
        );
        const status = await queueStatus(context, { root: f.root });
        assert.equal(status.entries[0]!.merge!.sha, s.prs[0]!.merge);
        assert.equal(status.entries[1]!.state, 'needs-approval');
        assert.equal(f.comments.filter((c) => c.body.includes(`merged as ${s.prs[0]!.merge}`)).length, 1);
      } finally {
        clock.mockRestore();
      }
      f.assertInert();
    },
  );
}

test(
  'queue refuses rebinding while the drained writer is still held',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      linked = f.worktree();
    s.approval.body = s.approval.body.replace('23,24', '23');
    s.approve([24]);
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
  },
);

test(
  'queue chooses the current lease after delayed authentication',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      linked = f.worktree();
    s.approval.body = s.approval.body.replace('23,24', '23');
    s.approve([24]);
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
  },
);

test(
  'queue refuses a lease changed before the runtime writer claim without touching queue state',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      linked = f.worktree();
    s.approval.body = s.approval.body.replace('23,24', '23');
    s.approve([24]);
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
  { tags: ['release'], timeout: 0 },
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

test(
  'queue keeps its process lease root across linked worktrees',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      linked = f.worktree();
    s.approval.body = s.approval.body.replace('23,24', '23');
    s.approve([24]);
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
  },
);

test(
  'queue enqueue is durable and idempotent while status never advances it',
  { tags: ['release'] },
  async ({ signal }) => {
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
  },
);

test(
  'foreground queue squashes three real Git trees in order and waits for native owner refresh',
  { tags: ['release'], timeout: 0 },
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
    // Status resolves a real checkout; poll at the driver's cadence instead of starving its Git work.
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
        { timeout: 120000, interval: 1000 },
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
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2),
      c = await f.connect();
    s.approval.body = s.approval.body.replace('23,24', '23');
    s.approve([24]);
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
      vi.waitFor(async () => assert.match((await entry()).reason ?? '', pattern), { timeout: 60000, interval: 1000 });
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
      { timeout: 60000, interval: 1000 },
    );
    s.controls.reviewDecision = 'REVIEW_REQUIRED';
    s.controls.pendingChecks = false;
    await vi.waitFor(() => assert.ok(f.calls.some((call) => call.name === 'DeliveryReviewDecision')), {
      timeout: 60000,
      interval: 1000,
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
  'refreshed prediction checkpoint resumes with the uninterrupted transition notices',
  { tags: ['release'], timeout: 0 },
  async ({ signal }) => {
    const f = inertTarget(signal),
      s = queueScenario(f, 2);
    s.controls.reviewDecision = 'REVIEW_REQUIRED';
    const context = await contextFor({ repoRoot: f.root, repo: 'example/widget', identity: 'author' }, 'pr:merge');
    for (const pr of s.prs) await enqueuePr(context, { prNumber: pr.number }, { root: f.root });
    const runUntilReady = async (head: string) => {
      const stop = new AbortController();
      await runQueue(context, {
        root: f.root,
        signal: AbortSignal.any([f.signal, stop.signal]),
        onProgress: async () => {
          const entries = (await queueStatus(context, { root: f.root })).entries;
          if (entries[0]!.state === 'waiting' && entries[1]!.state === 'ready' && entries[1]!.head === head)
            stop.abort();
        },
      }).catch((error: unknown) => {
        if (!stop.signal.aborted) throw error;
      });
    };
    await runUntilReady(s.prs[1]!.head);
    const path = join(f.root, '.git', 'ai-delivery', 'merge-queue', 'queue.json'),
      store = join(f.root, '.git', 'ai-delivery', 'merge-queue', 'objects.git'),
      original = readFileSync(path),
      originalEntries = (await queueStatus(context, { root: f.root })).entries,
      originalComments = structuredClone(f.comments);
    s.refresh(24, true);
    const refreshedHead = s.prs[1]!.head,
      outcomes: { notices: string[]; sha: string; tree: string }[] = [];
    for (const interrupted of [false, true]) {
      if (interrupted) {
        // Fork the same completed fictional checkpoint and Git inputs; this is not a runtime reset path.
        assert.equal(existsSync(store), false);
        writeFileSync(path, original, { mode: 0o600 });
        f.comments.splice(0, f.comments.length, ...structuredClone(originalComments));
        for (const entry of originalEntries) {
          const ref = `refs/heads/ai-delivery/queue/${entry.prNumber}`,
            current = fixtureGit(s.remote, 'rev-parse', ref);
          fixtureGit(s.remote, 'update-ref', ref, entry.published!, current);
        }
        const atomic = await import('./utils/atomicJson.js');
        const write = atomic.writePrivateJsonFileAtomically;
        let stopped = false;
        const fault = vi.spyOn(atomic, 'writePrivateJsonFileAtomically').mockImplementation((target, value) => {
          if (target === path && stopped) throw new Error('Synthetic controller loss at prediction checkpoint');
          write(target, value);
          const entries = (value as { entries?: { prNumber: number; head: string }[] }).entries;
          if (target === path && entries?.some((entry) => entry.prNumber === 24 && entry.head === refreshedHead)) {
            stopped = true;
            throw new Error('Synthetic controller loss at prediction checkpoint');
          }
        });
        try {
          await assert.rejects(
            runQueue(context, { root: f.root, signal: f.signal }),
            /Synthetic controller loss at prediction checkpoint/u,
          );
        } finally {
          fault.mockRestore();
        }
        assert.equal(stopped, true);
        const checkpoint = await queueStatus(context, { root: f.root });
        assert.equal(checkpoint.entries[1]!.head, refreshedHead);
        assert.equal(checkpoint.entries[1]!.state, 'verifying');
        assert.match(checkpoint.entries[1]!.notice!.body, /PR #24 verifying/u);
        assert.equal(checkpoint.pending, undefined);
        assert.equal(existsSync(store), true);
      }
      await runUntilReady(refreshedHead);
      assert.equal(existsSync(store), false);
      const entry = (await queueStatus(context, { root: f.root })).entries[1]!;
      const notices = f.comments
        .filter((comment) => comment.user.login === 'operator' && comment.issue_url.endsWith('/issues/24'))
        .map((comment) => comment.body);
      assert.deepEqual(
        notices.map((body) => /PR #24 (verifying|ready)\./u.exec(body)?.[1]),
        ['verifying', 'ready', 'verifying', 'ready'],
      );
      assert.equal(
        s.events.some((event) => event.startsWith('native.merge')),
        false,
      );
      assert.equal(s.object(entry.prediction!.sha).tree.sha, entry.prediction!.tree);
      outcomes.push({ notices, sha: entry.prediction!.sha, tree: entry.prediction!.tree });
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
    f.assertInert();
  },
);

test(
  'cancel/resume skips completed merges and rejects corrupt or incompatible state',
  { tags: ['release'], timeout: 0 },
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
        const entries = status.value!.entries as {
          state: string;
          reason?: string;
          published?: string;
          notice?: unknown;
        }[];
        assert.equal(entries[0]!.state, 'merged');
        assert.equal(entries[0]!.published, undefined);
        assert.match(entries[1]!.reason ?? '', /pending/u);
        assert.equal(status.value!.pending, undefined);
        assert.ok(entries.every((entry) => entry.notice === undefined));
      },
      { timeout: 60000, interval: 1000 },
    );
    stop.abort();
    await running;
    await driver.close();
    const path = join(f.root, '.git', 'ai-delivery', 'merge-queue', 'queue.json');
    const bytes = readFileSync(path);
    const oldSchema = JSON.parse(bytes.toString()) as { schemaVersion: string; stateId: string };
    oldSchema.schemaVersion = 'ai-delivery.merge-queue@1';
    const { stateId: _old, ...oldContent } = oldSchema;
    writeFileSync(path, JSON.stringify({ ...oldContent, stateId: digestValue(oldContent) }), { mode: 0o600 });
    const oldRefused = await c.call('issue_pr_merge_queue_status', {});
    assert.equal(oldRefused.response.isError, true);
    assert.match(oldRefused.text, /schemaVersion|merge-queue@2/u);
    writeFileSync(path, bytes, { mode: 0o600 });
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
  { tags: ['release'], timeout: 0 },
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
    const running = c.call('issue_pr_merge_queue_run', {});
    await vi.waitFor(
      async () => {
        const status = await c.call('issue_pr_merge_queue_status', {});
        const entries = status.value!.entries as { state: string }[];
        assert.equal(entries[1]!.state, 'removed');
        assert.equal(entries[0]!.state, 'needs-approval');
      },
      { timeout: 120000, interval: 1000 },
    );
    s.approve([23, 25]);
    const result = await running;
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
  test(
    `queue reconciles ${mode} without stale proof or duplicate merge`,
    { tags: ['release'], timeout: 0 },
    async ({ signal }) => {
      const f = inertTarget(signal);
      const s = queueScenario(f, 2);
      const c = await f.connect();
      if (mode === 'failed-check') s.failed.add(23);
      if (mode === 'lost-merge-ack') s.controls.loseMergeAck = true;
      if (mode === 'lost-push-ack') s.controls.losePushAck = true;
      if (mode === 'outside-race') s.controls.outsideAtMerge = true;
      for (const pr of s.prs)
        await c.call('issue_pr_merge', { issueNumber: pr.issueNumber, prNumber: pr.number, queue: true });
      const running = c.call('issue_pr_merge_queue_run', {});
      if (mode === 'failed-check') {
        await vi.waitFor(
          async () => {
            const status = await c.call('issue_pr_merge_queue_status', {});
            assert.equal((status.value!.entries as { state: string }[])[0]!.state, 'removed');
          },
          { timeout: 60000, interval: 1000 },
        );
        s.approve([24]);
      }
      const first = await running;
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
    },
  );
}

test(
  'canonical queue selection refuses independent configured clones even in a matching cwd',
  { tags: ['release'] },
  async ({ signal }) => {
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
  },
);
