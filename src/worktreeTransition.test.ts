import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';

import { digestBytes, digestValue, stableJson } from './delivery/common.js';
import {
  classifyRepositoryExactRange,
  createRepositoryStageInput,
  createRepositoryStageReceipt,
  createRepositoryStageAggregate,
  writeRepositoryStageCheckpoint,
  type RepositoryDeliveryPolicy,
} from './delivery/index.js';
import { buildRuntimeAdmission } from './services/deliveryAdmission.js';
import type { LoadedDeliveryConfig } from './config/deliveryConfig.js';
import { gitCommonDir } from './git.js';
import {
  addWorktreeEntry,
  assertNativeIssueTrackingAdmission,
  getIssueWorktreeStrict,
  listWorktreesStrict,
  withWorktreeTransitionRegistry,
  type WorktreeEntry,
} from './services/worktreeRegistry.js';
import { prepareIssueWorktree } from './worktree.js';
import { withWorktreeTransitionWriterLease } from './verification.js';
import {
  applyWorktreeTransition,
  assertWorktreeTransitionNativeAuthority,
  inspectWorktreeTransition,
  inventoryTransitionEvidence,
  preserveTransitionEvidence,
  worktreeAcceptanceBody,
  worktreeRelinquishmentBody,
  type WorktreeTransitionPlan,
} from './worktreeTransition.js';
import {
  assertWorktreeTransitionWriterQuiescent,
  loadVerifiedRun,
  retainedWorktreeTransitionProducerDigest,
} from './verification.js';
import type { DeliveryContext } from './issue.js';

const nativeAuthority = vi.hoisted(() => ({
  reviewer: 'configured-reviewer[bot]',
  comments: new Map<number, Record<string, unknown>>(),
  revoked: [] as Record<string, unknown>[],
}));
vi.mock('./github/client.js', async (original) => ({
  ...(await original<typeof import('./github/client.js')>()),
  createDeliveryGitHubClients: async () => ({
    authSource: 'app',
    role: 'reviewer',
    appActorLogin: async () => nativeAuthority.reviewer,
    rest: {
      issues: {
        getComment: async ({ comment_id }: { comment_id: number }) => ({
          data: nativeAuthority.comments.get(comment_id),
        }),
      },
    },
  }),
}));

function authorityFixture(root: string) {
  nativeAuthority.comments.clear();
  nativeAuthority.revoked = [];
  nativeAuthority.reviewer = 'configured-reviewer[bot]';
  // Authority-unit tests deliberately isolate native identity/body validation from installed producer and Git proof.
  const digest = digestValue('synthetic immutable bytes');
  const runtimeContent = {
    schemaVersion: 'ai-delivery.runtime-admission@2',
    capability: { cli: 2, mcp: 2 },
    repository: 'example/widget',
    cliPath: join(root, 'synthetic-runtime/dist/cli.js'),
    cliSha256: digest,
    configDigest: digest,
    mcpLauncherPath: join(root, 'synthetic-runtime/plugins/ai-delivery/dist/mcp-launcher.js'),
    mcpLauncherSha256: digest,
    pluginManifestPath: join(root, 'synthetic-runtime/plugins/ai-delivery/.claude-plugin/plugin.json'),
    pluginManifestSha256: digest,
    packageDistSha256: digest,
    packageManifestSha256: digest,
    packageVersion: '0.3.5',
    sourceArchiveSha256: digest,
    sourceCommit: 'a'.repeat(40),
  };
  const admission = { ...runtimeContent, admissionId: digestValue(runtimeContent) };
  const content = {
    schemaVersion: 'ai-delivery.worktree-transition-plan@1',
    repository: 'example/widget',
    repoRoot: root,
    row: entry(root),
    purpose: 'active-resume',
    disposition: 'retain',
    terminalPrNumber: null,
    head: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) },
    lineage: [],
    remoteRefs: null,
    retainedHoldCommentIds: [],
    holdEvidence: [],
    inventory: [],
    inventoryId: digestValue([]),
    historicalProducer: 'UNKNOWN',
    closure: {
      family: 'public-ai-delivery-0.3.5-posix@1',
      admissionPath: join(root, 'synthetic-admission.json'),
      archivePath: join(root, 'synthetic-archive.tar.gz'),
      admission,
      admissionBytesDigest: digest,
      producerDigest: digest,
      runManifestIds: [digest],
    },
    currentRuntime: admission,
    policyDigest: digest,
    operator: { actorLogin: 'configured-host', credentialIdentity: 'user:37' },
    reviewerActor: nativeAuthority.reviewer,
  };
  const plan = { ...content, planId: digestValue(content) } as unknown as WorktreeTransitionPlan;
  const context = {
    root,
    repo: { owner: 'example', repo: 'widget' },
    config: { roles: { reviewer: { identity: 'configured-reviewer' } } },
    clients: {
      authSource: 'personal',
      role: 'author',
      authenticatedAuthor: async () => plan.operator,
      rest: {
        issues: {
          getComment: async ({ comment_id }: { comment_id: number }) => ({
            data: nativeAuthority.comments.get(comment_id),
          }),
          listComments: async () => ({ data: nativeAuthority.revoked }),
        },
      },
    },
  } as unknown as DeliveryContext;
  const issue_url = 'https://api.github.com/repos/example/widget/issues/17';
  nativeAuthority.comments.set(101, {
    id: 101,
    issue_url,
    user: { id: 37, login: 'configured-host', type: 'User' },
    body: worktreeRelinquishmentBody(plan),
  });
  nativeAuthority.comments.set(102, {
    id: 102,
    issue_url,
    user: { id: 38, login: nativeAuthority.reviewer, type: 'Bot' },
    body: worktreeAcceptanceBody(plan, 101),
  });
  return { plan, context, ids: { relinquishmentCommentId: 101, acceptanceCommentId: 102 } };
}

function approvedFixturePlan(f: Awaited<ReturnType<typeof transitionFixture>>, plan: WorktreeTransitionPlan) {
  const planPath = join(f.root, 'approved-plan.json');
  writeFileSync(planPath, stableJson(plan));
  nativeAuthority.comments.get(101)!.body = worktreeRelinquishmentBody(plan);
  nativeAuthority.comments.get(102)!.body = worktreeAcceptanceBody(plan, 101);
  return {
    authority: 'worktree:transition' as const,
    planPath,
    expectedPlanId: plan.planId,
    relinquishmentCommentId: 101,
    acceptanceCommentId: 102,
    runtimeEntryPath: f.runtimeEntryPath,
  };
}

