import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { digestBytes, digestValue } from './delivery/common.js';
import { investigationAcceptanceBody, investigationAuthorityBody } from './pr.js';
import { readInvestigationPreparation } from './services/worktreeRegistry.js';
import { WorktreeTransitionPlanSchema } from './worktreeTransition.js';
import { fixtureGit, inertTarget, type PolicyState } from './fixtures/inertTarget.js';

type Fixture = ReturnType<typeof inertTarget>;
type Connection = Awaited<ReturnType<Fixture['connect']>>;
type Scope = ReturnType<typeof runtimeScope>;

const ASSERTED_MS = 15_000;
const DRAIN_MS = 15_000;
const GIT_MS = 5_000;
const REQUEST_MS = 60_000; // Existing MCP initialize/callTool request bound.
type SetupStep = readonly [name: string, budgetMs: number];
// Acquisition has seven 5s Git calls. Policy has three Git calls and one 5s
// child. Archive is one 5s tar; local config retains its former 15s bound.
// Closing is handler drain, not a new 60s request allowance.
const stageSteps = [
  ['fixture', 7 * GIT_MS],
  ['archive', GIT_MS],
  ['config', ASSERTED_MS],
  ['policy', 4 * GIT_MS],
  ['connect', REQUEST_MS],
  ['runtime_stage', REQUEST_MS],
] as const satisfies readonly SetupStep[];
const transitionSteps = [
  ['fixture', 7 * GIT_MS],
  ['worktree', GIT_MS],
  ['connect', REQUEST_MS],
  ['archive', GIT_MS],
  ['config', ASSERTED_MS],
  ['runtime_stage', REQUEST_MS],
  ['runtime_admit', REQUEST_MS],
  ['close', DRAIN_MS],
  ['reconnect', REQUEST_MS],
] as const satisfies readonly SetupStep[];
type Phase = {
  name: string;
  budgetMs: number;
  started: number;
  elapsedMs?: number;
  outcome: 'running' | 'passed' | 'failed' | 'cancelled' | 'deadline' | 'drain-stall';
};

// Each scoped case owns its fixture, signal bridge, operation promises and disposal.
// A hook deadline can reject before the real MCP handler settles; join never releases
// fixture globals until the existing active-handler drain completes.
function runtimeScope(steps: readonly SetupStep[] = []) {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const unlink = new Set<() => void>();
  let cleanup: (() => Promise<void>) | undefined;
  let disposal: Promise<void> | undefined;
  let joined: Promise<void> | undefined;
  const scope = {
    controller,
    signal: controller.signal,
    pending,
    phases: [] as Phase[],
    steps,
    nextStep: 0,
    fixture: undefined as Fixture | undefined,
    forward(signal: AbortSignal): void {
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        unlink.add(() => signal.removeEventListener('abort', abort));
      }
    },
    acquire(fixtureCancellation?: AbortSignal): Fixture {
      controller.signal.throwIfAborted();
      assert.equal(scope.fixture, undefined, 'Each case acquires exactly one fixture');
      // Expected fixture cancellation must not cancel the scope that still owns
      // the cancellation assertions and actual handler/disposal join.
      const signal = fixtureCancellation
        ? AbortSignal.any([controller.signal, fixtureCancellation])
        : controller.signal;
      scope.fixture = inertTarget(signal, (ownedCleanup) => {
        cleanup = ownedCleanup;
      });
      return scope.fixture;
    },
    join(): Promise<void> {
      if (joined) return joined;
      // This disposal remains owned after a stalled observation. Transport
      // rejection or elapsed time never authorizes fixture/global removal.
      disposal ??= (async () => {
        controller.abort(new Error('Owned scoped runtime case finished'));
        try {
          while (pending.size) await Promise.allSettled(pending);
          await cleanup?.();
        } finally {
          for (const remove of unlink) remove();
          unlink.clear();
        }
      })();
      const phase: Phase = { name: 'drain', budgetMs: DRAIN_MS, started: performance.now(), outcome: 'running' };
      scope.phases.push(phase);
      let timer: ReturnType<typeof setTimeout>;
      joined = Promise.race([
        disposal,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            phase.outcome = 'drain-stall';
            reject(new Error('Owned drain-stall: real handler/disposal did not settle within 15000ms'));
          }, DRAIN_MS);
        }),
      ])
        .then(
          () => {
            phase.outcome = 'passed';
          },
          (error: unknown) => {
            if (phase.outcome !== 'drain-stall') phase.outcome = 'failed';
            throw error;
          },
        )
        .finally(() => {
          clearTimeout(timer);
          phase.elapsedMs = performance.now() - phase.started;
          joined = undefined; // Later joins observe the SAME actual disposal.
        });
      return joined;
    },
  };
  return scope;
}

