import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  buildVelocityReport,
  getDeliveryRecords,
  recordMergedDelivery,
  type DeliveryRecord,
} from './services/deliveryRecordService.js';
import { planOfflineLegacyIssueMigration } from './services/legacyIssueMigration.js';

test('offline legacy normalization preserves native blockers and refuses an unproven tracking parent', () => {
  const input = {
    issues: [
      {
        number: 17,
        body: '<!-- dependencyDeclaration: {"blockedBy":["#9"]} -->\n## Outcome\nDeliver.',
        labels: ['area:delivery', 'effort:s', 'type:task', 'status:blocked'],
      },
    ],
    repositoryLabels: ['area:delivery', 'effort:s'],
  };
  const report = planOfflineLegacyIssueMigration(input);
  assert.equal(report.schemaVersion, 'ai-delivery.legacy-issue-migration@1');
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.plans[0]?.native, {
    blockedBy: [9],
    issueType: 'Task',
    points: 2,
    projectStatus: 'Blocked',
  });
  assert.deepEqual(report.retiredRepositoryLabels, ['effort:s']);
  assert.doesNotMatch(report.plans[0]?.body ?? '', /dependencyDeclaration/u);
  assert.throws(
    () =>
      planOfflineLegacyIssueMigration({
        issues: [
          {
            number: 18,
            body: 'Track children',
            labels: ['type:tracking'],
          },
        ],
      }),
    /native sub-issue/u,
  );
  assert.throws(
    () => planOfflineLegacyIssueMigration({ issues: [input.issues[0], input.issues[0]] }),
    /repeats an issue number/u,
  );
});

test('legacy CLI emits an offline plan without modifying its input', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-migration-'));
  try {
    const path = join(root, 'issues.json');
    const bytes = JSON.stringify({ issues: [{ number: 5, body: '## Outcome\nDeliver.', labels: ['effort:xs'] }] });
    writeFileSync(path, bytes);
    const output = execFileSync(
      process.execPath,
      [join(process.cwd(), 'dist', 'cli.js'), 'migrate:legacy-issues', '--input-file', path],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(output) as { mode: string; plans: { native: { points: number } }[] };
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.plans[0]?.native.points, 1);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded velocity records are idempotent and conflict on changed merged facts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-metrics-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    const now = new Date('2026-09-25T12:00:00.000Z');
    const mergedAt = '2026-09-20T12:00:00.000Z';
    const record: DeliveryRecord = {
      blockerTimeMs: null,
      cycleTimeMs: 3600000,
      firstPassApproved: null,
      issueNumber: 17,
      mergedAt,
      mergeSha: 'a'.repeat(40),
      points: 4,
      recordedAt: '2026-09-20T13:00:00.000Z',
      repository: 'example/widget',
      reviewRounds: null,
      schemaVersion: 'ai-delivery.delivery-record@1',
      terminalCleanupAt: '2026-09-20T13:00:00.000Z',
    };
    assert.equal((await recordMergedDelivery(record, root)).state, 'recorded');
    assert.equal((await recordMergedDelivery(record, root)).state, 'already-recorded');
    assert.equal(getDeliveryRecords(root).length, 1);
    await assert.rejects(recordMergedDelivery({ ...record, points: 3 }, root), /facts conflict/u);
    const report = buildVelocityReport(getDeliveryRecords(root), now, [1, 2, 4]);
    assert.equal(report.schemaVersion, 'ai-delivery.velocity-report@1');
    assert.equal(
      report.weeks.reduce((sum, week) => sum + week.mergedPoints, 0),
      4,
    );
    assert.equal(report.pointBuckets.find((bucket) => bucket.points === 4)?.firstPassRate, null);
    assert.equal(report.pointBuckets.find((bucket) => bucket.points === 1)?.deliveries, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
