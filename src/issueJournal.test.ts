import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import { getAiDeliveryMcpTool } from './mcp/tools.js';
import * as issue from './issue.js';
import type { DeliveryContext } from './issue.js';
import type { JournalInput } from './issueJournal.js';
import { JournalInputSchema, renderJournal, acceptanceCriteria, issueFollowUps } from './issueJournal.js';
import { executeTool } from './dispatch.js';
import * as configuration from './config/deliveryConfig.js';
import * as githubClients from './github/client.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('journal tool validates all five typed templates before dispatch', () => {
  const tool = getAiDeliveryMcpTool('issue_comment');
  assert.ok(tool, 'issue_comment must be exposed');
  const common = {
    issueNumber: 17,
    summary: 'Parser work is underway.',
    status: 'In progress',
    nextStep: 'Run checks',
    nextDate: '2026-10-09',
    keyNumbers: ['3 checks'],
    evidence: ['https://github.com/example/widget/pull/23'],
  };
  const valid: JournalInput[] = [
    { ...common, kind: 'start', outcome: 'Deliver a safe parser' },
    { ...common, kind: 'progress', done: ['Added validation'], decisionNeeded: 'None' },
    { ...common, kind: 'decision', decision: 'Use the existing parser', rationale: 'Preserves the contract' },
    { ...common, kind: 'blocker', blocker: 'Review pending', resolution: 'Independent acceptance' },
    {
      ...common,
      kind: 'closeout',
      acceptance: [{ criterion: 'Reject malformed input', evidence: 'https://github.com/example/widget/pull/23' }],
      followUps: [],
    },
  ];
  for (const input of valid) {
    for (const repo of [undefined, 'example/widget']) {
      for (const nextDate of [null, '2026-10-09', '2028-02-29']) {
        const selected = { ...input, nextDate, ...(repo === undefined ? {} : { repo }) };
        const parsed: ReturnType<typeof tool.inputSchema.safeParse> = tool.inputSchema.safeParse(selected);
        assert.equal(parsed.success, true, JSON.stringify(selected));
        if (parsed.success) assert.deepEqual(parsed.data, selected);
      }
    }
    assert.equal(JournalInputSchema.safeParse(input).success, true);
    assert.equal(JournalInputSchema.safeParse({ ...input, repo: 'example/widget' }).success, false);
  }
  for (const input of [
    { ...common, kind: 'progress' },
    { ...common, kind: 'start', outcome: '' },
    { ...common, kind: 'closeout', acceptance: [], followUps: [] },
    {
      ...common,
      kind: 'decision',
      decision: 'Use parser',
      rationale: 'Works',
      evidence: ['/Users/operator/checks.log'],
    },
    { ...common, kind: 'start', outcome: 'Deliver', nextDate: 'tomorrow' },
    { ...common, kind: 'start', outcome: 'Deliver', done: ['Wrong variant'] },
    { ...common, kind: 'progress', done: ['Deliver'], decisionNeeded: 'None', rationale: 'Wrong variant' },
    { ...common, kind: 'decision', decision: 'Use parser', rationale: 'Works', blocker: 'Wrong variant' },
    { ...common, kind: 'blocker', blocker: 'Review', resolution: 'Accept', outcome: 'Wrong variant' },
    { ...valid[4], done: ['Wrong variant'] },
    { ...valid[0], unknown: true },
    { ...valid[0], kind: 'unsupported' },
    { ...valid[0], nextDate: '2026-02-30' },
    { ...valid[0], nextDate: 20261009 },
    { ...valid[0], keyNumbers: '3 checks' },
    { ...valid[0], issueNumber: '17' },
    { ...valid[4], acceptance: [{ criterion: 'Deliver', evidence: common.evidence[0], unknown: true }] },
  ])
    for (const repo of [undefined, 'example/widget'])
      assert.equal(tool.inputSchema.safeParse({ ...input, ...(repo === undefined ? {} : { repo }) }).success, false);
  for (const repo of [
    '',
    'example',
    'example/widget/extra',
    'https://github.com/example/widget',
    'example/\nwidget',
    17,
    null,
    [],
  ])
    assert.equal(tool.inputSchema.safeParse({ ...valid[0], repo }).success, false);
});

