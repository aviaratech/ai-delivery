import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as board from './deliveryBoard.js';
import type { DeliveryBoardRequest, DeliveryBoardResult } from './deliveryBoard.js';
import type { ExecutionContext } from './dispatch.js';
import {
  boardReplayAsOf,
  boardReplayRepos,
  deliveryBoardReplay,
  type BoardReplayOptions,
} from './fixtures/deliveryBoardReplay.js';

function collector() {
  const collect = Reflect.get(board, 'collectDeliveryBoard') as
    | ((request: DeliveryBoardRequest, execution: ExecutionContext) => Promise<DeliveryBoardResult>)
    | undefined;
  assert.equal(typeof collect, 'function', 'read-only board collector is available');
  return collect!;
}
function parser() {
  const parse = Reflect.get(board, 'parseDeliveryBoardRequest') as ((raw: unknown) => DeliveryBoardRequest) | undefined;
  assert.equal(typeof parse, 'function', 'board request validation is available');
  return parse!;
}
const request = (): DeliveryBoardRequest => ({ repos: [...boardReplayRepos], decisionLabels: ['needs-decision'] });

test('board request is explicit, ordered, case-insensitive and validated before access', () => {
  const parse = parser();
  assert.deepEqual(parse({ repos: ['Example/Beta', 'example/ALPHA', 'EXAMPLE/beta'] }), {
    repos: ['example/beta', 'example/alpha'],
    decisionLabels: [],
  });
  assert.deepEqual(
    parse({ repos: ['example/alpha'], decisionLabels: [' Needs-Decision ', 'needs-decision'] }).decisionLabels,
    ['Needs-Decision'],
  );
  for (const raw of [
    undefined,
    {},
    { repos: [] },
    { repos: [''] },
    { repos: ['example'] },
    { repos: ['a/b/c'] },
    { repos: ['a/b\nother'] },
    { repos: ['a/b'], decisionLabels: [' '] },
    { repos: ['a/b'], decisionLabels: ['bad\nlabel'] },
    { repos: ['a/b'], decisionLabels: ['bad\u0085label'] },
  ])
    assert.throws(() => parse(raw));
});

test('two-repo board collects five sections with observed-null readiness and one six-page inventory', async () => {
  const collect = collector();
  const f = deliveryBoardReplay();
  const result = await collect(request(), f.execution);
  assert.equal(result.schemaVersion, 'ai-delivery.board@1');
  assert.equal(result.collection.asOf, boardReplayAsOf);
  assert.equal(
    result.complete,
    true,
    JSON.stringify(
      result.repositories.map((repository) => ({
        repository: repository.repository,
        humanAttention: repository.humanAttention.map((row) => ({
          number: row.number,
          labels: row.labels,
          journal: row.journal.state,
        })),
        coverage: Object.fromEntries(
          Object.entries(repository.coverage).map(([section, coverage]) => [
            section,
            {
              status: coverage.status,
              reasons: coverage.reasons,
              unknown: coverage.unknownRows.map((row) => ({ number: row.number, reasons: row.reasons })),
            },
          ]),
        ),
        metrics: repository.metrics,
      })),
    ),
  );
  assert.deepEqual(
    result.repositories.map((r) => r.repository),
    boardReplayRepos,
  );
  let rows = 0;
  for (const r of result.repositories) {
    assert.equal(r.access, 'readable');
    assert.deepEqual(
      [r.humanAttention.length, r.readyPrs.length, r.blockedPrs.length, r.staleIssues.length, r.mergeQueue.length],
      [5, 5, 5, 5, 5],
    );
    rows +=
      r.humanAttention.length + r.readyPrs.length + r.blockedPrs.length + r.staleIssues.length + r.mergeQueue.length;
    assert.ok(r.readyPrs.every((pr) => pr.ready && pr.review.observed === true && pr.review.reviewDecision === null));
    assert.equal(r.humanAttention.find((i) => i.number === 5)?.journal.state, 'clear');
    assert.ok(r.humanAttention.find((i) => i.number === 5)?.labels.includes('needs-decision'));
    for (const number of [21, 22, 23, 24, 25])
      assert.equal(
        r.humanAttention.some((i) => i.number === number),
        false,
        'latest lifecycle/full numeric ID clears the older request',
      );
    assert.ok(
      r.staleIssues.some((i) => i.number === 6),
      'exact 72-hour boundary is stale',
    );
    assert.equal(r.queueScope.host, 'this-host');
    assert.equal(r.metrics.opened.marked, 2);
    assert.equal(r.metrics.opened.total, 3);
    assert.equal(r.metrics.opened.percentage, (100 * 2) / 3);
    assert.equal(r.metrics.merged.marked, 1);
    assert.equal(r.metrics.merged.total, 3, 'merged PRs created before the window remain in the denominator');
  }
  assert.equal(rows, 50);
  assert.equal(f.calls.operations.ProjectDeliveryItems, 6);
  f.assertReadOnly();
  assert.doesNotMatch(
    JSON.stringify(result),
    /SYNTHETIC_PRIVATE|SYNTHETIC_PENDING|SYNTHETIC_GRANT|SYNTHETIC_TOKEN|synthetic-principal|ai-delivery-board-replay-/u,
  );
  const again = await collect({ ...request(), repos: [...boardReplayRepos].reverse() }, f.execution);
  assert.deepEqual(
    again.repositories.map((r) => r.repository),
    [...boardReplayRepos].reverse(),
  );
  assert.equal(
    f.calls.operations.ProjectDeliveryItems,
    12,
    'a later request recollects instead of retaining a persistent cache',
  );
  f.assertReadOnly();
});

