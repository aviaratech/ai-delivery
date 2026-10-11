import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as settings from './config/deliveryConfig.js';
import * as issues from './issue.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import { digestBytes, digestValue, stableJson } from './delivery/common.js';
import { gitCommonDir } from './git.js';
import type { DeliveryContext } from './issue.js';
import { getAiDeliveryMcpTool } from './mcp/tools.js';
import {
  finishInvestigation,
  investigationAcceptanceBody,
  investigationAuthorityBody,
  registerInvestigation,
} from './pr.js';
import {
  assertIssueWorktreeTransitionAdmission,
  readInvestigationPreparation,
  type InvestigationPreparation,
} from './services/worktreeRegistry.js';

const native = vi.hoisted(() => ({
  comments: new Map<number, Record<string, unknown>>(),
  reviewer: 'reviewer[bot]',
  fault: '' as '' | 'intent' | 'registry' | 'seal',
}));
vi.mock('./github/client.js', async (original) => ({
  ...(await original<typeof import('./github/client.js')>()),
  createDeliveryGitHubClients: async () => ({
    authSource: 'app',
    role: 'reviewer',
    appActorLogin: async () => native.reviewer,
    rest: {
      issues: {
        getComment: async ({ comment_id }: { comment_id: number }) => ({ data: native.comments.get(comment_id) }),
      },
    },
  }),
}));
vi.mock('./utils/atomicJson.js', async (original) => {
  const actual = await original<typeof import('./utils/atomicJson.js')>();
  return {
    ...actual,
    writeJsonFileAtomically(path: string, value: unknown) {
      if (
        native.fault === 'registry' &&
        basename(path) === 'worktrees.json' &&
        (value as { worktrees: unknown[] }).worktrees.length === 1
      ) {
        native.fault = '';
        throw new Error('Fixture interruption after Git removal, before registry commit.');
      }
      return actual.writeJsonFileAtomically(path, value);
    },
  };
});
vi.mock('./delivery/common.js', async (original) => {
  const actual = await original<typeof import('./delivery/common.js')>();
  return {
    ...actual,
    writeCreateOnly(path: string, bytes: Buffer, digest?: string) {
      if (native.fault === 'seal' && basename(path) === 'completion.json') {
        native.fault = '';
        throw new Error('Fixture interruption before completion seal.');
      }
      const result = actual.writeCreateOnly(path, bytes, digest);
      if (native.fault === 'intent' && basename(path) === 'intent.json') {
        native.fault = '';
        throw new Error('Fixture interruption after durable intent.');
      }
      return result;
    },
  };
});

