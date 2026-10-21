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
import { IssueFields, renderIssueBody } from './issueContract.js';
import type { DeliveryContext } from './issue.js';
import type { ProjectDeliveryStatus } from './github/projectDelivery.js';
import { gitEnvironment } from './gitProcess.js';
import * as board from './services/boardReconcileService.js';
import * as version from './version.js';

afterEach(() => vi.unstubAllEnvs());

type Checkout = { repository: string; issueNumber: number; path: string };
type DryRequest = { repositories: string[]; mode: 'dry-run'; checkouts?: Checkout[] };
const collect = async (contexts: DeliveryContext[], request: DryRequest, roots: string[]) => {
  return board.collectBoardReconcilePlan(contexts, request, { checkoutRoots: roots });
};

async function boardFixture(count = 101, repositories = ['example/widget']) {
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
    const configured = { ...syntheticDiscoveryConfig, repository };
    const discovery = syntheticDiscoveryClients(configured);
    const own = (number: number) => {
      const row = rows.get(`${repository}:${String(number)}`);
      assert.ok(row);
      return row;
    };
    const item = (node: string, member: NonNullable<ReturnType<typeof members.get>>) => ({
      id: member.itemId,
      isArchived: member.archived,
      project: { id: 'PROJECT-1', number: 1 },
      content: controls.hiddenContent
        ? null
        : { __typename: 'Issue', id: node, number: member.number, repository: { nameWithOwner: member.repository } },
      fieldValueByName: member.status === null ? null : { name: names[member.status], optionId: option[member.status] },
    });
    const graphql = (async (query: string, variables: Record<string, unknown> = {}) => {
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
          return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
        }
        throw new Error('Unexpected mutation');
      }
      if (query.includes('ProjectDeliveryItems')) {
        controls.itemPages++;
        const offset = typeof variables.cursor === 'string' ? Number(variables.cursor.slice(1)) : 0;
        const all = [...members.entries()];
        const slice = all.slice(offset, offset + 100);
        return {
          organization: {
            projectV2: {
              id: 'PROJECT-1',
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
            owner: { __typename: 'Organization', login: 'example' },
          },
        };
      if (query.includes('ProjectDeliveryConfiguration')) {
        const data = response as { organization: { projectV2: Record<string, unknown> } };
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
      authenticatedAuthor: async () => ({ actorLogin: 'operator', credentialIdentity: 'user:1' }),
    } as DeliveryContext['clients'];
    const loaded = await loadDeliveryConfig('', { clients, repository, readPageLimit: 20 });
    contexts.push({
      clients,
      config: loaded.config,
      configuration: loaded,
      repo: { owner: 'example', repo: repository.split('/')[1]! },
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

test('copied executing artifact changes identity with same-version bytes and refuses links', () => {
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
});

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