async function scopedPhase<T>(scope: Scope, name: string, budgetMs: number, operation: () => Promise<T>) {
  scope.signal.throwIfAborted();
  const started = performance.now();
  const timeout = new Error(`Owned ${name} deadline exceeded (${budgetMs}ms)`);
  const phase: Phase = { name, budgetMs, started, outcome: 'running' };
  scope.phases.push(phase);
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
  // Cancellation may win the observation; actual work remains owned until settled.
  void pending.then(
    () => scope.pending.delete(pending),
    () => scope.pending.delete(pending),
  );
  let removeAbort = () => {};
  try {
    const value = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const abort = () => reject(scope.signal.reason);
        removeAbort = () => scope.signal.removeEventListener('abort', abort);
        scope.signal.addEventListener('abort', abort, { once: true });
        if (scope.signal.aborted) abort();
      }),
    ]);
    phase.outcome = 'passed';
    return value;
  } catch (error) {
    phase.outcome = scope.signal.reason === timeout ? 'deadline' : scope.signal.aborted ? 'cancelled' : 'failed';
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbort();
    phase.elapsedMs = performance.now() - started;
  }
}

async function setupStep<T>(scope: Scope, name: string, operation: () => T | Promise<T>): Promise<T> {
  const declared = scope.steps[scope.nextStep++];
  assert.ok(declared, `Undeclared setup operation: ${name}`);
  assert.equal(name, declared[0], 'Setup must execute the declared ledger in order');
  return scopedPhase(scope, `setup:${name}`, declared[1], async () => operation());
}

async function prepareScope<T>(scope: Scope, prepare: () => Promise<T>) {
  try {
    const prepared = await prepare();
    assert.equal(scope.nextStep, scope.steps.length, 'Every declared setup operation must complete');
    return prepared;
  } catch (error) {
    scope.controller.abort(error);
    await scope.join();
    throw error;
  }
}

