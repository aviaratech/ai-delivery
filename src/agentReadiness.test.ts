import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { evaluateAgentReadiness } from './agent.js';
import { IssueFields, renderIssueBody } from './issueContract.js';

function fixture() {
  return IssueFields.parse({
    title: 'Reject invalid widget identifiers before persistence',
    points: 2,
    problem: 'The Project Todo column tracks work; TODO/TBD are literal documentation.',
    outcome: 'Reject malformed widget identifiers.',
    acceptanceCriteria: [
      {
        behavior: 'An invalid widget identifier returns an error without a write.',
        verifiedBy: 'A synthetic mock asserts no write.',
      },
    ],
    outOfScope: ['Changing storage.'],
    context: { files: ['src/absent.ts'], components: [], evidence: [] },
  });
}
function evaluate(overrides: Partial<Parameters<typeof evaluateAgentReadiness>[0]> = {}) {
  const issue = fixture();
  return evaluateAgentReadiness({
    title: issue.title,
    body: renderIssueBody(issue),
    points: 2,
    repoRoot: undefined,
    ...overrides,
  });
}

test('readiness from a non-git directory accepts Todo prose, absent paths and portable non-command verification', () => {
  const prior = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'typed-readiness-'));
  try {
    process.chdir(root);
    const result = evaluate();
    assert.equal(result.ready, true);
    assert.deepEqual(result.failures, []);
  } finally {
    process.chdir(prior);
    rmSync(root, { recursive: true, force: true });
  }
});
test('one or eight observable criteria are valid; count warns above seven', () => {
  for (const count of [1, 8]) {
    const issue = fixture();
    issue.acceptanceCriteria = Array.from({ length: count }, () => ({ ...issue.acceptanceCriteria[0]! }));
    const result = evaluate({ body: renderIssueBody(issue) });
    assert.equal(result.ready, true);
    assert.equal(
      result.warnings.some((w) => w.code === 'many-criteria'),
      count === 8,
    );
  }
});
for (const [name, override, code] of [
  ['missing live Points', { points: undefined }, 'points'],
  ['open native blocker', { blockedBy: [17] }, 'blocked'],
  ['tracking parent', { trackingParent: true }, 'tracking-parent'],
] as const)
  test(name + ' blocks independently of a valid body', () => {
    const result = evaluate(override);
    assert.equal(result.ready, false);
    assert.ok(result.failures.some((f) => f.code === code));
  });
test('draft and structured open questions block even without TODO markers', () => {
  for (const changed of [{ draft: true }, { openQuestions: ['Select the persistence contract.'] }]) {
    const issue = { ...fixture(), ...changed };
    assert.equal(evaluate({ body: renderIssueBody(issue) }).ready, false);
  }
});
test('native Points drift and visible/payload divergence cannot pass canonical readiness', () => {
  assert.ok(evaluate({ points: 3 }).failures.some((f) => f.code === 'points.sync'));
  assert.ok(
    evaluate({ body: renderIssueBody(fixture()).replace('## Status', '## Changed status') }).failures.some(
      (f) => f.code === 'body.canonical',
    ),
  );
});
