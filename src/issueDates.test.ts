import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDeliveryContext, updateIssue, issueInfo } from './issue.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { inertTarget, fixtureFields } from './fixtures/inertTarget.js';

function dateFixture() {
  const f = inertTarget();
  const original = f.rest.request;
  const dates = new Map<number, string>([
    [103, '2028-02-29'],
    [104, '2028-03-31'],
  ]);
  const changes: { route: string; input: Record<string, unknown> }[] = [];
  const controls = { mode: 'configured', failWrite: false };
  const definitions = () => [
    ...(controls.mode === 'missing'
      ? []
      : [{ id: 103, name: 'Start date', data_type: controls.mode === 'wrong-type' ? 'text' : 'date' }]),
    { id: 104, name: 'Target date', data_type: 'date' },
    ...(controls.mode === 'duplicate' ? [{ id: 203, name: 'Start date', data_type: 'date' }] : []),
    { id: 105, name: 'Notes', data_type: 'text' },
    { id: 106, name: 'Size', data_type: 'number' },
    { id: 107, name: 'Tags', data_type: 'multi_select' },
    { id: 108, name: 'Unassigned', data_type: 'date' },
  ];
  const values = async () => {
    const response = await original('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', {});
    return [
      ...(response.data as unknown[]),
      ...[...dates].map(([id, value]) => ({
        issue_field_id: id,
        issue_field_name: id === 103 ? 'Start date' : 'Target date',
        data_type: 'date',
        value,
      })),
      { issue_field_id: 105, issue_field_name: 'Notes', data_type: 'text', value: 'Preserve this note' },
      { issue_field_id: 106, issue_field_name: 'Size', data_type: 'number', value: 3.5 },
      {
        issue_field_id: 107,
        issue_field_name: 'Tags',
        data_type: 'multi_select',
        multi_select_options: [{ name: 'One' }, { name: 'Two' }],
      },
    ];
  };
  f.rest.request = (async (route: string, input: Record<string, unknown>) => {
    if (route === 'GET /orgs/{org}/issue-fields') {
      const response = await original(route, input);
      return { data: [...(response.data as unknown[]), ...definitions()] };
    }
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') return { data: await values() };
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values') {
      changes.push({ route, input: structuredClone(input) });
      const rows = input.issue_field_values as { field_id: number; value: string }[];
      if (controls.failWrite && rows.some((row) => row.field_id >= 103))
        throw new Error('Synthetic date field write unavailable');
      assert.ok(rows.length > 0, 'An empty POST would clear unrelated native values');
      const old = rows.filter((row) => row.field_id < 103);
      if (old.length) await original(route, { ...input, issue_field_values: old });
      for (const row of rows.filter((row) => row.field_id >= 103)) dates.set(row.field_id, row.value);
      return { data: await values() };
    }
    if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values/{issue_field_id}') {
      changes.push({ route, input: structuredClone(input) });
      assert.ok(dates.has(Number(input.issue_field_id)), 'Deleting an unset field would return 404');
      dates.delete(Number(input.issue_field_id));
      return { data: undefined };
    }
    return original(route, input);
  }) as typeof f.rest.request;
  return { ...f, dates, changes, controls };
}

test('MCP creates configured calendar dates and reads every supported field by name', async () => {
  const f = dateFixture();
  const c = await f.connect();
  try {
    const created = await c.call('issue_create', {
      ...fixtureFields,
      priority: 'High',
      startDate: '2032-02-29',
      targetDate: '2032-03-01',
    });
    assert.equal(created.response.isError, undefined, created.text);
    assert.equal(f.dates.get(103), '2032-02-29');
    const info = await c.call('issue_info', { issueNumber: 17 });
    assert.equal(info.response.isError, undefined, info.text);
    assert.deepEqual(info.value!.fields, {
      Estimate: '2',
      Urgency: 'High',
      'Start date': '2032-02-29',
      'Target date': '2032-03-01',
      Notes: 'Preserve this note',
      Size: 3.5,
      Tags: ['One', 'Two'],
      Unassigned: null,
    });
  } finally {
    await f.dispose(c);
  }
});

test('MCP explicit date clear targets one field and omission preserves all other values', async () => {
  const f = dateFixture();
  const c = await f.connect();
  try {
    const result = await c.call('issue_update', { issueNumber: 17, startDate: null });
    assert.equal(result.response.isError, undefined, result.text);
    assert.equal(f.dates.has(103), false);
    assert.equal(f.dates.get(104), '2028-03-31');
    assert.equal((result.value!.fields as Record<string, unknown>)['Start date'], null);
    assert.deepEqual(
      f.changes.filter((x) => x.route.startsWith('DELETE')).map((x) => x.input.issue_field_id),
      [103],
    );
    f.changes.length = 0;
    const omitted = await c.call('issue_update', { issueNumber: 17, priority: 'Low' });
    assert.equal(omitted.response.isError, undefined, omitted.text);
    assert.equal(f.dates.get(104), '2028-03-31');
    assert.equal((omitted.value!.fields as Record<string, unknown>).Notes, 'Preserve this note');
    assert.equal(
      f.changes.some((x) => x.route.startsWith('DELETE')),
      false,
    );
  } finally {
    await f.dispose(c);
  }
});