test('journal dispatch refuses invalid fields and repository conflicts before configuration or authentication', async () => {
  const settings = vi.spyOn(configuration, 'loadDeliverySettings').mockImplementation(async () => {
    throw new Error('Configuration must not load for an invalid journal');
  });
  const clients = vi.spyOn(githubClients, 'createDeliveryGitHubClients');
  const valid = {
    repo: 'example/widget',
    issueNumber: 17,
    kind: 'progress',
    summary: 'Parser work is underway.',
    status: 'In progress',
    done: ['Added validation'],
    decisionNeeded: 'None',
    keyNumbers: [],
    evidence: ['https://github.com/example/widget/pull/23'],
    nextStep: 'Run checks',
    nextDate: null,
  };
  try {
    for (const input of [
      { ...valid, kind: 'unsupported' },
      { ...valid, outcome: 'Wrong variant' },
      { ...valid, unknown: true },
      { ...valid, done: [] },
      { ...valid, evidence: [] },
      { ...valid, repo: 'invalid' },
      { ...valid, repo: 17 },
      { ...valid, nextDate: '2026-02-30' },
    ])
      await assert.rejects(executeTool('issue_comment', input, { repoRoot: '/non-git-fixture' }));
    await assert.rejects(
      executeTool('issue_comment', valid, { repoRoot: '/non-git-fixture', repo: 'example/other' }),
      /selectors disagree/u,
    );
    assert.equal(settings.mock.calls.length, 0);
    assert.equal(clients.mock.calls.length, 0, 'no authenticated client or comment writer is reached');
  } finally {
    settings.mockRestore();
    clients.mockRestore();
  }
});