function git(root: string, ...args: string[]): string {
  return execFileSync(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-C', root, ...args],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Fictional Operator',
        GIT_AUTHOR_EMAIL: 'operator@example.invalid',
        GIT_COMMITTER_NAME: 'Fictional Operator',
        GIT_COMMITTER_EMAIL: 'operator@example.invalid',
      },
    },
  ).trim();
}
async function fixture(
  run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  trackedChildResult = false,
) {
  const f = createFixture(trackedChildResult);
  try {
    await run(f);
  } finally {
    native.fault = '';
    assert.equal(realpathSync(f.directory), f.directory);
    assert.equal(lstatSync(f.directory).isSymbolicLink(), false);
    assert.equal(readFileSync(join(f.directory, 'FICTIONAL_FIXTURE'), 'utf8'), f.directory);
    assert.equal(gitCommonDir(f.root), join(f.root, '.git'));
    const paths = git(f.root, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    assert(paths.every((line) => line.slice(9).startsWith(`${f.directory}/`)));
    rmSync(f.directory, { recursive: true });
    assert.equal(existsSync(f.directory), false);
  }
}
function createFixture(trackedChildResult = false) {
  native.comments.clear();
  native.reviewer = 'reviewer[bot]';
  native.fault = '';
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-investigation-fictional-')));
  writeFileSync(join(directory, 'FICTIONAL_FIXTURE'), directory);
  const root = join(directory, 'repository');
  mkdirSync(root);
  git(root, 'init', '--initial-branch=main');
  writeFileSync(join(root, '.gitignore'), '.worktrees/\n.issue-cli/\nignored/\n');
  writeFileSync(join(root, 'source.txt'), 'unchanged fictional source\n');
  if (trackedChildResult) {
    mkdirSync(join(root, '..notes'));
    writeFileSync(
      join(root, '..notes', 'result.txt'),
      'Fictional independently reviewed investigation: no change needed; all producers stopped.\n',
      { mode: 0o600 },
    );
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Fictional initial source');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/widget.git');
  const head = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const target = join(root, '.worktrees', 'issue-17');
  git(root, 'worktree', 'add', '-b', 'issue/17', target, head);
  const unrelated = {
    branch: 'issue/23',
    identity: 'other',
    issueNumber: 23,
    path: join(directory, 'retained-other'),
    status: 'active',
    type: 'issue',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  mkdirSync(join(root, '.issue-cli'));
  writeFileSync(join(root, '.issue-cli', 'worktrees.json'), JSON.stringify({ worktrees: [unrelated] }));
  const state = {
    issue: 'open',
    reason: 'COMPLETED',
    branches: [{ name: 'issue/17', sha: head }],
    prs: [] as unknown[],
    acknowledgementId: 101,
  };
  const user = { id: 42, login: 'operator', type: 'User' };
  const comment = (id: number, body: string, app = false) => ({
    id,
    body,
    issue_url: 'https://api.github.com/repos/example/widget/issues/17',
    html_url: `https://github.com/example/widget/issues/17#issuecomment-${id}`,
    created_at: '2026-01-01T00:00:00Z',
    user: app ? { id: 99, login: 'reviewer[bot]', type: 'Bot' } : user,
  });
  const context = {
    root,
    repo: { owner: 'example', repo: 'widget' },
    config: {
      repository: 'example/widget',
      roles: { author: { identity: 'operator' }, reviewer: { identity: 'independent' } },
    },
    clients: {
      role: 'author',
      authSource: 'personal',
      authenticatedAuthor: async () => ({ actorLogin: user.login, credentialIdentity: `user:${user.id}` }),
      rest: {
        issues: {
          get: async () => ({
            data: { number: 17, state: state.issue, html_url: 'https://github.com/example/widget/issues/17' },
          }),
          listComments: async () => ({ data: [...native.comments.values()] }),
          createComment: async ({ body }: { body: string }) => {
            const c = comment(state.acknowledgementId, body);
            native.comments.set(c.id, c);
            return { data: c };
          },
          getComment: async ({ comment_id }: { comment_id: number }) => ({ data: native.comments.get(comment_id) }),
        },
        pulls: { list: async () => ({ data: state.prs }) },
        repos: { get: async () => ({ data: { full_name: 'example/widget', default_branch: 'main' } }) },
        git: { getRef: async () => ({ data: { ref: 'refs/heads/main', object: { sha: head } } }) },
      },
      graphql: async (query: string) => {
        if (query.includes('IssueClosureReadback'))
          return {
            repository: {
              issue: {
                number: 17,
                repository: { nameWithOwner: 'example/widget' },
                state: state.issue.toUpperCase(),
                stateReason: state.reason,
                duplicateOf: null,
              },
            },
          };
        return {
          repository: {
            issue: {
              linkedBranches: {
                nodes: state.branches.map((b) => ({
                  ref: { name: b.name, target: { oid: b.sha }, repository: { nameWithOwner: 'example/widget' } },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      },
    },
  } as unknown as DeliveryContext;
  const resultPath = trackedChildResult ? join(target, '..notes', 'result.txt') : join(directory, 'durable-result.txt');
  writeFileSync(
    resultPath,
    'Fictional independently reviewed investigation: no change needed; all producers stopped.\n',
    { mode: 0o600 },
  );
  if (trackedChildResult) chmodSync(resultPath, 0o600);
  const registry = () =>
    JSON.parse(readFileSync(join(root, '.issue-cli', 'worktrees.json'), 'utf8')) as { worktrees: unknown[] };
  const prepare = async () =>
    (await registerInvestigation(context, { issueNumber: 17, investigationWorktree: target, expectedHeadSha: head }))
      .preparation;
  const accept = (preparation: InvestigationPreparation) => {
    state.issue = 'closed';
    const digest = digestBytes(readFileSync(resultPath));
    native.comments.set(201, comment(201, investigationAuthorityBody(preparation, digest)));
    native.comments.set(202, comment(202, investigationAcceptanceBody(preparation, digest, 201), true));
  };
  const finish = (extra = {}) =>
    finishInvestigation(context, {
      issueNumber: 17,
      resultPath,
      authorityCommentId: 201,
      acceptanceCommentId: 202,
      ...extra,
    });
  const evidence = join(root, '.git', 'ai-delivery', 'investigations', '17');
  return {
    directory,
    root,
    target,
    head,
    tree,
    context,
    state,
    unrelated,
    prepare,
    accept,
    finish,
    resultPath,
    registry,
    evidence,
  };
}

test('prospective registration is exact, acknowledged, idempotent and does not manufacture merged custody', async () =>
  fixture(async (f) => {
    const preparation = await f.prepare();
    assert.equal(preparation.head.sha, f.head);
    assert.equal(preparation.head.tree, f.tree);
    assert.equal((await f.prepare()).preparationId, preparation.preparationId);
    assert.deepEqual(f.registry().worktrees, [f.unrelated, preparation.row]);
    assert.equal(native.comments.size, 1);
    assert.deepEqual(readInvestigationPreparation(f.root, 17), preparation);
    assert.equal(git(f.target, 'status', '--porcelain', '--untracked-files=all'), '');
  }));

test('completion consumes closed native authority and App acceptance, preserving branch, result and unrelated custody', async () =>
  fixture(async (f) => {
    const preparation = await f.prepare();
    f.accept(preparation);
    const dry = await f.finish({ dryRun: true });
    assert.equal(dry.completed, false);
    assert(existsSync(f.target));
    assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
    const completed = await f.finish();
    assert.equal(completed.completed, true);
    assert.equal(existsSync(f.target), false);
    assert.equal(existsSync(preparation.physical.gitDirectory), false);
    assert(!git(f.root, 'worktree', 'list', '--porcelain').includes(f.target));
    assert.equal(git(f.root, 'rev-parse', 'refs/heads/issue/17'), f.head);
    assert.deepEqual(f.registry().worktrees, [f.unrelated]);
    assert(existsSync(f.resultPath));
    const resultDigest = digestBytes(readFileSync(f.resultPath));
    assert.equal(
      readFileSync(join(f.evidence, `${resultDigest.slice(7)}.bin`), 'utf8'),
      readFileSync(f.resultPath, 'utf8'),
    );
    const replay = await f.finish();
    assert('replayed' in replay && replay.replayed);
    assert.throws(() => assertIssueWorktreeTransitionAdmission(17, f.root), /pending or terminal/u);
  }));

for (const failure of ['intent', 'registry', 'seal'] as const)
  test(`interrupted ${failure} resumes the same durable intent and seals exact disk/Git/registry state`, async () =>
    fixture(async (f) => {
      const preparation = await f.prepare();
      f.accept(preparation);
      native.fault = failure;
      await assert.rejects(f.finish(), /Fixture interruption/u);
      const intentBytes = readFileSync(join(f.evidence, 'intent.json'));
      assert.equal(existsSync(f.target), failure === 'intent');
      assert.equal(f.registry().worktrees.length, failure === 'seal' ? 1 : 2);
      const completed = await f.finish();
      assert.equal(completed.completed, true);
      assert('replayed' in completed && completed.replayed);
      assert(readFileSync(join(f.evidence, 'intent.json')).equals(intentBytes));
      assert.equal(existsSync(f.target), false);
      assert.equal(existsSync(preparation.physical.gitDirectory), false);
      assert.deepEqual(f.registry().worktrees, [f.unrelated]);
      assert.equal((await f.finish()).completed, true);
    }));

const unsafeSource = {
  dirty: (f: ReturnType<typeof createFixture>) =>
    writeFileSync(join(f.target, 'source.txt'), 'must preserve dirty data'),
  untracked: (f: ReturnType<typeof createFixture>) =>
    writeFileSync(join(f.target, 'untracked.txt'), 'must preserve untracked data'),
  ignored: (f: ReturnType<typeof createFixture>) => {
    mkdirSync(join(f.target, 'ignored'));
    writeFileSync(join(f.target, 'ignored', 'incident.txt'), 'must preserve ignored data');
  },
  'same-tree new commit': (f: ReturnType<typeof createFixture>) =>
    git(f.target, 'commit', '--allow-empty', '-m', 'Unpushed same-tree commit'),
  'native branch drift': (f: ReturnType<typeof createFixture>) => {
    f.state.branches[0]!.sha = 'a'.repeat(40);
  },
  'ambiguous native branches': (f: ReturnType<typeof createFixture>) => {
    f.state.branches.push({ name: 'issue/other', sha: f.head });
  },
  'locked worktree': (f: ReturnType<typeof createFixture>) => git(f.root, 'worktree', 'lock', f.target),
  'foreign repository': (f: ReturnType<typeof createFixture>) =>
    git(f.root, 'remote', 'set-url', 'origin', 'https://github.com/foreign/widget.git'),
  'PR association': (f: ReturnType<typeof createFixture>) => {
    f.state.prs = [{ number: 88 }];
  },
  'current worktree': (f: ReturnType<typeof createFixture>) => {
    f.context.root = f.target;
  },
  'registry identity drift': (f: ReturnType<typeof createFixture>) => {
    const r = f.registry();
    (r.worktrees[1] as { identity: string }).identity = 'foreign';
    writeFileSync(join(f.root, '.issue-cli', 'worktrees.json'), JSON.stringify(r));
  },
  'registry ambiguity': (f: ReturnType<typeof createFixture>) => {
    const r = f.registry();
    r.worktrees.push(r.worktrees[1]);
    writeFileSync(join(f.root, '.issue-cli', 'worktrees.json'), JSON.stringify(r));
  },
};
for (const [name, mutate] of Object.entries(unsafeSource))
  test(`refuses ${name} without removal or intent`, async () =>
    fixture(async (f) => {
      const p = await f.prepare();
      f.accept(p);
      mutate(f);
      const before = readFileSync(join(f.root, '.issue-cli', 'worktrees.json'));
      await assert.rejects(f.finish());
      assert(existsSync(f.target));
      assert(existsSync(p.physical.gitDirectory));
      assert(readFileSync(join(f.root, '.issue-cli', 'worktrees.json')).equals(before));
      assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
    }));

const unsafeAuthority = {
  'open issue': (f: ReturnType<typeof createFixture>) => {
    f.state.issue = 'open';
  },
  'not-planned closure': (f: ReturnType<typeof createFixture>) => {
    f.state.reason = 'NOT_PLANNED';
  },
  'duplicate closure': (f: ReturnType<typeof createFixture>) => {
    f.state.reason = 'DUPLICATE';
  },
  'missing App evidence': () => {
    native.comments.delete(202);
  },
  'author quotation of App body': () => {
    native.comments.get(202)!.user = { id: 42, login: 'operator', type: 'User' };
  },
  'foreign App': () => {
    native.comments.get(202)!.user = { id: 99, login: 'foreign[bot]', type: 'Bot' };
  },
  'changed whole App body': () => {
    native.comments.get(202)!.body = `${String(native.comments.get(202)!.body)}\nchanged`;
  },
  'foreign subject': () => {
    native.comments.get(202)!.issue_url = 'https://api.github.com/repos/example/widget/issues/18';
  },
  'operator identity drift': () => {
    native.comments.get(201)!.user = { id: 43, login: 'operator', type: 'User' };
  },
  'preparation acknowledgement changed': () => {
    native.comments.get(101)!.body = 'changed';
  },
  'acceptance predates preparation': () => {
    native.comments.get(202)!.created_at = '2025-01-01T00:00:00Z';
  },
  'changed durable result': (f: ReturnType<typeof createFixture>) =>
    writeFileSync(f.resultPath, 'different durable conclusion'),
};
for (const [name, mutate] of Object.entries(unsafeAuthority))
  test(`refuses ${name} and preserves custody`, async () =>
    fixture(async (f) => {
      const p = await f.prepare();
      f.accept(p);
      mutate(f);
      await assert.rejects(f.finish());
      assert(existsSync(f.target));
      assert.deepEqual(f.registry().worktrees, [f.unrelated, p.row]);
      assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
    }));

test('revoked operator authority cannot be resumed or replaced by local review assertions', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    native.comments.set(203, {
      ...native.comments.get(201),
      id: 203,
      body: stableJson({
        schemaVersion: 'ai-delivery.investigation-removal-revocation@1',
        preparationId: p.preparationId,
        resultDigest: digestBytes(readFileSync(f.resultPath)),
        authorityCommentId: 201,
      }),
    });
    await assert.rejects(f.finish(), /revoked/u);
    assert(existsSync(f.target));
  }));

test('inspection explains missing native acceptance without granting removal', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.state.issue = 'closed';
    const result = await finishInvestigation(f.context, { issueNumber: 17, resultPath: f.resultPath, dryRun: true });
    assert.equal(result.completed, false);
    assert('ready' in result && result.ready === false);
    assert(existsSync(f.target));
    assert.deepEqual(f.registry().worktrees, [f.unrelated, p.row]);
    await assert.rejects(
      finishInvestigation(f.context, { issueNumber: 17, resultPath: f.resultPath }),
      /positive native/u,
    );
  }));

test('legacy rows or absent preparation cannot be retrospectively adopted', async () =>
  fixture(async (f) => {
    await assert.rejects(f.finish(), /No prospective/u);
    const row = { ...f.unrelated, issueNumber: 17, path: f.target, branch: 'issue/17' };
    writeFileSync(join(f.root, '.issue-cli', 'worktrees.json'), JSON.stringify({ worktrees: [row] }));
    await assert.rejects(f.prepare(), /Legacy custody/u);
    assert(existsSync(f.target));
  }));

test('existing writer custody refuses prospective registration without attempting legacy recovery', async () =>
  fixture(async (f) => {
    const directory = join(f.root, '.git', 'ai-delivery', 'writers@1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${digestValue(f.target).slice(7)}.json`), 'retained historical writer');
    await assert.rejects(f.prepare(), /writer absence/u);
    assert(existsSync(f.target));
    assert.equal(readInvestigationPreparation(f.root, 17), undefined);
  }));

test('unexplained absence cannot create removal authority, and recreated paths cannot replay a sealed completion', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    git(f.root, 'worktree', 'remove', f.target);
    await assert.rejects(f.finish(), /missing/u);
    assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
  }));
test('recreated worktree refuses terminal replay even with identical Git source', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    await f.finish();
    git(f.root, 'worktree', 'add', f.target, 'issue/17');
    await assert.rejects(f.finish(), /physical identity/u);
    assert(existsSync(f.target));
  }));
test('resume requires the original evidence digest and revalidates current native acceptance', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    native.fault = 'registry';
    await assert.rejects(f.finish());
    const before = readFileSync(join(f.evidence, 'intent.json'));
    writeFileSync(f.resultPath, 'replacement result');
    await assert.rejects(f.finish(), /same exact/u);
    assert(readFileSync(join(f.evidence, 'intent.json')).equals(before));
    assert.equal(f.registry().worktrees.length, 2);
  }));