for (const mode of ['missing', 'duplicate', 'wrong-type']) {
  test(`MCP refuses ${mode} requested date field before issue or field mutation`, async () => {
    const f = dateFixture();
    f.controls.mode = mode;
    if (mode === 'missing') f.dates.delete(103);
    const c = await f.connect();
    try {
      const before = f.calls.length;
      const result = await c.call('issue_create', { ...fixtureFields, startDate: '2032-02-29' });
      assert.equal(result.response.isError, true);
      assert.match(result.text, /Start date|duplicate|catalog/u);
      assert.equal(
        f.calls
          .slice(before)
          .some((x) => x.name === 'issues.create' || x.name === 'issues.update' || x.name === 'issues.createComment'),
        false,
      );
      assert.deepEqual(f.changes, []);
    } finally {
      await f.dispose(c);
    }
  });
}

for (const value of ['2027-02-29', '2032-02-30', '2032-13-01', '2032-01-01T00:00:00Z']) {
  test(`MCP rejects non-calendar date ${value} before writes`, async () => {
    const f = dateFixture();
    const c = await f.connect();
    try {
      const before = f.calls.length;
      const result = await c.call('issue_update', { issueNumber: 17, targetDate: value });
      assert.equal(result.response.isError, true);
      const error = JSON.parse(result.text) as { failures: { code: string; field: string }[] };
      assert.ok(error.failures.some((failure) => failure.code === 'field.type' && failure.field === 'targetDate'));
      assert.equal(
        f.calls.slice(before).some((x) => x.name === 'issues.update' || x.name === 'issues.createComment'),
        false,
      );
      assert.deepEqual(f.changes, []);
    } finally {
      await f.dispose(c);
    }
  });
}

test('MCP clear of an unset configured date is idempotent', async () => {
  const f = dateFixture();
  f.dates.delete(103);
  const c = await f.connect();
  try {
    const result = await c.call('issue_update', { issueNumber: 17, startDate: null });
    assert.equal(result.response.isError, undefined, result.text);
    assert.equal(
      f.changes.some((x) => x.route.startsWith('DELETE')),
      false,
    );
  } finally {
    await f.dispose(c);
  }
});

test('public library date updates use the same guarded owner and preserve unrelated native fields', async () => {
  const f = dateFixture();
  try {
    const context = await loadDeliveryContext({
      identity: 'author',
      role: 'author',
      repoRoot: f.root,
      repository: 'example/widget',
    });
    const updated = await updateIssue(context, { issueNumber: 17, targetDate: '2032-02-29' });
    assert.equal(updated.targetDate, '2032-02-29');
    assert.equal(updated.startDate, '2028-02-29');
    assert.equal(updated.fields.Notes, 'Preserve this note');
    assert.deepEqual((await issueInfo(context, 17)).fields, updated.fields);
    const before = f.changes.length;
    await assert.rejects(updateIssue(context, { issueNumber: 17, targetDate: '2031-02-29' }));
    assert.equal(f.changes.length, before);
  } finally {
    await f.dispose(undefined);
  }
});

for (const command of ['create', 'update']) {
  test(`CLI ${command} fields file accepts native date aliases and validates calendar dates before configuration`, () => {
    const root = mkdtempSync(join(tmpdir(), 'issue151-cli-'));
    try {
      const file = join(root, 'fields.json');
      const args = command === 'create' ? ['create', '--title', fixtureFields.title] : ['update', '--issue', '17'];
      for (const value of ['2032-02-29', null, '2031-02-29']) {
        writeFileSync(file, JSON.stringify({ ...(command === 'create' ? fixtureFields : {}), targetDate: value }));
        const result = spawnSync(
          process.execPath,
          [resolve('dist/cli.js'), '--repo', 'example/widget', ...args, '--fields-file', file],
          {
            encoding: 'utf8',
            env: { ...process.env, AI_DELIVERY_CONFIG: join(root, 'missing-settings.json') },
          },
        );
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
        if (value === '2031-02-29') {
          assert.match(result.stderr, /targetDate/u);
          assert.match(result.stderr, /field.type|invalid_format|ISO date/u);
        } else {
          assert.doesNotMatch(result.stderr, /field.unknown|field.type/u);
          assert.match(result.stderr, /configuration|settings|ENOENT/iu);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a date-field failure after issue creation reports the known issue without creating another', async () => {
  const f = dateFixture();
  const c = await f.connect();
  try {
    f.controls.failWrite = true;
    const result = await c.call('issue_create', { ...fixtureFields, startDate: '2032-02-29' });
    assert.equal(result.response.isError, true);
    assert.match(result.text, /Issue #17 was created/u);
    assert.match(result.text, /do not create another/u);
    assert.equal(f.calls.filter((call) => call.name === 'issues.create').length, 1);
  } finally {
    await f.dispose(c);
  }
});

test('dates do not silently expand the separate issue_start input contract', () => {
  const start = getAiDeliveryMcpTool('issue_start')!;
  assert.throws(() => start.inputSchema.parse({ repo: 'example/widget', issueNumber: 17, startDate: '2032-02-29' }));
});