test('Project query count does not multiply between one and fifty selected issues', async () => {
  const collect = collector();
  for (const selectedIssues of [1, 50]) {
    const f = deliveryBoardReplay({ selectedIssues });
    await collect(request(), f.execution);
    assert.equal(f.calls.operations.ProjectDeliveryItems, 6);
    assert.equal(f.calls.perItemStatusReads, 0);
    f.assertReadOnly();
    console.log(
      JSON.stringify({
        selectedIssues,
        ProjectDeliveryItems: 6,
        perItemStatusReads: 0,
        nativeWrites: 0,
        queueChanges: 0,
        targetExecutions: 0,
      }),
    );
    f.dispose();
  }
});

test('read-only Project visibility is sufficient for stale and host queue observations', async () => {
  const collect = collector();
  const f = deliveryBoardReplay({ readOnlyProject: true });
  const result = await collect(request(), f.execution);
  assert.equal(result.complete, true);
  for (const r of result.repositories) {
    assert.equal(r.staleIssues.length, 5);
    assert.equal(r.mergeQueue.length, 5);
  }
  f.assertReadOnly();
});

test('repo denial and Project-only denial preserve independent readable sections', async () => {
  const collect = collector();
  for (const projectDenied of [false, true]) {
    const f = deliveryBoardReplay(projectDenied ? { projectDenied } : { unreadableRepository: boardReplayRepos[1]! });
    const result = await collect(request(), f.execution);
    const alpha = result.repositories[0]!;
    const beta = result.repositories[1]!;
    assert.equal(result.complete, false);
    assert.equal(alpha.access, 'readable');
    assert.equal(alpha.readyPrs.length, 5);
    assert.equal(alpha.humanAttention.length, 5);
    assert.equal(alpha.metrics.opened.complete, true);
    if (projectDenied) {
      assert.equal(alpha.coverage.staleIssues.status, 'unavailable');
      assert.equal(alpha.coverage.mergeQueue.status, 'unavailable');
      assert.equal(beta.readyPrs.length, 5);
      assert.equal(beta.metrics.merged.complete, true);
    } else {
      assert.equal(beta.access, 'unreadable');
      assert.equal(beta.metrics.opened.complete, false);
      assert.equal(beta.metrics.opened.percentage, null);
      assert.equal(
        f.calls.operations['Issues:example/beta'],
        undefined,
        'do not probe subordinate data after repository denial',
      );
    }
    f.assertReadOnly();
    f.dispose();
  }
});

test('latest malformed journals, parent identity and backward pagination never expose older requests', async () => {
  const collect = collector();
  const cases: BoardReplayOptions[] = [
    { ambiguousJournal: true },
    { journalDenied: true },
    { wrongJournalParent: true },
    { journalCursorRepeats: true },
  ];
  for (const options of cases) {
    const f = deliveryBoardReplay(options);
    const result = await collect(request(), f.execution);
    const alpha = result.repositories[0]!;
    assert.equal(
      alpha.humanAttention.some((i) => i.number === 1),
      false,
    );
    assert.ok(alpha.coverage.humanAttention.unknownRows.some((i) => i.number === 1));
    if (options.ambiguousJournal)
      assert.deepEqual(alpha.coverage.humanAttention.unknownRows.find((i) => i.number === 1)?.reasons, [
        'journal-ambiguous',
      ]);
    assert.notEqual(alpha.coverage.humanAttention.status, 'complete');
    assert.equal(result.repositories[1]!.humanAttention.length, 5);
    f.assertReadOnly();
    f.dispose();
  }
  const f = deliveryBoardReplay({ journalBackwards: true });
  const result = await collect(request(), f.execution);
  assert.equal(result.repositories[0]!.humanAttention.find((i) => i.number === 1)?.request, 'Approve synthetic design');
  assert.equal(result.repositories[0]!.coverage.humanAttention.status, 'complete');
  f.assertReadOnly();
});