test('result inside worktree is preserved and refused before removal', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    const path = join(f.target, 'private-result');
    writeFileSync(path, 'retain', { mode: 0o600 });
    await assert.rejects(f.finish({ resultPath: path }), /outside/u);
    assert.equal(readFileSync(path, 'utf8'), 'retain');
  }));
test('a clean tracked result under a ..-prefixed child is not external durable evidence', async () =>
  fixture(async (f) => {
    assert.equal(git(f.target, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.match(git(f.target, 'ls-tree', f.head, '--', '..notes/result.txt'), /^100644 blob /u);
    assert.equal(lstatSync(f.resultPath).mode & 0o777, 0o600);
    const p = await f.prepare();
    assert.equal(p.head.sha, f.head);
    f.accept(p);
    const bytes = readFileSync(f.resultPath);
    const registry = readFileSync(join(f.root, '.issue-cli', 'worktrees.json'));
    const comments = [...native.comments.entries()];
    const authority = vi.spyOn(f.context.clients.rest.issues, 'get');
    try {
      await assert.rejects(f.finish(), /canonical and outside/u);
      assert.equal(authority.mock.calls.length, 0);
    } finally {
      authority.mockRestore();
    }
    assert(readFileSync(f.resultPath).equals(bytes));
    assert(existsSync(f.target));
    assert(existsSync(p.physical.gitDirectory));
    assert(readFileSync(join(f.root, '.issue-cli', 'worktrees.json')).equals(registry));
    assert.deepEqual([...native.comments.entries()], comments);
    assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
    assert.equal(git(f.target, 'status', '--porcelain', '--untracked-files=all'), '');
  }, true));
test('registration requires exact canonical path and authoritative initial default head', async () =>
  fixture(async (f) => {
    await assert.rejects(
      registerInvestigation(f.context, {
        issueNumber: 17,
        investigationWorktree: `${f.target}/../issue-17`,
        expectedHeadSha: f.head,
      }),
      /canonical/u,
    );
    git(f.target, 'commit', '--allow-empty', '-m', 'Already investigated');
    f.state.branches[0]!.sha = git(f.target, 'rev-parse', 'HEAD');
    await assert.rejects(
      registerInvestigation(f.context, {
        issueNumber: 17,
        investigationWorktree: f.target,
        expectedHeadSha: f.state.branches[0]!.sha,
      }),
      /current native default/u,
    );
  }));

test('CLI/MCP modes reject PR mixing, preserve ordinary required PR and refuse local approval substitutions', () => {
  const start = getAiDeliveryMcpTool('issue_start')!.inputSchema;
  const finish = getAiDeliveryMcpTool('issue_finish')!.inputSchema;
  const registration = {
    issueNumber: 17,
    investigationWorktree: '/fictional/.worktrees/issue-17',
    expectedHeadSha: 'a'.repeat(40),
  };
  assert(start.safeParse(registration).success);
  for (const extra of [{ branch: 'issue/17' }, { request: 'create another' }, { expectedHeadSha: 'invalid' }])
    assert.equal(start.safeParse({ ...registration, ...extra }).success, false);
  const completion = { issueNumber: 17, investigation: true, resultPath: '/fictional/result' };
  assert(finish.safeParse(completion).success);
  for (const extra of [
    { prNumber: 23 },
    { nonClosing: true },
    { strategy: 'squash' },
    { reviewedHeadSha: 'a'.repeat(40) },
    { approved: true },
  ])
    assert.equal(finish.safeParse({ ...completion, ...extra }).success, false);
  assert(finish.safeParse({ issueNumber: 17, prNumber: 23 }).success);
  assert.equal(finish.safeParse({ issueNumber: 17 }).success, false);
});

test('an explicit repo-root cannot hide the physical current worktree', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    const original = process.cwd();
    try {
      process.chdir(f.target);
      await assert.rejects(f.finish(), /current worktree/u);
    } finally {
      process.chdir(original);
    }
    assert(existsSync(f.target));
    assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
  }));
