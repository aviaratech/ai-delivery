import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import * as settings from './config/deliveryConfig.js';
import * as issues from './issue.js';
import { executeTool, resumedIssueUpdate } from './dispatch.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import { issue63Fixture } from './fixtures/issue63.js';

afterEach(() => vi.restoreAllMocks());
const execution = { repoRoot: '/unrelated', repo: 'example/widget' };
function routes() {
  const f = issue63Fixture();
  vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue({
    roles: { author: { identity: 'author', authSource: 'personal' }, reviewer: { identity: 'reviewer' } },
  } as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>);
  const load = vi.spyOn(issues, 'loadDeliveryContext').mockResolvedValue(f.context);
  return { f, load };
}
test('public update/create schemas preserve guard fields and refuse invalid reasons', async () => {
  const { f, load } = routes();
  const input = { issueNumber: 17, blockedBy: [18], overrideReason: 'Explicit prerequisite' };
  await executeTool('issue_update', input, execution);
  assert.equal(f.comments.length, 1);
  assert.equal(load.mock.calls[0]![0].repository, 'example/widget');
  assert.deepEqual(
    resumedIssueUpdate({
      repo: 'example/widget',
      issueNumber: 20,
      blocks: [17],
      overrideReason: 'Reason',
      resumeCreated: true,
    }),
    { issueNumber: 20, blocks: [17], overrideReason: 'Reason' },
  );
  const create = getAiDeliveryMcpTool('issue_create')!.inputSchema;
  assert.equal(create.safeParse({ ...f.ready, blocks: [17], overrideReason: 'Reason' }).success, true);
  assert.throws(() => create.parse({ ...f.ready, blocks: [17], overrideReason: ' '.repeat(4) }));
  assert.throws(() =>
    getAiDeliveryMcpTool('issue_update')!.inputSchema.parse({ ...input, overrideReason: 'x'.repeat(2001) }),
  );
});
test('public health dispatch requires explicit repo and validates range before credential loading', async () => {
  const { f, load } = routes();
  const args = { repo: 'example/widget', from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z' };
  const result = (await executeTool('delivery_health', args, execution)) as { repository: string };
  assert.equal(result.repository, args.repo);
  assert.deepEqual(f.writes, []);
  const calls = load.mock.calls.length;
  await assert.rejects(executeTool('delivery_health', { from: args.from, to: args.to }, execution));
  await assert.rejects(executeTool('delivery_health', { ...args, to: args.from }, execution));
  assert.equal(load.mock.calls.length, calls);
});
test('actual CLI declares guard fields on every alias and the bounded health command', () => {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  for (const command of ['create', 'start', 'update']) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=96', cli, command, '--help'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--blocks/u);
    assert.match(result.stdout, /--override-reason/u);
  }
  const health = spawnSync(process.execPath, ['--max-old-space-size=96', cli, 'health', '--help'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(health.status, 0, health.stderr);
  for (const option of ['--from', '--to', '--max-issues', '--max-timeline-pages', '--oldest-limit'])
    assert.ok(health.stdout.includes(option));
  const invalid = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=96',
      cli,
      '--repo',
      'example/widget',
      'health',
      '--from',
      'invalid',
      '--to',
      '2026-01-03T00:00:00Z',
    ],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /datetime|ISO|Invalid/u);
});

test('actual issue_start recovery executes guarded reciprocal tracking against the known created issue', async () => {
  const { f } = routes();
  f.controls.failAdd = true;
  await assert.rejects(
    issues.createIssue(f.context, { ...f.ready, blocks: [17], overrideReason: 'Recorded prerequisite' }),
  );
  assert.ok(f.rows.has(20));
  f.controls.failAdd = false;
  vi.spyOn(issues, 'startIssueBranch').mockResolvedValue({
    issueNumber: 20,
    issueUrl: 'https://github.com/example/widget/issues/20',
    branch: 'issue/20',
    headSha: 'a'.repeat(40),
    reused: false,
  });
  vi.spyOn(issues, 'journalIssueStart').mockResolvedValue({
    commentId: 1,
    url: 'https://github.com/example/widget/issues/20#issuecomment-1',
    body: 'Start',
    reused: false,
  });
  const result = (await executeTool(
    'issue_start',
    {
      repo: 'example/widget',
      issueNumber: 20,
      resumeCreated: true,
      blocks: [17],
      overrideReason: 'Recorded prerequisite',
    },
    execution,
  )) as { issueNumber: number };
  assert.equal(result.issueNumber, 20);
  assert.equal(f.rows.size, 4);
  assert.deepEqual([...f.edges.get(17)!], [20]);
  assert.equal(f.comments.length, 1);
});

test('public MCP protocol discovers health and executes the same read-only owner', async () => {
  const { f } = routes();
  const server = createAiDeliveryMcpServer(execution);
  const client = new Client({ name: 'issue63-public-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const health = tools.tools.find((tool) => tool.name === 'delivery_health');
    assert.ok(health);
    assert.ok(health.inputSchema.required?.includes('repo'));
    const reply = await client.callTool({
      name: 'delivery_health',
      arguments: { repo: 'example/widget', from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z' },
    });
    assert.equal(reply.isError, undefined);
    const text = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(reply)
      .content[0]!.text;
    const report = z
      .object({ repository: z.literal('example/widget'), counts: z.object({ active: z.number() }) })
      .parse(JSON.parse(text));
    assert.equal(report.counts.active, 1);
    assert.deepEqual(f.writes, []);
    const invalid = await client.callTool({
      name: 'delivery_health',
      arguments: { from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z' },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