test('unknown Project status and repeated cursors remain unknown without per-issue fallback', async () => {
  const collect = collector();
  const cases: BoardReplayOptions[] = [
    { status: 'missing' },
    { status: 'unsupported' },
    { status: 'duplicate' },
    { projectCursorRepeats: true },
  ];
  for (const options of cases) {
    const f = deliveryBoardReplay(options);
    const result = await collect(request(), f.execution);
    const alpha = result.repositories[0]!;
    assert.equal(
      alpha.staleIssues.some((i) => i.number === 6),
      false,
    );
    assert.ok(alpha.coverage.staleIssues.unknownRows.some((i) => i.number === 6));
    assert.notEqual(alpha.coverage.staleIssues.status, 'complete');
    assert.equal(alpha.readyPrs.length, 5);
    if (options.projectCursorRepeats)
      assert.ok((f.calls.operations.ProjectDeliveryItems ?? 0) <= 2, 'cache one scoped failure for both repos');
    f.assertReadOnly();
    f.dispose();
  }
});

test('rolling windows are independent and use exact inclusive lower/exclusive upper bounds', async () => {
  const collect = collector();
  for (const asOf of [boardReplayAsOf, '2026-10-23T12:00:00.500Z']) {
    const f = deliveryBoardReplay({ windowEdges: true, recentBoundary: true, asOf });
    const result = await collect(request(), f.execution);
    const alpha = result.repositories[0]!;
    assert.equal(result.collection.asOf, asOf);
    assert.equal(alpha.metrics.opened.total, 1);
    assert.equal(alpha.metrics.opened.marked, 1);
    assert.equal(alpha.metrics.merged.total, 2);
    assert.equal(alpha.metrics.merged.marked, 1);
    assert.ok(alpha.staleIssues.some((i) => i.number === 6));
    assert.equal(
      alpha.staleIssues.some((i) => i.number === 7),
      false,
    );
    f.assertReadOnly();
    f.dispose();
  }
});

test('search gaps, duplicate IDs, unknown commits and retained-data limits do not report a percentage', async () => {
  const collect = collector();
  const cases: BoardReplayOptions[] = [
    { searchCap: true },
    { searchCursorRepeats: true },
    { duplicateSearchIds: true },
    { unknownMergeCommit: true },
    { retainedLimit: true },
    { lateMetricFailure: true },
  ];
  for (const options of cases) {
    const f = deliveryBoardReplay(options);
    const result = await collect(request(), f.execution);
    const metric = options.lateMetricFailure
      ? result.repositories[1]!.metrics.merged
      : options.unknownMergeCommit
        ? result.repositories[0]!.metrics.merged
        : result.repositories[0]!.metrics.opened;
    assert.equal(metric.complete, false);
    assert.equal(metric.percentage, null);
    assert.equal(result.complete, false);
    if (options.unknownMergeCommit) assert.equal(metric.unknown, 1);
    if (options.duplicateSearchIds) assert.equal(metric.total, 2);
    if (options.searchCursorRepeats) assert.ok((f.calls.operations.DeliveryBoardSearch ?? 0) <= 6);
    assert.equal(result.repositories[0]!.humanAttention.length, 5);
    assert.equal(result.repositories[1]!.readyPrs.length, 5);
    f.assertReadOnly();
    f.dispose();
  }
});

test('complete zero denominators are n/a and a valid missing queue is observed empty on this host', async () => {
  const collect = collector();
  const f = deliveryBoardReplay({ emptyMetrics: true, queue: 'missing' });
  const result = await collect(request(), f.execution);
  for (const r of result.repositories) {
    assert.deepEqual(
      [r.metrics.opened.marked, r.metrics.opened.total, r.metrics.opened.percentage, r.metrics.opened.complete],
      [0, 0, null, true],
    );
    assert.equal(r.mergeQueue.length, 0);
    assert.equal(r.coverage.mergeQueue.status, 'complete');
    assert.equal(r.queueScope.host, 'this-host');
  }
  f.assertReadOnly();
});

test('combined retained projections stop at the request bound while independent sections survive', async () => {
  const collect = collector();
  for (const projectDenied of [false, true]) {
    const f = deliveryBoardReplay({ combinedRetainedLimit: true, projectDenied });
    const result = await collect(request(), f.execution);
    assert.equal(result.complete, false);
    assert.equal(result.repositories[0]!.humanAttention.length, 5);
    const beta = result.repositories[1]!;
    assert.equal(beta.coverage.humanAttention.status, 'partial');
    assert.ok(beta.coverage.humanAttention.reasons.includes('retained-data-limit'));
    assert.equal(beta.readyPrs.length, 5);
    assert.equal(beta.metrics.opened.complete, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024 * 1024);
    f.assertReadOnly();
    f.dispose();
  }
});