test('canonical comment writes read back and recover a lost response without duplicates', async () => {
  const comment = (
    issue as unknown as {
      commentIssue?: (
        context: DeliveryContext,
        input: JournalInput | { issueNumber: number; body: string },
        lifecycleKey?: string,
      ) => Promise<{ commentId: number; url: string; body: string; reused: boolean }>;
    }
  ).commentIssue;
  assert.ok(comment, 'canonical comment writer must exist');
  const agent = await import('./agent.js');
  assert.equal(agent.commentIssue, comment);
  assert.equal(agent.ISSUE_COMMENT_BODY_LIMIT, 65536);
  const root = mkdtempSync(join(tmpdir(), 'ai-delivery-journal-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const stored: { id: number; body: string; html_url: string; user: { login: string }; issue_url: string }[] = [];
  let loseResponse = true;
  let corruptReadback = false;
  let authorCalls = 0;
  const context = {
    root,
    repo: { owner: 'example', repo: 'widget' },
    clients: {
      role: 'author',
      authenticatedAuthor: async () => {
        authorCalls += 1;
        return { actorLogin: 'operator', credentialIdentity: 'user:1' };
      },
      rest: {
        issues: {
          get: async () => ({ data: { number: 17, state: 'open' } }),
          listComments: async () => ({ data: stored }),
          createComment: async (input: { body: string }) => {
            const id = 91 + stored.length;
            const data = {
              id,
              body: input.body,
              html_url: `https://github.com/example/widget/issues/17#issuecomment-${String(id)}`,
              issue_url: 'https://api.github.com/repos/example/widget/issues/17',
              user: { login: 'operator' },
            };
            stored.push(data);
            if (loseResponse) {
              loseResponse = false;
              throw new Error('response lost');
            }
            return { data };
          },
          getComment: async (input: { comment_id: number }) => ({
            data: {
              ...stored.find((item) => item.id === input.comment_id),
              ...(corruptReadback ? { body: 'changed' } : {}),
            },
          }),
        },
      },
    },
  } as unknown as DeliveryContext;
  const input: JournalInput = {
    issueNumber: 17,
    kind: 'start',
    summary: 'Implementation started.',
    status: 'In progress',
    outcome: 'Deliver validation',
    keyNumbers: [],
    evidence: [],
    nextStep: 'Run checks',
    nextDate: '2026-10-09',
  };
  try {
    await assert.rejects(comment(context, input), /response lost/u);
    const recovered = await comment(context, input);
    assert.equal(recovered.commentId, 91);
    assert.equal(recovered.reused, true);
    assert.equal(stored.length, 1);
    assert.match(recovered.body, /^Implementation started\./u);
    corruptReadback = true;
    await assert.rejects(comment(context, input), /readback/u);
    corruptReadback = false;

    stored.push({ ...stored[0]!, id: 99, html_url: 'https://github.com/example/widget/issues/17#issuecomment-99' });
    await assert.rejects(comment(context, input), /duplicate authored retry matches/u);
    assert.equal(stored.length, 2, 'ambiguous retries must not write another comment');
    stored.pop();

    const rawBody = `\r\n  <details>\n<summary>Prior content</summary>\n<pre>${'🙂 &amp; prior title/body\r\n'.repeat(600)}</pre>\n</details>  \t\n`;
    assert.ok(rawBody.length > 10000);
    loseResponse = true;
    await assert.rejects(comment(context, { issueNumber: 17, body: rawBody }), /response lost/u);
    const rawRecovered = await comment(context, { issueNumber: 17, body: rawBody });
    assert.equal(rawRecovered.body, rawBody, 'raw history content must remain exact and unwrapped');
    assert.equal(rawRecovered.commentId, 92);
    assert.equal(rawRecovered.reused, true);
    assert.equal(stored.length, 2);
    assert.equal(stored[1]!.body, rawBody, 'no journal marker or unrequested content is appended');

    const maximumBody = '🙂'.repeat(32768);
    assert.equal(maximumBody.length, 65536);
    assert.equal((await comment(context, { issueNumber: 17, body: maximumBody })).body, maximumBody);
    assert.equal(stored.length, 3);
    const beforeInvalid = authorCalls;
    for (const body of ['', ' \r\n\t ', 'x'.repeat(65537), `${maximumBody}🙂`])
      await assert.rejects(comment(context, { issueNumber: 17, body }), /comment body/u);
    await assert.rejects(
      comment(context, {
        ...input,
        status: 'x'.repeat(9000),
        outcome: 'x'.repeat(9000),
        nextStep: 'x'.repeat(9000),
        details: 'x'.repeat(9000),
        keyNumbers: Array.from({ length: 4 }, () => 'x'.repeat(9000)),
      }),
      /comment body/u,
    );
    await assert.rejects(
      comment(context, { issueNumber: 17, body: rawBody }, 'start:legacy'),
      /lifecycle journal key/u,
    );
    assert.equal(authorCalls, beforeInvalid, 'unsupported payloads fail before authentication or mutation');
    assert.equal(stored.length, 3);
    corruptReadback = true;
    await assert.rejects(comment(context, { issueNumber: 17, body: rawBody }), /readback/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('length cap keeps the summary visible and moves every excess field into collapsed detail', () => {
  const rendered = renderJournal({
    issueNumber: 17,
    kind: 'progress',
    summary: 'Validation is implemented.',
    status: 'In progress',
    done: ['A'.repeat(900)],
    decisionNeeded: 'None',
    keyNumbers: ['7 tests'],
    evidence: ['https://github.com/example/widget/pull/23'],
    nextStep: 'Review',
    nextDate: '2026-10-09',
    lengthCap: 600,
  });
  assert.equal(rendered.split('\n')[0], 'Validation is implemented.');
  assert.match(rendered, /<details>/u);
  assert.match(rendered, /A{900}/u);
  assert.match(rendered, /7 tests/u);
  assert.match(rendered, /https:\/\/github.com\/example\/widget\/pull\/23/u);
});

test('automatic closeout selects acceptance checkboxes and declared follow-ups without swallowing other sections', () => {
  const body =
    '## Outcome\nShip.\n\n## Acceptance Criteria\n- [ ] Validation works\n- [x] Recovery works\n\n## Follow-ups\n- Track post-release adoption: https://github.com/example/widget/issues/24\n\n## Non-goals\n- [ ] Not an acceptance criterion';
  assert.deepEqual(acceptanceCriteria(body), ['Validation works', 'Recovery works']);
  assert.deepEqual(issueFollowUps(body), ['Track post-release adoption: https://github.com/example/widget/issues/24']);
});

test('closeout accepts every readiness heading level and stops at the next heading', () => {
  for (let level = 1; level <= 6; level += 1) {
    for (let indent = 0; indent <= 3; indent += 1) {
      const heading = `${' '.repeat(indent)}${'#'.repeat(level)}`;
      const body = `${heading}\tAcceptance Criteria\n-[ ] Compact bullet\n*\t[X]\tTabbed bullet\n+ [x] Checked bullet\n###### Other section\n- [ ] Excluded\n${heading} Follow-ups\n- [ ] Deferred work\n# Other section\n- Excluded`;
      assert.deepEqual(acceptanceCriteria(body), ['Compact bullet', 'Tabbed bullet', 'Checked bullet']);
      assert.deepEqual(issueFollowUps(body), ['Deferred work']);
    }
  }
});

test('journal evidence rejects local hosts and IP literals while accepting public DNS names', () => {
  const tool = getAiDeliveryMcpTool('issue_comment')!;
  const input = {
    issueNumber: 17,
    kind: 'start',
    summary: 'Work started.',
    status: 'Started',
    outcome: 'Deliver validation',
    keyNumbers: [],
    nextStep: 'Run checks',
    nextDate: null,
  };
  for (const host of [
    'localhost',
    'localhost.',
    'api.localhost',
    'runner.local',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '[::1]',
    '[fd00::1]',
    '[fe80::1]',
    '8.8.8.8',
  ])
    assert.equal(tool.inputSchema.safeParse({ ...input, evidence: [`https://${host}/evidence`] }).success, false, host);
  for (const host of ['github.com', '10.docs.example.com'])
    assert.equal(tool.inputSchema.safeParse({ ...input, evidence: [`https://${host}/evidence`] }).success, true, host);
});
