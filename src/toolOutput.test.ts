import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, test, vi } from 'vitest';
import * as dispatch from './dispatch.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { IssueValidationError } from './issueContract.js';
import { projectToolOutput } from './toolOutput.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';

const issue = {
  issueNumber: 17,
  url: 'https://github.com/example/widget/issues/17',
  title: 'Synthetic delivery change',
  state: 'open',
  projectStatus: 'Todo',
  issueType: 'Feature',
  points: 3,
  priority: 'P1',
  fields: { startDate: null },
  blockedBy: [12],
  parentIssueNumber: 1,
  body:
    'Synthetic issue body. '.repeat(140).padEnd(3000, '.') +
    '\n' +
    Array.from({ length: 5 }, (_, i) => `- [ ] Criterion ${i + 1}`).join('\n'),
  routing: { repository: 'example/widget', statusFieldId: 'synthetic-status' },
};
const warning = {
  code: 'body.length',
  field: 'body',
  message: 'Consider a smaller body.',
  fixHint: 'Shorten the body.',
};
const results = {
  issue_create: { ...issue, warnings: [warning] },
  issue_update: {
    ...issue,
    warnings: [warning],
    conversion: { priorBody: issue.body, canonicalBody: issue.body, diff: issue.body },
    historyComment: { commentId: 30, url: `${issue.url}#issuecomment-30`, body: issue.body, reused: false },
  },
  issue_info: issue,
  issue_comment: { commentId: 31, url: `${issue.url}#issuecomment-31`, body: issue.body, reused: false },
  issue_pr_create: {
    prNumber: 23,
    url: 'https://github.com/example/widget/pull/23',
    headSha: 'a'.repeat(40),
    draft: true,
    reviewRoute: {
      author: { actorLogin: 'synthetic-author', credentialSource: 'synthetic-author-source', identity: 'author' },
      reviewer: {
        actorLogin: 'synthetic-reviewer[bot]',
        credentialSource: 'synthetic-reviewer-source',
        identity: 'reviewer',
      },
      rules: { observedRequiredApprovals: 1, visibility: 'complete' },
      approvalEligibility: 'unknown',
      nextAction: 'Confirm counted approval after exact-head submission.',
    },
  },
  issue_pr_info: {
    prNumber: 23,
    url: 'https://github.com/example/widget/pull/23',
    state: 'open',
    draft: true,
    headSha: 'a'.repeat(40),
    headBranch: 'issue/17',
    baseBranch: 'main',
    merged: false,
  },
};
const inputs = {
  issue_create: { title: issue.title, issueType: 'Feature', points: 3, draft: true },
  issue_update: { issueNumber: 17, title: issue.title },
  issue_info: { issueNumber: 17 },
  issue_comment: {
    issueNumber: 17,
    kind: 'start',
    summary: 'Started.',
    status: 'In progress',
    outcome: 'Deliver the change.',
    nextStep: 'Test.',
    nextDate: null,
    keyNumbers: [],
    evidence: [],
  },
  issue_pr_create: { issueNumber: 17, body: 'Closes #17\n\nSynthetic change.' },
  issue_pr_info: { issueNumber: 17, prNumber: 23 },
};
afterEach(() => vi.restoreAllMocks());