function interruptedApply(
  f: Awaited<ReturnType<typeof transitionFixture>>,
  plan: WorktreeTransitionPlan,
  event: string,
) {
  const input = approvedFixturePlan(f, plan);
  const commonUrl = new URL('./delivery/common.js', import.meta.url).href;
  const clientUrl = new URL('./github/client.js', import.meta.url).href;
  const inputPath = join(f.root, 'child-transition-input.json');
  writeFileSync(
    inputPath,
    stableJson({
      input,
      event,
      plan,
      context: { root: f.root, repo: f.context.repo, config: f.context.config, configuration: f.context.configuration },
      comments: [...nativeAuthority.comments],
      nativePr: f.nativePr,
    }),
  );
  // Only GitHub HTTP/auth is substituted. Files, admission, producer hashing, Git and process identities stay real.
  const script = `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    const f=JSON.parse(readFileSync(process.argv[1],'utf8'));
    const comments=new Map(f.comments);
    const issues={getComment:async({comment_id})=>({data:comments.get(comment_id)}),listComments:async()=>({data:[]}),get:async()=>({data:{state:f.plan.purpose==='merged-cleanup'?'closed':'open'}})};
    globalThis.__transitionReviewer={authSource:'app',role:'reviewer',appActorLogin:async()=>f.plan.reviewerActor,rest:{issues}};
    registerHooks({load(url,context,next){
      if(url===${JSON.stringify(clientUrl)})return {format:'module',shortCircuit:true,source:
        'export * from '+JSON.stringify(url+'?original')+'; export async function createDeliveryGitHubClients(){return globalThis.__transitionReviewer;}'};
      if(url===${JSON.stringify(commonUrl)})return {format:'module',shortCircuit:true,source:
        'export * from '+JSON.stringify(url+'?original')+'; import {writeCreateOnly as original} from '+JSON.stringify(url+'?original')+'; export function writeCreateOnly(path,bytes,digest){const value=original(path,bytes,digest);if(globalThis.__transitionCrash(path))process.exit(73);return value;}'};
      return next(url,context);
    }});
    globalThis.__transitionCrash=(path)=> f.event==='intent' ? path.endsWith('.transition.json') : f.event==='completion' ? path.endsWith('/completion.json') : path.endsWith('.'+f.event+'.json');
    const {applyWorktreeTransition}=await import(${JSON.stringify(new URL('./worktreeTransition.js', import.meta.url).href)});
    const context={...f.context,clients:{authSource:'personal',role:'author',authenticatedAuthor:async()=>f.plan.operator,
      graphql:async()=>({repository:{pullRequest:{closingIssuesReferences:{nodes:[{number:17,repository:{nameWithOwner:'example/widget'}}],pageInfo:{hasNextPage:false}}}}}),
      rest:{issues,pulls:{get:async()=>({data:f.nativePr})},repos:{getBranch:async({branch})=>({data:{name:branch,commit:{sha:f.plan.remoteRefs?.baseSha??f.plan.head.sha}}})}}}};
    await applyWorktreeTransition(context,f.input);
    process.exit(9);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, inputPath], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 73, child.stderr);
  // The child is confirmed exited. Advance only its synthetic fixture lock mtimes to exercise stale-lock recovery promptly.
  const common = gitCommonDir(f.root);
  for (const lock of [
    join(f.root, '.issue-cli/worktrees.json.lock'),
    join(common, 'ai-delivery/writers@1', `${digestValue(f.row.path).slice(7)}.json.lock`),
  ])
    if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
  return input;
}

test(
  'real process interruption resumes original capture, claim, witness, row and release without losing originals',
  { timeout: 0 },
  async () => {
    for (const event of ['intent', 'authority', 'claim', 'claimed', 'owner', 'row', 'release', 'released']) {
      const f = await transitionFixture();
      try {
        const original = previousWriter(f.root);
        const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
        assert.equal(inspected.ready, true, inspected.blockers.join('; '));
        const plan = inspected.plan!;
        const input = interruptedApply(f, plan, event);
        assert.throws(() => getIssueWorktreeStrict(17, f.root), /transition.*incomplete/iu);
        const completed = await applyWorktreeTransition(f.context, input);
        assert.equal(completed.result, 'active-resumed', event);
        assert.equal(getIssueWorktreeStrict(17, f.root).identity, f.row.identity);
        const evidence = join(dirname(completed.receiptPath), 'bytes', `${digestBytes(original.bytes).slice(7)}.bin`);
        assert.deepEqual(readFileSync(evidence), original.bytes, event);
        assert.equal(existsSync(original.path), false, event);
      } finally {
        rmSync(f.root, { force: true, recursive: true });
      }
    }
  },
);

test(
  'terminal interruption resumes removal intent, physical absence and row removal without recreating source',
  { timeout: 0 },
  async () => {
    for (const event of ['removal-intent', 'removed', 'released', 'completion']) {
      const f = await transitionFixture({ purpose: 'merged-cleanup', disposition: 'remove' });
      try {
        const local = join(f.row.path, '.issue-cli', 'receipts');
        mkdirSync(local, { recursive: true });
        const original = Buffer.from('synthetic original terminal accounting and failed diagnostic\n');
        writeFileSync(join(local, 'original.json'), original);
        const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
        assert.equal(inspected.ready, true, inspected.blockers.join('; '));
        const plan = inspected.plan!;
        const input = interruptedApply(f, plan, event);
        const applied = await applyWorktreeTransition(f.context, input);
        assert.equal(applied.result, 'removed', event);
        assert.equal(existsSync(f.row.path), false, event);
        assert.deepEqual(listWorktreesStrict(f.root), [], event);
        assert.deepEqual(
          readFileSync(join(dirname(applied.receiptPath), 'bytes', `${digestBytes(original).slice(7)}.bin`)),
          original,
          event,
        );
        assert.throws(() => assertNativeIssueTrackingAdmission(17, f.root), /terminal/iu);
      } finally {
        rmSync(f.root, { force: true, recursive: true });
      }
    }
  },
);

test(
  'an earlier released attempt cannot authorize absence after a later acknowledged claim',
  { timeout: 0 },
  async () => {
    const f = await transitionFixture();
    try {
      const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
      assert.equal(inspected.ready, true, inspected.blockers.join('; '));
      const plan = inspected.plan!;
      interruptedApply(f, plan, 'released');
      const input = interruptedApply(f, plan, 'claimed');
      const writerPath = join(
        gitCommonDir(f.root),
        'ai-delivery/writers@1',
        `${digestValue(f.row.path).slice(7)}.json`,
      );
      assert.equal(existsSync(writerPath), true);
      const originalClaim = readFileSync(writerPath);
      unlinkSync(writerPath);
      await assert.rejects(applyWorktreeTransition(f.context, input), /latest exact.*lineage/iu);
      // Restore only the exact recorded claim, then resume successfully; no fabricated witness is accepted.
      writeFileSync(writerPath, originalClaim, { mode: 0o600 });
      assert.equal((await applyWorktreeTransition(f.context, input)).result, 'active-resumed');
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  },
);

test('transition authority requires exact native personal and configured App identities and whole bodies', async () => {
  const root = repository();
  try {
    for (const change of [
      'operator-id',
      'operator-body',
      'reviewer-actor',
      'acceptance-body',
      'subject',
      'comment-id',
    ]) {
      const { plan, context, ids } = authorityFixture(root);
      const operator = nativeAuthority.comments.get(101)!;
      const reviewer = nativeAuthority.comments.get(102)!;
      if (change === 'operator-id') operator.user = { id: 99, login: 'configured-host', type: 'User' };
      if (change === 'operator-body') operator.body = `${String(operator.body)}\n`;
      if (change === 'reviewer-actor') reviewer.user = { id: 39, login: 'caller-selected-reviewer[bot]', type: 'Bot' };
      if (change === 'acceptance-body') reviewer.body = worktreeAcceptanceBody(plan, 999);
      if (change === 'subject') reviewer.issue_url = 'https://api.github.com/repos/example/widget/issues/99';
      if (change === 'comment-id') reviewer.id = 999;
      await assert.rejects(
        assertWorktreeTransitionNativeAuthority(context, plan, ids),
        /Native .* (?:missing|changed)/u,
      );
    }
    const { plan, context, ids } = authorityFixture(root);
    await assertWorktreeTransitionNativeAuthority(context, plan, ids);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('only authenticated exact relinquishment revocations invalidate native acceptance', async () => {
  const root = repository();
  try {
    const { plan, context, ids } = authorityFixture(root);
    const body = JSON.stringify({
      schemaVersion: 'ai-delivery.worktree-relinquishment-revocation@1',
      planId: plan.planId,
      relinquishmentCommentId: 101,
    });
    const stableBody = Object.fromEntries(
      Object.entries(JSON.parse(body) as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
    nativeAuthority.revoked = [{ body: JSON.stringify(stableBody), user: { id: 99, login: 'forged-host' } }];
    await assertWorktreeTransitionNativeAuthority(context, plan, ids);
    nativeAuthority.revoked[0]!.user = { id: 37, login: 'configured-host' };
    await assert.rejects(assertWorktreeTransitionNativeAuthority(context, plan, ids), /revoked/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-transition-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Synthetic Operator');
  git('config', 'user.email', 'operator@example.test');
  writeFileSync(join(root, 'source.txt'), 'synthetic source\n');
  git('add', 'source.txt');
  git('commit', '-m', 'synthetic source');
  writeFileSync(join(root, '.git', 'info', 'exclude'), '.issue-cli/\n');
  git('worktree', 'add', '-b', 'issue/17', join(root, '.worktrees', 'issue-17'));
  return root;
}

async function transitionFixture(
  options: { purpose?: 'active-resume' | 'merged-cleanup'; disposition?: 'retain' | 'remove'; held?: boolean } = {},
) {
  const root = repository();
  const row = entry(root);
  const { context } = authorityFixture(root);
  const configuration = {
    config: { ...context.config, repository: 'example/widget' },
    configDigest: digestValue('synthetic current configuration'),
    policyModulePath: join(root, 'source.txt'),
    remote: 'origin',
  } as unknown as LoadedDeliveryConfig;
  context.config = configuration.config;
  context.configuration = configuration;
  context.clients.rest.issues.get = (async () => ({
    data: { state: 'open' },
  })) as typeof context.clients.rest.issues.get;
  mkdirSync(join(root, '.issue-cli'), { recursive: true });
  writeFileSync(join(root, '.issue-cli', 'worktrees.json'), JSON.stringify({ worktrees: [row] }), { mode: 0o600 });
  const oldDirectory = join(root, '.retained-producer');
  mkdirSync(oldDirectory);
  // Official npm 0.3.5 distribution, fixed SHA-256; only unpack/read its bytes. Never execute retained code.
  const archivePath = fileURLToPath(new URL('../src/fixtures/public-ai-delivery-0.3.5.tar.gz', import.meta.url));
  execFileSync('tar', ['-xzf', archivePath, '-C', oldDirectory]);
  const packageRoot = join(oldDirectory, 'package');
  const thisPackage = dirname(dirname(fileURLToPath(import.meta.url)));
  symlinkSync(join(thisPackage, 'node_modules'), join(root, 'node_modules'));
  const admission = buildRuntimeAdmission({
    cliPath: join(packageRoot, 'dist', 'cli.js'),
    mcpLauncherPath: join(packageRoot, 'plugins/ai-delivery/dist/mcp-launcher.js'),
    pluginManifestPath: join(packageRoot, 'plugins/ai-delivery/.claude-plugin/plugin.json'),
    packageVersion: '0.3.5',
    sourceArchiveSha256: digestBytes(readFileSync(archivePath)),
    sourceCommit: 'a'.repeat(40),
    configuration,
  });
  const admissionPath = join(root, '.retained-admission.json');
  writeFileSync(admissionPath, JSON.stringify(admission), { mode: 0o600 });
  const runtimeEntryPath = join(thisPackage, 'dist', 'cli.js');
  const currentRuntime = buildRuntimeAdmission({
    cliPath: runtimeEntryPath,
    mcpLauncherPath: join(thisPackage, 'plugins/ai-delivery/dist/mcp-launcher.js'),
    pluginManifestPath: join(thisPackage, 'plugins/ai-delivery/.claude-plugin/plugin.json'),
    packageVersion: (JSON.parse(readFileSync(join(thisPackage, 'package.json'), 'utf8')) as { version: string })
      .version,
    sourceArchiveSha256: digestValue('synthetic reviewed current archive'),
    sourceCommit: 'b'.repeat(40),
    configuration,
  });
  const common = gitCommonDir(root);
  mkdirSync(join(common, 'ai-delivery'), { recursive: true, mode: 0o700 });
  writeFileSync(join(common, 'ai-delivery', 'runtime-admission.json'), JSON.stringify(currentRuntime), { mode: 0o600 });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: row.path, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: row.path, encoding: 'utf8' }).trim();
  const sourceDigest = digestBytes(readFileSync(join(row.path, 'source.txt')));
  const policy = {
    schemaVersion: 'RepositoryDeliveryPolicy@1',
    classifyExactRange: () => {
      const content = {
        schemaVersion: 'ai-delivery.policy-evidence@1',
        repository: 'example/widget',
        base: { sha, tree },
        head: { sha, tree },
        configDigest: configuration.configDigest,
        policyDigest: sourceDigest,
        producer: 'synthetic-history-policy',
        opaquePayload: 'synthetic history',
        artifacts: [{ digest: sourceDigest, path: 'source.txt', producer: 'synthetic-history-policy' }],
      };
      return {
        policyDigest: sourceDigest,
        policyEvidence: { ...content, evidenceId: digestValue(content) },
        risk: 'standard',
        requiredStages: [
          {
            id: 'source',
            resourceClass: 'source_only',
            commands: [],
            attestationKey: 'source.txt',
            dependsOn: [],
            semanticInputKeys: ['source'],
          },
        ],
      };
    },
  } as unknown as RepositoryDeliveryPolicy;
  const classification = classifyRepositoryExactRange({
    repoRoot: row.path,
    repository: 'example/widget',
    base: { sha, tree },
    head: { sha, tree },
    changedPaths: [],
    configDigest: configuration.configDigest,
    policySourcePath: 'source.txt',
    policy,
  });
  const producerDigest = retainedWorktreeTransitionProducerDigest(join(packageRoot, 'dist'));
  const stageInput = createRepositoryStageInput({
    classification,
    stageId: 'source',
    semanticInputs: [{ key: 'source', digest: sourceDigest }],
    upstream: [],
    environmentDigest: digestValue({
      arch: process.arch,
      node: process.version,
      path: process.env.PATH ?? '',
      platform: process.platform,
      worktreeDigest: digestValue(row.path),
      producerDigest,
    }),
  });
  const receipt = createRepositoryStageReceipt({
    classification,
    stageInput,
    commands: [],
    artifacts: [{ digest: sourceDigest, path: 'source.txt' }],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
  });
  writeRepositoryStageCheckpoint({ gitCommonDir: common, repoRoot: row.path, receipt });
  const runContent = {
    schemaVersion: 'ai-delivery.run@3',
    completedAt: '2026-01-01T00:00:00.000Z',
    classification,
    aggregate: createRepositoryStageAggregate({ classification, receipts: [receipt] }),
    stageReceipts: [receipt],
    writer: { worktreeDigest: digestValue(row.path), producerDigest },
  };
  const runs = join(common, 'ai-delivery', 'runs@2', digestValue(row.path).slice(7));
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  writeFileSync(join(runs, `${sha}.json`), JSON.stringify({ ...runContent, manifestId: digestValue(runContent) }), {
    mode: 0o600,
  });
  const nativePr = {
    number: 23,
    head: { sha, ref: row.branch, repo: { full_name: 'example/widget' } },
    base: { sha, ref: 'main', repo: { full_name: 'example/widget' } },
    merge_commit_sha: sha,
    merged: true,
    user: { login: 'synthetic-original-author' },
  };
  if (options.purpose === 'merged-cleanup') {
    row.status = 'pr-published';
    row.prNumber = 23;
    writeFileSync(join(root, '.issue-cli/worktrees.json'), JSON.stringify({ worktrees: [row] }), { mode: 0o600 });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/widget.git'], { cwd: root });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', sha], { cwd: root });
    context.clients.rest.issues.get = (async () => ({
      data: { state: 'closed' },
    })) as typeof context.clients.rest.issues.get;
    context.clients.rest.pulls = {
      get: async () => ({ data: nativePr }),
    } as unknown as typeof context.clients.rest.pulls;
    context.clients.rest.repos = {
      getBranch: async ({ branch }: { branch: string }) => ({ data: { name: branch, commit: { sha } } }),
    } as unknown as typeof context.clients.rest.repos;
    context.clients.graphql = (async () => ({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [{ number: 17, repository: { nameWithOwner: 'example/widget' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    })) as unknown as typeof context.clients.graphql;
    for (const id of [101, 102])
      nativeAuthority.comments.get(id)!.issue_url = 'https://api.github.com/repos/example/widget/issues/23';
    if (options.held)
      nativeAuthority.comments.set(103, {
        id: 103,
        issue_url: 'https://api.github.com/repos/example/widget/issues/23',
        body: 'Synthetic retained source hold; transition does not release it.',
        user: { id: 37, login: 'configured-host', type: 'User' },
      });
  }
  return {
    root,
    row,
    context,
    runtimeEntryPath,
    admissionPath,
    archivePath,
    nativePr,
    inspectInput: {
      issueNumber: 17,
      purpose: options.purpose ?? 'active-resume',
      disposition: options.disposition ?? 'retain',
      ...(options.held ? { retainedHoldCommentIds: [103] } : {}),
      retainedAdmissionPath: admissionPath,
      retainedArchivePath: archivePath,
      runtimeEntryPath,
    },
  };
}

test('actual retained public bytes support one explicit independently accepted active resume', async () => {
  const f = await transitionFixture();
  try {
    const inspection = await inspectWorktreeTransition(f.context, f.inspectInput);
    assert.equal(inspection.ready, true, inspection.blockers.join('; '));
    const plan = inspection.plan!;
    assert.ok(
      worktreeRelinquishmentBody(plan).length < 65_000,
      'native authority body must fit the comment boundary while binding the full plan',
    );
    for (const path of [f.admissionPath, f.archivePath, plan.closure.admission.cliPath])
      assert.ok(
        plan.inventory.some((file) => file.source === path),
        `retained operational producer original omitted: ${path}`,
      );
    const planPath = join(f.root, 'approved-plan.json');
    writeFileSync(planPath, stableJson(plan));
    nativeAuthority.comments.get(101)!.body = worktreeRelinquishmentBody(plan);
    nativeAuthority.comments.get(102)!.body = worktreeAcceptanceBody(plan, 101);
    const applied = await applyWorktreeTransition(f.context, {
      authority: 'worktree:transition',
      planPath,
      expectedPlanId: plan.planId,
      relinquishmentCommentId: 101,
      acceptanceCommentId: 102,
      runtimeEntryPath: f.runtimeEntryPath,
    });
    assert.equal(applied.result, 'active-resumed');
    assert.equal(getIssueWorktreeStrict(17, f.root).identity, f.row.identity);
    assert.throws(
      () => loadVerifiedRun(f.row.path, 17),
      /verification.*(?:missing|corrupt|incompatible)|producer|run/iu,
      'preserved retained-producer history cannot satisfy current verification',
    );
    assert.equal(digestBytes(readFileSync(f.admissionPath)), plan.closure.admissionBytesDigest);
    const replayed = await applyWorktreeTransition(f.context, {
      authority: 'worktree:transition',
      planPath,
      expectedPlanId: plan.planId,
      relinquishmentCommentId: 101,
      acceptanceCommentId: 102,
      runtimeEntryPath: f.runtimeEntryPath,
    });
    assert.equal(replayed.replayed, true);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test(
  'completed replay checks original attempt bytes, actual writer absence, row and owner witness',
  { timeout: 0 },
  async () => {
    const f = await transitionFixture();
    try {
      const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
      assert.equal(inspected.ready, true, inspected.blockers.join('; '));
      const plan = inspected.plan!;
      const input = approvedFixturePlan(f, plan);
      const completed = await applyWorktreeTransition(f.context, input);
      const directory = dirname(completed.receiptPath);
      const attempt = readdirSync(join(directory, 'attempts')).find((name) => name.endsWith('.authority.json'))!;
      const authority = JSON.parse(readFileSync(join(directory, 'attempts', attempt), 'utf8')) as {
        data: { bytesDigest: string };
      };
      const bytesPath = join(directory, 'bytes', `${authority.data.bytesDigest.slice(7)}.bin`);
      const bytes = readFileSync(bytesPath);
      writeFileSync(bytesPath, 'corrupt preserved native authority', { mode: 0o600 });
      await assert.rejects(applyWorktreeTransition(f.context, input), /preserved.*corrupt/iu);
      writeFileSync(bytesPath, bytes, { mode: 0o600 });
      const writer = previousWriter(f.root);
      await assert.rejects(applyWorktreeTransition(f.context, input), /writer absence postcondition/iu);
      assert.deepEqual(readFileSync(writer.path), writer.bytes, 'replay must not signal or replace a writer');
      unlinkSync(writer.path);
      const registry = join(f.root, '.issue-cli/worktrees.json');
      const registryBytes = readFileSync(registry);
      writeFileSync(registry, JSON.stringify({ worktrees: [{ ...f.row, status: 'stale' }] }), { mode: 0o600 });
      await assert.rejects(applyWorktreeTransition(f.context, input), /row|registry/iu);
      writeFileSync(registry, registryBytes, { mode: 0o600 });
      const owners = join(gitCommonDir(f.root), 'ai-delivery/worktree-owners');
      const witness = readdirSync(owners).find((name) => name.endsWith('.json') && !name.includes('.transition.'))!;
      const witnessPath = join(owners, witness);
      const witnessBytes = readFileSync(witnessPath);
      writeFileSync(witnessPath, '{}', { mode: 0o600 });
      await assert.rejects(applyWorktreeTransition(f.context, input), /owner witness/iu);
      writeFileSync(witnessPath, witnessBytes, { mode: 0o600 });
      assert.equal((await applyWorktreeTransition(f.context, input)).replayed, true);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  },
);

test(
  'inspection and accepted apply refuse dirty source, wrong repository and changed canonical row without writing intent',
  { timeout: 0 },
  async () => {
    const f = await transitionFixture();
    try {
      const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
      assert.equal(inspected.ready, true, inspected.blockers.join('; '));
      const input = approvedFixturePlan(f, inspected.plan!);
      writeFileSync(join(f.row.path, 'untracked.txt'), 'dirty source\n');
      assert.equal((await inspectWorktreeTransition(f.context, f.inspectInput)).ready, false);
      await assert.rejects(applyWorktreeTransition(f.context, input), /dirty|clean|uncommitted/iu);
      unlinkSync(join(f.row.path, 'untracked.txt'));
      const repository = f.context.config.repository;
      f.context.config.repository = 'example/another';
      assert.match((await inspectWorktreeTransition(f.context, f.inspectInput)).blockers.join('; '), /repository/iu);
      await assert.rejects(applyWorktreeTransition(f.context, input), /repository/iu);
      f.context.config.repository = repository;
      writeFileSync(
        join(f.root, '.issue-cli/worktrees.json'),
        JSON.stringify({ worktrees: [{ ...f.row, identity: 'another-owner' }] }),
        { mode: 0o600 },
      );
      await assert.rejects(applyWorktreeTransition(f.context, input), /row|ownership|owner/iu);
      assert.equal(
        existsSync(join(gitCommonDir(f.root), 'ai-delivery/worktree-owners/issue-17.transition.json')),
        false,
      );
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  },
);

test(
  'inspection reports unsupported operative v2 and missing or corrupt required historical originals',
  { timeout: 0 },
  async () => {
    const f = await transitionFixture();
    try {
      const unsupported = join(gitCommonDir(f.root), 'issue-cli/verification-stages/v2');
      mkdirSync(unsupported, { recursive: true });
      assert.match(
        (await inspectWorktreeTransition(f.context, f.inspectInput)).blockers.join('; '),
        /unsupported operative.*v2/iu,
      );
      rmSync(unsupported, { recursive: true });
      const directory = join(f.root, '.issue-cli/issues/17/terminal');
      mkdirSync(directory, { recursive: true });
      const original = Buffer.from('original failed diagnostic\n');
      writeFileSync(
        join(directory, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 'issue-cli.terminal-evidence@1',
          files: [{ name: 'failed.txt', size: original.length, sha256: digestBytes(original).slice(7) }],
        }),
      );
      assert.equal((await inspectWorktreeTransition(f.context, f.inspectInput)).ready, false, 'missing original');
      writeFileSync(join(directory, 'failed.txt'), 'corrupt');
      assert.match(
        (await inspectWorktreeTransition(f.context, f.inspectInput)).blockers.join('; '),
        /original bytes/iu,
      );
      writeFileSync(join(directory, 'failed.txt'), original);
      assert.equal((await inspectWorktreeTransition(f.context, f.inspectInput)).ready, true);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  },
);

test(
  'terminal inspection and accepted apply reject wrong native repository and PR lineage drift',
  { timeout: 0 },
  async () => {
    const f = await transitionFixture({ purpose: 'merged-cleanup' });
    try {
      const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
      assert.equal(inspected.ready, true, inspected.blockers.join('; '));
      const input = approvedFixturePlan(f, inspected.plan!);
      f.nativePr.head.repo.full_name = 'example/another';
      assert.match(
        (await inspectWorktreeTransition(f.context, f.inspectInput)).blockers.join('; '),
        /repository.*closing issue/iu,
      );
      await assert.rejects(applyWorktreeTransition(f.context, input), /repository.*closing issue/iu);
      f.nativePr.head.repo.full_name = 'example/widget';
      f.nativePr.user.login = 'changed-original-author';
      await assert.rejects(applyWorktreeTransition(f.context, input), /native PR lineage.*drifted/iu);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  },
);

test('closure check refuses live owners, reused root PIDs and live process groups without signaling', () => {
  const root = repository();
  try {
    const original = previousWriter(root);
    const previous = JSON.parse(original.bytes.toString('utf8')) as Record<string, unknown>;
    const { stateId: _id, ...content } = previous;
    const identity = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    for (const reason of ['owner', 'reused-pid', 'group']) {
      const state = {
        ...content,
        owner: reason === 'owner' ? { pid: process.pid, identity } : content.owner,
        command:
          reason === 'owner'
            ? { phase: 'idle' }
            : {
                phase: 'running',
                root: { pid: reason === 'reused-pid' ? process.pid : 2_000_000_000, identity: 'unrelated old birth' },
                tracked:
                  reason === 'group'
                    ? [
                        {
                          pid: 2_000_000_001,
                          identity: 'old birth',
                          pgid: Number(
                            execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid='], {
                              encoding: 'utf8',
                            }).trim(),
                          ),
                        },
                      ]
                    : [],
              },
      };
      assert.throws(
        () =>
          assertWorktreeTransitionWriterQuiescent(
            entry(root).path,
            Buffer.from(stableJson({ ...state, stateId: digestValue(state) })),
          ),
        /live verification|process-group absence/iu,
      );
      process.kill(process.pid, 0);
    }
    assert.deepEqual(readFileSync(original.path), original.bytes);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('supported closure requires a run for the exact retained head and tree', async () => {
  const f = await transitionFixture();
  try {
    writeFileSync(join(f.row.path, 'new-source.txt'), 'a newer synthetic retained source\n');
    execFileSync('git', ['add', 'new-source.txt'], { cwd: f.row.path });
    execFileSync('git', ['commit', '-m', 'new synthetic head'], { cwd: f.row.path });
    const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
    assert.equal(inspected.ready, false, 'old producer-bound run cannot close a newer unverified retained source');
    assert.match(inspected.blockers.join('; '), /exact.*(?:head|source)|closure/iu);
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test('apply revalidates the exact operational run inventory despite native acceptance of local JSON', async () => {
  const f = await transitionFixture();
  try {
    const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
    assert.equal(inspected.ready, true, inspected.blockers.join('; '));
    const { planId: _originalId, ...content } = inspected.plan!;
    content.closure = { ...content.closure, runManifestIds: [digestValue('unrelated run')] };
    const plan = { ...content, planId: digestValue(content) };
    const planPath = join(f.root, 'changed-plan.json');
    writeFileSync(planPath, stableJson(plan));
    nativeAuthority.comments.get(101)!.body = worktreeRelinquishmentBody(plan);
    nativeAuthority.comments.get(102)!.body = worktreeAcceptanceBody(plan, 101);
    await assert.rejects(
      applyWorktreeTransition(f.context, {
        authority: 'worktree:transition',
        planPath,
        expectedPlanId: plan.planId,
        relinquishmentCommentId: 101,
        acceptanceCommentId: 102,
        runtimeEntryPath: f.runtimeEntryPath,
      }),
      /run.*inventory|operational.*closure/iu,
    );
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test('terminal transition retains source, holds and original PR identity and permanently rejects ordinary resume', async () => {
  const f = await transitionFixture({ purpose: 'merged-cleanup', held: true });
  try {
    const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
    assert.equal(inspected.ready, true, inspected.blockers.join('; '));
    const plan = inspected.plan!;
    const applied = await applyWorktreeTransition(f.context, approvedFixturePlan(f, plan));
    assert.equal(applied.result, 'retained');
    assert.equal(existsSync(f.row.path), true);
    assert.deepEqual(listWorktreesStrict(f.root), [{ ...f.row, status: 'merged' }]);
    assert.deepEqual(plan.retainedHoldCommentIds, [103]);
    assert.match(String(nativeAuthority.comments.get(103)!.body), /does not release/);
    await assert.rejects(
      prepareIssueWorktree({ repoRoot: f.root, issueNumber: 17, identity: 'configured-host' }),
      /terminal/iu,
    );
    const hold = plan.holdEvidence[0]!;
    assert.equal(
      digestBytes(readFileSync(join(dirname(applied.receiptPath), 'bytes', `${hold.digest.slice(7)}.bin`))),
      hold.digest,
    );
  } finally {
    rmSync(f.root, { force: true, recursive: true });
  }
});

test(
  'unheld terminal removal checks native remote refs and completed replay rejects recreated source',
  { timeout: 0 },
  async () => {
    const f = await transitionFixture({ purpose: 'merged-cleanup', disposition: 'remove' });
    try {
      const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
      assert.equal(inspected.ready, true, inspected.blockers.join('; '));
      const plan = inspected.plan!;
      const input = approvedFixturePlan(f, plan);
      const applied = await applyWorktreeTransition(f.context, input);
      assert.equal(applied.result, 'removed');
      assert.equal(existsSync(f.row.path), false);
      assert.deepEqual(listWorktreesStrict(f.root), []);
      assert.equal((await applyWorktreeTransition(f.context, input)).replayed, true);
      execFileSync('git', ['worktree', 'add', f.row.path, f.row.branch], { cwd: f.root });
      await assert.rejects(applyWorktreeTransition(f.context, input), /recreated|absence postcondition/iu);
      assert.throws(() => assertNativeIssueTrackingAdmission(17, f.root), /terminal/iu);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  },
);

test('terminal inspection rejects held removal and configured reviewer matching the native PR author', async () => {
  for (const reason of ['held', 'reviewer-author']) {
    const f = await transitionFixture({ purpose: 'merged-cleanup', disposition: 'remove', held: reason === 'held' });
    try {
      if (reason === 'reviewer-author') f.nativePr.user.login = nativeAuthority.reviewer;
      const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
      assert.equal(inspected.ready, false, reason);
      assert.match(inspected.blockers.join('; '), reason === 'held' ? /disposition/iu : /native PR author/iu);
      assert.equal(
        existsSync(join(gitCommonDir(f.root), 'ai-delivery/worktree-owners/issue-17.transition.json')),
        false,
      );
    } finally {
      rmSync(f.root, { force: true, recursive: true });
    }
  }
});

function entry(root: string, status: WorktreeEntry['status'] = 'active'): WorktreeEntry {
  return {
    branch: 'issue/17',
    createdAt: '2026-01-01T00:00:00.000Z',
    identity: 'synthetic-author',
    issueNumber: 17,
    path: join(root, '.worktrees', 'issue-17'),
    status,
    type: 'issue',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function interruptTransition(root: string, row: WorktreeEntry): void {
  // A truncated intent is also an incomplete transition and must fail closed.
  const path = join(
    gitCommonDir(root),
    'ai-delivery',
    'worktree-owners',
    `issue-${String(row.issueNumber)}.transition.json`,
  );
  writeFileSync(path, '{', { mode: 0o600 });
}

test('ordinary ownership and resume refuse an interrupted transition even after the owner witness exists', async () => {
  const root = repository();
  try {
    const row = entry(root);
    await addWorktreeEntry(row, root);
    assert.equal(getIssueWorktreeStrict(17, root).path, row.path);
    interruptTransition(root, row);
    assert.throws(() => getIssueWorktreeStrict(17, root), /Worktree transition.*(?:pending|incomplete|terminal)/iu);
    await assert.rejects(
      prepareIssueWorktree({ identity: row.identity!, issueNumber: 17, repoRoot: root }),
      /Worktree transition.*(?:pending|incomplete|terminal)/iu,
    );
    assert.deepEqual(listWorktreesStrict(root), [row]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('registration cannot reactivate a merged issue through an interrupted transition', async () => {
  const root = repository();
  try {
    const row = { ...entry(root, 'merged'), prNumber: 23 };
    await addWorktreeEntry(row, root);
    const registry = join(root, '.issue-cli', 'worktrees.json');
    const original = readFileSync(registry);
    interruptTransition(root, row);
    await assert.rejects(addWorktreeEntry(entry(root), root), /Worktree transition.*(?:pending|incomplete|terminal)/iu);
    assert.deepEqual(readFileSync(registry), original);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('ordinary ownership still refuses a legacy row without a witness', () => {
  const root = repository();
  try {
    mkdirSync(join(root, '.issue-cli'), { mode: 0o700 });
    writeFileSync(join(root, '.issue-cli', 'worktrees.json'), JSON.stringify({ worktrees: [entry(root)] }), {
      mode: 0o600,
    });
    assert.throws(() => getIssueWorktreeStrict(17, root), /ownership witness/iu);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('direct tracking admission refuses pending intent after its canonical row is absent', async () => {
  const root = repository();
  try {
    const row = entry(root);
    await addWorktreeEntry(row, root);
    writeFileSync(join(root, '.issue-cli/worktrees.json'), JSON.stringify({ worktrees: [] }), { mode: 0o600 });
    interruptTransition(root, row);
    assert.throws(
      () => assertNativeIssueTrackingAdmission(17, root),
      /Worktree transition.*(?:pending|incomplete|terminal)/iu,
    );
    await assert.rejects(
      prepareIssueWorktree({ identity: row.identity!, issueNumber: 17, repoRoot: root }),
      /Worktree transition.*(?:pending|incomplete|terminal)/iu,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('absent-row admission refuses valid JSON with a non-issue or mismatched embedded row', async () => {
  const root = repository();
  try {
    const row = entry(root);
    await addWorktreeEntry(row, root);
    writeFileSync(join(root, '.issue-cli/worktrees.json'), JSON.stringify({ worktrees: [] }), { mode: 0o600 });
    const path = join(gitCommonDir(root), 'ai-delivery/worktree-owners/issue-17.transition.json');
    for (const invalid of [{ type: 'pr' }, { ...row, issueNumber: 18 }, { ...row, issueNumber: undefined }]) {
      writeFileSync(path, JSON.stringify({ plan: { row: invalid } }), { mode: 0o600 });
      assert.throws(() => assertNativeIssueTrackingAdmission(17, root), /transition.*(?:incomplete|unreadable)/iu);
      await assert.rejects(
        prepareIssueWorktree({ identity: row.identity!, issueNumber: 17, repoRoot: root }),
        /transition.*(?:incomplete|unreadable)/iu,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'native acceptance cannot bypass terminal or active purpose and complete PR-set predicates',
  { timeout: 0 },
  async () => {
    for (const reason of ['empty-terminal-lineage', 'active-merged-lineage', 'active-merged-row']) {
      const f = await transitionFixture({ purpose: 'merged-cleanup' });
      try {
        const inspected = await inspectWorktreeTransition(f.context, f.inspectInput);
        assert.equal(inspected.ready, true, inspected.blockers.join('; '));
        const { planId: _id, ...content } = inspected.plan!;
        if (reason === 'empty-terminal-lineage') content.lineage = [];
        else {
          content.purpose = 'active-resume';
          content.terminalPrNumber = null;
          f.context.clients.rest.issues.get = (async () => ({
            data: { state: 'open' },
          })) as typeof f.context.clients.rest.issues.get;
          for (const id of [101, 102])
            nativeAuthority.comments.get(id)!.issue_url = 'https://api.github.com/repos/example/widget/issues/17';
          if (reason === 'active-merged-row') {
            content.row = { ...content.row, status: 'merged' };
            content.lineage = [];
            writeFileSync(join(f.root, '.issue-cli/worktrees.json'), JSON.stringify({ worktrees: [content.row] }), {
              mode: 0o600,
            });
          }
        }
        const plan = { ...content, planId: digestValue(content) };
        await assert.rejects(
          applyWorktreeTransition(f.context, approvedFixturePlan(f, plan)),
          /lineage|active resume|terminal|PR.*set/iu,
          reason,
        );
        assert.equal(
          existsSync(join(gitCommonDir(f.root), 'ai-delivery/worktree-owners/issue-17.transition.json')),
          false,
        );
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }
  },
);

test('transition registry rejects a foreign issue row sharing its exact path or branch', async () => {
  const root = repository();
  try {
    const { plan } = authorityFixture(root);
    mkdirSync(join(root, '.issue-cli'), { recursive: true });
    for (const conflict of ['path', 'branch']) {
      const other = { ...entry(root), issueNumber: 18, path: join(root, '.worktrees', 'issue-18'), branch: 'issue/18' };
      if (conflict === 'path') other.path = plan.row.path;
      else other.branch = plan.row.branch;
      writeFileSync(join(root, '.issue-cli/worktrees.json'), JSON.stringify({ worktrees: [plan.row, other] }), {
        mode: 0o600,
      });
      await assert.rejects(
        withWorktreeTransitionRegistry(plan, async () => undefined),
        /colli|conflict/iu,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('historical inventory preserves unknown schemas and failed diagnostics byte for byte', () => {
  const root = repository();
  try {
    const historical = join(root, '.issue-cli', 'issues', '17', 'review', 'historical-head');
    mkdirSync(historical, { recursive: true });
    const original = Buffer.from(
      '{"schemaVersion":"historical.unknown@7","failed":true,"accounting":{"elapsed":51}}\n',
    );
    writeFileSync(join(historical, 'failed-diagnostic.json'), original);
    const inventory = inventoryTransitionEvidence(root, entry(root));
    const item = inventory.find((file) => file.path.endsWith('failed-diagnostic.json'));
    assert.ok(item);
    const output = join(gitCommonDir(root), 'ai-delivery', 'worktree-owners', 'preserved');
    preserveTransitionEvidence(output, inventory);
    assert.deepEqual(readFileSync(join(output, `${item.digest.slice(7)}.bin`)), original);
    assert.deepEqual(readFileSync(join(historical, 'failed-diagnostic.json')), original);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('preservation rejects drift without replacing an already preserved original', () => {
  const root = repository();
  try {
    const historical = join(root, '.issue-cli', 'issues', '17');
    mkdirSync(historical, { recursive: true });
    const source = join(historical, 'receipt.json');
    writeFileSync(source, 'original historical bytes');
    const inventory = inventoryTransitionEvidence(root, entry(root));
    const output = join(gitCommonDir(root), 'ai-delivery', 'worktree-owners', 'preserved');
    preserveTransitionEvidence(output, inventory);
    writeFileSync(source, 'changed historical bytes');
    assert.throws(() => preserveTransitionEvidence(output, inventory), /historical evidence.*drift/iu);
    assert.deepEqual(
      readFileSync(join(output, `${inventory[0]!.digest.slice(7)}.bin`)),
      Buffer.from('original historical bytes'),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('inventory preserves worktree-local original receipts and accounting before terminal removal', () => {
  const root = repository();
  try {
    const local = join(entry(root).path, '.issue-cli', 'receipts', 'verification');
    mkdirSync(local, { recursive: true });
    const path = join(local, 'historical.json');
    const bytes = Buffer.from(
      '{"schemaVersion":"legacy.receipt@2","failedDiagnostic":true,"accounting":{"runtimeMs":771}}\n',
    );
    writeFileSync(path, bytes);
    const inventory = inventoryTransitionEvidence(root, entry(root));
    const selected = inventory.find((file) => file.source === path);
    assert.ok(selected, 'worktree-local original receipt was omitted');
    const output = join(gitCommonDir(root), 'ai-delivery', 'worktree-owners', 'preserved');
    preserveTransitionEvidence(output, inventory);
    assert.deepEqual(readFileSync(join(output, `${selected.digest.slice(7)}.bin`)), bytes);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function previousWriter(root: string, phase: 'idle' | 'starting' = 'idle'): { path: string; bytes: Buffer } {
  const worktree = join(root, '.worktrees', 'issue-17');
  const worktreeDigest = digestValue(realpathSync(worktree));
  const content = {
    schemaVersion: 'ai-delivery.verification-writer@1',
    writerId: 'c9d58755-17b2-4fc9-9218-90f92c7642e1',
    worktreeDigest,
    owner: { pid: 2_000_000_000, identity: 'synthetic deceased process' },
    command: { phase },
  };
  const path = join(gitCommonDir(root), 'ai-delivery', 'writers@1', `${worktreeDigest.slice(7)}.json`);
  mkdirSync(join(gitCommonDir(root), 'ai-delivery', 'writers@1'), { mode: 0o700, recursive: true });
  const bytes = Buffer.from(`${JSON.stringify({ ...content, stateId: digestValue(content) }, null, 2)}\n`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, bytes };
}

test('transition lease preserves original bytes before claim and records release before deletion', async () => {
  const root = repository();
  try {
    const original = previousWriter(root);
    const events: string[] = [];
    const writerId = '1b75f48b-0746-43a5-bd6d-9ddc17848c9a';
    await withWorktreeTransitionWriterLease(
      {
        repoRoot: entry(root).path,
        writerId,
        beforeClaim: ({ previousBytes }: { previousBytes: Buffer | undefined }) => {
          assert.deepEqual(previousBytes, original.bytes);
          assert.deepEqual(readFileSync(original.path), original.bytes);
          events.push('preserved');
        },
        recordClaim: (bytes: Buffer) => {
          assert.deepEqual(events, ['preserved']);
          assert.deepEqual(readFileSync(original.path), original.bytes);
          assert.equal((JSON.parse(bytes.toString()) as { writerId: string }).writerId, writerId);
          events.push('claimed');
        },
        recordRelease: (bytes: Buffer) => {
          assert.deepEqual(events, ['preserved', 'claimed', 'operation']);
          assert.deepEqual(readFileSync(original.path), bytes);
          events.push('released');
        },
      },
      async () => {
        assert.equal((JSON.parse(readFileSync(original.path, 'utf8')) as { writerId: string }).writerId, writerId);
        events.push('operation');
      },
    );
    assert.deepEqual(events, ['preserved', 'claimed', 'operation', 'released']);
    assert.throws(() => readFileSync(original.path), { code: 'ENOENT' });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('failed intent preservation cannot overwrite the original writer', async () => {
  const root = repository();
  try {
    const original = previousWriter(root);
    await assert.rejects(
      withWorktreeTransitionWriterLease(
        {
          repoRoot: entry(root).path,
          writerId: '1b75f48b-0746-43a5-bd6d-9ddc17848c9a',
          beforeClaim: () => {
            throw new Error('synthetic intent failure');
          },
          recordClaim: () => assert.fail('claim must not be reached'),
          recordRelease: () => assert.fail('release must not be reached'),
        },
        async () => assert.fail('operation must not be reached'),
      ),
      /synthetic intent failure/u,
    );
    assert.deepEqual(readFileSync(original.path), original.bytes);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('failed claim evidence cannot replace the preserved writer', async () => {
  const root = repository();
  try {
    const original = previousWriter(root);
    await assert.rejects(
      withWorktreeTransitionWriterLease(
        {
          repoRoot: entry(root).path,
          writerId: '1b75f48b-0746-43a5-bd6d-9ddc17848c9a',
          beforeClaim: () => undefined,
          recordClaim: () => {
            throw new Error('synthetic claim failure');
          },
          recordRelease: () => assert.fail('release must not be reached'),
        },
        async () => assert.fail('operation must not be reached'),
      ),
      /synthetic claim failure/u,
    );
    assert.deepEqual(readFileSync(original.path), original.bytes);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('transition refuses an interrupted unknown launch without changing its state', async () => {
  const root = repository();
  try {
    const original = previousWriter(root, 'starting');
    await assert.rejects(
      withWorktreeTransitionWriterLease(
        {
          repoRoot: entry(root).path,
          writerId: '1b75f48b-0746-43a5-bd6d-9ddc17848c9a',
          beforeClaim: () => assert.fail('unknown ownership must refuse before preservation'),
          recordClaim: () => assert.fail('unknown ownership must refuse before claim'),
          recordRelease: () => assert.fail('unknown ownership must refuse before release'),
        },
        async () => assert.fail('operation must not be reached'),
      ),
      /unknown command ownership/u,
    );
    assert.deepEqual(readFileSync(original.path), original.bytes);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('transition cannot delete its writer when durable release evidence fails', async () => {
  const root = repository();
  try {
    const original = previousWriter(root);
    let claim: Buffer | undefined;
    await assert.rejects(
      withWorktreeTransitionWriterLease(
        {
          repoRoot: entry(root).path,
          writerId: '1b75f48b-0746-43a5-bd6d-9ddc17848c9a',
          beforeClaim: () => undefined,
          recordClaim: (bytes: Buffer) => {
            claim = Buffer.from(bytes);
          },
          recordRelease: () => {
            throw new Error('synthetic release evidence failure');
          },
        },
        async () => undefined,
      ),
      /synthetic release evidence failure/u,
    );
    assert.deepEqual(readFileSync(original.path), claim);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('transition seals completion only after recorded writer deletion while the lease remains held', async () => {
  const root = repository();
  try {
    const original = previousWriter(root);
    let releaseRecorded = false;
    let sealed = false;
    await withWorktreeTransitionWriterLease(
      {
        repoRoot: entry(root).path,
        writerId: '1b75f48b-0746-43a5-bd6d-9ddc17848c9a',
        beforeClaim: () => undefined,
        recordClaim: () => undefined,
        recordRelease: () => {
          releaseRecorded = true;
        },
        afterRelease: () => {
          assert.equal(releaseRecorded, true);
          assert.throws(() => readFileSync(original.path), { code: 'ENOENT' });
          assert.equal(realpathSync(`${original.path}.lock`), `${original.path}.lock`);
          sealed = true;
        },
      },
      async () => undefined,
    );
    assert.equal(sealed, true);
    assert.throws(() => realpathSync(`${original.path}.lock`), { code: 'ENOENT' });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('removed-worktree replay uses the original subject writer slot without recreating source', async () => {
  const root = repository();
  try {
    const row = entry(root);
    const original = previousWriter(root);
    execFileSync('git', ['worktree', 'remove', row.path], { cwd: root, stdio: 'pipe' });
    let captured = false;
    await withWorktreeTransitionWriterLease(
      {
        repoRoot: root,
        worktreePath: row.path,
        writerId: '1b75f48b-0746-43a5-bd6d-9ddc17848c9a',
        beforeClaim: ({ previousBytes }: { previousBytes: Buffer | undefined }) => {
          assert.deepEqual(previousBytes, original.bytes);
          captured = true;
        },
        recordClaim: () => undefined,
        recordRelease: () => undefined,
      },
      async () => assert.throws(() => realpathSync(row.path), { code: 'ENOENT' }),
    );
    assert.equal(captured, true);
    assert.throws(() => realpathSync(row.path), { code: 'ENOENT' });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