test('an explicit repo-root cannot hide an empty ..-prefixed physical current-worktree child', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    const directory = join(f.target, '..notes');
    mkdirSync(directory);
    assert.equal(readdirSync(directory).length, 0);
    assert.equal(git(f.target, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.equal(f.context.root, f.root);
    const registry = readFileSync(join(f.root, '.issue-cli', 'worktrees.json'));
    const original = process.cwd();
    try {
      process.chdir(directory);
      await assert.rejects(f.finish(), /current worktree/u);
    } finally {
      process.chdir(original);
    }
    assert(existsSync(directory));
    assert(existsSync(f.target));
    assert(existsSync(p.physical.gitDirectory));
    assert(readFileSync(join(f.root, '.issue-cli', 'worktrees.json')).equals(registry));
    assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
  }));
test('primary worktree registration is refused without touching its source', async () =>
  fixture(async (f) => {
    await assert.rejects(
      registerInvestigation(f.context, { issueNumber: 17, investigationWorktree: f.root, expectedHeadSha: f.head }),
      /canonical/u,
    );
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
    assert(existsSync(f.target));
  }));
test('missing ownership witness or registry row refuses cleanup rather than reconstructing custody', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    const directory = join(f.root, '.git', 'ai-delivery', 'worktree-owners');
    for (const name of readdirSync(directory)) rmSync(join(directory, name));
    await assert.rejects(f.finish(), /ownership witness/u);
    assert(existsSync(f.target));
  }));