async function call(name: keyof typeof results, verbose?: boolean) {
  const server = createAiDeliveryMcpServer({ repoRoot: '/synthetic' });
  const client = new Client({ name: 'compact-output-synthetic', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await client.callTool({
      name,
      arguments: { ...inputs[name], repo: 'example/widget', ...(verbose === undefined ? {} : { verbose }) },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

test.each(Object.keys(results) as Array<keyof typeof results>)(
  '%s returns compact MCP JSON and unchanged verbose JSON',
  async (name) => {
    const execute = vi.spyOn(dispatch, 'executeTool').mockResolvedValue(results[name]);
    const compact = await call(name);
    expect(compact.isError).not.toBe(true);
    const text = (compact.content as Array<{ text: string }>)[0]!.text;
    expect(text.length).toBeLessThanOrEqual(1500);
    expect(JSON.parse(text)).not.toHaveProperty('body');
    const verbose = await call(name, true);
    expect(verbose.isError).not.toBe(true);
    const full = (verbose.content as Array<{ text: string }>)[0]!.text;
    expect(full).toBe(JSON.stringify(results[name]));

    expect(execute.mock.calls.at(-1)![1]).not.toHaveProperty('verbose');
  },
);

test('MCP compact and verbose snapshots', async () => {
  const compact: Record<string, unknown> = {};
  const execute = vi.spyOn(dispatch, 'executeTool');
  for (const name of Object.keys(results) as Array<keyof typeof results>) {
    execute.mockResolvedValue(results[name]);
    const reply = await call(name);
    compact[name] = JSON.parse((reply.content as Array<{ text: string }>)[0]!.text);
  }
  await expect(JSON.stringify(compact, null, 2) + '\n').toMatchFileSnapshot(
    join(process.cwd(), 'src/fixtures/toolOutput.compact.snap'),
  );
  execute.mockResolvedValue(results.issue_update);
  const reply = await call('issue_update', true);
  await expect(
    JSON.stringify(JSON.parse((reply.content as Array<{ text: string }>)[0]!.text), null, 2) + '\n',
  ).toMatchFileSnapshot(join(process.cwd(), 'src/fixtures/toolOutput.verbose.snap'));
});

test('contract refusals retain the field and fix hint', async () => {
  vi.spyOn(dispatch, 'executeTool').mockRejectedValue(new IssueValidationError([warning]));
  const reply = await call('issue_update');
  expect(reply.isError).toBe(true);
  const refusal = JSON.parse((reply.content as Array<{ text: string }>)[0]!.text) as { failures: unknown };
  expect(refusal.failures).toEqual([warning]);
});

test('verbose belongs to the batch envelope and cannot alter an individual write', () => {
  const schema = getAiDeliveryMcpTool('issue_batch_update')!.inputSchema;
  expect(
    schema.parse({ verbose: true, items: [{ issueNumber: 17, status: { latestJournal: 'Verified' } }] }),
  ).toHaveProperty('verbose', true);
  expect(() =>
    schema.parse({ items: [{ issueNumber: 17, verbose: true, status: { latestJournal: 'Verified' } }] }),
  ).toThrow();
});

test('published write schemas state the limits that refuse a write', async () => {
  const server = createAiDeliveryMcpServer({ repoRoot: '/synthetic' });
  const client = new Client({ name: 'schema-limits-synthetic', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  const published = (name: string) => JSON.stringify(tools.find((tool) => tool.name === name));
  for (const name of ['issue_create', 'issue_update', 'issue_batch_update']) {
    expect(published(name)).toContain('10–80 characters');
    expect(published(name)).toContain('1, 2, 3, 5 or 8');
    expect(published(name)).toContain('Required when issueType is Bug');
  }
  expect(published('issue_comment')).toContain('progress: done, decisionNeeded and non-empty evidence');
  expect(published('issue_comment')).toContain('HTTPS link with a public DNS hostname');
});

test('compact batch output reports each item once', () => {
  const item = {
    issueNumber: 17,
    status: 'applied',
    changes: { state: 'closed', closeReason: 'not_planned' },
    readback: issue,
    relatedReadback: { ...issue, closeReason: 'not_planned' },
  };
  const value = { dryRun: false, results: Array.from({ length: 10 }, () => item), summary: { total: 10 } };
  const compact = JSON.stringify(projectToolOutput('issue_batch_update', value));
  expect(compact).not.toContain('relatedReadback');
  expect(compact.length).toBeLessThanOrEqual(10 * 600);
  expect(projectToolOutput('issue_batch_update', value, true)).toBe(value);
});

test('compact output preserves recovery inputs, fields and diagnostics without mutating evidence', () => {
  const value = {
    status: 'update-incomplete',
    native: { readback: issue },
    recovery: { tool: 'issue_batch_update', arguments: { items: [{ issueNumber: 17, body: issue.body }] } },
    safeResume: { tool: 'issue_start', arguments: { body: issue.body } },
    fields: { body: 'An organization field named body' },
    warnings: [warning],
    failures: [warning],
  };
  const before = JSON.stringify(value);
  const compact = projectToolOutput('issue_update', value) as typeof value;
  expect(compact.native.readback).not.toHaveProperty('body');
  expect(compact.recovery).toEqual(value.recovery);
  expect(compact.safeResume).toEqual(value.safeResume);
  expect(compact.fields).toEqual(value.fields);
  expect(compact.warnings).toEqual([warning]);
  expect(compact.failures).toEqual([warning]);
  expect(JSON.stringify(value)).toBe(before);
  expect(projectToolOutput('issue_update', value, true)).toBe(value);
  expect(projectToolOutput('board_reconcile', value)).toBe(value);
});

test.each([[], ['--json'], ['--verbose'], ['--json', '--verbose']].map((flags) => ({ flags })))(
  'actual CLI output flags $flags',
  { tags: ['release'] },
  async ({ flags }) => {
    const cli = pathToFileURL(join(process.cwd(), 'dist/cli.js')).href;
    const module = pathToFileURL(join(process.cwd(), 'dist/dispatch.js')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--no-warnings',
        '--input-type=module',
        '-e',
        `import { mock } from 'node:test';
     mock.module(${JSON.stringify(module)}, { exports: {
       contextFor: () => { throw new Error('Unexpected configuration access'); },
       executeTool: async () => (${JSON.stringify(results.issue_update)})
     }});
     process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(flags)}, 'update', '--issue', '17', '--title', 'Synthetic delivery change'];
     await import(${JSON.stringify(cli)});`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const full = flags.includes('--json') && flags.includes('--verbose');
    if (full) expect(result.stdout).toBe(JSON.stringify(results.issue_update, null, 2) + '\n');
    else expect(result.stdout.length).toBeLessThanOrEqual(1500);
    if (!full) await expect(result.stdout).toMatchFileSnapshot(join(process.cwd(), 'src/fixtures/toolOutput.cli.snap'));
  },
);
