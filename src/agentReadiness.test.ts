import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';

import { evaluateAgentReadiness } from './agent.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'readiness-currency-'));
  for (const path of ['src/feature.ts', 'src/$1.ts', 'docs/guide.md', '$1/config.ts']) {
    const filename = join(repoRoot, path);
    mkdirSync(join(filename, '..'), { recursive: true });
    writeFileSync(filename, 'Synthetic feature fixture.\n');
  }
});

afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

function body(scope: string, evidence = ''): string {
  return [
    '## Problem',
    'Keep feature behavior correct while evaluating a bounded change.',
    '## Scope',
    scope,
    '## Acceptance Criteria',
    '- [ ] The intended feature works.',
    '- [ ] Existing behavior is preserved.',
    '## Verification',
    '`npm run checks`',
    '## Current State',
    evidence,
  ].join('\n');
}

function evaluate(scope: string, overrides: Partial<Parameters<typeof evaluateAgentReadiness>[0]> = {}) {
  return evaluateAgentReadiness({
    body: body(scope),
    points: 2,
    repoRoot,
    title: 'Improve the synthetic feature',
    ...overrides,
  });
}

describe('inline monetary prose in declared readiness scope', () => {
  test.each(['$1/$2', '$1', '$2.50', '$1,000.00', '$0.50 / $2.00', '$1-$2', '$1–$2'])(
    'accepts an existing scope path with monetary prose %s without false path or evidence requirements',
    (currency) => {
      assert.deepEqual(evaluate(`- \`src/feature.ts\`\nPrices are \`${currency}\`.`), {
        ready: true,
        failures: [],
      });
    },
  );

  test('handles whitespace and several independent monetary spans', () => {
    assert.equal(evaluate('- `src/feature.ts`\nPrices are ` $1/$2 `, `$3.50` and `$4`.').ready, true);
  });

  test.each(['$1/$2', '$2.50', '$1,000.00'])(
    'does not let monetary prose %s substitute for declared scope',
    (currency) => {
      assert.deepEqual(
        evaluate(`Prices are \`${currency}\`.`).failures.map((failure) => failure.code),
        ['scope'],
      );
    },
  );

  test('does not let currency-only scope pass when no local repository root is available', () => {
    assert.deepEqual(
      evaluate('Prices are `$1/$2`.', { repoRoot: undefined }).failures.map((failure) => failure.code),
      ['scope'],
    );
  });

  test('ignores monetary prose without changing path syntax validation when the root is unavailable', () => {
    assert.equal(evaluate('- `src/feature.ts`\nPrices are `$1/$2`.', { repoRoot: undefined }).ready, true);
    assert.equal(evaluate('- `../feature.ts`\nPrices are `$1/$2`.', { repoRoot: undefined }).ready, false);
  });
});

