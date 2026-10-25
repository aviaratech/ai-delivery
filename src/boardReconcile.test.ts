import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test, vi } from 'vitest';
import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { syntheticDiscoveryClients, syntheticDiscoveryConfig } from './fixtures/discovery.js';
import { IssueFields, parseIssueBody, renderIssueBody } from './issueContract.js';
import type { DeliveryContext } from './issue.js';
import type { ProjectDeliveryStatus } from './github/projectDelivery.js';
import { gitEnvironment } from './gitProcess.js';
import * as board from './services/boardReconcileService.js';
import * as version from './version.js';
import { digestValue } from './delivery/common.js';
import { executeTool } from './dispatch.js';
import * as githubClients from './github/client.js';
import * as issueModule from './issue.js';
import { createAiDeliveryMcpServer } from './mcp/index.js';
import type { AiDeliveryMcpToolName } from './mcp/tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const boardName: AiDeliveryMcpToolName = 'board_reconcile';

type Checkout = { repository: string; issueNumber: number; path: string };
type DryRequest = { repositories: string[]; mode: 'dry-run'; checkouts?: Checkout[] };
const collect = async (contexts: DeliveryContext[], request: DryRequest, roots: string[]) => {
  return board.collectBoardReconcilePlan(contexts, request, { checkoutRoots: roots });
};

async function applyPlan(
  f: Awaited<ReturnType<typeof boardFixture>>,
  plan: board.BoardReconcilePlan,
  priorResult?: board.BoardReconcileResult,
  signal?: AbortSignal,
) {
  const operation = Reflect.get(board, 'boardReconcile') as
    | ((
        contexts: readonly DeliveryContext[],
        request: board.BoardReconcileRequest,
        options: { checkoutRoots: readonly string[] },
      ) => Promise<board.BoardReconcilePlan | board.BoardReconcileResult>)
    | undefined;
  assert.equal(typeof operation, 'function');
  const request = board.parseBoardReconcileRequest({
    repositories: f.request.repositories,
    mode: 'apply',
    plan,
    ...(priorResult === undefined ? {} : { priorResult }),
  });
  return board.BoardReconcileResultSchema.parse(
    await operation!(f.contexts, request, { checkoutRoots: [f.root], ...(signal === undefined ? {} : { signal }) }),
  );
}
function redigest(plan: board.BoardReconcilePlan): void {
  plan.operations = plan.operations.map((operation) => {
    const { operationId: _id, ...intent } = operation;
    return { ...intent, operationId: digestValue(intent) };
  });
  const { planId: _id, collectionStartedAt: _start, collectionCompletedAt: _end, ...semantic } = plan;
  plan.planId = digestValue(semantic);
}

