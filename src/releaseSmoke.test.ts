import assert from 'node:assert/strict';
import { test } from 'vitest';

interface Smoke {
  releaseSmoke: (input: { cli: (args: string[]) => unknown; version: string; now?: () => Date }) => {
    line: string;
    ok: boolean;
  };
}
const { releaseSmoke } = (await import(new URL('../scripts/release-smoke.mjs', import.meta.url).href)) as Smoke;

/** A repository with one issue state; `fail` makes the named command throw. */
function fakeCli(fail?: string, readTitle?: string) {
  const calls: string[][] = [];
  let title = '';
  let state = 'open';
  const cli = (args: string[]) => {
    calls.push(args);
    const command = args[0]!;
    if (command === fail) throw new Error(`${command} unavailable`);
    if (command === 'create') {
      title = args[args.indexOf('--title') + 1]!;
      return { created: { number: 42 } };
    }
    if (command === 'info') return { title: readTitle ?? title, state };
    state = 'closed';
    return { state };
  };
  return { calls, cli };
}
const now = () => new Date('2026-11-02T18:00:00.000Z');

test('release smoke creates a draft issue, reads it back and closes it', () => {
  const repository = fakeCli();
  const result = releaseSmoke({ cli: repository.cli, now, version: '0.3.41' });
  assert.equal(result.ok, true);
  assert.equal(result.line, 'PASS release smoke 0.3.41: created, read back and closed #42');
  assert.deepEqual(
    repository.calls.map((call) => call[0]),
    ['create', 'info', 'update'],
  );
  assert.ok(repository.calls[0]!.includes('--draft'));
  assert.equal(
    repository.calls[0]![repository.calls[0]!.indexOf('--title') + 1],
    'release smoke 0.3.41 2026-11-02T18:00:00.000Z',
  );
  assert.deepEqual(repository.calls[2], [
    'update',
    '--issue',
    '42',
    '--state',
    'closed',
    '--close-reason',
    'not_planned',
  ]);
});

test('a failed or wrong read-back still closes the issue and fails the check', () => {
  for (const repository of [fakeCli('info'), fakeCli(undefined, 'some other issue')]) {
    const result = releaseSmoke({ cli: repository.cli, now, version: '0.3.41' });
    assert.equal(result.ok, false);
    assert.match(result.line, /^FAIL release smoke 0\.3\.41: read back #42: /u);
    assert.deepEqual(
      repository.calls.map((call) => call[0]),
      ['create', 'info', 'update'],
      'the close is attempted after the failed read',
    );
  }
});

test('a failed create attempts no close, and a failed close tells the caller to close by hand', () => {
  const created = fakeCli('create');
  const failedCreate = releaseSmoke({ cli: created.cli, now, version: '0.3.41' });
  assert.equal(failedCreate.ok, false);
  assert.match(failedCreate.line, /^FAIL release smoke 0\.3\.41: create: create unavailable$/u);
  assert.deepEqual(
    created.calls.map((call) => call[0]),
    ['create'],
  );
  const closing = fakeCli('update');
  const failedClose = releaseSmoke({ cli: closing.cli, now, version: '0.3.41' });
  assert.equal(failedClose.ok, false);
  assert.match(failedClose.line, /close #42: update unavailable\. Close it by hand\.$/u);
});
