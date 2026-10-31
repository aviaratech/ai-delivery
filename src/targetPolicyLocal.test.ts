import assert from 'node:assert/strict';
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import { inertTarget } from './fixtures/inertTarget.js';

type Fixture = ReturnType<typeof inertTarget>;
type Scope = ReturnType<typeof runtimeScope>;

const ASSERTED_MS = 15_000;
const DRAIN_MS = 15_000;
const GIT_MS = 5_000;
const REQUEST_MS = 60_000; // Existing MCP initialize/callTool request bound.
type SetupStep = readonly [name: string, budgetMs: number];
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