describe('preserved path and evidence requirements', () => {
  test.each(['src/feature.ts', './src/feature.ts', 'src\\feature.ts', 'src/feature.ts:3', 'src/feature.ts:3:2'])(
    'accepts the existing path syntax %s',
    (path) => assert.equal(evaluate(`- \`${path}\`\nPrices are \`$1/$2\`.`).ready, true),
  );

  test.each(['src/$1.ts', '$1/config.ts'])('preserves existing dollar-bearing paths %s', (path) =>
    assert.equal(evaluate(`- \`${path}\``).ready, true),
  );

  test.each([
    'src/missing.ts',
    'missing',
    '../outside.ts',
    'src/../../outside.ts',
    '/absolute.ts',
    '..\\outside.ts',
    'src/$2.ts',
    '$2/config.ts',
    '$1/$2.ts',
    '$HOME',
    '1/2',
    'USD 1/2',
    '$1/$2suffix',
    '$1,00',
    'arbitrary inline prose',
    'npm run checks',
  ])('still rejects missing, invalid or non-currency inline scope %s', (path) => {
    const result = evaluate(`- \`src/feature.ts\`\n- \`${path}\`\nPrices are \`$1/$2\`.`);
    assert.equal(result.ready, false);
    assert.ok(result.failures.some((failure) => failure.code === 'scope'));
  });

  test('does not let currency hide a missing declared path', () => {
    assert.ok(evaluate('- `src/missing.ts`\nPrices are `$1/$2`.').failures.some((failure) => failure.code === 'scope'));
  });

  test('keeps repository-backed evidence mandatory for contract-sensitive scope', () => {
    const scope = '- `src/feature.ts`\nPrices are `$1/$2`.';
    const input = body(scope).replace('bounded change', 'contract-sensitive change');
    assert.deepEqual(
      evaluate(scope, { body: input }).failures.map((failure) => failure.code),
      ['evidence'],
    );
    assert.equal(evaluate(scope, { body: `${input}\nObserved implementation: \`src/feature.ts\`.` }).ready, true);
  });

  test('keeps evidence mandatory for multiple real ownership roots', () => {
    const scope = '- `src/feature.ts`\n- `docs/guide.md`\nPrices are `$1/$2`.';
    assert.deepEqual(
      evaluate(scope).failures.map((failure) => failure.code),
      ['evidence'],
    );
    assert.equal(evaluate(scope, { body: body(scope, 'Observed implementation: `src/feature.ts`.') }).ready, true);
  });

  test('keeps evidence mandatory for aggregate scope', () => {
    const scope = '- `.`\nPrices are `$1/$2`.';
    assert.deepEqual(
      evaluate(scope).failures.map((failure) => failure.code),
      ['evidence'],
    );
    assert.equal(evaluate(scope, { body: body(scope, 'Observed implementation: `src/feature.ts`.') }).ready, true);
  });

  test('does not treat currency or a missing path outside Scope as repository-backed evidence', () => {
    const scope = '- `src/feature.ts`';
    const input = body(scope, 'Observed prices: `$1/$2`; absent implementation: `src/missing.ts`.').replace(
      'bounded change',
      'contract-sensitive change',
    );
    assert.deepEqual(
      evaluate(scope, { body: input }).failures.map((failure) => failure.code),
      ['evidence'],
    );
  });
});

describe('preserved non-scope readiness gates', () => {
  const scope = '- `src/feature.ts`\nPrices are `$1/$2`.';

  test('requires configured points', () => {
    assert.deepEqual(
      evaluateAgentReadiness({ body: body(scope), repoRoot, title: 'Improve the synthetic feature' }).failures.map(
        (failure) => failure.code,
      ),
      ['points'],
    );
  });

  test('requires two to five acceptance criteria', () => {
    const input = body(scope).replace('- [ ] Existing behavior is preserved.\n', '');
    assert.deepEqual(
      evaluate(scope, { body: input }).failures.map((failure) => failure.code),
      ['acceptance-criteria'],
    );
  });

  test('requires executable verification', () => {
    const input = body(scope).replace('`npm run checks`', 'Inspect the change.');
    assert.deepEqual(
      evaluate(scope, { body: input }).failures.map((failure) => failure.code),
      ['verification'],
    );
  });

  test('requires a substantive outcome or problem', () => {
    const input = body(scope).replace('Keep feature behavior correct while evaluating a bounded change.', 'Brief.');
    assert.deepEqual(
      evaluate(scope, { body: input }).failures.map((failure) => failure.code),
      ['outcome'],
    );
  });

  test('refuses native blockers', () => {
    assert.deepEqual(
      evaluate(scope, { blockedBy: [17] }).failures.map((failure) => failure.code),
      ['blocked'],
    );
  });

  test('refuses tracking parents', () => {
    assert.deepEqual(
      evaluate(scope, { trackingParent: true }).failures.map((failure) => failure.code),
      ['tracking-parent'],
    );
  });

  test('refuses unresolved decisions', () => {
    assert.deepEqual(
      evaluate(scope, { body: `${body(scope)}\nTBD` }).failures.map((failure) => failure.code),
      ['unresolved'],
    );
  });
});
