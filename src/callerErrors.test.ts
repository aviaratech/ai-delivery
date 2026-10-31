import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, test, vi } from 'vitest';
import { z } from 'zod';
import { IssueValidationError } from './issueContract.js';
import { executeTool } from './dispatch.js';
import * as issues from './issue.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import type { AiDeliveryMcpToolName } from './mcp/tools.js';

const cases: [AiDeliveryMcpToolName, Record<string, unknown>, string, string, string[]][] = [
  ['issue_start', { title: '' }, 'Issue title is empty; enter a title.', 'too_small', ['title']],
  [
    'issue_start',
    { title: 'x'.repeat(257) },
    'Issue title exceeds 256 characters; shorten the title.',
    'too_big',
    ['title'],
  ],
  [
    'issue_update',
    { issueNumber: 17, closeReason: 'completed' },
    'Closure details require a closed issue; set state to closed.',
    'closure.state',
    ['state'],
  ],
  [
    'issue_pr_create',
    { issueNumber: 17, head: 'one', headBranch: 'two' },
    'PR head selectors disagree; use the same branch for head and headBranch.',
    'custom',
    [],
  ],
  [
    'issue_pr_create',
    { issueNumber: 17, title: '' },
    'PR title is empty; enter a title or omit it to use the issue title.',
    'too_small',
    ['title'],
  ],
  [
    'issue_pr_create',
    { issueNumber: 17, body: '' },
    'PR body is empty; enter a body or omit it to use the default body.',
    'too_small',
    ['body'],
  ],
  [
    'issue_pr_review',
    { issueNumber: 17, prNumber: 23, artifact: '' },
    'Review artifact is empty; provide the independent review artifact JSON.',
    'too_small',
    ['artifact'],
  ],
  [
    'issue_pr_merge',
    { issueNumber: 17, prNumber: 23, reviewedHeadSha: 'bad' },
    'Reviewed head is invalid; provide the exact 40-character lowercase commit SHA.',
    'invalid_format',
    ['reviewedHeadSha'],
  ],
  [
    'issue_pr_merge',
    { prNumber: 23 },
    'Direct merge is missing its issue number; provide issueNumber.',
    'custom',
    ['issueNumber'],
  ],
];
afterEach(() => vi.restoreAllMocks());

for (const [tool, input, message, code, path] of cases) {
  test(`${tool}: ${message}`, async () => {
    const load = vi.spyOn(issues, 'loadDeliveryContext');
    await assert.rejects(executeTool(tool, input, { repoRoot: '/unrelated', repo: 'example/widget' }), (error) => {
      if (error instanceof IssueValidationError) {
        assert.deepEqual(
          error.failures.map(({ message, code, field }) => ({ message, code, path: [field] })),
          [{ message, code, path }],
        );
        return true;
      }
      assert.ok(error instanceof z.ZodError);
      assert.deepEqual(
        error.issues.slice(0, 1).map(({ message, code, path }) => ({ message, code, path })),
        [{ message, code, path }],
      );
      assert.deepEqual(error.issues.slice(1), []);
      return true;
    });
    const server = createAiDeliveryMcpServer({ repoRoot: '/unrelated', repo: 'example/widget' });
    const client = new Client({ name: 'caller-errors', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const reply = await client.callTool({ name: tool, arguments: input });
      assert.equal(reply.isError, true);
      assert.ok(JSON.stringify(reply.content).includes(message));
      assert.equal(load.mock.calls.length, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });
}
