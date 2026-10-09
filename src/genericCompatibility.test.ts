import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

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
