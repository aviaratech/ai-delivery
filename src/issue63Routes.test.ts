import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
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
test('actual CLI declares guard fields on every alias', { tags: ['release'] }, () => {
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