test('row absence without durable removal intent refuses cleanup', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    writeFileSync(join(f.root, '.issue-cli', 'worktrees.json'), JSON.stringify({ worktrees: [f.unrelated] }));
    await assert.rejects(f.finish(), /without a removal intent/u);
    assert(existsSync(f.target));
  }));
test('terminal replay still requires current authentic App acceptance', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    await f.finish();
    native.comments.delete(202);
    await assert.rejects(f.finish(), /reviewer-App/u);
    assert.deepEqual(f.registry().worktrees, [f.unrelated]);
  }));
test('corrupt preserved result prevents interruption recovery from deleting or retiring more data', async () =>
  fixture(async (f) => {
    const p = await f.prepare();
    f.accept(p);
    native.fault = 'intent';
    await assert.rejects(f.finish());
    const digest = digestBytes(readFileSync(f.resultPath));
    writeFileSync(join(f.evidence, `${digest.slice(7)}.bin`), 'corrupt');
    await assert.rejects(f.finish(), /evidence changed/u);
    assert(existsSync(f.target));
    assert.equal(f.registry().worktrees.length, 2);
  }));

test('MCP investigation lifecycle resolves the selected checkout and completes through the shared owner', async () =>
  fixture(async (f) => {
    const loadSettings = vi.spyOn(settings, 'loadDeliverySettings').mockResolvedValue({
      roles: {
        author: { identity: 'operator', authSource: 'personal' },
        reviewer: { identity: 'independent' },
      },
      checkoutRoots: [f.root],
    } as unknown as Awaited<ReturnType<typeof settings.loadDeliverySettings>>);
    const loadContext = vi.spyOn(issues, 'loadDeliveryContext').mockResolvedValue(f.context);
    const server = createAiDeliveryMcpServer({ repoRoot: f.directory });
    const client = new Client({ name: 'fictional-investigation', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await client.callTool({
        name: 'issue_start',
        arguments: {
          repo: 'example/widget',
          issueNumber: 17,
          investigationWorktree: f.target,
          expectedHeadSha: f.head,
        },
      });
      assert.equal(started.isError, undefined, JSON.stringify(started));
      const p = readInvestigationPreparation(f.root, 17)!;
      f.accept(p);
      const finished = await client.callTool({
        name: 'issue_finish',
        arguments: {
          repo: 'example/widget',
          issueNumber: 17,
          investigation: true,
          resultPath: f.resultPath,
          authorityCommentId: 201,
          acceptanceCommentId: 202,
        },
      });
      assert.equal(finished.isError, undefined, JSON.stringify(finished));
      assert.equal(existsSync(f.target), false);
      assert.deepEqual(f.registry().worktrees, [f.unrelated]);
      assert.equal(git(f.root, 'rev-parse', 'refs/heads/issue/17'), f.head);
    } finally {
      await client.close();
      await server.close();
      loadSettings.mockRestore();
      loadContext.mockRestore();
    }
  }));

for (const flag of ['--assume-unchanged', '--skip-worktree'] as const) {
  test(`registration refuses ${flag} without recording prospective custody`, async () =>
    fixture(async (f) => {
      git(f.target, 'update-index', flag, '--', 'source.txt');
      writeFileSync(join(f.target, 'source.txt'), 'hidden private bytes before registration\n');
      assert.equal(git(f.target, 'status', '--porcelain', '--untracked-files=all'), '');
      await assert.rejects(f.prepare(), /index entries/u);
      assert.equal(readFileSync(join(f.target, 'source.txt'), 'utf8'), 'hidden private bytes before registration\n');
      assert.equal(readInvestigationPreparation(f.root, 17), undefined);
      assert.deepEqual(f.registry().worktrees, [f.unrelated]);
    }));
  test(`completion refuses ${flag} and preserves hidden bytes, administration and registry`, async () =>
    fixture(async (f) => {
      const p = await f.prepare();
      f.accept(p);
      git(f.target, 'update-index', flag, '--', 'source.txt');
      writeFileSync(join(f.target, 'source.txt'), 'hidden private bytes after registration\n');
      assert.equal(git(f.target, 'status', '--porcelain', '--untracked-files=all'), '');
      const before = readFileSync(join(f.root, '.issue-cli', 'worktrees.json'));
      await assert.rejects(f.finish(), /index entries/u);
      assert.equal(readFileSync(join(f.target, 'source.txt'), 'utf8'), 'hidden private bytes after registration\n');
      assert(existsSync(p.physical.gitDirectory));
      assert(readFileSync(join(f.root, '.issue-cli', 'worktrees.json')).equals(before));
      assert.equal(git(f.target, 'rev-parse', 'HEAD'), f.head);
      assert.equal(existsSync(join(f.evidence, 'intent.json')), false);
    }));
  test(`interrupted resume refuses ${flag} without retiring hidden bytes or changing its intent`, async () =>
    fixture(async (f) => {
      const p = await f.prepare();
      f.accept(p);
      native.fault = 'intent';
      await assert.rejects(f.finish(), /Fixture interruption/u);
      const intent = readFileSync(join(f.evidence, 'intent.json'));
      git(f.target, 'update-index', flag, '--', 'source.txt');
      writeFileSync(join(f.target, 'source.txt'), 'hidden private bytes during recovery\n');
      assert.equal(git(f.target, 'status', '--porcelain', '--untracked-files=all'), '');
      await assert.rejects(f.finish(), /index entries/u);
      assert.equal(readFileSync(join(f.target, 'source.txt'), 'utf8'), 'hidden private bytes during recovery\n');
      assert(readFileSync(join(f.evidence, 'intent.json')).equals(intent));
      assert(existsSync(p.physical.gitDirectory));
      assert.deepEqual(f.registry().worktrees, [f.unrelated, p.row]);
    }));
}

for (const [mode, args, refusal] of [
  [
    'start',
    [
      'start',
      '--issue',
      '17',
      '--investigation-worktree',
      '/fictional',
      '--expected-head',
      'a'.repeat(40),
      '--branch',
      'issue/17',
    ],
    /cannot create or change/u,
  ],
  [
    'finish',
    ['finish', '--issue', '17', '--investigation', '--result', '/fictional-result', '--pr', '23'],
    /cannot accept PR or merge/u,
  ],
] as const)
  test(`CLI ${mode} refuses mixed modes before authentication and preserves fixture source`, async () =>
    fixture(async (f) => {
      const cli = new URL('./cli.js', import.meta.url);
      const response = spawnSync(process.execPath, [cli.pathname, '--repo', 'example/widget', ...args], {
        cwd: f.directory,
        env: { HOME: f.directory, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        encoding: 'utf8',
      });
      assert.equal(response.status, 1, response.stderr);
      assert.match(response.stderr, refusal);
      assert.equal(git(f.target, 'rev-parse', 'HEAD'), f.head);
      assert.deepEqual(f.registry().worktrees, [f.unrelated]);
    }));