async function boardFixture(count = 101, repositories = ['example/widget'], independentProjects = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-reconcile-')));
  const roles = {
    author: {
      identity: 'synthetic-author',
      credentialEnv: {
        appId: 'AUTHOR_APP_ID',
        installationId: 'AUTHOR_INSTALLATION_ID',
        privateKeyPath: 'AUTHOR_KEY_PATH',
      },
    },
    reviewer: {
      identity: 'synthetic-reviewer',
      credentialEnv: {
        appId: 'REVIEWER_APP_ID',
        installationId: 'REVIEWER_INSTALLATION_ID',
        privateKeyPath: 'REVIEWER_KEY_PATH',
      },
    },
  };
  const settingsPath = join(root, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      schemaVersion: 'ai-delivery.user@1',
      roles,
      checkoutRoots: [root],
      project: 1,
      pointsField: 'Estimate',
      priorityField: 'Urgency',
      statusField: 'Flow',
      statuses: syntheticDiscoveryConfig.native.project.statuses,
    }),
  );
  vi.stubEnv('AI_DELIVERY_CONFIG', settingsPath);
  const ready = IssueFields.parse({
    title: 'Reconcile native widget',
    issueType: 'Task',
    points: 2,
    problem: 'Board drift obscures native truth.',
    outcome: 'Report scoped native truth.',
    acceptanceCriteria: [
      { behavior: 'Exact reconciliation retains issue truth.', verifiedBy: 'Synthetic scoped fixture.' },
    ],
    outOfScope: ['Native field repair.'],
  });
  const rows = new Map<
    string,
    {
      number: number;
      id: number;
      node_id: string;
      title: string;
      body: string;
      state: string;
      html_url: string;
      labels: { name: string }[];
      type: { name: string };
      points: number | null;
    }
  >();
  const members = new Map<
    string,
    { itemId: string; repository: string; number: number; status: ProjectDeliveryStatus | null; archived: boolean }
  >();
  const children = new Map<string, number[]>();
  const blockers = new Map<
    string,
    { id: string; number: number; title: string; state: 'OPEN' | 'CLOSED'; repository: { nameWithOwner: string } }[]
  >();
  const branches = new Map<string, string[]>();
  const writes: { kind: string; subject: string }[] = [];
  const controls = {
    itemPages: 0,
    issuePages: 0,
    hiddenContent: false,
    writable: true,
    failAfterAdd: false,
    automaticStatus: null as ProjectDeliveryStatus | null,
    failAfterStatus: false,
    beforeGraphql: undefined as undefined | ((query: string, variables: Record<string, unknown>) => void),
    afterWrite: undefined as undefined | ((kind: string, node: string) => void),
  };
  const git = (cwd: string, args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: gitEnvironment(),
      encoding: 'utf8',
    }).trim();
  const clones = new Map<string, string>();
  for (const repository of repositories) {
    const clone = join(root, repository.split('/')[1]!);
    mkdirSync(clone);
    clones.set(repository, clone);
    git(clone, ['init', '-q', '-b', 'main']);
    git(clone, ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
    writeFileSync(join(clone, 'README'), 'fixture\n');
    git(clone, ['add', 'README']);
    git(clone, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    for (let number = 17; number < 17 + count; number++) {
      const key = `${repository}:${String(number)}`;
      const node = `ISSUE-${key}`;
      rows.set(key, {
        number,
        id: number,
        node_id: node,
        title: ready.title,
        body: renderIssueBody(ready),
        state: 'open',
        html_url: `https://github.com/${repository}/issues/${String(number)}`,
        labels: [{ name: 'estimate:2' }, { name: 'area:widget' }],
        type: { name: 'Task' },
        points: 2,
      });
      members.set(node, { itemId: `ITEM-${key}`, repository, number, status: 'Todo', archived: false });
    }
  }
  const contexts: DeliveryContext[] = [];
  const names: Record<ProjectDeliveryStatus, string> = {
    Todo: 'Queued',
    'In Progress': 'Active',
    Blocked: 'Waiting',
    Done: 'Shipped',
  };
  const option: Record<ProjectDeliveryStatus, string> = {
    Todo: 'STATUS-0',
    'In Progress': 'STATUS-1',
    Blocked: 'STATUS-2',
    Done: 'STATUS-3',
  };
  for (const repository of repositories) {
    const organization = repository.split('/')[0]!;
    const projectId = independentProjects ? `PROJECT-${organization}` : 'PROJECT-1';
    const configured = {
      ...syntheticDiscoveryConfig,
      repository,
      native: { ...syntheticDiscoveryConfig.native, organization },
    };
    const discovery = syntheticDiscoveryClients(configured);
    const own = (number: number) => {
      const row = rows.get(`${repository}:${String(number)}`);
      assert.ok(row);
      return row;
    };
    const item = (node: string, member: NonNullable<ReturnType<typeof members.get>>) => ({
      id: member.itemId,
      isArchived: member.archived,
      project: { id: projectId, number: 1 },
      content: controls.hiddenContent
        ? null
        : { __typename: 'Issue', id: node, number: member.number, repository: { nameWithOwner: member.repository } },
      fieldValueByName: member.status === null ? null : { name: names[member.status], optionId: option[member.status] },
    });
    const graphql = (async (query: string, variables: Record<string, unknown> = {}) => {
      controls.beforeGraphql?.(query, variables);
      if (query.includes('mutation')) {
        if (query.includes('AddProjectDeliveryItem')) {
          const node = String(variables.contentId);
          const row = [...rows.values()].find((r) => r.node_id === node);
          assert.ok(row);
          const rowRepository = row.html_url.split('/').slice(3, 5).join('/');
          members.set(node, {
            itemId: `ADDED-${node}`,
            repository: rowRepository,
            number: row.number,
            status: controls.automaticStatus,
            archived: false,
          });
          writes.push({ kind: 'add', subject: node });
          controls.afterWrite?.('add', node);
          if (controls.failAfterAdd) throw new Error('Lost add response');
          return { addProjectV2ItemById: { item: { id: `ADDED-${node}` } } };
        }
        if (query.includes('UpdateProjectDeliveryStatus')) {
          const found = [...members.entries()].find(([, m]) => m.itemId === variables.itemId);
          assert.ok(found);
          found[1].status = (Object.keys(option) as ProjectDeliveryStatus[]).find(
            (s) => option[s] === variables.optionId,
          )!;
          writes.push({ kind: 'status', subject: found[0] });
          controls.afterWrite?.('status', found[0]);
          if (controls.failAfterStatus) throw new Error('Lost Status response');
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
        }
        throw new Error('Unexpected mutation');
      }
      if (query.includes('ProjectDeliveryItems')) {
        controls.itemPages++;
        const offset = typeof variables.cursor === 'string' ? Number(variables.cursor.slice(1)) : 0;
        const all = [...members.entries()].filter(
          ([, member]) => !independentProjects || member.repository.split('/')[0] === organization,
        );
        const slice = all.slice(offset, offset + 100);
        return {
          organization: {
            projectV2: {
              id: projectId,
              number: 1,
              items: {
                nodes: slice.map(([node, m]) => item(node, m)),
                pageInfo: { hasNextPage: offset + 100 < all.length, endCursor: `p${String(offset + 100)}` },
              },
            },
          },
        };
      }
      if (query.includes('ProjectDeliveryItemReadback')) {
        const found = [...members.entries()].find(([, m]) => m.itemId === variables.itemId);
        return { node: found ? item(found[0], found[1]) : null };
      }
      if (query.includes('blockedBy(first:')) {
        const row = own(Number(variables.number));
        const all = blockers.get(`${repository}:${String(row.number)}`) ?? [];
        const offset = typeof variables.cursor === 'string' ? Number(variables.cursor.slice(1)) : 0;
        return {
          repository: {
            issue: {
              id: row.node_id,
              number: row.number,
              repository: { nameWithOwner: repository },
              parent: null,
              blockedBy: {
                nodes: all.slice(offset, offset + 100),
                pageInfo: { hasNextPage: offset + 100 < all.length, endCursor: `b${String(offset + 100)}` },
              },
            },
          },
        };
      }
      if (query.includes('DeliveryIssueBranches'))
        return {
          repository: {
            issue: {
              linkedBranches: {
                nodes: (branches.get(`${repository}:${String(variables.issue)}`) ?? []).map((name) => ({
                  ref: { name, target: { oid: '1'.repeat(40) }, repository: { nameWithOwner: repository } },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      const response = await discovery.graphql(query, variables);
      if (query.includes('DeliveryRepository'))
        return {
          repository: {
            id: `REPO-${repository}`,
            nameWithOwner: repository,
            isFork: false,
            owner: { __typename: 'Organization', login: organization },
          },
        };
      if (query.includes('ProjectDeliveryConfiguration')) {
        const data = response as { organization: { projectV2: Record<string, unknown> } };
        data.organization.projectV2.id = projectId;
        data.organization.projectV2.viewerCanUpdate = controls.writable;
      }
      return response;
    }) as unknown as DeliveryContext['clients']['graphql'];
    const rest = {
      issues: {
        listForRepo: async (input: { page: number; per_page: number }) => {
          controls.issuePages++;
          return {
            data: [...rows.entries()]
              .filter(([key]) => key.startsWith(`${repository}:`))
              .map(([, r]) => r)
              .slice((input.page - 1) * input.per_page, input.page * input.per_page),
          };
        },
        get: async (input: { issue_number: number }) => ({ data: { ...own(input.issue_number) } }),
        listSubIssues: async (input: { issue_number: number; per_page: number }) => ({
          data: (children.get(`${repository}:${String(input.issue_number)}`) ?? [])
            .slice(0, input.per_page)
            .map((number) => own(number)),
        }),
      },
      request: async (route: string, input: { page?: number; issue_number?: number }) => {
        assert.ok(route.startsWith('GET'));
        const offset = ((input.page ?? 1) - 1) * 100;
        if (route.includes('/orgs/'))
          return {
            data: [
              { id: 101, name: 'Estimate', data_type: 'single_select' },
              { id: 102, name: 'Urgency', data_type: 'single_select' },
              ...Array.from({ length: 101 }, (_, n) => ({
                id: 1000 + n,
                name: `Extra ${String(n)}`,
                data_type: 'text',
              })),
            ].slice(offset, offset + 100),
          };
        const row = own(input.issue_number!);
        return {
          data:
            offset === 0 && row.points !== null
              ? [
                  {
                    issue_field_id: 101,
                    issue_field_name: 'Estimate',
                    data_type: 'single_select',
                    value: row.points,
                    single_select_option: { name: String(row.points) },
                  },
                ]
              : [],
        };
      },
    } as unknown as DeliveryContext['clients']['rest'];
    const clients = {
      graphql,
      rest,
      role: 'author' as const,
      authSource: 'app' as const,
      authenticatedAuthor: async () => ({
        actorLogin: 'synthetic-author[bot]',
        credentialIdentity: 'app:1:installation:2',
      }),
    } as DeliveryContext['clients'];
    const loaded = await loadDeliveryConfig('', { clients, repository, readPageLimit: 20 });
    contexts.push({
      clients,
      config: loaded.config,
      configuration: loaded,
      repo: { owner: organization, repo: repository.split('/')[1]! },
      root: '',
      readPageLimit: 20,
    });
  }
  return {
    root,
    contexts,
    rows,
    members,
    children,
    blockers,
    branches,
    writes,
    controls,
    request: { repositories, mode: 'dry-run' as const },
    statusFor: (node: string) => members.get(node)?.status ?? null,
    get writesSinceResume() {
      return writes;
    },
    checkout: (repository: string, issueNumber: number) => {
      const path = join(root, `checkout ü ${String(issueNumber)}`);
      const name = `native/${String(issueNumber)}`;
      git(clones.get(repository)!, ['worktree', 'add', '-q', '-b', name, path]);
      branches.set(`${repository}:${String(issueNumber)}`, [name]);
      return { repository, issueNumber, path };
    },
    git,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('dry-run includes all scoped issues and writes nothing', async () => {
  const f = await boardFixture(101, ['example/widget', 'example/second']);
  try {
    const first = f.rows.get('example/widget:17')!;
    first.state = 'closed';
    const draft = { ...IssueFields.parse({ title: first.title, draft: true }), draft: true };
    f.rows.get('example/widget:18')!.body = renderIssueBody(draft);
    f.blockers.set('example/widget:18', [
      ...Array.from({ length: 101 }, (_, n) => ({
        id: `CLOSED-${String(n)}`,
        number: 1000 + n,
        title: 'Closed blocker',
        state: 'CLOSED' as const,
        repository: { nameWithOwner: 'foreign/repo' },
      })),
      {
        id: 'FOREIGN',
        number: 17,
        title: 'Foreign blocker',
        state: 'OPEN',
        repository: { nameWithOwner: 'foreign/repo' },
      },
    ]);
    f.rows.get('example/widget:19')!.body = renderIssueBody(draft);
    f.children.set('example/widget:20', [17]);
    f.members.delete(f.rows.get('example/widget:21')!.node_id);
    f.rows.get('example/widget:22')!.state = 'closed';
    f.members.delete(f.rows.get('example/widget:22')!.node_id);
    f.members.get(f.rows.get('example/widget:23')!.node_id)!.archived = true;
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(plan.scopeComplete, true);
    assert.equal(plan.issues.length, 202);
    assert.equal(new Set(plan.issues.map((i) => `${i.repository}:${String(i.issueNumber)}`)).size, 202);
    const issue = (number: number) =>
      plan.issues.find((i) => i.repository === 'example/widget' && i.issueNumber === number)!;
    assert.equal(issue(17).status.target, 'Done');
    assert.equal(issue(18).status.target, 'Blocked');
    assert.equal(issue(19).status.target, 'Todo');
    assert.equal(issue(20).status.target, null);
    assert.equal(issue(18).native.blockers!.length, 102);
    assert.equal(
      issue(20).metadata.some((d) => d.code === 'parent-points'),
      true,
    );
    assert.equal(issue(22).membership.kind, 'not-required');
    assert.equal(issue(23).membership.kind, 'archived-preserved');
    assert.equal(
      plan.operations.some((o) => o.issueNumber === 21 && o.kind === 'add-membership'),
      true,
    );
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test('physical checkout is positive evidence only after live native association', async () => {
  const f = await boardFixture(1);
  try {
    const noSelection = await collect(f.contexts, f.request, [f.root]);
    assert.equal(noSelection.issues[0]!.status.target, null);
    const checkout = f.checkout('example/widget', 17);
    writeFileSync(join(checkout.path, 'README'), 'dirty bytes\n');
    const indexPath = f.git(checkout.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const indexBefore = readFileSync(indexPath);
    const active = await collect(f.contexts, { ...f.request, checkouts: [checkout] }, [f.root]);
    assert.equal(active.issues[0]!.status.target, 'In Progress', JSON.stringify(active.issues[0]));
    assert.equal(readFileSync(join(checkout.path, 'README'), 'utf8'), 'dirty bytes\n');
    assert.deepEqual(readFileSync(indexPath), indexBefore);
    f.branches.clear();
    const gone = await collect(f.contexts, { ...f.request, checkouts: [checkout] }, [f.root]);
    assert.equal(gone.issues[0]!.status.target, null);
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test('executing package identity ignores cwd', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const identity = version.readPackageArtifactIdentity();
  assert.equal(identity.packageVersion, manifest.version);
  assert.match(identity.packageManifestDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(identity.packageDistDigest, /^sha256:[a-f0-9]{64}$/u);
});

test(
  'copied executing artifact changes identity with same-version bytes and refuses links',
  { tags: ['release'] },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'reconcile-artifact-')));
    try {
      cpSync(fileURLToPath(new URL('.', import.meta.url)), join(root, 'dist'), { recursive: true });
      cpSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(root, 'package.json'));
      symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
      const read = () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              'const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.readPackageArtifactIdentity()));',
              join(root, 'dist/version.js'),
            ],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 },
          ),
        ) as ReturnType<typeof version.readPackageArtifactIdentity>;
      assert.deepEqual(read(), version.readPackageArtifactIdentity());
      writeFileSync(join(root, 'dist/changed-bytes'), 'different bytes, same package version\n');
      const changed = read();
      assert.equal(changed.packageVersion, version.readPackageArtifactIdentity().packageVersion);
      assert.notEqual(changed.packageDistDigest, version.readPackageArtifactIdentity().packageDistDigest);
      symlinkSync(join(root, 'package.json'), join(root, 'dist/unsupported-link'));
      assert.throws(read);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('request bounds and conflicting selectors refuse before collection', () => {
  for (const input of [
    { repositories: [] },
    { repositories: Array.from({ length: 11 }, (_, n) => `example/r${String(n)}`) },
    { repositories: ['example/widget', 'EXAMPLE/WIDGET'] },
    { repositories: ['invalid'] },
    { repositories: ['example/widget', 'example/other'], repo: 'example/widget' },
    {
      repositories: ['example/widget'],
      checkouts: [{ repository: 'other/repo', issueNumber: 1, path: '/tmp/example' }],
    },
    {
      repositories: ['example/widget'],
      checkouts: [{ repository: 'example/widget', issueNumber: 1, path: 'relative' }],
    },
    { repositories: ['example/widget'], mode: 'apply' },
    { repositories: ['example/widget'], priorResult: {} },
  ])
    assert.equal(board.BoardReconcileInput.safeParse(input).success, false);
  assert.equal(board.BoardReconcileInput.parse({ repositories: [' example/widget '] }).mode, 'dry-run');
  const text = '😀'.repeat(4_300_000);
  assert.ok(text.length < 16 * 1024 * 1024);
  assert.throws(
    () => board.parseBoardReconcileRequest({ repositories: ['example/widget'], oversized: text }),
    /16 MiB/u,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => board.parseBoardReconcileRequest(cyclic), /serializable JSON/u);
});

test('native metadata reports drafts, closed-child parents and mapped duplicate labels without repair', async () => {
  const f = await boardFixture(3);
  try {
    f.rows.get('example/widget:17')!.points = null;
    f.rows.get('example/widget:17')!.body = renderIssueBody(
      IssueFields.parse({ title: f.rows.get('example/widget:17')!.title, draft: true }),
    );
    f.children.set('example/widget:18', [19]);
    f.rows.get('example/widget:19')!.state = 'closed';
    f.rows.get('example/widget:18')!.labels = [
      'points:2',
      'estimate:4',
      'urgency:unmapped',
      'flow:Todo',
      'area:widget',
    ].map((name) => ({ name }));
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(
      plan.issues.find((i) => i.issueNumber === 17)!.metadata.some((d) => d.code === 'missing-points'),
      true,
    );
    const reports = plan.issues.find((i) => i.issueNumber === 18)!.metadata;
    assert.equal(
      reports.some((d) => d.code === 'parent-points'),
      true,
    );
    assert.deepEqual(
      reports.filter((d) => d.code === 'duplicate-field-label').map((d) => [d.label, d.mapping]),
      [
        ['points:2', 'exact'],
        ['estimate:4', 'conflicting'],
        ['urgency:unmapped', 'unknown'],
        ['flow:Todo', 'exact'],
      ],
    );
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test('dry-run read access does not require Project write permission', async () => {
  const f = await boardFixture(1);
  try {
    f.controls.writable = false;
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(plan.scopeComplete, true);
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test('hidden Project content makes the scoped inventory incomplete', async () => {
  const f = await boardFixture(1, ['example/widget', 'example/other']);
  try {
    f.controls.hiddenContent = true;
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(plan.scopeComplete, false);
    assert.equal(plan.issues.length, 2);
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test.each(['source', 'duplicate'] as const)('wrong %s blocker evidence cannot prove a Status rule', async (failure) => {
  const f = await boardFixture(1);
  try {
    f.blockers.set('example/widget:17', [
      {
        id: 'BLOCKER',
        number: 99,
        title: 'Native blocker',
        state: 'OPEN',
        repository: { nameWithOwner: 'foreign/repo' },
      },
    ]);
    const context = f.contexts[0]!,
      original = context.clients.graphql;
    context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
      const response = await original(query, variables);
      if (!query.includes('blockedBy(first:')) return response;
      const data = response as { repository: { issue: { id: string; blockedBy: { nodes: unknown[] } } } };
      if (failure === 'source') data.repository.issue.id = 'WRONG-SOURCE';
      else data.repository.issue.blockedBy.nodes.push(data.repository.issue.blockedBy.nodes[0]);
      return data;
    }) as typeof original;
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(plan.issues[0]!.status.target, null, failure);
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test.each(['detached', 'locked', 'missing', 'remote', 'ambiguous-link', 'root-escape'] as const)(
  'physical %s observation stays unknown',
  async (failure) => {
    const f = await boardFixture(1);
    try {
      const checkout = f.checkout('example/widget', 17);
      let roots = [f.root];
      if (failure === 'detached') f.git(checkout.path, ['checkout', '--detach', '--quiet']);
      if (failure === 'locked') f.git(checkout.path, ['worktree', 'lock', checkout.path]);
      if (failure === 'missing') rmSync(checkout.path, { recursive: true });
      if (failure === 'remote')
        f.git(checkout.path, ['remote', 'set-url', 'origin', 'https://github.com/foreign/repo.git']);
      if (failure === 'ambiguous-link') f.branches.set('example/widget:17', ['native/17', 'native/17']);
      if (failure === 'root-escape') {
        const allowed = join(f.root, 'only-allowed');
        mkdirSync(allowed);
        roots = [allowed];
      }
      const plan = await collect(f.contexts, { ...f.request, checkouts: [checkout] }, roots);
      assert.equal(plan.issues[0]!.activity.state, 'unknown');
      assert.equal(plan.issues[0]!.status.target, null);
      assert.deepEqual(f.writes, []);
    } finally {
      f.cleanup();
    }
  },
);

test('cancellation after a completed unit preserves an incomplete zero-write plan', async () => {
  const f = await boardFixture(3);
  try {
    const cancellation = new AbortController(),
      context = f.contexts[0]!,
      get = context.clients.rest.issues.get;
    context.clients.rest.issues.get = (async (input: Parameters<typeof get>[0]) => {
      const response = await get(input);
      if (input?.issue_number === 18) cancellation.abort();
      return response;
    }) as typeof get;
    const plan = await board.collectBoardReconcilePlan(f.contexts, f.request, {
      checkoutRoots: [f.root],
      signal: cancellation.signal,
    });
    assert.equal(plan.scopeComplete, false);
    assert.ok(plan.issues.some((i) => i.issueNumber === 17));
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test.each([500, 501])('native issue limit %s requires complete boundary evidence', async (count) => {
  const f = await boardFixture(count);
  try {
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(plan.scopeComplete, count === 500);
    assert.equal(plan.issues.length, 500);
    assert.equal(f.controls.issuePages, 6); // exact 500 requires the empty completion page
    if (count === 501)
      assert.equal(
        plan.gaps.some((g) => g.collection === 'repository-issues' && g.limit === 500),
        true,
      );
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test('Project page 21 is not requested and cannot truncate into successful absence', async () => {
  const f = await boardFixture(1);
  try {
    const context = f.contexts[0]!,
      original = context.clients.graphql;
    let requests = 0;
    context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
      if (!query.includes('ProjectDeliveryItems')) return original(query, variables);
      requests++;
      const page = typeof variables.cursor === 'string' ? Number(variables.cursor.slice(1)) + 1 : 1;
      return {
        organization: {
          projectV2: {
            id: 'PROJECT-1',
            number: 1,
            items: { nodes: [], pageInfo: { hasNextPage: page < 21, endCursor: `c${String(page)}` } },
          },
        },
      };
    }) as unknown as typeof original;
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(plan.scopeComplete, false);
    assert.equal(
      plan.gaps.some((g) => g.collection === 'project-items' && g.pagesRequested === 20 && g.limit === 20),
      true,
    );
    assert.equal(requests, 20); // metadata cannot restart an incomplete Project collection
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test('incomplete child existence cannot activate a checkout or fabricate a leaf', async () => {
  const f = await boardFixture(1);
  try {
    const checkout = f.checkout('example/widget', 17);
    f.contexts[0]!.clients.rest.issues.listSubIssues = (async () => ({
      data: [],
      headers: {
        link: '<https://api.github.com/repos/example/widget/issues/17/sub_issues?page=2&per_page=1>; rel="next"',
      },
    })) as unknown as DeliveryContext['clients']['rest']['issues']['listSubIssues'];
    const plan = await collect(f.contexts, { ...f.request, checkouts: [checkout] }, [f.root]);
    assert.equal(plan.issues[0]!.native.hasChildren, null);
    assert.equal(plan.issues[0]!.status.target, null);
    assert.equal(
      plan.issues[0]!.metadata.some((d) => d.code === 'unknown-metadata'),
      true,
    );
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test.each(['catalog', 'values'] as const)(
  'an incomplete %s collection is not retried through later reads',
  async (collection) => {
    const f = await boardFixture(collection === 'catalog' ? 3 : 1);
    try {
      const context = f.contexts[0]!,
        request = context.clients.rest.request;
      let pages = 0;
      context.clients.rest.request = (async (route: string, input: { page: number }) => {
        if (route.includes('/orgs/') !== (collection === 'catalog')) return request(route, input);
        pages++;
        return {
          data:
            input.page > 20
              ? []
              : Array.from({ length: 100 }, (_, n) => {
                  const id = input.page * 100 + n + 1000;
                  return collection === 'catalog'
                    ? { id, name: `Extra ${String(id)}`, data_type: 'text' }
                    : {
                        issue_field_id: id,
                        issue_field_name: `Extra ${String(id)}`,
                        data_type: 'text',
                        value: 'value',
                      };
                }),
        };
      }) as typeof request;
      const checkouts = collection === 'values' ? [f.checkout('example/widget', 17)] : [];
      const plan = await collect(f.contexts, { ...f.request, checkouts }, [f.root]);
      assert.equal(plan.scopeComplete, false);
      assert.equal(pages, 20);
      assert.deepEqual(f.writes, []);
    } finally {
      f.cleanup();
    }
  },
);

test.each([401, 429])(
  'global HTTP %s failure makes preflight incomplete and stops further requests',
  async (status) => {
    const f = await boardFixture(3);
    try {
      let requests = 0;
      f.contexts[0]!.clients.rest.request = (async () => {
        requests++;
        throw Object.assign(new Error('not-public-error-details'), {
          status,
          headers: status === 429 ? { 'retry-after': '2' } : {},
        });
      }) as unknown as (typeof f.contexts)[0]['clients']['rest']['request'];
      const plan = await collect(f.contexts, f.request, [f.root]);
      assert.equal(plan.scopeComplete, false);
      assert.equal(requests, 1);
      assert.equal(plan.issues.length, 3);
      assert.equal(JSON.stringify(plan).includes('not-public-error-details'), false);
      assert.deepEqual(f.writes, []);
    } finally {
      f.cleanup();
    }
  },
);

test.each(['selected', 'unselected'] as const)(
  'unreadable %s Status does not fabricate an unset preimage',
  async (scope) => {
    const f = await boardFixture(2);
    try {
      f.rows.get('example/widget:17')!.state = 'closed';
      f.members.delete(f.rows.get('example/widget:18')!.node_id);
      const context = f.contexts[0]!,
        original = context.clients.graphql;
      context.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
        const response = await original(query, variables);
        if (!query.includes('ProjectDeliveryItems')) return response;
        const data = response as {
          organization: {
            projectV2: {
              items: {
                nodes: {
                  id: string;
                  isArchived: boolean;
                  content: { __typename: string; id: string; number: number; repository: { nameWithOwner: string } };
                  fieldValueByName: { name: string; optionId: string };
                }[];
              };
            };
          };
        };
        const nodes = data.organization.projectV2.items.nodes;
        if (scope === 'selected') nodes[0]!.fieldValueByName = { name: 'Other', optionId: 'OTHER' };
        else
          nodes.push({
            id: 'UNSELECTED',
            isArchived: false,
            content: {
              __typename: 'Issue',
              id: 'FOREIGN-ISSUE',
              number: 1,
              repository: { nameWithOwner: 'other/repo' },
            },
            fieldValueByName: { name: 'Other', optionId: 'OTHER' },
          });
        return data;
      }) as typeof original;
      const plan = await collect(f.contexts, f.request, [f.root]);
      assert.equal(plan.scopeComplete, true);
      assert.equal(
        plan.operations.some((o) => o.kind === 'add-membership' && o.issueNumber === 18),
        true,
      );
      assert.equal(
        plan.operations.some((o) => o.kind === 'set-status' && o.issueNumber === 17),
        scope === 'unselected',
      );
      if (scope === 'selected')
        assert.equal(
          plan.issues.find((i) => i.issueNumber === 17)!.gaps.some((g) => g.stage === 'project-status'),
          true,
        );
      assert.deepEqual(f.writes, []);
    } finally {
      f.cleanup();
    }
  },
);

test.each(['verified', 'foreign-marker', 'duplicate'] as const)(
  'mixed inventory %s PR evidence is checked before exclusion',
  async (kind) => {
    const f = await boardFixture(1);
    try {
      const context = f.contexts[0]!,
        list = context.clients.rest.issues.listForRepo;
      context.clients.rest.issues.listForRepo = (async (input: Parameters<typeof list>[0]) => {
        const response = await list(input);
        const pr = {
          number: 18,
          node_id: 'PR18',
          html_url: 'https://github.com/example/widget/pull/18',
          pull_request: {
            url:
              kind === 'foreign-marker'
                ? 'https://foreign.invalid/pulls/18'
                : 'https://api.github.com/repos/example/widget/pulls/18',
          },
        };
        return { data: [...response.data, pr, ...(kind === 'duplicate' ? [pr] : [])] };
      }) as unknown as typeof list;
      const plan = await collect(f.contexts, f.request, [f.root]);
      assert.equal(plan.scopeComplete, kind === 'verified');
      assert.equal(plan.issues.length, 1);
      assert.deepEqual(f.writes, []);
    } finally {
      f.cleanup();
    }
  },
);

test('membership-only apply and resume preserve automatic Todo and unresolved activity', async () => {
  const f = await boardFixture(1);
  try {
    const node = f.rows.get('example/widget:17')!.node_id;
    f.members.delete(node);
    f.controls.automaticStatus = 'Todo';
    const plan = await collect(f.contexts, f.request, [f.root]);
    const applied = await applyPlan(f, plan);
    assert.equal(applied.summary.applied, 1);
    assert.equal(applied.summary.unresolved, 1);
    assert.equal(f.statusFor(node), 'Todo');
    assert.deepEqual(
      f.writes.map((w) => w.kind),
      ['add'],
    );
    f.writes.length = 0;
    const resumed = await applyPlan(f, plan, applied);
    assert.equal(resumed.planId, plan.planId);
    assert.equal(resumed.summary.applied, 0);
    assert.equal(resumed.summary.satisfied, 1);
    assert.equal(resumed.summary.unresolved, 1);
    assert.equal(f.statusFor(node), 'Todo');
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test.each(['actor', 'access', 'inventory', 'archive', 'configuration'] as const)(
  'apply preflight %s drift refuses before writes',
  async (failure) => {
    const f = await boardFixture(1);
    try {
      const row = f.rows.get('example/widget:17')!;
      row.state = 'closed';
      const plan = await collect(f.contexts, f.request, [f.root]);
      assert.equal(plan.operations.length, 1);
      if (failure === 'actor')
        f.contexts[0]!.clients.authenticatedAuthor = async () => ({
          actorLogin: 'different-actor',
          credentialIdentity: 'user:1',
        });
      if (failure === 'access') f.controls.writable = false;
      if (failure === 'inventory')
        f.rows.set('example/widget:99', {
          ...row,
          number: 99,
          id: 99,
          node_id: 'NEW-ISSUE99',
          state: 'open',
          html_url: 'https://github.com/example/widget/issues/99',
        });
      if (failure === 'archive') f.members.get(row.node_id)!.archived = true;
      if (failure === 'configuration') {
        const path = join(f.root, 'settings.json');
        const settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        settings.checkoutRoots = [];
        writeFileSync(path, JSON.stringify(settings));
      }
      const result = await applyPlan(f, plan);
      assert.equal(result.planId, plan.planId);
      assert.ok(result.summary.refused + result.summary.drifted > 0);
      assert.equal(result.summary.applied, 0);
      assert.deepEqual(f.writes, []);
    } finally {
      f.cleanup();
    }
  },
);

test.each(['destination', 'artifact'] as const)(
  'a recomputed %s digest cannot authorize different intent',
  async (failure) => {
    const f = await boardFixture(1);
    try {
      f.rows.get('example/widget:17')!.state = 'closed';
      const plan = await collect(f.contexts, f.request, [f.root]);
      if (failure === 'destination') plan.operations[0]!.projectId = 'FOREIGN-PROJECT';
      else plan.packageIdentity!.packageDistDigest = `sha256:${'a'.repeat(64)}`;
      redigest(plan);
      assert.equal(board.BoardReconcileInput.safeParse({ ...f.request, mode: 'apply', plan }).success, true);
      const result = await applyPlan(f, plan);
      assert.ok(result.summary.refused + result.summary.drifted > 0);
      assert.deepEqual(f.writes, []);
    } finally {
      f.cleanup();
    }
  },
);

test('validated prior item evidence prevents recreating a deleted membership', async () => {
  const f = await boardFixture(1);
  try {
    const node = f.rows.get('example/widget:17')!.node_id;
    f.members.delete(node);
    const plan = await collect(f.contexts, f.request, [f.root]);
    const prior = await applyPlan(f, plan);
    f.members.delete(node);
    f.writes.length = 0;
    const result = await applyPlan(f, plan, prior);
    assert.ok(result.summary.refused + result.summary.drifted > 0);
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test('known add response item survives a failed readback and constrains resume', async () => {
  const f = await boardFixture(1);
  try {
    const node = f.rows.get('example/widget:17')!.node_id;
    f.members.delete(node);
    const plan = await collect(f.contexts, f.request, [f.root]);
    f.controls.beforeGraphql = (query) => {
      if (query.includes('ProjectDeliveryItemReadback')) throw new Error('Unreadable exact item');
    };
    const prior = await applyPlan(f, plan);
    assert.equal(prior.operations[0]!.attempted, true);
    assert.equal(prior.operations[0]!.outcome, 'unknown');
    assert.deepEqual(prior.operations[0]!.knownItemIds, [`ADDED-${node}`]);
    f.controls.beforeGraphql = undefined;
    f.members.delete(node);
    f.writes.length = 0;
    const resumed = await applyPlan(f, plan, prior);
    assert.equal(resumed.summary.applied, 0);
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test.each(['add', 'status'] as const)(
  'lost %s response is unknown until fresh resume proves the postimage',
  async (kind) => {
    const f = await boardFixture(1);
    try {
      const row = f.rows.get('example/widget:17')!;
      if (kind === 'add') {
        f.members.delete(row.node_id);
        f.controls.automaticStatus = 'Todo';
      } else row.state = 'closed';
      const plan = await collect(f.contexts, f.request, [f.root]);
      f.controls.failAfterAdd = kind === 'add';
      f.controls.failAfterStatus = kind === 'status';
      const prior = await applyPlan(f, plan);
      assert.equal(prior.summary.unknown, 1);
      assert.equal(prior.operations[0]!.attempted, true);
      f.controls.failAfterAdd = false;
      f.controls.failAfterStatus = false;
      f.writes.length = 0;
      const resumed = await applyPlan(f, plan, prior);
      assert.equal(resumed.summary.satisfied, 1);
      assert.equal(resumed.summary.applied, 0);
      assert.deepEqual(f.writesSinceResume, []);
      assert.equal(resumed.operations[0]!.priorEvidence.at(-1)!.outcome, 'unknown');
      assert.equal(resumed.operations[0]!.priorEvidence.at(-1)!.attempted, true);
    } finally {
      f.cleanup();
    }
  },
);

test.each(['absent', 'unexpected-auto-status'] as const)(
  'Status follow-up after membership preserves %s preimage',
  async (variant) => {
    const f = await boardFixture(1);
    try {
      const row = f.rows.get('example/widget:17')!;
      f.members.delete(row.node_id);
      f.blockers.set('example/widget:17', [
        {
          id: 'OPEN-BLOCKER',
          number: 90,
          title: 'Open',
          state: 'OPEN',
          repository: { nameWithOwner: 'example/widget' },
        },
      ]);
      const plan = await collect(f.contexts, f.request, [f.root]);
      assert.equal(plan.operations.length, 2);
      f.controls.automaticStatus = variant === 'absent' ? null : 'Todo';
      const first = await applyPlan(f, plan);
      assert.equal(first.operations[0]!.outcome, 'applied');
      assert.equal(first.operations[1]!.outcome, variant === 'absent' ? 'applied' : 'refused');
      assert.equal(f.statusFor(row.node_id), variant === 'absent' ? 'Blocked' : 'Todo');
      f.writes.length = 0;
      const resumed = await applyPlan(f, plan, first);
      assert.deepEqual(f.writes, []);
      assert.equal(resumed.operations[0]!.outcome, 'satisfied');
    } finally {
      f.cleanup();
    }
  },
);

test.each(['add', 'status'] as const)('native truth is guarded immediately before %s', async (kind) => {
  const f = await boardFixture(1);
  try {
    const row = f.rows.get('example/widget:17')!;
    if (kind === 'add') f.members.delete(row.node_id);
    else row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    let itemReads = 0;
    f.controls.beforeGraphql = (query) => {
      if (query.includes('ProjectDeliveryItems') && ++itemReads === 3) row.state = kind === 'add' ? 'closed' : 'open';
    };
    const result = await applyPlan(f, plan);
    assert.deepEqual(f.writes, []);
    assert.equal(result.operations[0]!.attempted, false);
    assert.equal(result.summary.drifted, 1);
  } finally {
    f.cleanup();
  }
});

test.each(['native-drift', 'cancel'] as const)(
  'post-write %s retains attempted evidence and stops the shared Project',
  async (failure) => {
    const f = await boardFixture(2);
    const controller = new AbortController();
    try {
      for (const row of f.rows.values()) row.state = 'closed';
      const plan = await collect(f.contexts, f.request, [f.root]);
      f.controls.afterWrite = (_kind, node) => {
        if (failure === 'cancel') controller.abort();
        else [...f.rows.values()].find((row) => row.node_id === node)!.state = 'open';
      };
      const result = await applyPlan(f, plan, undefined, controller.signal);
      assert.equal(f.writes.length, 1);
      assert.equal(result.operations[0]!.attempted, true);
      if (failure === 'cancel') assert.equal(result.scopeComplete, false);
      assert.equal(result.operations[0]!.outcome, failure === 'cancel' ? 'unknown' : 'drifted');
      assert.equal(result.operations[1]!.attempted, false);
    } finally {
      f.cleanup();
    }
  },
);

test('late prerequisite overflow preserves an earlier applied operation', async () => {
  const f = await boardFixture(2);
  try {
    for (const row of f.rows.values()) row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    let readsAfterWrite = 0,
      overflowRequests = 0;
    const original = f.contexts[0]!.clients.graphql;
    f.contexts[0]!.clients.graphql = (async (query: string, variables: Record<string, unknown>) => {
      if (f.writes.length && query.includes('ProjectDeliveryItems') && ++readsAfterWrite >= 2) {
        overflowRequests++;
        return {
          organization: {
            projectV2: {
              id: 'PROJECT-1',
              number: 1,
              items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `late-${String(overflowRequests)}` } },
            },
          },
        };
      }
      return original(query, variables);
    }) as unknown as typeof original;
    const result = await applyPlan(f, plan);
    assert.equal(result.scopeComplete, false);
    assert.equal(result.summary.applied, 1);
    assert.equal(result.summary.refused, 1);
    assert.equal(result.operations[0]!.outcome, 'applied');
    assert.equal(result.operations[1]!.attempted, false);
    assert.equal(result.gaps.at(-1)!.pagesRequested, 20);
    assert.equal(result.gaps.at(-1)!.collection, 'project-items');
    assert.equal(overflowRequests, 20);
    assert.equal(f.writes.length, 1);
  } finally {
    f.cleanup();
  }
});

test('an oversized readback cannot erase an attempted write', async () => {
  const f = await boardFixture(1);
  try {
    const row = f.rows.get('example/widget:17')!;
    row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    f.controls.afterWrite = () =>
      (f.controls.beforeGraphql = (query) => {
        if (query.includes('ProjectDeliveryItemReadback')) throw new Error('x'.repeat(17 * 1024 * 1024));
      });
    const result = await applyPlan(f, plan);
    assert.equal(result.operations[0]!.attempted, true);
    assert.equal(result.operations[0]!.outcome, 'unknown');
    assert.equal(result.operations[0]!.issueNodeId, row.node_id);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024 * 1024);
  } finally {
    f.cleanup();
  }
});

test('retained result capacity is reserved before a next mutation', async () => {
  const f = await boardFixture(1);
  try {
    const row = f.rows.get('example/widget:17')!;
    row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    const prior = board.incompleteBoardReconcile(
      { repositories: plan.scope, mode: 'apply', plan },
      { repository: plan.scope[0]!, stage: 'prior', reason: 'evidence-unavailable' },
    );
    const entry = { outcome: 'unknown' as const, attempted: true, before: null, readback: null };
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    const baseline = Buffer.byteLength(
      JSON.stringify({ repositories: plan.scope, mode: 'apply', plan, priorResult: prior }),
    );
    prior.operations[0]!.priorEvidence = Array.from(
      { length: Math.floor((16 * 1024 * 1024 - baseline - 512) / entryBytes) },
      () => entry,
    );
    const result = await applyPlan(f, plan, prior);
    assert.deepEqual(f.writes, []);
    assert.equal(result.summary.applied, 0);
    assert.ok(result.summary.refused > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024 * 1024);
  } finally {
    f.cleanup();
  }
});

test('an exact Status target appearing at the final boundary skips the mutation', async () => {
  const f = await boardFixture(1);
  try {
    const row = f.rows.get('example/widget:17')!;
    row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    let reads = 0;
    f.controls.beforeGraphql = (query) => {
      if (query.includes('ProjectDeliveryItems') && ++reads === 4) f.members.get(row.node_id)!.status = 'Done';
    };
    const result = await applyPlan(f, plan);
    assert.deepEqual(f.writes, []);
    assert.equal(result.summary.satisfied, 1);
    assert.equal(result.operations[0]!.attempted, false);
  } finally {
    f.cleanup();
  }
});

test('cancellation between add and update resumes the same frozen intent', async () => {
  const f = await boardFixture(1);
  const controller = new AbortController();
  try {
    const row = f.rows.get('example/widget:17')!;
    f.members.delete(row.node_id);
    f.blockers.set('example/widget:17', [
      { id: 'BLOCKER', number: 91, title: 'Open', state: 'OPEN', repository: { nameWithOwner: 'example/widget' } },
    ]);
    const plan = await collect(f.contexts, f.request, [f.root]);
    f.controls.afterWrite = () => controller.abort();
    const first = await applyPlan(f, plan, undefined, controller.signal);
    assert.equal(first.operations[0]!.outcome, 'unknown');
    assert.equal(first.operations[1]!.attempted, false);
    f.controls.afterWrite = undefined;
    f.writes.length = 0;
    const resumed = await applyPlan(f, plan, first);
    assert.deepEqual(
      f.writes.map((write) => write.kind),
      ['status'],
    );
    assert.equal(resumed.operations[0]!.outcome, 'satisfied');
    assert.equal(resumed.operations[1]!.outcome, 'applied');
    assert.equal(resumed.operations[0]!.priorEvidence.at(-1)!.outcome, 'unknown');
    assert.equal(f.statusFor(row.node_id), 'Blocked');
  } finally {
    f.cleanup();
  }
});

test.each([false, true])(
  'Project ambiguity stops dependents while independent groups finish (%s)',
  async (independent) => {
    const f = await boardFixture(
      1,
      independent ? ['example/widget', 'other/second'] : ['example/widget', 'example/second'],
      independent,
    );
    try {
      for (const row of f.rows.values()) row.state = 'closed';
      const plan = await collect(f.contexts, f.request, [f.root]);
      assert.equal(plan.scopeComplete, true);
      let first = true;
      const orderedFirst = plan.operations[0]!;
      f.controls.beforeGraphql = (query, variables) => {
        if (first && query.includes('ProjectDeliveryItems') && f.controls.itemPages >= 1) {
          // Wait until global preflight has collected every selected inventory.
          if (f.controls.issuePages >= plan.scope.length * 2) {
            first = false;
            const member = f.members.get(orderedFirst.issueNodeId)!;
            member.archived = true;
          }
        }
        void variables;
      };
      const result = await applyPlan(f, plan);
      assert.equal(result.operations[0]!.outcome, 'drifted');
      assert.equal(f.writes.length, independent ? 1 : 0);
      if (independent) assert.equal(result.operations[1]!.outcome, 'applied');
    } finally {
      f.cleanup();
    }
  },
);

test.each([401, 429])('global failure %s after an applied operation stops independent groups', async (status) => {
  const f = await boardFixture(1, ['example/widget', 'other/second'], true);
  try {
    for (const row of f.rows.values()) row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    let configurationReadsAfterWrite = 0;
    f.controls.beforeGraphql = (query) => {
      if (f.writes.length && query.includes('ProjectDeliveryConfiguration') && ++configurationReadsAfterWrite === 3)
        throw Object.assign(new Error('Provider unavailable'), { status });
    };
    const result = await applyPlan(f, plan);
    assert.equal(result.operations[0]!.outcome, 'applied');
    assert.equal(f.writes.length, 1);
    assert.equal(result.operations[1]!.attempted, false);
    assert.ok(result.gaps.some((value) => value.reason === (status === 401 ? 'authentication' : 'rate-limit')));
  } finally {
    f.cleanup();
  }
});

test('resumed and uninterrupted operations reach identical exact postimages', async () => {
  const f = await boardFixture(2);
  try {
    for (const row of f.rows.values()) row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    const uninterrupted = await applyPlan(f, plan);
    assert.equal(uninterrupted.summary.applied, 2);
    for (const member of f.members.values()) member.status = 'Todo';
    f.writes.length = 0;
    f.controls.failAfterStatus = true;
    const interrupted = await applyPlan(f, plan);
    assert.equal(interrupted.operations[0]!.outcome, 'unknown');
    assert.equal(interrupted.operations[1]!.attempted, false);
    f.controls.failAfterStatus = false;
    f.writes.length = 0;
    const resumed = await applyPlan(f, plan, interrupted);
    const postimages = (result: board.BoardReconcileResult) =>
      result.operations.map((operation) => ({
        operationId: operation.operationId,
        repository: operation.repository,
        issueNodeId: operation.issueNodeId,
        projectId: operation.projectId,
        target: operation.target,
        readback: operation.readback,
      }));
    assert.deepEqual(postimages(resumed), postimages(uninterrupted));
    assert.deepEqual(
      resumed.operations.map((operation) => operation.attempted),
      [false, true],
    );
    assert.equal(resumed.operations[0]!.priorEvidence.at(-1)!.outcome, 'unknown');
  } finally {
    f.cleanup();
  }
});

test('an interruption before add leaves a revalidated incomplete operation retryable', async () => {
  const f = await boardFixture(1);
  const controller = new AbortController();
  try {
    const row = f.rows.get('example/widget:17')!;
    f.members.delete(row.node_id);
    const plan = await collect(f.contexts, f.request, [f.root]);
    let reads = 0;
    f.controls.beforeGraphql = (query) => {
      if (query.includes('ProjectDeliveryItems') && ++reads === 3) controller.abort();
    };
    const interrupted = await applyPlan(f, plan, undefined, controller.signal);
    assert.equal(f.writes.length, 0);
    assert.equal(interrupted.operations[0]!.attempted, false);
    f.controls.beforeGraphql = undefined;
    const resumed = await applyPlan(f, plan, interrupted);
    assert.equal(resumed.summary.applied, 1);
    assert.deepEqual(
      f.writes.map((write) => write.kind),
      ['add'],
    );
  } finally {
    f.cleanup();
  }
});

test('actual MCP registrar and library share bounded explicit-scope reconciliation', async () => {
  const f = await boardFixture(1);
  const server = createAiDeliveryMcpServer({ repoRoot: f.root });
  const client = new Client({ name: 'board-reconcile-fixture', version: '1' });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  const clients = vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockResolvedValue(f.contexts[0]!.clients);
  const loads = vi.spyOn(issueModule, 'loadDeliveryContext');
  try {
    await server.connect(serverTransport);
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((value) => value.name === boardName);
    assert.ok(tool);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const input of [
      { repositories: [] },
      { repositories: Array.from({ length: 11 }, (_, n) => `example/r${String(n)}`) },
      { repositories: ['example/widget', 'EXAMPLE/Widget'] },
      { repositories: ['invalid'] },
      { repositories: ['example/widget'], mode: 'apply' },
      { repositories: ['example/widget'], mode: 'dry-run', extra: true },
      { repositories: ['example/widget'], repo: 'example/other' },
      {
        repositories: ['example/widget'],
        checkouts: [
          { repository: 'example/widget', issueNumber: 17, path: f.root },
          { repository: 'example/widget', issueNumber: 17, path: f.root },
        ],
      },
    ]) {
      const response = await client.callTool({ name: boardName, arguments: input });
      assert.equal(response.isError, true);
      assert.equal(clients.mock.calls.length, 0);
    }
    await assert.rejects(
      executeTool(boardName, { repositories: ['example/widget'] }, { repoRoot: f.root, repo: 'example/other' }),
    );
    assert.equal(clients.mock.calls.length, 0);
    const fromLibrary = board.BoardReconcilePlanSchema.parse(
      await executeTool(boardName, f.request, { repoRoot: f.root }),
    );
    const beforeInvalid = clients.mock.calls.length;
    for (const input of [
      { ...f.request, plan: fromLibrary },
      { ...f.request, priorResult: {} },
      { repositories: fromLibrary.scope, mode: 'apply', plan: fromLibrary, checkouts: [] },
    ])
      await assert.rejects(executeTool(boardName, input, { repoRoot: f.root }));
    assert.equal(clients.mock.calls.length, beforeInvalid);
    const response = await client.callTool({ name: boardName, arguments: f.request });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    const fromMcp = board.BoardReconcilePlanSchema.parse(JSON.parse((response.content as { text: string }[])[0]!.text));
    assert.equal(fromMcp.planId, fromLibrary.planId);
    assert.equal(fromMcp.scopeComplete, true);
    assert.ok(loads.mock.calls.length >= 2);
    assert.equal(
      loads.mock.calls.every(([input]) => input.readPageLimit === 20),
      true,
    );
    assert.deepEqual(f.writes, []);
  } finally {
    await client.close();
    await server.close();
    f.cleanup();
  }
});

test.each(['dry-run', 'apply'] as const)(
  'pre-context access failure preserves %s output without writes',
  async (mode) => {
    const f = await boardFixture(1);
    const server = createAiDeliveryMcpServer({ repoRoot: f.root });
    const client = new Client({ name: 'board-access-fixture', version: '1' });
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      f.rows.get('example/widget:17')!.state = 'closed';
      const plan = await collect(f.contexts, f.request, [f.root]);
      const request = mode === 'apply' ? { repositories: plan.scope, mode, plan } : f.request;
      f.controls.beforeGraphql = (query) => {
        if (query.includes('DeliveryRepository'))
          throw Object.assign(new Error('No repository read access'), { status: 403 });
      };
      vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockResolvedValue(f.contexts[0]!.clients);
      await server.connect(serverTransport);
      await client.connect(transport);
      const library: unknown = await executeTool(boardName, request, { repoRoot: f.root });
      const response = await client.callTool({ name: boardName, arguments: request });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      for (const value of [library, JSON.parse((response.content as { text: string }[])[0]!.text) as unknown]) {
        if (mode === 'apply') {
          const result = board.BoardReconcileResultSchema.parse(value);
          assert.equal(result.planId, plan.planId);
          assert.equal(result.scopeComplete, false);
          assert.equal(result.summary.applied, 0);
        } else assert.equal(board.BoardReconcilePlanSchema.parse(value).scopeComplete, false);
      }
      assert.deepEqual(f.writes, []);
    } finally {
      await client.close();
      await server.close();
      f.cleanup();
    }
  },
);

test('public dry-run permits a readable Project without write access', async () => {
  const f = await boardFixture(1);
  try {
    f.controls.writable = false;
    vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockResolvedValue(f.contexts[0]!.clients);
    const result = board.BoardReconcilePlanSchema.parse(await executeTool(boardName, f.request, { repoRoot: f.root }));
    assert.equal(result.scopeComplete, true);
    assert.deepEqual(f.writes, []);
  } finally {
    f.cleanup();
  }
});

test.each(['dry-run', 'apply', 'apply-empty'] as const)(
  'pre-context 21st routing page preserves %s mode through real library and MCP',
  async (variant) => {
    const f = await boardFixture(1);
    const server = createAiDeliveryMcpServer({ repoRoot: f.root });
    const client = new Client({ name: 'board-pre-context-fixture', version: '1' });
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      if (variant === 'apply') f.rows.get('example/widget:17')!.state = 'closed';
      const plan = await collect(f.contexts, f.request, [f.root]);
      const prior = board.incompleteBoardReconcile(
        { repositories: plan.scope, mode: 'apply', plan },
        { repository: plan.scope[0]!, stage: 'prior', reason: 'evidence-unavailable' },
      );
      if (prior.operations[0]) {
        const operation = prior.operations[0];
        operation.outcome = 'unknown';
        operation.attempted = true;
        operation.before = {
          itemId: operation.expected.itemId!,
          archived: false,
          status: { current: 'Todo', kind: 'verified', name: 'Queued', optionId: 'STATUS-0' },
        };
        operation.readback = structuredClone(operation.before);
      }
      const request =
        variant === 'dry-run' ? f.request : { repositories: plan.scope, mode: 'apply', plan, priorResult: prior };
      const original = f.contexts[0]!.clients.graphql;
      let requests = 0;
      const limited = (async (query: string, variables: Record<string, unknown>) => {
        const response: unknown = await original(query, variables);
        if (!query.includes('ProjectDeliveryConfiguration')) return response;
        requests++;
        const cloned = JSON.parse(JSON.stringify(response)) as {
          organization: { projectV2: { fields: { nodes: unknown[]; pageInfo: unknown } } };
        };
        if (variables.cursor != null) cloned.organization.projectV2.fields.nodes = [];
        cloned.organization.projectV2.fields.pageInfo = { hasNextPage: true, endCursor: `bounded-${String(requests)}` };
        return cloned;
      }) as unknown as typeof original;
      vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockResolvedValue({
        ...f.contexts[0]!.clients,
        graphql: limited,
      });
      await server.connect(serverTransport);
      await client.connect(transport);
      for (const surface of ['library', 'mcp']) {
        const before = requests;
        const value: unknown =
          surface === 'library'
            ? await executeTool(boardName, request, { repoRoot: f.root })
            : await (async () => {
                const response = await client.callTool({ name: boardName, arguments: request });
                assert.equal(response.isError, undefined, JSON.stringify(response));
                return JSON.parse((response.content as { text: string }[])[0]!.text) as unknown;
              })();
        assert.equal(requests - before, 20);
        if (variant === 'dry-run') {
          const result = board.BoardReconcilePlanSchema.parse(value);
          assert.equal(result.scopeComplete, false);
          assert.equal(result.gaps[0]!.pagesRequested, 20);
        } else {
          const result = board.BoardReconcileResultSchema.parse(value);
          assert.equal(result.scopeComplete, false);
          assert.equal(result.planId, plan.planId);
          assert.deepEqual(
            result.operations.map((operation) => operation.operationId),
            plan.operations.map((operation) => operation.operationId),
          );
          assert.equal(result.summary.applied, 0);
          assert.equal(result.summary.satisfied, 0);
          if (result.operations[0]) {
            assert.deepEqual(result.operations[0].priorEvidence.at(-1), {
              outcome: 'unknown',
              attempted: true,
              before: prior.operations[0]!.before,
              readback: prior.operations[0]!.readback,
            });
            assert.ok(result.operations[0].knownItemIds.includes(prior.operations[0]!.expected.itemId!));
          }
        }
        assert.deepEqual(f.writes, []);
      }
    } finally {
      await client.close();
      await server.close();
      f.cleanup();
    }
  },
);

test('apply development-token override is rejected before clients while configured personal author remains valid', async () => {
  const f = await boardFixture(1);
  try {
    f.rows.get('example/widget:17')!.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    const clients = vi.spyOn(githubClients, 'createDeliveryGitHubClients').mockResolvedValue(f.contexts[0]!.clients);
    await assert.rejects(
      executeTool(
        boardName,
        { repositories: plan.scope, mode: 'apply', plan },
        { repoRoot: f.root, identity: 'personal', personalAuth: true },
      ),
      /override/u,
    );
    assert.equal(clients.mock.calls.length, 0);
    const settingsPath = join(f.root, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { roles: { author: unknown } };
    settings.roles.author = {
      authSource: 'personal',
      identity: 'host-author',
      credentialEnv: { token: 'SYNTHETIC_TOKEN' },
    };
    writeFileSync(settingsPath, JSON.stringify(settings));
    f.contexts[0]!.clients.authSource = 'personal';
    f.contexts[0]!.clients.authenticatedAuthor = async () => ({
      actorLogin: 'host-author',
      credentialIdentity: 'user:1',
    });
    const personal = board.BoardReconcilePlanSchema.parse(
      await executeTool(boardName, f.request, { repoRoot: f.root }),
    );
    const result = board.BoardReconcileResultSchema.parse(
      await executeTool(
        boardName,
        { repositories: personal.scope, mode: 'apply', plan: personal },
        { repoRoot: f.root },
      ),
    );
    assert.equal(result.summary.applied, 1);
  } finally {
    f.cleanup();
  }
});

test('opaque actor revalidation failure stops every remaining independent Project group', async () => {
  const f = await boardFixture(1, ['example/widget', 'other/second', 'third/last'], true);
  try {
    for (const row of f.rows.values()) row.state = 'closed';
    const plan = await collect(f.contexts, f.request, [f.root]);
    const actor = f.contexts[1]!.clients.authenticatedAuthor!;
    f.contexts[1]!.clients.authenticatedAuthor = async (signal) => {
      if (f.writes.length > 0)
        throw new (await import('./errors.js')).DeliveryError('Personal author identity readback failed.');
      return actor(signal);
    };
    const result = await applyPlan(f, plan);
    assert.equal(result.operations[0]!.outcome, 'applied');
    assert.equal(result.operations[1]!.outcome, 'refused');
    assert.equal(result.operations[2]!.attempted, false);
    assert.equal(f.writes.length, 1);
    assert.equal(result.scopeComplete, false);
  } finally {
    f.cleanup();
  }
});

test.each(['closure', 'points', 'status'] as const)(
  '%s observed by the final readiness reread refuses activation before mutation',
  async (change) => {
    const f = await boardFixture(1);
    try {
      const row = f.rows.get('example/widget:17')!;
      const request = { ...f.request, checkouts: [f.checkout('example/widget', 17)] };
      const plan = await collect(f.contexts, request, [f.root]);
      assert.equal(plan.operations[0]!.target, 'In Progress');
      const original = f.contexts[0]!.clients.rest.issues.get;
      let reads = 0;
      f.contexts[0]!.clients.rest.issues.get = (async (input) => {
        if (++reads === 6) {
          // global pair, outer guard pair, then final boundary pair
          if (change === 'closure') row.state = 'closed';
          if (change === 'points') row.points = 4;
          if (change === 'status') f.members.get(row.node_id)!.status = 'Blocked';
        }
        return original(input);
      }) as typeof original;
      const result = await applyPlan(f, plan);
      assert.equal(reads >= 6, true);
      assert.equal(f.writes.length, 0);
      assert.equal(result.operations[0]!.attempted, false);
      assert.ok(result.summary.refused + result.summary.drifted > 0);
    } finally {
      f.cleanup();
    }
  },
);

test('verified Status postimage refreshes current duplicate-label migration advice', async () => {
  const f = await boardFixture(1);
  try {
    const row = f.rows.get('example/widget:17')!;
    row.state = 'closed';
    row.labels = [{ name: 'status:Todo' }];
    const plan = await collect(f.contexts, f.request, [f.root]);
    assert.equal(plan.issues[0]!.metadata.find((value) => value.label === 'status:Todo')!.mapping, 'exact');
    const result = await applyPlan(f, plan);
    assert.equal(result.summary.applied, 1);
    assert.equal(result.issues[0]!.status.current, 'Done');
    const duplicate = result.issues[0]!.metadata.find((value) => value.label === 'status:Todo')!;
    assert.equal(duplicate.authoritativeValue, 'Shipped');
    assert.equal(duplicate.mapping, 'conflicting');
    assert.deepEqual(row.labels, [{ name: 'status:Todo' }]);
  } finally {
    f.cleanup();
  }
});

test.each(['active', 'parked', 'deferred'] as const)(
  '%s Status apply and lost-response recovery retain the exact original intent',
  async (mode) => {
    const f = await boardFixture(1);
    try {
      const row = f.rows.get('example/widget:17')!;
      const checkouts = mode === 'active' ? [f.checkout('example/widget', 17)] : [];
      if (mode !== 'active') {
        f.members.get(row.node_id)!.status = 'In Progress';
        const fields = parseIssueBody(row.body, { title: row.title }).issue;
        row.body = renderIssueBody({
          ...fields,
          ...(mode === 'parked' ? { draft: true } : { deferral: { trigger: 'Await the synthetic fixture signal.' } }),
        });
      }
      const plan = await collect(f.contexts, { ...f.request, checkouts }, [f.root]);
      const target = mode === 'active' ? 'In Progress' : 'Todo';
      assert.equal(plan.operations[0]!.target, target);
      f.controls.failAfterStatus = true;
      const interrupted = await applyPlan(f, plan);
      assert.equal(interrupted.summary.unknown, 1);
      assert.equal(f.statusFor(row.node_id), target);
      f.controls.failAfterStatus = false;
      f.writes.length = 0;
      const resumed = await applyPlan(f, plan, interrupted);
      assert.equal(resumed.summary.satisfied, 1);
      assert.equal(resumed.summary.applied, 0);
      assert.equal(f.writes.length, 0);
      assert.equal(resumed.operations[0]!.priorEvidence.at(-1)!.outcome, 'unknown');
      f.members.get(row.node_id)!.status = mode === 'active' ? 'Todo' : 'In Progress';
      const applied = await applyPlan(f, plan);
      assert.equal(applied.summary.applied, 1);
      assert.equal(applied.operations[0]!.readback!.status.current, target);
    } finally {
      f.cleanup();
    }
  },
);

test.each(['archived', 'missing', 'unwritable'] as const)(
  'later readiness cannot hide %s membership behind initially unset Status',
  async (change) => {
    const f = await boardFixture(1);
    try {
      const row = f.rows.get('example/widget:17')!;
      f.members.get(row.node_id)!.status = null;
      const plan = await collect(f.contexts, { ...f.request, checkouts: [f.checkout('example/widget', 17)] }, [f.root]);
      assert.equal(plan.operations[0]!.target, 'In Progress');
      const original = f.contexts[0]!.clients.rest.issues.get;
      let reads = 0;
      f.contexts[0]!.clients.rest.issues.get = (async (input) => {
        if (++reads === 6) {
          if (change === 'archived') f.members.get(row.node_id)!.archived = true;
          if (change === 'missing') f.members.delete(row.node_id);
          if (change === 'unwritable') f.controls.writable = false;
        }
        return original(input);
      }) as typeof original;
      const result = await applyPlan(f, plan);
      assert.equal(reads >= 6, true);
      assert.equal(result.operations[0]!.attempted, false);
      assert.equal(f.writes.length, 0);
      assert.ok(result.summary.refused + result.summary.drifted > 0);
    } finally {
      f.cleanup();
    }
  },
);

test('a compatible active postimage observed during readiness is satisfied without a repeated update', async () => {
  const f = await boardFixture(1);
  try {
    const row = f.rows.get('example/widget:17')!;
    const plan = await collect(f.contexts, { ...f.request, checkouts: [f.checkout('example/widget', 17)] }, [f.root]);
    const original = f.contexts[0]!.clients.rest.issues.get;
    let reads = 0;
    f.contexts[0]!.clients.rest.issues.get = (async (input) => {
      if (++reads === 6) f.members.get(row.node_id)!.status = 'In Progress';
      return original(input);
    }) as typeof original;
    const result = await applyPlan(f, plan);
    assert.equal(result.summary.satisfied, 1);
    assert.equal(result.operations[0]!.attempted, false);
    assert.equal(f.writes.length, 0);
  } finally {
    f.cleanup();
  }
});