test('an oversized PR retains bounded unknown identities without escaping the request limit', async () => {
  const collect = collector();
  const f = deliveryBoardReplay({ oversizedPr: true });
  const result = await collect(request(), f.execution);
  const alpha = result.repositories[0]!;
  assert.equal(result.complete, false);
  for (const section of ['readyPrs', 'blockedPrs'] as const) {
    assert.equal(alpha.coverage[section].status, 'partial');
    assert.ok(alpha.coverage[section].reasons.includes('retained-data-limit'));
    assert.equal(alpha.coverage[section].unknownRows.find((pr) => pr.number === 101)?.title, '');
  }
  assert.equal(alpha.readyPrs.length, 4);
  assert.equal(result.repositories[1]!.readyPrs.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024 * 1024);
  f.assertReadOnly();
});

test('unavailable PR facts make coverage partial while observed blocked facts remain complete', async () => {
  const collect = collector();
  for (const options of [
    { prReviewUnavailable: true },
    { prNativeUnavailable: true },
    { prChecksFailed: true },
    { movedBase: true },
  ]) {
    const f = deliveryBoardReplay(options);
    const result = await collect(request(), f.execution);
    const alpha = result.repositories[0]!;
    assert.ok(alpha.blockedPrs.some((pr) => pr.number === 101));
    const known = 'prChecksFailed' in options;
    assert.equal(alpha.coverage.readyPrs.status, known ? 'complete' : 'partial');
    assert.equal(alpha.coverage.blockedPrs.status, known ? 'complete' : 'partial');
    assert.equal(result.complete, known);
    assert.equal(result.repositories[1]!.readyPrs.length, 5);
    f.assertReadOnly();
    f.dispose();
  }
});

test('Project reuse requires matching verified principals and rejected contexts never read queues', async () => {
  const collect = collector();
  const cases: BoardReplayOptions[] = [
    { contextPrincipal: 'changed' },
    { contextPrincipal: 'unavailable' },
    { contextIdentityMismatch: true },
  ];
  for (const options of cases) {
    const f = deliveryBoardReplay(options);
    const result = await collect(request(), f.execution);
    const beta = result.repositories[1]!;
    assert.equal(result.complete, false);
    assert.equal(beta.coverage.staleIssues.status, 'unavailable');
    assert.equal(beta.coverage.mergeQueue.status, 'unavailable');
    assert.equal(f.calls.queueReads, 1, 'only alpha supplies a validated queue context');
    assert.equal(f.calls.operations.ProjectDeliveryItems, 6);
    assert.equal(beta.humanAttention.length, 5);
    assert.equal(beta.readyPrs.length, 5);
    assert.equal(beta.metrics.opened.complete, true);
    f.assertReadOnly();
    f.dispose();
  }
  const f = deliveryBoardReplay({ projectCursorRepeats: true });
  const result = await collect(request(), f.execution);
  assert.ok(result.repositories.every((repo) => repo.coverage.mergeQueue.status === 'complete'));
  assert.equal(f.calls.queueReads, 2, 'a later Project inventory failure preserves validated queue contexts');
  f.assertReadOnly();
});

test('unsafe, corrupt or unresolved host queues are unavailable without repair or setup', async () => {
  const collect = collector();
  for (const queue of ['corrupt', 'unsafe', 'no-checkout'] as const) {
    const f = deliveryBoardReplay({ queue });
    const result = await collect(request(), f.execution);
    for (const r of result.repositories) {
      assert.equal(r.mergeQueue.length, 0);
      assert.equal(r.coverage.mergeQueue.status, 'unavailable');
      assert.equal(r.readyPrs.length, 5);
    }
    f.assertReadOnly();
    f.dispose();
  }
});

test('selector conflicts and cancellation stop before dependent native work', async () => {
  const collect = collector();
  const f = deliveryBoardReplay();
  await assert.rejects(collect(request(), { ...f.execution, repo: boardReplayRepos[0]! }), /repo|selector/iu);
  assert.equal(f.calls.clientFactory, 0);
  const initial = new AbortController();
  initial.abort();
  await assert.rejects(collect(request(), { ...f.execution, signal: initial.signal }), /abort/iu);
  assert.equal(f.calls.clientFactory, 0);
  f.assertReadOnly();
  f.dispose();
  const during = new AbortController();
  const g = deliveryBoardReplay({ abortAfterRepository: during });
  await assert.rejects(collect(request(), { ...g.execution, signal: during.signal }), /abort/iu);
  assert.equal(g.calls.operations['Prs:example/alpha'], undefined);
  assert.equal(g.calls.operations['Repo:example/beta'], undefined);
  g.assertReadOnly();
});
