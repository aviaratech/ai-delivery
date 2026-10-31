import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, test, vi } from 'vitest';
import { fixtureFields, inertTarget } from './fixtures/inertTarget.js';
import { AI_DELIVERY_MCP_TOOLS, type AiDeliveryMcpToolName } from './mcp/tools.js';

type Fixture = ReturnType<typeof inertTarget>;
type Route = {
  name: AiDeliveryMcpToolName;
  input: (f: Fixture) => Record<string, unknown>;
  cli?: (f: Fixture) => string[];
  witness?: string;
  refusal?: RegExp;
  verify?: (value: Record<string, unknown>) => void;
  before?: (f: Fixture) => void | Promise<void>;
};
const digest = `sha256:${'0'.repeat(64)}`;
function inputFile(f: Fixture, name: string, value: unknown): string {
  const path = join(f.base, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
const journal = {
  issueNumber: 17,
  kind: 'decision',
  summary: 'Retain the target code boundary.',
  status: 'In progress',
  decision: 'Only operator settings are executable.',
  rationale: 'Repository content is untrusted.',
  nextStep: 'Review synthetic evidence',
  nextDate: null,
  keyNumbers: [],
  evidence: [],
};
const routes: Route[] = [
  {
    name: 'delivery_board',
    input: () => ({ repos: ['example/widget'], verbose: true }),
    cli: () => ['board', '--repos', 'example/widget', '--json'],
    witness: 'issues.listForRepo',
    verify: (value) => assert.equal(value.schemaVersion, 'ai-delivery.board@1'),
  },
  {
    name: 'board_reconcile',
    input: (f) => ({
      repositories: ['example/widget'],
      checkouts: [{ repository: 'example/widget', issueNumber: 17, path: f.root }],
    }),
    cli: (f) => [
      'board:reconcile',
      '--repositories',
      'example/widget',
      '--checkouts-file',
      inputFile(f, 'checkouts.json', [{ repository: 'example/widget', issueNumber: 17, path: f.root }]),
    ],
    witness: 'issues.listForRepo',
  },
  {
    name: 'delivery_health',
    input: () => ({ from: '2026-01-01T00:00:00Z', to: '2026-01-04T00:00:00Z', maxIssues: 1 }),
    cli: () => ['health', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-04T00:00:00Z', '--max-issues', '1'],
    witness: 'issues.listForRepo',
  },
  {
    name: 'issue_comment',
    input: () => journal,
    witness: 'issues.getComment',
  },
  {
    name: 'issue_create',
    input: () => fixtureFields,
    cli: (f) => ['create', '--title', fixtureFields.title, '--fields-file', inputFile(f, 'fields.json', fixtureFields)],
    witness: 'issues.create',
  },
  {
    name: 'issue_start',
    input: () => ({ issueNumber: 17 }),
    cli: () => ['start', '--issue', '17'],
    witness: 'DeliveryStartBranch',
    before: (f) => {
      f.state.linked = false;
    },
  },
  {
    name: 'issue_list',
    input: () => ({ perPage: 1 }),
    cli: () => ['list', '--per-page', '1'],
    witness: 'issues.listForRepo',
  },
  {
    name: 'issue_search',
    input: () => ({ query: 'widget', perPage: 1 }),
    cli: () => ['search', '--query', 'widget', '--per-page', '1'],
    witness: 'search.issuesAndPullRequests',
  },
  {
    name: 'issue_update',
    input: () => ({ issueNumber: 17, title: 'Reject invalid widget identifiers before any persistence call' }),
    cli: () => ['update', '--issue', '17', '--title', 'Reject invalid widget identifiers before any persistence call'],
    witness: 'issues.update',
  },
  {
    name: 'issue_batch_update',
    input: () => ({
      items: [{ issueNumber: 17, title: 'Reject invalid widget identifiers before any persistence call' }],
      dryRun: true,
    }),
    cli: (f) => [
      'batch:update',
      '--items-file',
      inputFile(f, 'items.json', [
        { issueNumber: 17, title: 'Reject invalid widget identifiers before any persistence call' },
      ]),
      '--dry-run',
    ],
    witness: 'issues.get',
  },
  {
    name: 'issue_info',
    input: () => ({ issueNumber: 17 }),
    cli: () => ['info', '--issue', '17'],
    witness: 'issues.get',
  },
  {
    name: 'issue_ready_check',
    input: () => ({ issueNumber: 17 }),
    cli: () => ['ready:check', '--issue', '17'],
    witness: 'issues.get',
  },
  {
    name: 'issue_pr_create',
    input: () => ({ issueNumber: 17, body: 'Closes #17\n\nReject invalid identifiers.', draft: true }),
    cli: (f) => {
      const path = join(f.base, 'body.md');
      writeFileSync(path, 'Closes #17\n\nReject invalid identifiers.');
      return ['pr:create', '--issue', '17', '--body-file', path];
    },
    witness: 'pulls.create',
    before: (f) => {
      f.state.published = false;
    },
  },
  {
    name: 'issue_pr_info',
    input: () => ({ prNumber: 23 }),
    cli: () => ['pr:info', '--pr', '23'],
    witness: 'pulls.get',
  },
  {
    name: 'issue_pr_review',
    input: (f) => ({ issueNumber: 17, prNumber: 23, artifact: JSON.stringify(f.artifact) }),
    cli: (f) => ['pr:review', '--issue', '17', '--pr', '23', '--artifact', f.artifactPath],
    witness: 'pulls.createReview',
    before: (f) => {
      f.reviews.length = 0;
    },
  },
  {
    name: 'issue_pr_merge',
    input: () => ({ issueNumber: 17, prNumber: 23 }),
    cli: () => ['pr:merge', '--issue', '17', '--pr', '23'],
    witness: 'pulls.merge',
  },
  {
    name: 'issue_finish',
    input: () => ({ issueNumber: 17, prNumber: 23 }),
    cli: () => ['finish', '--issue', '17', '--pr', '23'],
    witness: 'issues.update',
  },
  {
    name: 'issue_worktree_transition_inspect',
    input: () => ({ issueNumber: 17, purpose: 'active-resume' }),
    cli: () => ['worktree:transition:inspect', '--issue', '17', '--purpose', 'active-resume'],
    verify: (value) => assert.deepEqual(value.blockers, ['Expected one canonical legacy issue row.']),
  },
  {
    name: 'issue_worktree_transition_apply',
    input: (f) => ({
      authority: 'worktree:transition',
      planPath: join(f.root, 'ai-delivery.config.mjs'),
      expectedPlanId: digest,
      relinquishmentCommentId: 1,
      acceptanceCommentId: 2,
    }),
    cli: (f) => [
      'worktree:transition:apply',
      '--plan',
      join(f.root, 'ai-delivery.config.mjs'),
      '--plan-id',
      digest,
      '--relinquishment-comment',
      '1',
      '--acceptance-comment',
      '2',
      '--authorize-transition',
    ],
    refusal: /Unexpected token.*import.*JSON/u,
  },
];

// Capture the real registered Commander tree without running process.argv. Each
// case then uses Commander's real parser and actual action/dispatch/owner code.
let cli: Command;
beforeAll(async () => {
  const captured: Command[] = [];
  const argv = process.argv;
  process.argv = ['node', 'ai-delivery', 'plugin'];
  const parse = vi.spyOn(Command.prototype, 'parseAsync').mockImplementationOnce(async function (this: Command) {
    captured.push(this);
    return this;
  });
  try {
    await import('./cli.js');
  } finally {
    process.argv = argv;
    parse.mockRestore();
  }
  cli = captured[0]!;
  cli.exitOverride();
});

function cliLeaves(command: Command, prefix = ''): string[] {
  return command.commands.flatMap((child) => {
    const name = `${prefix}${child.name()}`;
    return child.commands.length ? cliLeaves(child, `${name} `) : [name];
  });
}

async function runCli(f: Fixture, args: string[]) {
  const exitCode = process.exitCode;
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    await cli.parseAsync(['--repo', 'example/widget', '--repo-root', f.root, ...args], { from: 'user' });
    return JSON.parse(output) as Record<string, unknown>;
  } finally {
    stdout.mockRestore();
    process.exitCode = exitCode;
    f.assertInert();
  }
}

test('every public MCP and CLI route has an execution-boundary case', () => {
  assert.deepEqual(routes.map((r) => r.name).sort(), AI_DELIVERY_MCP_TOOLS.map((r) => r.name).sort());
  assert.deepEqual(
    cliLeaves(cli).sort(),
    [
      ...routes
        .filter((r) => r.cli)
        .map((r) => AI_DELIVERY_MCP_TOOLS.find((tool) => tool.name === r.name)!.commandName),
      ...new Set(cliOnly.map((r) => r.command)),
      'mcp:serve',
    ].sort(),
  );
});

for (const route of routes) {
  for (const surface of ['MCP', 'CLI'] as const) {
    if (surface === 'CLI' && route.cli === undefined) continue;
    test(`${surface} ${route.name} never executes target repository files`, async ({ signal }) => {
      const f = inertTarget(signal);
      let connection: Awaited<ReturnType<Fixture['connect']>> | undefined;
      try {
        f.policy('tracked');
        await route.before?.(f);
        // A schema/authentication failure must never masquerade as owner coverage.
        AI_DELIVERY_MCP_TOOLS.find((tool) => tool.name === route.name)!.inputSchema.parse({
          ...(route.name === 'delivery_board' ? {} : { repo: 'example/widget' }),
          ...route.input(f),
        });
        if (surface === 'MCP') {
          connection = await f.connect();
          const result = await connection.call(route.name, route.input(f));
          if (route.refusal) {
            assert.equal(result.response.isError, true);
            assert.match(result.text, route.refusal);
          } else {
            assert.notEqual(result.response.isError, true, result.text);
            route.verify?.(result.value!);
          }
        } else if (route.refusal) {
          await assert.rejects(runCli(f, route.cli!(f)), route.refusal);
        } else {
          const value = await runCli(f, route.cli!(f));
          assert.ok(value);
          route.verify?.(value);
        }
        if (route.witness)
          assert.ok(
            f.calls.some((call) => call.name === route.witness),
            `Missing owner witness: ${route.witness}`,
          );
      } finally {
        await f.dispose(connection);
      }
    });
  }
}

function configureReviewer(f: Fixture) {
  const path = process.env.AI_DELIVERY_CONFIG!;
  const settings = JSON.parse(readFileSync(path, 'utf8')) as { roles: { reviewer: unknown } };
  settings.roles.reviewer = {
    identity: 'reviewer',
    authSource: 'app',
    appId: 1,
    installationId: 2,
    actorLogin: 'reviewer[bot]',
    provider: 'openai',
  };
  writeFileSync(path, JSON.stringify(settings));
  f.reviews.length = 0;
}

const cliOnly: {
  command: string;
  variant?: string;
  args: (f: Fixture) => string[];
  witness?: string;
  before?: (f: Fixture) => void;
}[] = [
  { command: 'parent', args: () => ['parent', '--issue', '17'], witness: 'issues.get' },
  { command: 'blockers', args: () => ['blockers', '--issue', '17'], witness: 'issues.get' },
  { command: 'subissues', args: () => ['subissues', '--issue', '17'], witness: 'issues.listSubIssues' },
  { command: 'pr:list', args: () => ['pr:list'], witness: 'pulls.list' },
  { command: 'pr:checks', args: () => ['pr:checks', '--pr', '23'], witness: 'checks.listForRef' },
  { command: 'config:resolve', args: () => ['config:resolve'], witness: 'appActorLogin' },
  {
    command: 'migrate:legacy-issues',
    args: (f) => [
      'migrate:legacy-issues',
      '--input-file',
      inputFile(f, 'migration.json', {
        issues: [
          {
            number: 17,
            body: 'node consumer-trap.cjs',
            labels: [],
            existingNative: { points: 2, issueType: 'Task', blockedBy: [] },
          },
        ],
      }),
    ],
  },
  {
    command: 'review',
    variant: 'doctor',
    args: () => ['review', 'doctor', '--identity', 'reviewer'],
    before: configureReviewer,
    witness: 'appActorLogin',
  },
  {
    command: 'review',
    variant: 'submit',
    before: configureReviewer,
    witness: 'pulls.createReview',
    args: (f) => [
      'review',
      'submit',
      '--identity',
      'reviewer',
      '--pr',
      '23',
      '--head',
      f.head,
      '--verdict',
      inputFile(f, 'verdict.json', {
        schemaVersion: 'ai-delivery.review-verdict@1',
        verdict: 'approve',
        summary: 'Synthetic independent review.',
        issueNumber: 17,
        scope: { headSha: f.head, headTree: f.tree, changedPaths: ['change.ts'] },
        verificationReproduced: ['Synthetic route boundary'],
        requestedModel: 'gpt-6-astra',
        requestedEffort: 'xhigh',
        effectiveModel: 'gpt-6-astra',
        effectiveEffort: 'xhigh',
        elapsedMs: 1,
        findings: [],
        readOnly: true,
      }),
    ],
  },
  ...(['install', 'doctor', 'preview', 'update', 'rollback', 'remove'] as const).map((action) => ({
    command: `plugin ${action}`,
    args: () => [
      'plugin',
      action,
      '--host',
      'codex',
      '--dry-run',
      '--json',
      ...(['install', 'update'].includes(action) ? ['--version', '0.3.35'] : []),
    ],
  })),
];
for (const route of cliOnly) {
  test(`CLI ${route.command}${route.variant ? ` ${route.variant}` : ''} never executes target repository files`, async () => {
    const f = inertTarget();
    const home = process.env.HOME;
    process.env.HOME = f.base;
    try {
      f.policy('tracked');
      route.before?.(f);
      assert.ok(await runCli(f, route.args(f)));
      if (route.witness)
        assert.ok(
          f.calls.some((call) => call.name === route.witness),
          `Missing owner witness: ${route.witness}`,
        );
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      await f.dispose(undefined);
    }
  });
}

test(
  'CLI mcp:serve initializes and serves a real stdio request without target code execution',
  { tags: ['release'] },
  async () => {
    const f = inertTarget();
    const request = inputFile(f, 'stdio-request.json', {
      mode: 'cli',
      root: f.root,
      head: f.head,
      report: join(f.base, 'stdio-report.json'),
      args: [],
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--max-old-space-size=96',
        '--experimental-test-module-mocks',
        '--import',
        fileURLToPath(new URL('./fixtures/inertEntrypointChild.js', import.meta.url)),
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        '--repo-root',
        f.root,
        'mcp:serve',
      ],
      env: {
        PATH: process.env.PATH!,
        HOME: f.base,
        AI_DELIVERY_CONFIG: process.env.AI_DELIVERY_CONFIG!,
        AI_DELIVERY_ENTRYPOINT_REQUEST: request,
      },
      stderr: 'pipe',
    });
    let childClosed = false;
    let childStderr = '';
    transport.stderr?.on('data', (bytes: Buffer) => {
      childStderr = (childStderr + bytes.toString('utf8')).slice(-64 * 1024);
    });
    transport.onclose = () => {
      childClosed = true;
    };
    const client = new Client({ name: 'hostile-stdio-fixture', version: '1' });
    try {
      f.policy('tracked');
      await client.connect(transport);
      const result = await client.callTool({
        name: 'issue_info',
        arguments: { repo: 'example/widget', issueNumber: 17 },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const value = JSON.parse((result.content as { text: string }[])[0]!.text) as { issueNumber: number };
      assert.equal(value.issueNumber, 17);
      f.assertInert();
    } catch (cause) {
      throw new Error(`Real stdio MCP failed. Child stderr: ${childStderr}`, { cause });
    } finally {
      await client.close();
      await transport.close();
      assert.equal(childClosed, true, 'The stdio child must exit before removing its fixture');
      await f.dispose(undefined);
    }
  },
);

test('hostile repository arms policy, executable configs, package scripts and Git hooks', async () => {
  const f = inertTarget();
  try {
    for (const file of ['ai-delivery.policy.mjs', 'ai-delivery.config.mjs', 'ai-delivery.config.js', 'package.json'])
      assert.equal(existsSync(join(f.root, file)), true, `Missing target execution trap: ${file}`);
    const manifest = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of ['prepare', 'postinstall', 'test'])
      assert.equal(manifest.scripts[script], 'node consumer-trap.cjs');
    for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'pre-push'])
      assert.equal(existsSync(join(f.root, '.git', 'hooks', hook)), true, `Missing Git hook: ${hook}`);
    for (const file of [
      'ai-delivery.policy.mjs',
      'ai-delivery.config.mjs',
      'ai-delivery.config.js',
      'consumer-trap.cjs',
    ]) {
      execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(join(f.root, file)).href)})`,
      ]);
      assert.equal(existsSync(f.sentinel), true, `Importing the actual fixture ${file} must execute the sentinel`);
      unlinkSync(f.sentinel);
    }
    for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'pre-push']) {
      execFileSync('/bin/sh', [join(f.root, '.git', 'hooks', hook)]);
      assert.equal(existsSync(f.sentinel), true, `Executing the actual fixture ${hook} must execute the sentinel`);
      unlinkSync(f.sentinel);
    }
  } finally {
    await f.dispose(undefined);
  }
});