test(
  'sequential setup operations may exceed the former aggregate budget while each operation stays bounded',
  { tags: ['release'] },
  async () => {
    const scope = runtimeScope([
      ['first', 10_000],
      ['second', 10_000],
    ]);
    const observed: number[] = [];
    vi.useFakeTimers();
    try {
      const result = prepareScope(scope, async () => {
        for (const [name, step] of [
          ['first', 1],
          ['second', 2],
        ] as const)
          await setupStep(scope, name, async () => {
            await new Promise((resolve) => setTimeout(resolve, 8_000));
            observed.push(step);
          });
        return 'prepared';
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(16_000);
      assert.equal(await result, 'prepared');
      assert.deepEqual(observed, [1, 2]);
      assert.deepEqual(
        scope.phases.map(({ name, outcome }) => ({ name, outcome })),
        [
          { name: 'setup:first', outcome: 'passed' },
          { name: 'setup:second', outcome: 'passed' },
        ],
      );
    } finally {
      vi.useRealTimers();
      await scope.join();
    }
  },
);

test(
  'held real handler reports a finite drain stall, retains ownership and permits cleanup only after late settlement',
  { tags: ['release'], timeout: 30_000 },
  async ({ signal }) => {
    const scope = runtimeScope();
    scope.forward(signal);
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
      const c = await f.connect();
      const call = c.call('issue_info', { issueNumber: 17 }).catch((error: unknown) => error);
      await reached;
      vi.useFakeTimers();
      let outcome: unknown;
      const joined = scope.join().then(
        () => {
          outcome = 'drained';
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(15_000);
      assert.ok(outcome instanceof Error, 'A held handler must produce a finite drain-stall outcome');
      assert.match(outcome.message, /drain-stall/u);
      assert.equal(handlerSettled, false);
      assert.equal(existsSync(f.root), true);
      assert.throws(() => inertTarget(signal), /previous fixture must finish disposal/u);
      await joined;
      release();
      await scope.join();
      await call;
      assert.equal(handlerSettled, true);
      assert.equal(existsSync(f.base), false);
      const next = inertTarget(signal);
      await next.dispose(undefined);
    } finally {
      vi.useRealTimers();
      release();
      await scope.join();
    }
  },
);

for (const phase of ['setup', 'asserted body'])
  test(`an individual ${phase} stall aborts without dropping unsettled work`, { tags: ['release'] }, async () => {
    const scope = runtimeScope([['controlled', 1_000]]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.useFakeTimers();
    try {
      const result = (
        phase === 'setup'
          ? setupStep(scope, 'controlled', () => held)
          : scopedPhase(scope, phase, ASSERTED_MS, () => held)
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(phase === 'setup' ? 1_000 : ASSERTED_MS);
      assert.match(String(await result), /deadline exceeded/u);
      assert.equal(scope.signal.aborted, true);
      assert.equal(scope.pending.size, 1, 'Cancellation must not erase the unsettled operation');
      assert.equal(scope.phases[0]!.outcome, 'deadline');
    } finally {
      vi.useRealTimers();
      release();
      await scope.join();
      assert.equal(scope.pending.size, 0);
    }
  });

const faultSteps = [
  ['fixture', 7 * GIT_MS],
  ['connect', REQUEST_MS],
] as const satisfies readonly SetupStep[];
const faultBudget = faultSteps.reduce((sum, [, budget]) => sum + budget, 0) + DRAIN_MS;
type SupervisedCommand = {
  status: string;
  exitCode: number | null;
  cleanupConfirmed?: boolean;
  observedProcesses: { pid: number; birth: string }[];
};
const neverReleasedCase =
  'never-released real handler fails in a supervised native test process and is reaped before cleanup';
test(neverReleasedCase, { tags: ['release'], timeout: faultBudget + 4_000 }, async ({ signal }) => {
  const recordPath = process.env['AI_DELIVERY_DRAIN_FAULT_RECORD'];
  if (recordPath) {
    // Only the supervised child enters this fault. It deliberately never releases
    // the real handler; an active handle prevents an idle event loop hiding it.
    const scope = runtimeScope(faultSteps);
    scope.forward(signal);
    const f = await setupStep(scope, 'fixture', () => scope.acquire());
    const owned = lstatSync(f.base);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.rest.issues.get = async () => {
      setInterval(() => {}, 1_000);
      entered();
      await new Promise<never>(() => {});
      throw new Error('Never released');
    };
    const c = await setupStep(scope, 'connect', () => f.connect());
    void c.call('issue_info', { issueNumber: 17 }).catch(() => {});
    await reached;
    try {
      await scope.join();
      assert.fail('A never-released real handler cannot drain');
    } catch (error) {
      assert.match(String(error), /drain-stall/u);
      assert.equal(existsSync(f.base), true);
      assert.throws(() => inertTarget(signal), /previous fixture must finish disposal/u);
      writeFileSync(
        recordPath,
        JSON.stringify({
          base: f.base,
          dev: owned.dev,
          ino: owned.ino,
          uid: owned.uid,
          retainedOwnership: true,
          phases: scope.phases,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      throw error;
    }
  }
  const checks = (await import(new URL('../scripts/checks.mjs', import.meta.url).href)) as {
    safeEnvironment(input: Record<string, string>): Record<string, string>;
    executeCommand(
      command: string[],
      options: {
        cwd: string;
        env: Record<string, string>;
        directory: string;
        signal: AbortSignal;
        timeoutMs: number;
        maxRssBytes: number;
        progress: (record: unknown) => void;
      },
    ): Promise<SupervisedCommand>;
    confirmCommandQuiescence(command: SupervisedCommand): { quiescent: boolean };
  };
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-drain-fault-evidence-')));
  const temporary = join(evidence, 'temporary');
  mkdirSync(temporary);
  const record = join(evidence, 'retained-handler.json');
  const unrelated = join(evidence, 'unrelated');
  writeFileSync(unrelated, 'preserved');
  const started = performance.now();
  const command = await checks.executeCommand(
    [
      process.execPath,
      fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run',
      '--mode=compiled',
      fileURLToPath(import.meta.url),
      '-t',
      neverReleasedCase,
      '--reporter=json',
      '--outputFile=' + join(evidence, 'vitest.json'),
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...checks.safeEnvironment(process.env as Record<string, string>),
        TMPDIR: temporary,
        AI_DELIVERY_DRAIN_FAULT_RECORD: record,
      },
      directory: join(evidence, 'command'),
      signal,
      timeoutMs: faultBudget,
      maxRssBytes: 1024 ** 3,
      progress: (partial) => writeFileSync(join(evidence, 'supervision.json'), JSON.stringify(partial)),
    },
  );
  assert.ok(['failed', 'command-timeout', 'owned-child-remained-after-command'].includes(command.status));
  assert.notEqual(command.exitCode, 0);
  assert.equal(command.cleanupConfirmed, true);
  assert.equal(checks.confirmCommandQuiescence(command).quiescent, true);
  assert.ok(
    performance.now() - started <= faultBudget + 4_000,
    'Fault supervision must finish within its declared budget and termination grace',
  );
  assert.ok(command.observedProcesses.length > 0);
  const retained = JSON.parse(readFileSync(record, 'utf8')) as {
    base: string;
    dev: number;
    ino: number;
    uid: number;
    retainedOwnership: boolean;
    phases: Phase[];
  };
  assert.equal(retained.retainedOwnership, true);
  assert.ok(retained.phases.some((phase) => phase.name === 'drain' && phase.outcome === 'drain-stall'));
  assert.ok(retained.base.startsWith(temporary + '/ai-delivery-inert-target-'));
  const owned = lstatSync(retained.base);
  assert.equal(owned.isSymbolicLink(), false);
  assert.deepEqual([owned.dev, owned.ino, owned.uid], [retained.dev, retained.ino, retained.uid]);
  assert.equal(readFileSync(unrelated, 'utf8'), 'preserved');
  // Termination/quiescence is the alternative to actual settlement. Only now may
  // this parent's exact child temporary root be removed. Keep original evidence.
  rmSync(temporary, { recursive: true });
  assert.equal(existsSync(temporary), false);
  const receipt = {
    elapsedMs: performance.now() - started,
    faultBudgetMs: faultBudget,
    command,
    ownedTemporaryRemoved: true,
    unrelatedPreserved: true,
    evidence,
  };
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(receipt, null, 2));
  process.stdout.write('DRAIN_FAULT_SUPERVISION_RECEIPT ' + JSON.stringify(receipt) + '\n');
}); // Existing supervisor: 3s TERM grace + 1s quiescence confirmation.

function scopedRuntimeCase<T extends object>(
  name: string,
  steps: readonly SetupStep[],
  prepare: (scope: Scope) => Promise<T>,
  observe: (prepared: T) => Promise<void>,
) {
  describe('per-operation runtime preparation (15s asserted work, 15s drain)', () => {
    let owned: { scope: Scope; prepared?: T; ready: boolean } | undefined;
    beforeEach(
      async ({ signal }) => {
        assert.equal(owned, undefined, 'Previous case must finish owned teardown');
        const scope = runtimeScope(steps);
        owned = { scope, ready: false };
        scope.forward(signal);
        owned.prepared = await prepareScope(scope, () => prepare(scope));
        owned.ready = true;
      },
      steps.reduce((sum, [, budget]) => sum + budget, 0) + DRAIN_MS,
    );
    afterEach(async () => {
      const current = owned;
      if (current) {
        await current.scope.join();
        process.stderr.write('ai-delivery.fixture-phases ' + JSON.stringify(current.scope.phases) + '\n');
        owned = undefined;
      }
    }, ASSERTED_MS + DRAIN_MS);
    test(name, { tags: ['release'], timeout: ASSERTED_MS + DRAIN_MS }, async ({ signal }) => {
      const current = owned;
      assert.ok(current?.ready, 'Real case prerequisites must finish before the asserted body');
      assert.ok(current.prepared);
      const prepared = current.prepared;
      current.scope.forward(signal);
      try {
        await scopedPhase(current.scope, 'asserted body', ASSERTED_MS, () => observe(prepared));
      } finally {
        await current.scope.join();
      }
    });
  });
}

async function runtimeFixture(f: Fixture, scope?: Scope) {
  f.signal.throwIfAborted();
  const archive = () => {
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
    return { archivePath, lifecycleSentinel };
  };
  const { archivePath, lifecycleSentinel } = scope ? await setupStep(scope, 'archive', archive) : archive();
  const config = () =>
    loadDeliveryConfig(f.root, {
      repository: 'example/widget',
      signal: f.signal,
      clients: { graphql: f.graphql } as never,
    });
  const loaded = scope ? await setupStep(scope, 'config', config) : await config();
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

const cancellationSteps = [
  ['fixture', 7 * GIT_MS],
  ['policy', 4 * GIT_MS],
  ['connect', REQUEST_MS],
] as const satisfies readonly SetupStep[];

for (const preparationDelayMs of [0, 3_000])
  test(
    preparationDelayMs === 0
      ? 'fixture cancellation drains the real MCP handler before releasing global ownership'
      : 'fixture cancellation and reuse keep bounded preparation outside asserted-work budgets',
    {
      tags: ['release'],
      timeout: 2 * (cancellationSteps.reduce((sum, [, budget]) => sum + budget, 0) + ASSERTED_MS + 2 * DRAIN_MS),
    },
    async ({ signal }) => {
      const first = runtimeScope(cancellationSteps);
      const reuse = runtimeScope(cancellationSteps);
      first.forward(signal);
      reuse.forward(signal);
      const cancellation = new AbortController();
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const prepare = (scope: Scope, fixtureCancellation?: AbortSignal) =>
        prepareScope(scope, async () => {
          const f = await setupStep(scope, 'fixture', async () => {
            if (preparationDelayMs) await new Promise((resolve) => setTimeout(resolve, preparationDelayMs));
            return scope.acquire(fixtureCancellation);
          });
          await setupStep(scope, 'policy', () => f.policy('tracked'));
          const connection = await setupStep(scope, 'connect', () => f.connect());
          return { f, connection };
        });
      try {
        const { f, connection } = await prepare(first, cancellation.signal);
        const get = f.rest.issues.get;
        let portSettled = false;
        f.rest.issues.get = async (input) => {
          entered();
          await held;
          portSettled = true;
          return get(input);
        };
        await scopedPhase(first, 'asserted cancellation', ASSERTED_MS, async () => {
          const pending = connection.call('issue_info', { issueNumber: 17 });
          const rejected = assert.rejects(pending, /Controlled fixture cancellation/u);
          // Observe immediately, then join below; an early transport failure must
          // also release the wait for real handler entry rather than strand it.
          void rejected.catch(() => {});
          await Promise.race([
            reached,
            pending.then(() => {
              throw new Error('Controlled real handler was not reached');
            }),
          ]);
          cancellation.abort(new Error('Controlled fixture cancellation'));
          const disposal = f.dispose(connection);
          assert.equal(f.dispose(connection), disposal, 'All disposal callers must join the same promise');
          let disposed = false;
          void disposal.then(
            () => {
              disposed = true;
            },
            () => {},
          );
          await rejected;
          assert.equal(portSettled, false);
          assert.equal(disposed, false, 'Transport cancellation must not be treated as handler settlement');
          assert.equal(existsSync(f.root), true, 'Files remain owned until the handler settles');
          assert.throws(() => inertTarget(signal), /previous fixture must finish disposal/u);
          release();
        });
        await first.join();
        assert.equal(portSettled, true);
        assert.equal(existsSync(f.base), false);

        const next = await prepare(reuse);
        if (preparationDelayMs) {
          const setupElapsed = [first, reuse].flatMap((scope) =>
            scope.phases.filter((phase) => phase.name.startsWith('setup:')),
          );
          assert.ok(
            setupElapsed.reduce((sum, phase) => sum + phase.elapsedMs!, 0) > 5_000,
            'Two bounded preparations must exceed the former aggregate five-second fuse',
          );
        }
        await scopedPhase(reuse, 'asserted reuse', ASSERTED_MS, async () => {
          await f.dispose(connection);
          const result = await next.connection.call('issue_info', { issueNumber: 17 });
          assert.notEqual(result.response.isError, true, result.text);
          assert.ok(next.f.calls.some((call) => call.name === 'issues.get'));
        });
      } finally {
        release();
        try {
          await first.join();
        } finally {
          await reuse.join();
          process.stderr.write(
            'CANCELLATION_SCOPE_PHASES ' +
              JSON.stringify({ preparationDelayMs, first: first.phases, reuse: reuse.phases }) +
              '\n',
          );
        }
      }
    },
  );

test(
  'fixture disposal closes a cancelled MCP connection',
  { tags: ['release'], timeout: 5_000 },
  async ({ signal }) => {
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
  },
);

async function stageAndAdmit(f: Fixture, c: Connection, scope: Scope) {
  const runtime = await runtimeFixture(f, scope);
  const staged = await setupStep(scope, 'runtime_stage', () => c.call('runtime_stage', runtime.stage));
  assert.notEqual(staged.response.isError, true, staged.text);
  const admitted = await setupStep(scope, 'runtime_admit', () =>
    c.call('runtime_admit', {
      ...runtime.common,
      authority: 'runtime:admit',
      stageId: staged.value!.stageId,
      expectedPriorAdmissionSha256: null,
    }),
  );
  assert.notEqual(admitted.response.isError, true, admitted.text);
  return { ...runtime, stageId: staged.value!.stageId, admission: admitted.value!.admission };
}

for (const cancellation of ['hook signal', 'owned setup deadline'] as const) {
  test(
    `scoped runtime setup ${cancellation} aborts and drains a real handler before releasing globals`,
    { tags: ['release'], timeout: 5_000 },
    async ({ signal }) => {
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
        const setup = prepareScope(scope, () =>
          scopedPhase(scope, 'setup', cancellation === 'owned setup deadline' ? 1_000 : REQUEST_MS, async () => {
            const call = c.call('issue_info', { issueNumber: 17 });
            callOutcome = call.then(
              () => undefined,
              (error: unknown) => error,
            );
            return call;
          }),
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
    },
  );
}

test(
  'scoped runtime setup failure after connection acquisition drains and restores only owned globals',
  { tags: ['release'], timeout: 5_000 },
  async ({ signal }) => {
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
  },
);

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
  const f = await setupStep(scope, 'fixture', () => scope.acquire());
  const runtime = await runtimeFixture(f, scope);
  await setupStep(scope, 'policy', () => f.policy('tracked'));
  const c = await setupStep(scope, 'connect', () => f.connect());
  const staged = await setupStep(scope, 'runtime_stage', () => c.call('runtime_stage', runtime.stage));
  assert.notEqual(staged.response.isError, true, staged.text);
  assert.ok(existsSync(runtime.cli));
  assert.equal(existsSync(runtime.lifecycleSentinel), false);
  assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false, 'Staging must not admit');
  return { f, c, runtime, staged };
}

// The edited-policy refusal has the same real staged prerequisites, then one
// separately bounded tracked-to-edited transition (three Git calls, two controls).
const editedAdmitSteps = [...stageSteps, ['edited policy', 5 * GIT_MS]] as const satisfies readonly SetupStep[];

async function prepareEditedAdmit(scope: Scope) {
  const prepared = await prepareStage(scope);
  await setupStep(scope, 'edited policy', () => prepared.f.policy('edited'));
  return prepared;
}

async function observeEditedAdmit({ f, c, runtime, staged }: Awaited<ReturnType<typeof prepareEditedAdmit>>) {
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
}

for (const cancellation of ['operation deadline', 'forwarded cancellation'] as const)
  test(
    `edited runtime_admit preparation ${cancellation} retains its real stage handler through drain stall and late settlement`,
    { tags: ['release'], timeout: editedAdmitSteps.reduce((sum, [, budget]) => sum + budget, 0) + 2 * DRAIN_MS },
    async ({ signal }) => {
      const scope = runtimeScope(
        editedAdmitSteps.map(([name, budget]) => [name, name === 'runtime_stage' ? 3_000 : budget] as const),
      );
      const hook = new AbortController();
      scope.forward(signal);
      scope.forward(hook.signal);
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const acquire = scope.acquire.bind(scope);
      let handlerSettled = false;
      scope.acquire = () => {
        const f = acquire();
        const get = f.rest.repos.get;
        f.rest.repos.get = async (input) => {
          entered();
          await held;
          handlerSettled = true;
          return get(input);
        };
        return f;
      };
      try {
        const preparing = prepareScope(scope, () => prepareEditedAdmit(scope)).then(
          () => new Error('Controlled stage handler was not held'),
          (error: unknown) => error,
        );
        await Promise.race([
          reached,
          preparing.then((result) => {
            throw result;
          }),
        ]);
        const f = scope.fixture!;
        process.stderr.write('EDITED_REFUSAL_HELD ' + JSON.stringify({ cancellation, phases: scope.phases }) + '\n');
        // This actual stage owns native supervision too: keep real timers while
        // its held handler reaches the shortened fault-only operation deadline.
        if (cancellation === 'forwarded cancellation')
          hook.abort(new Error('Controlled edited-refusal setup cancellation'));
        assert.match(String(await preparing), /drain-stall/u);
        assert.equal(handlerSettled, false, 'Rejected transport cannot establish handler settlement');
        assert.equal(scope.signal.aborted, true);
        assert.equal(existsSync(f.base), true, 'Stalled handler must retain fixture and globals');
        assert.throws(() => inertTarget(signal), /previous fixture must finish disposal/u);
        assert.ok(
          scope.phases.some(
            (phase) =>
              phase.name === 'setup:runtime_stage' &&
              phase.outcome === (cancellation === 'operation deadline' ? 'deadline' : 'cancelled'),
          ),
        );
        assert.ok(scope.phases.some((phase) => phase.name === 'drain' && phase.outcome === 'drain-stall'));
        assert.equal(
          scope.phases.some((phase) => phase.name === 'setup:edited policy'),
          false,
        );
        release();
        await scope.join();
        assert.equal(handlerSettled, true);
        assert.equal(scope.pending.size, 0);
        assert.equal(existsSync(f.base), false);
        process.stderr.write(
          'EDITED_REFUSAL_OWNERSHIP ' +
            JSON.stringify({ cancellation, phases: scope.phases, rootRemoved: true }) +
            '\n',
        );
        const next = inertTarget(signal);
        await next.dispose(undefined);
      } finally {
        release();
        await scope.join();
      }
    },
  );

async function prepareTransition(scope: Scope) {
  const f = await setupStep(scope, 'fixture', () => scope.acquire());
  await setupStep(scope, 'worktree', () => f.worktree());
  let c = await setupStep(scope, 'connect', () => f.connect());
  const runtime = await stageAndAdmit(f, c, scope);
  await setupStep(scope, 'close', () => c.close());
  c = await setupStep(scope, 'reconnect', () => f.connect({ runtimeEntryPath: runtime.cli }));
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
      'public MCP runtime_stage asserts bounded first install and exact reuse/lifecycle control with tracked policy inert',
      stageSteps,
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
      'public MCP runtime_admit binds and reuses exact stage bytes after bounded real stage setup and leaves tracked policy inert',
      stageSteps,
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
    test(
      'public MCP runtime_stage refuses primary source edits and leaves edited policy inert',
      { tags: ['release'], timeout: 15_000 },
      async ({ signal }) => {
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
      },
    );
    scopedRuntimeCase(
      'public MCP runtime_admit refuses primary source edits and leaves edited policy inert',
      editedAdmitSteps,
      prepareEditedAdmit,
      observeEditedAdmit,
    );
    scopedRuntimeCase(
      'edited runtime_admit refusal keeps bounded preparation outside its asserted-work budget',
      [['controlled before fixture', 10_000], ...editedAdmitSteps, ['controlled after staging', 10_000]],
      async (scope) => {
        const started = performance.now();
        await setupStep(scope, 'controlled before fixture', () => new Promise((resolve) => setTimeout(resolve, 8_000)));
        const prepared = await prepareEditedAdmit(scope);
        await setupStep(scope, 'controlled after staging', () => new Promise((resolve) => setTimeout(resolve, 8_000)));
        assert.ok(performance.now() - started > ASSERTED_MS, 'Preparation must exceed the original aggregate fuse');
        return prepared;
      },
      observeEditedAdmit,
    );
  }

  test(
    `public MCP investigation start ${kind === 'tracked' ? 'registers exact selected source' : 'refuses selected worktree edits'} with ${kind} policy`,
    { tags: ['release'], timeout: 15_000 },
    async ({ signal }) => {
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
    },
  );

  test(
    `public MCP investigation finish ${kind === 'tracked' ? 'removes only acknowledged selected custody' : 'refuses selected worktree edits'} with ${kind} policy`,
    { tags: ['release'], timeout: 15_000 },
    async ({ signal }) => {
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
    },
  );

  test(
    `public MCP transition inspect inventories legacy custody and names reached guard with ${kind} policy`,
    { tags: ['release'], timeout: 15_000 },
    async ({ signal }) => {
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
    },
  );

  scopedRuntimeCase(
    `public MCP transition apply reaches unsupported historical binding after bounded stage/admit/reconnect without loading ${kind} policy`,
    transitionSteps,
    prepareTransition,
    async ({ f, c, runtime }) => observeTransition(f, c, runtime, kind),
  );
}
