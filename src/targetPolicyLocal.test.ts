import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { digestBytes, digestValue } from './delivery/common.js';
import { investigationAcceptanceBody, investigationAuthorityBody } from './pr.js';
import { readInvestigationPreparation } from './services/worktreeRegistry.js';
import { WorktreeTransitionPlanSchema } from './worktreeTransition.js';
import { fixtureGit, inertTarget, type PolicyState } from './fixtures/inertTarget.js';

type Fixture = ReturnType<typeof inertTarget>;
type Connection = Awaited<ReturnType<Fixture['connect']>>;
type Scope = ReturnType<typeof runtimeScope>;

// Each scoped case owns its fixture, signal bridge, operation promises and disposal.
// A hook deadline can reject before the real MCP handler settles; join never releases
// fixture globals until the existing active-handler drain completes.
function runtimeScope() {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const unlink = new Set<() => void>();
  let cleanup: (() => Promise<void>) | undefined;
  let joined: Promise<void> | undefined;
  const scope = {
    controller,
    signal: controller.signal,
    pending,
    fixture: undefined as Fixture | undefined,
    forward(signal: AbortSignal): void {
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        unlink.add(() => signal.removeEventListener('abort', abort));
      }
    },
    acquire(): Fixture {
      controller.signal.throwIfAborted();
      assert.equal(scope.fixture, undefined, 'Each case acquires exactly one fixture');
      scope.fixture = inertTarget(controller.signal, (ownedCleanup) => {
        cleanup = ownedCleanup;
      });
      return scope.fixture;
    },
    join(): Promise<void> {
      joined ??= (async () => {
        controller.abort(new Error('Owned scoped runtime case finished'));
        try {
          while (pending.size) await Promise.allSettled(pending);
          await cleanup?.();
        } finally {
          for (const remove of unlink) remove();
          unlink.clear();
        }
      })();
      return joined;
    },
  };
  return scope;
}

async function scopedPhase<T>(scope: Scope, name: string, budgetMs: number, operation: () => Promise<T>) {
  scope.signal.throwIfAborted();
  const started = performance.now();
  const timeout = new Error(`Owned ${name} deadline exceeded (${budgetMs}ms)`);
  const timer = setTimeout(() => scope.controller.abort(timeout), budgetMs);
  const pending = Promise.resolve().then(async () => {
    scope.signal.throwIfAborted();
    const value = await operation();
    // Synchronous owned subprocesses may delay timers. Late settlement still fails.
    if (performance.now() - started >= budgetMs) scope.controller.abort(timeout);
    scope.signal.throwIfAborted();
    return value;
  });
  scope.pending.add(pending);
  try {
    return await pending;
  } finally {
    clearTimeout(timer);
    scope.pending.delete(pending);
  }
}

async function prepareScope<T>(scope: Scope, prepare: () => Promise<T>, budgetMs = 15_000) {
  try {
    return await scopedPhase(scope, 'setup', budgetMs, prepare);
  } catch (error) {
    scope.controller.abort(error);
    await scope.join();
    throw error;
  }
}

function scopedRuntimeCase<T extends object>(
  name: string,
  prepare: (scope: Scope) => Promise<T>,
  observe: (prepared: T) => Promise<void>,
) {
  describe('per-case runtime preparation (15s setup, 15s asserted body)', () => {
    let owned: { scope: Scope; prepared?: T; ready: boolean } | undefined;
    beforeEach(async ({ signal }) => {
      assert.equal(owned, undefined, 'Previous case must finish owned teardown');
      const scope = runtimeScope();
      owned = { scope, ready: false };
      scope.forward(signal);
      owned.prepared = await prepareScope(scope, () => prepare(scope));
      owned.ready = true;
    }, 15_000);
    afterEach(async () => {
      const current = owned;
      if (current) {
        await current.scope.join();
        owned = undefined;
      }
    }, 15_000);
    test(
      name,
      async ({ signal }) => {
        const current = owned;
        assert.ok(current?.ready, 'Real case prerequisites must finish before the asserted body');
        assert.ok(current.prepared);
        const prepared = current.prepared;
        current.scope.forward(signal);
        try {
          await scopedPhase(current.scope, 'asserted body', 15_000, () => observe(prepared));
        } finally {
          await current.scope.join();
        }
      },
      15_000,
    );
  });
}

