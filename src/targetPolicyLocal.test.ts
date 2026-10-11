import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'vitest';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { digestBytes, digestValue } from './delivery/common.js';
import { investigationAcceptanceBody, investigationAuthorityBody } from './pr.js';
import { readInvestigationPreparation } from './services/worktreeRegistry.js';
import { WorktreeTransitionPlanSchema } from './worktreeTransition.js';
import { fixtureGit, inertTarget, type PolicyState } from './fixtures/inertTarget.js';

type Fixture = ReturnType<typeof inertTarget>;
type Connection = Awaited<ReturnType<Fixture['connect']>>;
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

for (const kind of ['tracked', 'edited'] satisfies PolicyState[]) {
  test(`public MCP runtime_stage ${kind === 'tracked' ? 'installs offline without lifecycle scripts' : 'refuses primary source edits'} and leaves ${kind} policy inert`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let c: Connection | undefined;
    try {
      const runtime = await runtimeFixture(f);
      f.policy(kind);
      c = await f.connect();
      const result = await c.call('runtime_stage', runtime.stage);
      if (kind === 'edited') {
        assert.equal(result.response.isError, true);
        assert.match(result.text, /Delivery requires an exact clean worktree\./u);
        assert.equal(existsSync(runtime.common.runtimeDirectory), false);
      } else {
        assert.notEqual(result.response.isError, true, result.text);
        assert.ok(existsSync(runtime.cli));
        assert.equal(existsSync(runtime.lifecycleSentinel), false);
        assert.equal(
          existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')),
          false,
          'Staging must not admit',
        );
        const reused = await c.call('runtime_stage', runtime.stage);
        assert.notEqual(reused.response.isError, true, reused.text);
        assert.equal(reused.value!.stageId, result.value!.stageId);
        assert.equal(reused.value!.reused, true);
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
    } finally {
      await f.dispose(c);
    }
  }, 15_000);

  test(`public MCP runtime_admit ${kind === 'tracked' ? 'binds and reuses exact stage bytes' : 'refuses primary source edits'} and leaves ${kind} policy inert`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let c: Connection | undefined;
    try {
      const runtime = await runtimeFixture(f);
      f.policy('tracked');
      c = await f.connect();
      const staged = await c.call('runtime_stage', runtime.stage);
      assert.notEqual(staged.response.isError, true, staged.text);
      if (kind === 'edited') f.policy('edited');
      const args = {
        ...runtime.common,
        authority: 'runtime:admit',
        stageId: staged.value!.stageId,
        expectedPriorAdmissionSha256: null,
      };
      const admitted = await c.call('runtime_admit', args);
      if (kind === 'edited') {
        assert.equal(admitted.response.isError, true);
        assert.match(admitted.text, /Delivery requires an exact clean worktree\./u);
        assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
      } else {
        assert.notEqual(admitted.response.isError, true, admitted.text);
        const disk = JSON.parse(
          readFileSync(join(f.root, '.git/ai-delivery/runtime-admission.json'), 'utf8'),
        ) as unknown;
        assert.deepEqual(disk, admitted.value!.admission);
        const reused = await c.call('runtime_admit', args);
        assert.notEqual(reused.response.isError, true, reused.text);
        assert.equal(reused.value!.reused, true);
        assert.deepEqual(reused.value!.admission, disk);
      }
      assert.equal(existsSync(runtime.lifecycleSentinel), false);
    } finally {
      await f.dispose(c);
    }
  }, 15_000);

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

  test(`public MCP transition apply reaches unsupported historical binding without loading ${kind} policy`, async ({
    signal,
  }) => {
    const f = inertTarget(signal);
    let c: Connection | undefined;
    try {
      f.worktree();
      c = await f.connect();
      const runtime = await stageAndAdmit(f, c);
      await c.close();
      c = await f.connect({ runtimeEntryPath: runtime.cli });
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
    } finally {
      await f.dispose(c);
    }
  }, 15_000);
}