async function runtimeFixture(f: Fixture) {
  f.signal.throwIfAborted();
  const packageRoot = join(f.base, 'archive', 'package');
  const lifecycleSentinel = join(f.base, 'lifecycle-executed');
  const files = {
    'package.json': JSON.stringify({
      name: '@aviaratech/ai-delivery',
      version: '0.3.5',
      type: 'module',
      bin: { 'ai-delivery': './dist/cli.js' },
      scripts: { preinstall: 'node lifecycle.cjs', postinstall: 'node lifecycle.cjs' },
    }),
    'lifecycle.cjs': `require('node:fs').appendFileSync(${JSON.stringify(lifecycleSentinel)},'executed\\n');\n`,
    'dist/cli.js': "#!/usr/bin/env node\nconsole.log('0.3.5');\n",
    'dist/agent.js': 'export const fictional = true;\n',
    'plugins/ai-delivery/dist/mcp-launcher.js': '/* Owned inert launcher bytes. */\n',
    'plugins/ai-delivery/.claude-plugin/plugin.json': JSON.stringify({
      name: 'ai-delivery',
      packageVersion: '0.3.5',
      deliveryCapabilityVersion: 2,
    }),
  };
  for (const [path, bytes] of Object.entries(files)) {
    const file = join(packageRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  const archivePath = join(f.base, 'inert.tgz');
  execFileSync('tar', ['-czf', archivePath, '-C', dirname(packageRoot), 'package'], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  const loaded = await loadDeliveryConfig(f.root, {
    repository: 'example/widget',
    signal: f.signal,
    clients: { graphql: f.graphql } as never,
  });
  const runtimeDirectory = join(f.base, 'runtime');
  const common = { expectedSourceCommit: f.head, expectedConfigDigest: loaded.configDigest, runtimeDirectory };
  return {
    archivePath,
    lifecycleSentinel,
    common,
    stage: {
      ...common,
      authority: 'runtime:stage',
      archivePath,
      expectedArchiveSha256: digestBytes(readFileSync(archivePath)),
      packageVersion: '0.3.5',
      resourceBounds: {
        maxAggregateRssBytes: 384 * 1024 ** 2,
        minFreeDiskBytes: 8 * 1024 ** 2,
        maxNewOutputBytes: 8 * 1024 ** 2,
        maxCapturedOutputBytes: 64 * 1024,
      },
    },
    cli: join(runtimeDirectory, 'node_modules/@aviaratech/ai-delivery/dist/cli.js'),
  };
}

test('fixture cancellation drains the real MCP handler before releasing global ownership', async ({ signal }) => {
  const cancellation = new AbortController();
  const f = inertTarget(AbortSignal.any([signal, cancellation.signal]));
  let connection: Connection | undefined;
  let next: Fixture | undefined;
  let nextConnection: Connection | undefined;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const get = f.rest.issues.get;
  let portSettled = false;
  f.rest.issues.get = async (input) => {
    entered();
    await held;
    portSettled = true;
    return get(input);
  };
  try {
    f.policy('tracked');
    connection = await f.connect();
    const pending = connection.call('issue_info', { issueNumber: 17 });
    const rejected = assert.rejects(pending, /Controlled fixture cancellation/u);
    await reached;
    cancellation.abort(new Error('Controlled fixture cancellation'));
    const disposal = f.dispose(connection);
    assert.equal(f.dispose(connection), disposal, 'All disposal callers must join the same promise');
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await rejected;
    assert.equal(portSettled, false);
    assert.equal(disposed, false, 'Transport cancellation must not be treated as handler settlement');
    assert.equal(existsSync(f.root), true, 'Files remain owned until the handler settles');
    assert.throws(() => inertTarget(signal), /previous fixture must finish disposal/u);
    release();
    await disposal;
    assert.equal(portSettled, true);
    assert.equal(existsSync(f.base), false);

    next = inertTarget(signal);
    next.policy('tracked');
    nextConnection = await next.connect();
    await f.dispose(connection);
    const result = await nextConnection.call('issue_info', { issueNumber: 17 });
    assert.notEqual(result.response.isError, true, result.text);
    assert.ok(next.calls.some((call) => call.name === 'issues.get'));
  } finally {
    release();
    try {
      await f.dispose(connection);
    } finally {
      await next?.dispose(nextConnection);
    }
  }
}, 5_000);

test('fixture disposal closes a cancelled MCP connection', async ({ signal }) => {
  const f = inertTarget(signal);
  const cancellation = new AbortController();
  cancellation.abort(new Error('Controlled connection cancellation'));
  try {
    await assert.rejects(f.connect({ signal: cancellation.signal }), /Controlled connection cancellation/u);
  } finally {
    await f.dispose(undefined);
  }
  assert.equal(existsSync(f.base), false);
  const next = inertTarget(signal);
  try {
    const loaded = await loadDeliveryConfig(next.root, {
      repository: 'example/widget',
      clients: { graphql: next.graphql } as never,
    });
    assert.ok(loaded.configDigest);
  } finally {
    await next.dispose(undefined);
  }
}, 5_000);

async function stageAndAdmit(f: Fixture, c: Connection) {
  const runtime = await runtimeFixture(f);
  const staged = await c.call('runtime_stage', runtime.stage);
  assert.notEqual(staged.response.isError, true, staged.text);
  const admitted = await c.call('runtime_admit', {
    ...runtime.common,
    authority: 'runtime:admit',
    stageId: staged.value!.stageId,
    expectedPriorAdmissionSha256: null,
  });
  assert.notEqual(admitted.response.isError, true, admitted.text);
  return { ...runtime, stageId: staged.value!.stageId, admission: admitted.value!.admission };
}

for (const cancellation of ['hook signal', 'owned setup deadline'] as const) {
  test(`scoped runtime setup ${cancellation} aborts and drains a real handler before releasing globals`, async ({
    signal,
  }) => {
    const scope = runtimeScope();
    const hook = new AbortController();
    scope.forward(signal);
    scope.forward(hook.signal);
    const f = scope.acquire();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const get = f.rest.issues.get;
    let handlerSettled = false;
    f.rest.issues.get = async (input) => {
      entered();
      await held;
      handlerSettled = true;
      return get(input);
    };
    try {
      f.policy('tracked');
      const c = await f.connect();
      let callOutcome!: Promise<unknown>;
      const setup = prepareScope(
        scope,
        async () => {
          const call = c.call('issue_info', { issueNumber: 17 });
          callOutcome = call.then(
            () => undefined,
            (error: unknown) => error,
          );
          return call;
        },
        cancellation === 'owned setup deadline' ? 1_000 : 15_000,
      );
      // Observe both outcomes immediately; failures before release must not create
      // an unhandled assertion promise while the held real handler is drained.
      const setupOutcome = setup.then(
        () => undefined,
        (error: unknown) => error,
      );
      let setupSettled = false;
      void setupOutcome.then(() => {
        setupSettled = true;
      });
      await reached;
      if (cancellation === 'hook signal') hook.abort(new Error('Controlled hook cancellation'));
      assert.match(String(await callOutcome), /Controlled hook cancellation|Owned setup deadline exceeded/u);
      assert.equal(handlerSettled, false);
      assert.equal(setupSettled, false, 'Rejected transport is not joined setup completion');
      const disposal = scope.join();
      assert.equal(scope.join(), disposal, 'All cleanup paths join one owned disposal');
      let disposed = false;
      void disposal.then(
        () => {
          disposed = true;
        },
        () => {},
      );
      await Promise.resolve();
      assert.equal(disposed, false);
      assert.equal(existsSync(f.root), true);
      assert.throws(() => inertTarget(signal), /previous fixture must finish disposal/u);
      release();
      assert.match(String(await setupOutcome), /Controlled hook cancellation|Owned setup deadline exceeded/u);
      await disposal;
      assert.equal(handlerSettled, true);
      assert.equal(existsSync(f.base), false);
      const next = inertTarget(signal);
      try {
        next.policy('tracked');
        const nextConnection = await next.connect();
        const result = await nextConnection.call('issue_info', { issueNumber: 17 });
        assert.notEqual(result.response.isError, true, result.text);
      } finally {
        await next.dispose(undefined);
      }
    } finally {
      release();
      await scope.join();
    }
  }, 5_000);
}

test('scoped runtime setup failure after connection acquisition drains and restores only owned globals', async ({
  signal,
}) => {
  const scope = runtimeScope();
  scope.forward(signal);
  let f: Fixture | undefined;
  try {
    await assert.rejects(
      prepareScope(scope, async () => {
        f = scope.acquire();
        f.policy('tracked');
        const c = await f.connect();
        const result = await c.call('issue_info', { issueNumber: 17 });
        assert.notEqual(result.response.isError, true, result.text);
        throw new Error('Controlled failure after owned connection');
      }),
      /Controlled failure after owned connection/u,
    );
    assert.ok(f);
    assert.equal(existsSync(f.base), false);
    const next = inertTarget(signal);
    try {
      next.policy('tracked');
      const c = await next.connect();
      await scope.join();
      const result = await c.call('issue_info', { issueNumber: 17 });
      assert.notEqual(result.response.isError, true, result.text);
    } finally {
      await next.dispose(undefined);
    }
  } finally {
    await scope.join();
  }
}, 5_000);

async function lifecycleControl(f: Fixture, runtime: Awaited<ReturnType<typeof runtimeFixture>>) {
  // Same archive, real npm and same environment; explicitly enabled scripts establish the lifecycle control.
  f.signal.throwIfAborted();
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      join(f.base, 'control-install'),
      '--omit=dev',
      '--ignore-scripts=false',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--cache',
      join(f.base, 'control-cache'),
      '--userconfig',
      '/dev/null',
      '--globalconfig',
      join(f.base, 'fictional-global.npmrc'),
      runtime.archivePath,
    ],
    { env: process.env, cwd: f.base, timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  assert.match(readFileSync(runtime.lifecycleSentinel, 'utf8'), /executed/u);
}

async function prepareStage(scope: Scope) {
  const f = scope.acquire();
  const runtime = await runtimeFixture(f);
  f.policy('tracked');
  const c = await f.connect();
  const staged = await c.call('runtime_stage', runtime.stage);
  assert.notEqual(staged.response.isError, true, staged.text);
  assert.ok(existsSync(runtime.cli));
  assert.equal(existsSync(runtime.lifecycleSentinel), false);
  assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false, 'Staging must not admit');
  return { f, c, runtime, staged };
}

async function prepareTransition(f: Fixture) {
  f.worktree();
  let c = await f.connect();
  const runtime = await stageAndAdmit(f, c);
  await c.close();
  c = await f.connect({ runtimeEntryPath: runtime.cli });
  return { f, c, runtime };
}

async function observeTransition(
  f: Fixture,
  c: Connection,
  runtime: Awaited<ReturnType<typeof stageAndAdmit>>,
  kind: PolicyState,
) {
  const row = {
    branch: 'issue/17',
    path: f.target,
    issueNumber: 17,
    identity: 'author',
    type: 'issue',
    status: 'active',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  writeFileSync(join(f.root, '.issue-cli/worktrees.json'), JSON.stringify({ worktrees: [row] }));
  f.policy(kind, f.target);
  const digest = digestValue('Owned synthetic closure placeholder; not operational attestation.');
  const content = {
    schemaVersion: 'ai-delivery.worktree-transition-plan@1',
    repository: 'example/widget',
    repoRoot: f.root,
    row,
    purpose: 'active-resume',
    disposition: 'retain',
    terminalPrNumber: null,
    head: { sha: f.head, tree: f.tree },
    lineage: [],
    remoteRefs: null,
    retainedHoldCommentIds: [],
    holdEvidence: [],
    inventory: [],
    inventoryId: digestValue([]),
    historicalProducer: 'UNKNOWN',
    closure: {
      family: 'public-ai-delivery-0.3.5-posix@1',
      admissionPath: join(f.base, 'retained-admission.json'),
      archivePath: runtime.archivePath,
      admission: runtime.admission,
      admissionBytesDigest: digest,
      producerDigest: digest,
      runManifestIds: [digest],
    },
    currentRuntime: runtime.admission,
    policyDigest: digestBytes(readFileSync(join(f.root, 'ai-delivery.policy.mjs'))),
    operator: { actorLogin: 'operator', credentialIdentity: 'user:42' },
    reviewerActor: 'reviewer[bot]',
  };
  const plan = WorktreeTransitionPlanSchema.parse({ ...content, planId: digestValue(content) });
  const planPath = join(f.base, 'transition.json');
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  const result = await c.call('issue_worktree_transition_apply', {
    authority: 'worktree:transition',
    planPath,
    expectedPlanId: plan.planId,
    relinquishmentCommentId: 201,
    acceptanceCommentId: 202,
  });
  assert.equal(result.response.isError, true);
  assert.match(result.text, /Historical repository configuration binding is unsupported/u);
  assert.equal(existsSync(f.target), true);
  assert.equal(
    existsSync(join(f.root, '.git/ai-delivery/worktree-transitions', plan.planId.slice(7), 'intent.json')),
    false,
  );
  assert.equal(existsSync(runtime.lifecycleSentinel), false);
}

for (const kind of ['tracked', 'edited'] satisfies PolicyState[]) {
  if (kind === 'tracked') {
    scopedRuntimeCase(
      'public MCP runtime_stage asserts first install in 15s setup and exact reuse/lifecycle control in 15s body with tracked policy inert',
      prepareStage,
      async ({ f, c, runtime, staged }) => {
        const reused = await c.call('runtime_stage', runtime.stage);
        assert.notEqual(reused.response.isError, true, reused.text);
        assert.equal(reused.value!.stageId, staged.value!.stageId);
        assert.equal(reused.value!.reused, true);
        await lifecycleControl(f, runtime);
      },
    );
    scopedRuntimeCase(
      'public MCP runtime_admit binds and reuses exact stage bytes after 15s real stage setup and leaves tracked policy inert',
      prepareStage,
      async ({ f, c, runtime, staged }) => {
        const args = {
          ...runtime.common,
          authority: 'runtime:admit',
          stageId: staged.value!.stageId,
          expectedPriorAdmissionSha256: null,
        };
        const admitted = await c.call('runtime_admit', args);
        assert.notEqual(admitted.response.isError, true, admitted.text);
        const disk = JSON.parse(
          readFileSync(join(f.root, '.git/ai-delivery/runtime-admission.json'), 'utf8'),
        ) as unknown;
        assert.deepEqual(disk, admitted.value!.admission);
        const reused = await c.call('runtime_admit', args);
        assert.notEqual(reused.response.isError, true, reused.text);
        assert.equal(reused.value!.reused, true);
        assert.deepEqual(reused.value!.admission, disk);
        assert.equal(existsSync(runtime.lifecycleSentinel), false);
      },
    );
  } else {
    test('public MCP runtime_stage refuses primary source edits and leaves edited policy inert', async ({ signal }) => {
      const f = inertTarget(signal);
      let c: Connection | undefined;
      try {
        const runtime = await runtimeFixture(f);
        f.policy('edited');
        c = await f.connect();
        const result = await c.call('runtime_stage', runtime.stage);
        assert.equal(result.response.isError, true);
        assert.match(result.text, /Delivery requires an exact clean worktree\./u);
        assert.equal(existsSync(runtime.common.runtimeDirectory), false);
      } finally {
        await f.dispose(c);
      }
    }, 15_000);
    test('public MCP runtime_admit refuses primary source edits and leaves edited policy inert', async ({ signal }) => {
      const f = inertTarget(signal);
      let c: Connection | undefined;
      try {
        const runtime = await runtimeFixture(f);
        f.policy('tracked');
        c = await f.connect();
        const staged = await c.call('runtime_stage', runtime.stage);
        assert.notEqual(staged.response.isError, true, staged.text);
        f.policy('edited');
        const admitted = await c.call('runtime_admit', {
          ...runtime.common,
          authority: 'runtime:admit',
          stageId: staged.value!.stageId,
          expectedPriorAdmissionSha256: null,
        });
        assert.equal(admitted.response.isError, true);
        assert.match(admitted.text, /Delivery requires an exact clean worktree\./u);
        assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
        assert.equal(existsSync(runtime.lifecycleSentinel), false);
      } finally {
        await f.dispose(c);
      }
    }, 15_000);
  }

  test(`public MCP investigation start ${kind === 'tracked' ? 'registers exact selected source' : 'refuses selected worktree edits'} with ${kind} policy`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let c: Connection | undefined;
    try {
      f.worktree();
      f.policy(kind, f.target);
      assert.equal(fixtureGit(f.root, 'status', '--porcelain'), '');
      c = await f.connect();
      const args = { issueNumber: 17, investigationWorktree: f.target, expectedHeadSha: f.head };
      const result = await c.call('issue_start', args);
      if (kind === 'edited') {
        assert.equal(result.response.isError, true);
        assert.match(result.text, /Delivery requires an exact clean worktree\./u);
        assert.equal(readInvestigationPreparation(f.root, 17), undefined);
      } else {
        assert.notEqual(result.response.isError, true, result.text);
        const preparation = readInvestigationPreparation(f.root, 17)!;
        assert.equal(preparation.head.sha, f.head);
        assert.equal(preparation.row.path, f.target);
        assert.equal(f.comments.length, 1);
        const again = await c.call('issue_start', args);
        assert.notEqual(again.response.isError, true, again.text);
        assert.equal(f.comments.length, 1);
        assert.deepEqual(again.value!.preparation, result.value!.preparation);
      }
    } finally {
      await f.dispose(c);
    }
  }, 15_000);

  test(`public MCP investigation finish ${kind === 'tracked' ? 'removes only acknowledged selected custody' : 'refuses selected worktree edits'} with ${kind} policy`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let c: Connection | undefined;
    try {
      f.worktree();
      f.policy('tracked', f.target);
      c = await f.connect();
      const start = await c.call('issue_start', {
        issueNumber: 17,
        investigationWorktree: f.target,
        expectedHeadSha: f.head,
      });
      assert.notEqual(start.response.isError, true, start.text);
      const preparation = readInvestigationPreparation(f.root, 17)!;
      const resultPath = join(f.base, 'durable-result.txt');
      writeFileSync(resultPath, 'Fictional result: unchanged source; all producers stopped.\n', { mode: 0o600 });
      const resultDigest = digestBytes(readFileSync(resultPath));
      f.state.issueState = 'closed';
      f.addComment(201, investigationAuthorityBody(preparation, resultDigest));
      f.addComment(202, investigationAcceptanceBody(preparation, resultDigest, 201), true);
      if (kind === 'edited') f.policy('edited', f.target);
      assert.equal(fixtureGit(f.root, 'status', '--porcelain'), '');
      const args = {
        issueNumber: 17,
        investigation: true,
        resultPath,
        authorityCommentId: 201,
        acceptanceCommentId: 202,
      };
      const result = await c.call('issue_finish', args);
      if (kind === 'edited') {
        assert.equal(result.response.isError, true);
        assert.match(result.text, /Delivery requires an exact clean worktree\./u);
        assert.equal(existsSync(f.target), true);
      } else {
        assert.notEqual(result.response.isError, true, result.text);
        assert.equal(result.value!.completed, true);
        assert.equal(existsSync(f.target), false);
        assert.equal(fixtureGit(f.root, 'rev-parse', 'refs/heads/issue/17'), f.head);
        assert.equal(existsSync(resultPath), true);
        const replay = await c.call('issue_finish', args);
        assert.notEqual(replay.response.isError, true, replay.text);
        assert.equal(replay.value!.replayed, true);
      }
      assert.equal(f.state.closedCount, 0);
      assert.equal(
        f.calls.some((value) => value.name === 'pulls.merge'),
        false,
      );
    } finally {
      await f.dispose(c);
    }
  }, 15_000);

  test(`public MCP transition inspect inventories legacy custody and names reached guard with ${kind} policy`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let c: Connection | undefined;
    try {
      f.worktree();
      const row = {
        branch: 'issue/17',
        path: f.target,
        issueNumber: 17,
        identity: 'author',
        type: 'issue',
        status: 'active',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      };
      writeFileSync(join(f.root, '.issue-cli/worktrees.json'), JSON.stringify({ worktrees: [row] }));
      mkdirSync(join(f.root, '.issue-cli/issues/17'), { recursive: true });
      writeFileSync(join(f.root, '.issue-cli/issues/17', 'fictional.txt'), 'Preserved original evidence.\n');
      f.policy(kind, f.target);
      c = await f.connect();
      const result = await c.call('issue_worktree_transition_inspect', {
        issueNumber: 17,
        purpose: 'active-resume',
        disposition: 'retain',
      });
      assert.notEqual(result.response.isError, true, result.text);
      assert.equal(result.value!.ready, false);
      assert.equal(result.value!.plan, null);
      assert.ok((result.value!.inventory as unknown[]).length > 0, 'Inventory owner must be reached');
      assert.match(
        JSON.stringify(result.value!.blockers),
        kind === 'tracked'
          ? /Missing retained supported public producer admission\/archive/u
          : /Delivery requires an exact clean worktree\./u,
      );
      assert.equal(existsSync(f.target), true);
      assert.equal(
        readFileSync(join(f.root, '.issue-cli/issues/17/fictional.txt'), 'utf8'),
        'Preserved original evidence.\n',
      );
    } finally {
      await f.dispose(c);
    }
  }, 15_000);

  if (kind === 'tracked') {
    scopedRuntimeCase(
      'public MCP transition apply reaches unsupported historical binding after 15s real stage/admit/reconnect setup without loading tracked policy',
      async (scope) => prepareTransition(scope.acquire()),
      async ({ f, c, runtime }) => observeTransition(f, c, runtime, 'tracked'),
    );
  } else {
    test('public MCP transition apply reaches unsupported historical binding without loading edited policy', async ({
      signal,
    }) => {
      const f = inertTarget(signal);
      let c: Connection | undefined;
      try {
        const prepared = await prepareTransition(f);
        c = prepared.c;
        await observeTransition(f, c, prepared.runtime, 'edited');
      } finally {
        await f.dispose(c);
      }
    }, 15_000);
  }
}
