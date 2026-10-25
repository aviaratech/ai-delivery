import { producer, fixture, git, runtimeSetupState, type SetupInput } from './fixtures/runtimeSetup.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { z } from 'zod';

import { loadDeliveryConfig } from './config/deliveryConfig.js';
import * as privateFiles from './delivery/common.js';
import { digestBytes, digestValue } from './delivery/index.js';
import { type RuntimeAdmission } from './services/deliveryAdmission.js';
import * as atomicJson from './utils/atomicJson.js';

const { actors, sharedOutputRead } = runtimeSetupState;
afterEach(() => vi.unstubAllEnvs());

test('setup CLI preparation child', { tags: ['release'], skip: !process.env.AI_DELIVERY_CLI_PREPARE }, async () => {
  await prepareOwnedCliStage();
});

const stageAdmitCase = 'CLI stage and admit execute the same public producer with explicit authority and prior absence';
const preparedCliSchema = z.strictObject({
  ownerRoot: z.string(),
  base: z.string(),
  stageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  configPath: z.string(),
  npmBin: z.string(),
  author: z.literal('host-user'),
  reviewer: z.literal('reviewer[bot]'),
  input: z.strictObject({
    authority: z.literal('runtime:stage'),
    identity: z.literal('host-author'),
    repoRoot: z.string(),
    archivePath: z.string(),
    expectedArchiveSha256: z.string(),
    packageVersion: z.literal('0.3.5'),
    expectedSourceCommit: z.string(),
    expectedConfigDigest: z.string(),
    runtimeDirectory: z.string(),
  }),
  files: z.array(z.strictObject({ path: z.string(), digest: z.string() })).length(6),
});
type PreparedCli = z.infer<typeof preparedCliSchema>;

function preparedCliClosure(input: SetupInput): void {
  const npmRoot = join(dirname(process.execPath), '../lib/node_modules/npm');
  assert.equal(
    (JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')) as { version: string }).version,
    '11.19.0',
  );
  const result = spawnSync(
    process.execPath,
    [
      join(npmRoot, 'bin/npm-cli.js'),
      'ls',
      '--prefix',
      input.runtimeDirectory,
      '--omit=dev',
      '--all',
      '--json',
      '--logs-max',
      '0',
    ],
    {
      cwd: input.repoRoot,
      encoding: 'utf8',
      maxBuffer: 1024 ** 2,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const graph = JSON.parse(result.stdout) as {
    problems?: string[];
    dependencies: Record<string, { version: string; resolved: string; invalid?: unknown; missing?: unknown }>;
  };
  assert.equal(graph.problems, undefined);
  const dependency = graph.dependencies['@aviaratech/ai-delivery']!;
  assert.equal(dependency.version, input.packageVersion);
  assert.equal(dependency.resolved, `file:${join(input.runtimeDirectory, 'reviewed-archive.tgz')}`);
  assert.equal(dependency.invalid, undefined);
  assert.equal(dependency.missing, undefined);
}

function readPreparedCli(ownerRoot: string): PreparedCli {
  assert.equal(realpathSync(ownerRoot), ownerRoot);
  const prepared = preparedCliSchema.parse(
    JSON.parse(
      privateFiles.assertPrivateFile(join(ownerRoot, 'prepared.json'), { maxBytes: 16 * 1024 }).toString('utf8'),
    ),
  );
  assert.equal(prepared.ownerRoot, ownerRoot);
  const below = (path: string): void => {
    const name = relative(ownerRoot, path);
    assert.ok(name !== '' && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name));
    assert.equal(realpathSync(path), path);
  };
  for (const path of [
    prepared.base,
    prepared.configPath,
    prepared.npmBin,
    prepared.input.repoRoot,
    prepared.input.archivePath,
    prepared.input.runtimeDirectory,
    ...prepared.files.map((f) => f.path),
  ])
    below(path);
  assert.equal(dirname(prepared.base), ownerRoot);
  assert.ok(prepared.base.split(sep).at(-1)!.startsWith('ai-delivery-setup-'));
  assert.equal(prepared.input.repoRoot, join(prepared.base, 'consumer'));
  assert.equal(prepared.input.runtimeDirectory, join(prepared.base, 'staged'));
  assert.equal(prepared.input.archivePath, join(prepared.base, 'reviewed archive; inert.tgz'));
  assert.equal(prepared.configPath, join(prepared.base, 'user.json'));
  assert.equal(prepared.npmBin, join(prepared.base, 'prepared-npm'));
  assert.equal(digestBytes(readFileSync(prepared.input.archivePath)), prepared.input.expectedArchiveSha256);
  assert.equal(git(prepared.input.repoRoot, 'rev-parse', 'HEAD'), prepared.input.expectedSourceCommit);
  assert.equal(git(prepared.input.repoRoot, 'status', '--porcelain'), '');
  const recordPath = join(prepared.input.runtimeDirectory, 'runtime-stage.json');
  const record = JSON.parse(privateFiles.assertPrivateFile(recordPath).toString('utf8')) as {
    status: string;
    stageId: string;
    recordId: string;
    intent: Record<string, unknown>;
  };
  const { recordId, ...content } = record;
  assert.equal(digestValue(content), recordId);
  assert.equal(record.status, 'complete');
  assert.equal(record.stageId, prepared.stageId, 'Prepared CLI stage identity mismatch');
  assert.equal(digestValue(record.intent), prepared.stageId);
  for (const [field, value] of Object.entries({
    repoRoot: prepared.input.repoRoot,
    runtimeDirectory: prepared.input.runtimeDirectory,
    sourceCommit: prepared.input.expectedSourceCommit,
    configDigest: prepared.input.expectedConfigDigest,
    archivePath: prepared.input.archivePath,
    archiveSha256: prepared.input.expectedArchiveSha256,
    packageVersion: prepared.input.packageVersion,
  }))
    assert.equal(record.intent[field], value);
  assert.deepEqual(record.intent.resourceBounds, {
    maxAggregateRssBytes: 1024 ** 3,
    minFreeDiskBytes: 256 * 1024 ** 2,
    maxNewOutputBytes: 512 * 1024 ** 2,
    maxCapturedOutputBytes: 1024 ** 2,
  });
  const expectedPaths = [
    recordPath,
    join(prepared.input.runtimeDirectory, 'package.json'),
    join(prepared.input.runtimeDirectory, 'package-lock.json'),
    join(prepared.input.runtimeDirectory, 'reviewed-archive.tgz'),
    join(prepared.input.runtimeDirectory, 'node_modules/@aviaratech/ai-delivery/dist/cli.js'),
    prepared.configPath,
  ];
  assert.deepEqual(
    prepared.files.map((f) => f.path),
    expectedPaths,
  );
  for (const file of prepared.files) assert.equal(digestBytes(readFileSync(file.path)), file.digest);
  assert.equal(readFileSync(join(prepared.base, 'installs'), 'utf8'), 'x');
  return prepared;
}

async function prepareOwnedCliStage(): Promise<void> {
  const ownerRoot = process.env.AI_DELIVERY_CLI_PREPARE!;
  const f = await fixture(false, ownerRoot);
  const previousPath = process.env.PATH;
  const scenario = process.env.AI_DELIVERY_STAGE_ADMIT_SCENARIO;
  try {
    writeFileSync(join(f.base, 'unrelated-preparation'), 'unrelated');
    const npmRoot = join(dirname(process.execPath), '../lib/node_modules/npm');
    assert.equal(
      (JSON.parse(readFileSync(join(npmRoot, 'package.json'), 'utf8')) as { version: string }).version,
      '11.19.0',
    );
    const npmBin = join(f.base, 'prepared-npm');
    mkdirSync(npmBin);
    writeFileSync(
      join(npmBin, 'npm'),
      `#!${process.execPath}\nconst fs=require('node:fs'),assert=require('node:assert/strict');if(process.argv[2]==='install'){assert.ok(process.argv.includes('--ignore-scripts'));fs.appendFileSync(${JSON.stringify(f.counter)},'x');fs.writeFileSync(${JSON.stringify(f.marker)},String(process.pid));}${scenario === 'preparation-failure' ? "process.argv[2]='synthetic-unknown-command';" : ''}${scenario === 'preparation-cancel' ? 'setInterval(()=>{},1000);' : ''}require(${JSON.stringify(join(npmRoot, 'bin/npm-cli.js'))});\n`,
    );
    chmodSync(join(npmBin, 'npm'), 0o755);
    process.env.PATH = `${npmBin}:${previousPath ?? ''}`;
    const stage = await (await producer()).stageRuntime(f.input);
    preparedCliClosure(f.input);
    assert.equal(stage.reused, false);
    assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
    const files = [
      join(f.input.runtimeDirectory, 'runtime-stage.json'),
      join(f.input.runtimeDirectory, 'package.json'),
      join(f.input.runtimeDirectory, 'package-lock.json'),
      join(f.input.runtimeDirectory, 'reviewed-archive.tgz'),
      stage.admission.cliPath,
      join(f.base, 'user.json'),
    ].map((path) => ({ path, digest: digestBytes(readFileSync(path)) }));
    atomicJson.writePrivateJsonFileAtomically(join(ownerRoot, 'prepared.json'), {
      ownerRoot,
      base: f.base,
      stageId: stage.stageId,
      configPath: join(f.base, 'user.json'),
      npmBin,
      author: actors.author,
      reviewer: actors.reviewer,
      input: f.input,
      files,
    });
    readPreparedCli(ownerRoot);
  } finally {
    // The outer supervisor owns fixture disposal, including a killed preparation process.
    process.env.PATH = previousPath;
  }
}

const cliBindingSchema = z.strictObject({
  ownerRoot: z.string(),
  scenario: z.string(),
  repoRoot: z.string(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  configDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  userConfigDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  archivePath: z.string(),
  archiveSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeDirectory: z.string(),
});
type CliBinding = z.infer<typeof cliBindingSchema>;
const cliUnitSchema = z.strictObject({
  command: z.enum(['runtime:stage', 'runtime:admit']),
  kind: z.enum(['context', 'preflight', 'installer', 'authority']),
  call: z.number().int().min(1).max(3),
  binding: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  result: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .optional(),
});
type CliUnit = z.infer<typeof cliUnitSchema>;
type CliPhase = { phase: string; event: 'start' | 'end' | 'settled' | 'pending'; atMs: number; unit?: CliUnit };
function cliUnitResult(unit: CliUnit): string {
  const { result: _result, ...operation } = unit;
  return digestValue({ ...operation, result: 'validated-success' });
}
type CliScenario =
  | 'normal'
  | 'progress'
  | 'unfinished'
  | 'installer-failure'
  | 'preparation-failure'
  | 'preparation-cancel';
type CliTraceFault =
  | 'missing'
  | 'oversized'
  | 'records'
  | 'write'
  | 'completion-duplicate'
  | 'completion-unmatched'
  | 'completion-rejected'
  | 'completion-malformed';
type CliCaseFailure = Error & {
  root: string;
  nativeIdle: boolean;
  cleanupState: import('./verification.js').OwnedProcessState | undefined;
  receiptFailure: string | undefined;
  residualInstaller: { pid: number; counter: string } | undefined;
  retainedPhaseCount: number;
  traceFaultInjected: boolean;
  restoredGlobalsWithPending: boolean;
};

// Re-enter this same case so cancellation can contain synchronous CLI work as well as promises.
// The existing producer supervisor owns the native process; these callbacks only retain its observations.
async function observeStageAdmitCase(scenario: CliScenario = 'normal', traceFault?: CliTraceFault) {
  const { runStageCommand } = await import('./verification.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-cli-case-')));
  const tracePath = join(root, 'phases.json');
  const cancellation = new AbortController();
  let idle = false;
  let cleanupFailure: string | undefined;
  let receiptFailure: string | undefined;
  let lastPhase: CliPhase[] = [];
  let deadline = 0;
  const active = new Map<string, number>();
  const pendingUnits = new Map<string, CliUnit>();
  const startedUnits = new Set<string>();
  const completedUnits: string[] = [];
  let fixtureBinding: CliBinding | undefined;
  let seen = 0;
  let cancelledPhase: string | undefined;
  let failure: string | undefined;
  let failedBytes: Buffer | undefined;
  let owned: unknown;
  const identities = new Map<string, { pid: number; identity: string; pgid: number }>();
  let residualInstaller: { pid: number; counter: string; noiseWrites: number } | undefined;
  let cleanupState: import('./verification.js').OwnedProcessState | undefined;
  let traceFaultInjected = false;
  let unreadableSince: number | undefined;
  let prepared: PreparedCli | undefined;
  let preparationStartedAt: number | undefined;
  let preparationElapsedMs: number | undefined;
  let preparationCompleted = false;
  const needsPreparation = ['preparation-failure', 'preparation-cancel'].includes(scenario);
  const readPhases = (): CliPhase[] => {
    const value: unknown = JSON.parse(
      privateFiles.assertPrivateFile(tracePath, { maxBytes: 64 * 1024 }).toString('utf8'),
    );
    assert.ok(Array.isArray(value) && value.length <= 64, 'CLI phase count exceeded its bound');
    let previous = -1;
    for (const item of value as unknown[]) {
      assert.ok(
        item !== null &&
          typeof item === 'object' &&
          Object.keys(item).length === ('unit' in item ? 4 : 3) &&
          Object.keys(item).every((key) => ['phase', 'event', 'atMs', 'unit'].includes(key)),
        'CLI phase entry is invalid',
      );
      const entry = item as Partial<CliPhase>;
      assert.ok(
        typeof entry.phase === 'string' &&
          entry.phase.length <= 64 &&
          ['start', 'end', 'settled', 'pending'].includes(entry.event ?? '') &&
          typeof entry.atMs === 'number' &&
          Number.isFinite(entry.atMs) &&
          entry.atMs >= 0 &&
          entry.atMs >= previous,
        'CLI phase entry is invalid',
      );
      previous = entry.atMs;
      if (entry.unit !== undefined) cliUnitSchema.parse(entry.unit);
    }
    const phases = value as CliPhase[];
    assert.ok(
      phases.length >= lastPhase.length &&
        lastPhase.every((entry, index) => {
          const current = phases[index]!;
          return (
            current.phase === entry.phase &&
            current.event === entry.event &&
            current.atMs === entry.atMs &&
            JSON.stringify(current.unit) === JSON.stringify(entry.unit)
          );
        }),
      'CLI phase history changed after observation',
    );
    return phases;
  };
  const save = (): void => {
    try {
      writeFileSync(join(root, 'ownership.json'), JSON.stringify({ idle, owned, cleanupFailure, receiptFailure }), {
        mode: 0o600,
      });
    } catch (error) {
      receiptFailure = error instanceof Error ? error.message : String(error);
      cancellation.abort();
    }
  };
  let watch: ReturnType<typeof setInterval> | undefined;
  const readBinding = (): CliBinding => {
    const binding = cliBindingSchema.parse(
      JSON.parse(
        privateFiles.assertPrivateFile(join(root, 'producer-binding.json'), { maxBytes: 8 * 1024 }).toString('utf8'),
      ),
    );
    assert.equal(binding.ownerRoot, root);
    assert.equal(binding.scenario, scenario);
    assert.equal(realpathSync(binding.repoRoot), binding.repoRoot);
    assert.equal(dirname(dirname(binding.repoRoot)), root);
    assert.equal(binding.runtimeDirectory, join(dirname(binding.repoRoot), 'staged'));
    assert.equal(binding.archivePath, join(dirname(binding.repoRoot), 'reviewed archive; inert.tgz'));
    assert.equal(
      digestBytes(privateFiles.assertPrivateFile(join(dirname(binding.repoRoot), 'user.json'))),
      binding.userConfigDigest,
    );
    if (fixtureBinding === undefined) {
      assert.equal(git(binding.repoRoot, 'rev-parse', 'HEAD'), binding.sourceCommit);
      assert.equal(digestBytes(readFileSync(binding.archivePath)), binding.archiveSha256);
      fixtureBinding = binding;
    } else assert.deepEqual(binding, fixtureBinding, 'CLI producer binding changed');
    return binding;
  };
  const watchPhases = (injectFault = true): void => {
    try {
      if (existsSync(tracePath)) {
        const phases = readPhases();
        unreadableSince = undefined;
        for (const entry of phases.slice(seen)) {
          if (entry.unit !== undefined) {
            const unit = cliUnitSchema.parse(entry.unit);
            assert.equal(entry.phase, `unit:${unit.command}:${unit.kind}:${unit.call}`);
            assert.equal(unit.binding, digestValue(readBinding()));
            assert.ok(active.has(unit.command), 'Completion record is outside its actual CLI invocation');
            assert.ok(unit.kind !== 'installer' || (unit.command === 'runtime:stage' && unit.call === 1));
            assert.ok(unit.kind !== 'authority' || unit.command === 'runtime:admit');
            if (entry.event === 'start') {
              assert.equal(unit.result, undefined);
              assert.ok(!startedUnits.has(entry.phase), 'Duplicate CLI unit start');
              assert.equal(
                unit.call,
                1 + [...startedUnits].filter((name) => name.startsWith(`unit:${unit.command}:${unit.kind}:`)).length,
              );
              if (unit.kind === 'preflight')
                assert.ok(
                  completedUnits.includes(`unit:${unit.command}:context:${unit.call}`),
                  'Preflight preceded its validated context',
                );
              if (unit.kind === 'context' && unit.call > 1)
                assert.ok(
                  completedUnits.includes(`unit:${unit.command}:preflight:${unit.call - 1}`),
                  'Context recheck preceded its prior preflight',
                );
              if (unit.kind === 'installer')
                assert.ok(
                  completedUnits.includes('unit:runtime:stage:preflight:1'),
                  'Installer preceded real preflight',
                );
              if (unit.kind === 'authority')
                assert.ok(
                  pendingUnits.has(`unit:runtime:admit:preflight:${unit.call}`),
                  'Authority check is outside its real preflight',
                );
              startedUnits.add(entry.phase);
              pendingUnits.set(entry.phase, unit);
            } else {
              assert.equal(entry.event, 'end', 'Only successful delegated units may report completion');
              const started = pendingUnits.get(entry.phase);
              assert.ok(started, 'Unmatched or duplicate CLI unit completion');
              assert.deepEqual({ ...unit, result: undefined }, { ...started, result: undefined });
              assert.equal(unit.result, cliUnitResult(started), 'CLI unit result binding is invalid');
              if (unit.command === 'runtime:admit' && unit.kind === 'preflight')
                assert.ok(
                  completedUnits.includes(`unit:runtime:admit:authority:${unit.call}`),
                  'Admission preflight lacks successful authority readback',
                );
              pendingUnits.delete(entry.phase);
              completedUnits.push(entry.phase);
              // This measures inactivity between verified substantive units, never total command duration.
              active.set(
                unit.command,
                performance.now() + (scenario === 'unfinished' && unit.command === 'runtime:stage' ? 30_000 : 15_000),
              );
            }
            continue;
          }
          if (entry.phase.startsWith('unit:')) {
            assert.equal(entry.event, 'settled', 'CLI unit completion lacks a validated result');
            assert.ok(pendingUnits.delete(entry.phase), 'Unmatched rejected CLI unit');
            continue; // A rejected operation is settled, but cannot refresh the stall clock.
          }
          if (entry.event === 'start')
            active.set(
              entry.phase,
              performance.now() + (scenario === 'unfinished' && entry.phase === 'runtime:stage' ? 30_000 : 15_000),
            );
          else if (entry.event === 'end' || entry.event === 'settled') active.delete(entry.phase);
        }
        lastPhase = phases;
        if (phases.length > seen) deadline = performance.now() + 15_000;
        seen = phases.length;
        if (injectFault && !idle && traceFault !== undefined && traceFault !== 'write' && !traceFaultInjected) {
          const fixtureRoot = readdirSync(root).find((name) => name.startsWith('ai-delivery-setup-'));
          const marker = fixtureRoot === undefined ? undefined : join(root, fixtureRoot, 'installer-running');
          if (marker !== undefined && existsSync(marker)) {
            assert.equal(readFileSync(join(dirname(marker), 'installs'), 'utf8'), 'x');
            traceFaultInjected = true;
            if (traceFault === 'missing') rmSync(tracePath);
            else if (traceFault === 'oversized') {
              writeFileSync(tracePath, Buffer.alloc(64 * 1024 + 1, 32));
              sharedOutputRead.path = tracePath;
            } else if (traceFault.startsWith('completion-')) {
              const source = phases.find((entry) =>
                traceFault === 'completion-malformed'
                  ? entry.unit?.kind === 'installer' && entry.event === 'start' && pendingUnits.has(entry.phase)
                  : entry.unit !== undefined && entry.event === 'end',
              );
              assert.ok(source?.unit, 'A completion fault needs its matching real delegated unit first');
              const injected: CliPhase = {
                ...source,
                event: 'end',
                atMs: phases.at(-1)!.atMs + 0.001,
                unit: { ...source.unit },
              };
              if (traceFault === 'completion-unmatched') {
                injected.unit!.call++;
                injected.phase = `unit:${injected.unit!.command}:${injected.unit!.kind}:${injected.unit!.call}`;
              } else if (traceFault === 'completion-rejected') injected.event = 'settled';
              else if (traceFault === 'completion-malformed') injected.unit!.result = 'sha256:' + '0'.repeat(64);
              writeFileSync(tracePath, JSON.stringify([...phases, injected]));
            } else writeFileSync(tracePath, JSON.stringify(Array.from({ length: 65 }, () => phases[0])));
          }
        }
      } else if (seen > 0) throw new Error('CLI phase evidence disappeared after observation');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Atomic replacement can race an identity-bound read. Retry only that bounded observation,
      // while operation deadlines continue to run; missing, oversized or invalid history fails immediately.
      const changing =
        /identity changed before its bounded read|truncated during its bounded read|bytes are missing, corrupt or changed during its bounded read/u.test(
          message,
        );
      if (changing) unreadableSince ??= performance.now();
      if (!changing || performance.now() - unreadableSince! >= 1_000) {
        receiptFailure ??= message;
        cancellation.abort();
      }
    }
    const overdue = [...active].find(([, limit]) => performance.now() >= limit);
    if (overdue !== undefined || (active.size === 0 && performance.now() >= deadline)) {
      cancelledPhase ??= overdue?.[0] ?? (seen === 0 ? 'bootstrap' : 'native-drain');
      cancellation.abort();
    }
  };
  const executeChild = async (preparing: boolean): Promise<void> => {
    idle = false;
    failedBytes = undefined;
    const output = await runStageCommand(
      process.cwd(),
      [
        process.execPath,
        join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
        'run',
        '--mode=compiled',
        'dist/setupCli.test.js',
        '-t',
        preparing ? '^setup CLI preparation child$' : `^${stageAdmitCase}$`,
      ],
      cancellation.signal,
      undefined,
      // This bounded synthetic case uses the fixture floor, not a local host's 100 GiB reserve.
      { maxAggregateRssBytes: 3 * 1024 ** 3, minFreeDiskBytes: 256 * 1024 ** 2 },
      undefined,
      undefined,
      {
        starting: () => {
          idle = false;
          save();
        },
        observed: (state) => {
          cleanupState = { ...state, tracked: new Map(state.tracked) };
          for (const member of state.tracked.values()) {
            if (identities.size >= 512 && !identities.has(`${member.pid}:${member.identity}`)) {
              receiptFailure ??= 'CLI ownership observation count exceeded its bound';
              cancellation.abort();
              break;
            }
            identities.set(`${member.pid}:${member.identity}`, {
              pid: member.pid,
              identity: member.identity,
              pgid: member.pgid,
            });
          }
          owned = {
            rootPid: state.rootPid,
            rootIdentity: state.rootIdentity,
            sampled: state.sampled,
            tracked: [...identities.values()],
          };
          save();
        },
        idle: () => {
          idle = true;
          save();
        },
        assertQuiescent: () => assert.ok(idle && cleanupFailure === undefined),
      },
      {
        environment: {
          ...process.env,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          AI_DELIVERY_STAGE_ADMIT_CHILD: tracePath,
          AI_DELIVERY_STAGE_ADMIT_SCENARIO: scenario,
          AI_DELIVERY_STAGE_ADMIT_TRACE_FAULT: traceFault ?? '',
          AI_DELIVERY_CLI_PREPARE: preparing ? root : '',
          ...(preparing ? { AI_DELIVERY_SETUP_INTERRUPT_INPUT: 'owned-cli-preparation' } : {}),
          AI_DELIVERY_CLI_PREPARED_ROOT: !preparing && prepared !== undefined ? root : '',
        },
        maxCapturedOutputBytes: 32 * 1024 ** 2,
        includeControllerTree: true,
        failedOutput: (bytes) => {
          failedBytes = bytes;
          if (bytes.includes(Buffer.from('SETUP_CLI_TRACE_WRITE_FAULT_WITH_PENDING'))) traceFaultInjected = true;
          if (bytes.includes(Buffer.from('SETUP_CLI_TRACE_FAILURE'))) receiptFailure ??= 'Child CLI phase write failed';
          return ` CLI case output ${digestBytes(bytes)} (${bytes.length} bytes).`;
        },
        onCleanupFailure: (reason) => {
          cleanupFailure = reason;
          save();
        },
      },
    );
    if (output.includes(Buffer.from('SETUP_CLI_TRACE_FAILURE'))) receiptFailure ??= 'Child CLI phase write failed';
    process.stdout.write(output);
  };
  try {
    if (needsPreparation) {
      preparationStartedAt = performance.now();
      const cancelPreparation =
        scenario === 'preparation-cancel'
          ? setInterval(() => {
              const base = readdirSync(root).find((name) => name.startsWith('ai-delivery-setup-'));
              if (base !== undefined && existsSync(join(root, base, 'installer-running'))) cancellation.abort();
            }, 50)
          : undefined;
      try {
        await executeChild(true);
        assert.ok(idle && cleanupFailure === undefined, 'preparation must settle with native quiescence');
        prepared = readPreparedCli(root);
        preparedCliClosure(prepared.input);
        preparationCompleted = true;
      } finally {
        if (cancelPreparation !== undefined) clearInterval(cancelPreparation);
        preparationElapsedMs = performance.now() - preparationStartedAt;
      }
    }
    deadline = performance.now() + 15_000;
    watch = setInterval(watchPhases, 50);
    await executeChild(false);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (failedBytes !== undefined) process.stdout.write(failedBytes);
  } finally {
    if (watch !== undefined) clearInterval(watch);
    if (needsPreparation && !preparationCompleted) receiptFailure ??= 'CLI preparation failed before completed handoff';
    else {
      try {
        watchPhases(false);
      } catch (error) {
        receiptFailure ??= error instanceof Error ? error.message : String(error);
      }
    }
    if (idle && cleanupFailure === undefined) {
      try {
        for (const name of readdirSync(root).filter((name) => name.startsWith('ai-delivery-setup-'))) {
          const base = join(root, name);
          const marker = join(base, 'installer-running');
          if (existsSync(marker)) {
            assert.ok(lstatSync(marker).size <= 64 && lstatSync(join(base, 'installs')).size <= 64);
            residualInstaller = {
              pid: Number(readFileSync(marker, 'utf8')),
              counter: readFileSync(join(base, 'installs'), 'utf8'),
              noiseWrites: existsSync(join(base, 'noise-writes')) ? lstatSync(join(base, 'noise-writes')).size : 0,
            };
          }
        }
      } catch (error) {
        receiptFailure ??= error instanceof Error ? error.message : String(error);
      }
    }
    process.stdout.write(
      'SETUP_CLI_PHASE_RECEIPT ' +
        JSON.stringify({
          scenario,
          traceFault,
          traceFaultInjected,
          phases: lastPhase,
          nativeIdle: idle,
          cancelledPhase,
          failure,
          cleanupFailure,
          receiptFailure,
          owned,
          root,
          residualInstaller,
          preparationElapsedMs,
          preparationCompleted,
          completedUnits,
        }) +
        '\n',
    );
  }
  if (!idle || cleanupFailure !== undefined || receiptFailure !== undefined)
    throw Object.assign(new Error(`CLI case ownership unresolved; preserve ${root}`), {
      root,
      nativeIdle: idle,
      cleanupState,
      receiptFailure,
      residualInstaller,
      retainedPhaseCount: lastPhase.length,
      traceFaultInjected,
      restoredGlobalsWithPending: failedBytes?.includes(Buffer.from('SETUP_CLI_ENV_RESTORED_WITH_PENDING')) ?? false,
    });
  if (fixtureBinding !== undefined) {
    const savedConfig = process.env.AI_DELIVERY_CONFIG;
    try {
      process.env.AI_DELIVERY_CONFIG = join(dirname(fixtureBinding.repoRoot), 'user.json');
      assert.equal((await loadDeliveryConfig(fixtureBinding.repoRoot)).configDigest, fixtureBinding.configDigest);
    } finally {
      if (savedConfig === undefined) delete process.env.AI_DELIVERY_CONFIG;
      else process.env.AI_DELIVERY_CONFIG = savedConfig;
    }
    if (failure === undefined) {
      assert.equal(pendingUnits.size, 0, 'A successful CLI retained an unfinished semantic unit');
      const stage = JSON.parse(
        privateFiles.assertPrivateFile(join(fixtureBinding.runtimeDirectory, 'runtime-stage.json')).toString('utf8'),
      ) as {
        status: string;
        recordId: string;
        intent: { sourceCommit: string; configDigest: string; archiveSha256: string };
        admission: RuntimeAdmission;
      };
      const { recordId, ...content } = stage;
      assert.equal(recordId, digestValue(content));
      assert.equal(stage.status, 'complete');
      assert.equal(stage.intent.sourceCommit, fixtureBinding.sourceCommit);
      assert.equal(stage.intent.configDigest, fixtureBinding.configDigest);
      assert.equal(stage.intent.archiveSha256, fixtureBinding.archiveSha256);
      assert.deepEqual(
        JSON.parse(
          privateFiles
            .assertPrivateFile(join(fixtureBinding.repoRoot, '.git/ai-delivery/runtime-admission.json'))
            .toString('utf8'),
        ),
        stage.admission,
      );
      assert.ok(completedUnits.includes('unit:runtime:stage:installer:1') || prepared !== undefined);
    }
  }
  if (prepared !== undefined) {
    for (const file of prepared.files) assert.equal(digestBytes(readFileSync(file.path)), file.digest);
    assert.equal(readFileSync(join(prepared.base, 'installs'), 'utf8'), 'x');
    preparedCliClosure(prepared.input);
    assert.equal(existsSync(join(prepared.input.repoRoot, '.git/ai-delivery/runtime-admission.json')), false);
  }
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, 'Owned CLI case root was not removed');
  return {
    phases: lastPhase,
    completedUnits,
    nativeIdle: idle,
    cancelledPhase,
    failure,
    rootRemoved: true,
    residualInstaller,
    identities: [...identities.values()],
    installerFailureReported: failedBytes?.includes(Buffer.from('exit 7')) ?? false,
  };
}

test(stageAdmitCase, { tags: ['release'], timeout: 0 }, async () => {
  const tracePath = process.env.AI_DELIVERY_STAGE_ADMIT_CHILD;
  if (tracePath === undefined) {
    const result = await observeStageAdmitCase();
    assert.equal(result.failure, undefined);
    return;
  }
  const scenario = process.env.AI_DELIVERY_STAGE_ADMIT_SCENARIO as CliScenario;
  const traceFault = process.env.AI_DELIVERY_STAGE_ADMIT_TRACE_FAULT as CliTraceFault;
  const phases: CliPhase[] = [];
  let activeCommands = 0;
  let traceFailure: Error | undefined;
  const phase = (name: string, event: CliPhase['event'], unit?: CliUnit): void => {
    if (traceFailure !== undefined) return;
    try {
      assert.ok(phases.length < 64, 'CLI phase count exceeded its bound');
      phases.push({ phase: name, event, atMs: performance.now(), ...(unit === undefined ? {} : { unit }) });
      if (traceFault === 'write' && name === 'import:runtime:stage' && event === 'end') {
        assert.ok(activeCommands > 0, 'Trace write fault requires an actually pending CLI command');
        process.stderr.write('SETUP_CLI_TRACE_WRITE_FAULT_WITH_PENDING\n');
        rmSync(tracePath);
        mkdirSync(tracePath);
      }
      atomicJson.writePrivateJsonFileAtomically(tracePath, phases);
    } catch (error) {
      traceFailure = error instanceof Error ? error : new Error(String(error));
      try {
        process.stderr.write('SETUP_CLI_TRACE_FAILURE\n');
      } catch {
        /* The parent also validates the retained trace. */
      }
    }
  };
  phase('preparation', 'start');
  const preparedRoot = process.env.AI_DELIVERY_CLI_PREPARED_ROOT;
  const prepared = preparedRoot ? readPreparedCli(preparedRoot) : undefined;
  const ownedFixture = prepared === undefined ? await fixture() : undefined;
  const f = ownedFixture ?? {
    base: prepared!.base,
    root: prepared!.input.repoRoot,
    input: prepared!.input,
    counter: join(prepared!.base, 'installs'),
    marker: join(prepared!.base, 'installer-running'),
  };
  const previousPath = process.env.PATH;
  if (prepared !== undefined) {
    vi.stubEnv('AI_DELIVERY_CONFIG', prepared.configPath);
    process.env.PATH = `${prepared.npmBin}:${previousPath ?? ''}`;
    assert.equal((await loadDeliveryConfig(f.root)).configDigest, f.input.expectedConfigDigest);
    assert.equal(actors.author, prepared.author);
    assert.equal(actors.reviewer, prepared.reviewer);
    assert.equal(existsSync(join(f.root, '.git/ai-delivery/runtime-admission.json')), false);
    preparedCliClosure(f.input);
  }
  if (scenario === 'unfinished') {
    writeFileSync(join(f.base, 'wait'), '');
    writeFileSync(join(f.base, 'wait-noise'), '');
  }
  if (scenario === 'installer-failure') writeFileSync(join(f.base, 'fail'), '');
  chmodSync(join(f.base, 'user.json'), 0o600);
  const binding: CliBinding = {
    ownerRoot: dirname(tracePath),
    scenario,
    repoRoot: f.root,
    sourceCommit: f.input.expectedSourceCommit,
    configDigest: f.input.expectedConfigDigest,
    userConfigDigest: digestBytes(readFileSync(join(f.base, 'user.json'))),
    archivePath: f.input.archivePath,
    archiveSha256: f.input.expectedArchiveSha256,
    runtimeDirectory: f.input.runtimeDirectory,
  };
  atomicJson.writePrivateJsonFileAtomically(join(dirname(tracePath), 'producer-binding.json'), binding);
  phase('preparation', 'end');
  const argv = process.argv;
  const exitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write');
  const pending: Promise<unknown>[] = [];
  const restoreObservations: (() => void)[] = [];
  const restoreEnvs = vi.unstubAllEnvs.bind(vi);
  const environmentProbe =
    traceFault === 'write'
      ? vi.spyOn(vi, 'unstubAllEnvs').mockImplementation(() => {
          if (activeCommands > 0) process.stderr.write('SETUP_CLI_ENV_RESTORED_WITH_PENDING\n');
          return restoreEnvs();
        })
      : undefined;
  try {
    const runCli = async (args: string[]): Promise<Record<string, unknown>> => {
      const begin = stdout.mock.calls.length;
      let settled = false;
      process.argv = [
        process.execPath,
        join(process.cwd(), 'dist/cli.js'),
        '--repo-root',
        f.root,
        '--identity',
        'host-author',
        ...args,
      ];
      vi.resetModules();
      const calls = { context: 0, preflight: 0, installer: 0, authority: 0 };
      const observeUnit = async <T>(
        kind: CliUnit['kind'],
        operation: () => Promise<T>,
        validate: (value: T) => void,
      ): Promise<T> => {
        const unit: CliUnit = {
          command: args[0] as CliUnit['command'],
          kind,
          call: ++calls[kind],
          binding: digestValue(binding),
        };
        const name = `unit:${unit.command}:${unit.kind}:${unit.call}`;
        phase(name, 'start', unit);
        try {
          const value = await operation();
          validate(value);
          phase(name, 'end', { ...unit, result: cliUnitResult(unit) });
          return value;
        } catch (error) {
          phase(name, 'settled'); // Failure is evidence of settlement, never successful progress.
          throw error;
        }
      };
      const contextModule = await import('./issue.js');
      const context = contextModule.loadDeliveryContext;
      const contextObserver = vi.spyOn(contextModule, 'loadDeliveryContext').mockImplementation((...input) =>
        observeUnit(
          'context',
          () => context(...input),
          (value) => {
            assert.equal(input[0].repoRoot, f.root);
            assert.equal(input[0].identity, 'host-author');
            assert.equal(input[0].role, 'author');
            assert.equal(value.config.repository, 'example/widget');
            assert.equal(value.configuration?.configDigest, f.input.expectedConfigDigest);
            assert.equal(value.clients.role, 'author');
            assert.equal(value.clients.authSource, 'personal');
            assert.equal(value.clients.credentialSource, 'env:AUTHOR_TOKEN');
          },
        ),
      );
      restoreObservations.push(() => contextObserver.mockRestore());
      const preflightModule = await import('./pr.js');
      const preflight = preflightModule.preflightReviewRoute;
      const preflightObserver = vi.spyOn(preflightModule, 'preflightReviewRoute').mockImplementation((...input) =>
        observeUnit(
          'preflight',
          () => preflight(...input),
          (value) => {
            assert.equal(value.author.actorLogin, 'host-user');
            assert.equal(value.author.identity, 'host-author');
            assert.equal(value.author.authSource, 'personal');
            assert.equal(value.reviewer.actorLogin, 'reviewer[bot]');
            assert.equal(value.reviewer.identity, 'synthetic-reviewer');
            assert.equal(value.reviewer.repositoryAccess, 'readable');
            assert.equal(value.rules.visibility, 'unknown');
            assert.equal(value.rules.observedRequiredApprovals, null);
            assert.equal(value.approvalEligibility, 'unknown');
          },
        ),
      );
      restoreObservations.push(() => preflightObserver.mockRestore());
      const verificationModule = await import('./verification.js');
      const writer = verificationModule.withRuntimeSetupWriter;
      const observedWriter: typeof writer = (root, operation, scope) =>
        writer(
          root,
          (runner) =>
            operation({
              ...runner,
              run: (...input) =>
                observeUnit(
                  'installer',
                  () => runner.run(...input),
                  () => {
                    assert.equal(root, f.root);
                    assert.equal(input[0][0], 'npm');
                    assert.equal(input[0][1], 'install');
                    assert.equal(input[0][input[0].indexOf('--prefix') + 1], f.input.runtimeDirectory);
                    assert.equal(input[0].at(-1), join(f.input.runtimeDirectory, 'reviewed-archive.tgz'));
                    assert.equal(input[4], f.input.runtimeDirectory);
                    runner.assertQuiescent();
                    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
                    const installed = JSON.parse(
                      readFileSync(
                        join(f.input.runtimeDirectory, 'node_modules/@aviaratech/ai-delivery/package.json'),
                        'utf8',
                      ),
                    ) as { name: string; version: string };
                    assert.equal(installed.name, '@aviaratech/ai-delivery');
                    assert.equal(installed.version, f.input.packageVersion);
                    const lock = JSON.parse(
                      readFileSync(join(f.input.runtimeDirectory, 'package-lock.json'), 'utf8'),
                    ) as { packages: Record<string, { version: string }> };
                    assert.equal(
                      lock.packages['node_modules/@aviaratech/ai-delivery']?.version,
                      f.input.packageVersion,
                    );
                  },
                ),
            }),
          scope,
        );
      const writerObserver = vi.spyOn(verificationModule, 'withRuntimeSetupWriter').mockImplementation(observedWriter);
      restoreObservations.push(() => writerObserver.mockRestore());
      if (args[0] === 'runtime:admit') {
        const clientsModule = await import('./github/client.js');
        const create = clientsModule.createDeliveryGitHubClients;
        let authorChecks = 0;
        const clients = vi.spyOn(clientsModule, 'createDeliveryGitHubClients').mockImplementation(async (...input) => {
          const client = await create(...input);
          const authenticatedAuthor = client.authenticatedAuthor;
          if (authenticatedAuthor !== undefined) {
            client.authenticatedAuthor = async (...request) => {
              const name = `admit:author:${++authorChecks}${actors.pauseAuthor ? ':delayed' : ''}`;
              phase(name, 'start');
              try {
                return await observeUnit(
                  'authority',
                  async () => {
                    const response = await authenticatedAuthor(...request);
                    return response;
                  },
                  (response) => {
                    assert.equal(response.actorLogin, 'host-user');
                    assert.equal(response.credentialIdentity, 'user:37');
                  },
                );
              } finally {
                phase(name, 'end');
              }
            };
          }
          return client;
        });
        restoreObservations.push(() => clients.mockRestore());
      }
      const { Command } = await import('commander');
      const descriptor = Object.getOwnPropertyDescriptor(Command.prototype, 'parseAsync');
      assert.equal(typeof descriptor?.value, 'function', 'Commander parse operation is unavailable');
      const parse = descriptor!.value as typeof Command.prototype.parseAsync;
      let command: Promise<import('commander').Command> | undefined;
      let observation: Promise<void> | undefined;
      const observe = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (
        this: import('commander').Command,
        ...input
      ) {
        phase(args[0]!, 'start');
        if (traceFailure !== undefined) throw traceFailure;
        const operation = parse.apply(this, input);
        activeCommands++;
        command = operation;
        observation = operation.then(
          () => {
            activeCommands--;
            settled = true;
            phase(args[0]!, 'settled');
          },
          () => {
            activeCommands--;
            settled = true;
            phase(args[0]!, 'settled');
          },
        );
        pending.push(operation, observation);
        // Retain observer failures for the explicit join without an interim unhandled rejection.
        void observation.catch(() => {});
        return operation;
      });
      try {
        phase(`import:${args[0]!}`, 'start');
        if (traceFailure !== undefined) throw traceFailure;
        await import('./cli.js');
        phase(`import:${args[0]!}`, 'end');
      } finally {
        observe.mockRestore();
      }
      assert.ok(command, 'CLI import did not start its actual parse operation');
      await command;
      await observation;
      if (traceFailure !== undefined) throw traceFailure;
      for (let i = 0; i < 300; i++) {
        const output = stdout.mock.calls
          .slice(begin)
          .map(([bytes]) => String(bytes))
          .find((bytes) => bytes.startsWith('{'));
        if (output) {
          phase(`return:${args[0]!}`, settled ? 'end' : 'pending');
          return JSON.parse(output) as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      phase(`return:${args[0]!}`, settled ? 'end' : 'pending');
      throw new Error('CLI completion output unavailable');
    };
    const common = [
      '--source-commit',
      f.input.expectedSourceCommit,
      '--config-digest',
      f.input.expectedConfigDigest,
      '--runtime-directory',
      f.input.runtimeDirectory,
    ];
    if (scenario === 'progress') {
      // Two actual authority responses alone exceed the old aggregate command limit.
      actors.pauseAuthor = true;
      actors.authorDelayMs = 8_000;
    }
    const staged = await runCli([
      'runtime:stage',
      '--authorize-stage',
      '--archive',
      f.input.archivePath,
      '--archive-sha256',
      f.input.expectedArchiveSha256,
      '--package-version',
      f.input.packageVersion,
      ...common,
    ]);
    phase('assertions:stageId', 'start');
    assert.equal(typeof staged.stageId, 'string');
    if (prepared !== undefined) {
      assert.equal(staged.reused, true, 'the actual CLI must reuse the completed prepared stage');
      assert.equal(staged.stageId, prepared.stageId);
      assert.equal(readFileSync(f.counter, 'utf8'), 'x');
      for (const file of prepared.files) assert.equal(digestBytes(readFileSync(file.path)), file.digest);
    }
    phase('assertions:stageId', 'end');
    if (scenario === 'progress') actors.pauseAuthor = false;
    const authorCallsBeforeAdmission = actors.authorCalls;
    const admitted = await runCli([
      'runtime:admit',
      '--authorize-admit',
      '--stage-id',
      String(staged.stageId),
      '--expected-absent',
      ...common,
    ]);
    phase('assertions', 'start');
    assert.equal(
      actors.authorCalls - authorCallsBeforeAdmission,
      3,
      'Admission must authenticate at its initial, locked and final controller checks',
    );
    assert.equal((admitted.admission as RuntimeAdmission).sourceCommit, f.input.expectedSourceCommit);
    assert.equal(readFileSync(f.counter, 'utf8'), 'x');
    assert.equal(process.exitCode, exitCode);
    phase('assertions', 'end');
  } finally {
    phase('drain', 'start');
    await Promise.allSettled(pending);
    for (const restore of restoreObservations) restore();
    environmentProbe?.mockRestore();
    phase('drain', 'end');
    phase('cleanup', 'start');
    stdout.mockRestore();
    process.argv = argv;
    process.exitCode = exitCode;
    // The existing parent owns final artifact corroboration and disposal after native quiescence.
    if (ownedFixture !== undefined) ownedFixture.cleanup(true);
    else process.env.PATH = previousPath;
    phase('cleanup', 'end');
  }
  if (traceFailure !== undefined) throw traceFailure;
});

test(
  'CLI stage/admit completes substantive work beyond the former aggregate command limit',
  { tags: ['release'] },
  async () => {
    const result = await observeStageAdmitCase('progress');
    assert.equal(result.failure, undefined, 'The actual CLI must complete while real producer units keep completing');
    const start = result.phases.find((entry) => entry.phase === 'runtime:stage' && entry.event === 'start');
    const end = result.phases.find((entry) => entry.phase === 'runtime:stage' && entry.event === 'settled');
    assert.ok(start && end && end.atMs - start.atMs > 15_000);
    assert.ok(result.nativeIdle && result.rootRemoved);
    assert.ok(result.phases.some((entry) => entry.phase === 'runtime:admit' && entry.event === 'settled'));
  },
);

for (const fault of ['failure', 'cancel'] as const) {
  test(`CLI preparation ${fault} retains owned evidence through native drain`, { tags: ['release'] }, async () => {
    const previousPath = process.env.PATH;
    let received: unknown;
    try {
      await observeStageAdmitCase(`preparation-${fault}`);
    } catch (error) {
      received = error;
    }
    assert.ok(received instanceof Error, 'failed preparation must retain its owned root for recovery');
    const error = received as CliCaseFailure;
    assert.equal(error.nativeIdle, true);
    assert.ok(error.cleanupState !== undefined);
    assert.equal(error.restoredGlobalsWithPending, false);
    assert.equal(realpathSync(error.root), error.root);
    assert.equal(dirname(error.root), realpathSync(tmpdir()));
    assert.match(error.root, /ai-delivery-cli-case-/u);
    const ownership = JSON.parse(
      privateFiles.assertPrivateFile(join(error.root, 'ownership.json')).toString('utf8'),
    ) as {
      idle: boolean;
      owned: { rootPid: number; rootIdentity: string };
    };
    assert.equal(ownership.idle, true);
    assert.equal(ownership.owned.rootPid, error.cleanupState.rootPid);
    assert.equal(ownership.owned.rootIdentity, error.cleanupState.rootIdentity);
    const { confirmOwnedCleanup } = await import('./verification.js');
    await confirmOwnedCleanup(error.cleanupState);
    try {
      const bases = readdirSync(error.root).filter((name) => name.startsWith('ai-delivery-setup-'));
      assert.equal(bases.length, 1);
      const base = join(error.root, bases[0]!);
      assert.equal(readFileSync(join(base, 'unrelated-preparation'), 'utf8'), 'unrelated');
      assert.equal(readFileSync(join(base, 'installs'), 'utf8'), 'x');
      assert.equal(existsSync(join(base, 'consumer/.git/ai-delivery/runtime-admission.json')), false);
      if (fault === 'cancel') {
        assert.equal(error.residualInstaller?.counter, 'x');
        assert.ok(error.cleanupState.tracked.has(error.residualInstaller!.pid));
      }
      assert.equal(process.env.PATH, previousPath);
    } finally {
      rmSync(error.root, { recursive: true, force: true });
    }
    assert.equal(existsSync(error.root), false);
    process.stdout.write(
      'SETUP_CLI_PREPARATION_RECOVERY ' +
        JSON.stringify({ fault, root: error.root, quiescenceRechecked: true, removed: true }) +
        '\n',
    );
  });
}

test(
  'CLI stage/admit keeps an unfinished real installer owned until native quiescence',
  { tags: ['release'] },
  async () => {
    const result = await observeStageAdmitCase('unfinished');
    assert.ok(result.failure !== undefined && result.nativeIdle && result.rootRemoved);
    assert.equal(result.residualInstaller?.counter, 'x', 'A real installer must execute exactly once');
    assert.ok(
      result.identities.some((member) => member.pid === result.residualInstaller?.pid),
      'Installer birth identity was not observed by the native supervisor',
    );
    assert.equal(
      result.phases.some((entry) => entry.event === 'pending'),
      false,
      'CLI caller relinquished an unfinished command',
    );
    assert.equal(result.cancelledPhase, 'runtime:stage');
    assert.ok(
      (result.residualInstaller?.noiseWrites ?? 0) >= 2,
      'The actually stalled installer must emit repeated noise',
    );
    assert.equal(result.completedUnits.includes('unit:runtime:stage:installer:1'), false);
    assert.equal(
      result.phases.some((entry) => entry.phase === 'cleanup'),
      false,
      'Child cleaned a fixture with active work',
    );
  },
);

test('CLI stage/admit joins a failed real installer before restoring its fixture', { tags: ['release'] }, async () => {
  const result = await observeStageAdmitCase('installer-failure');
  assert.ok(result.failure !== undefined && result.nativeIdle && result.rootRemoved);
  assert.equal(result.installerFailureReported, true, 'The real installer failure was not reported');
  const settled = result.phases.findIndex((entry) => entry.phase === 'runtime:stage' && entry.event === 'settled');
  const cleanup = result.phases.findIndex((entry) => entry.phase === 'cleanup' && entry.event === 'start');
  assert.ok(settled >= 0 && cleanup > settled, 'Failure cleanup preceded actual command settlement');
  assert.equal(
    result.phases.some((entry) => entry.phase === 'runtime:admit'),
    false,
  );
});

test.each([
  'missing',
  'oversized',
  'records',
  'write',
  'completion-duplicate',
  'completion-unmatched',
  'completion-rejected',
  'completion-malformed',
] as const)(
  'CLI stage/admit preserves owned recovery evidence when its trace fails: %s',
  { tags: ['release'] },
  async (fault) => {
    let failure: CliCaseFailure | undefined;
    sharedOutputRead.unboundedReads = 0;
    try {
      try {
        await observeStageAdmitCase('unfinished', fault);
      } catch (error) {
        assert.ok(error instanceof Error);
        failure = error as CliCaseFailure;
      }
      assert.ok(failure?.receiptFailure, 'Unavailable phase evidence was accepted');
      if (fault === 'completion-malformed') assert.match(failure.receiptFailure, /CLI unit result binding is invalid/u);
      assert.equal(failure.nativeIdle, true);
      assert.equal(failure.traceFaultInjected, true, 'The real pending CLI trace fault did not execute');
      assert.equal(existsSync(failure.root), true, 'Untrusted phase evidence was discarded before recovery');
      assert.ok(failure.retainedPhaseCount <= 64, 'Invalid final trace replaced validated bounded evidence');
      assert.equal(sharedOutputRead.unboundedReads, 0, 'Failure handling attempted an unbounded final trace read');
      assert.equal(failure.restoredGlobalsWithPending, false, 'Trace failure bypassed the actual command join');
      if (fault !== 'write') assert.equal(failure.residualInstaller?.counter, 'x');
    } finally {
      sharedOutputRead.path = '';
      if (failure?.nativeIdle && failure.cleanupState !== undefined) {
        const recorded = JSON.parse(
          privateFiles
            .assertPrivateFile(join(failure.root, 'ownership.json'), { maxBytes: 256 * 1024 })
            .toString('utf8'),
        ) as { idle: boolean; owned: { rootPid: number } };
        assert.equal(recorded.idle, true);
        assert.equal(recorded.owned.rootPid, failure.cleanupState.rootPid);
        const { confirmOwnedCleanup } = await import('./verification.js');
        await confirmOwnedCleanup(failure.cleanupState);
        rmSync(failure.root, { recursive: true, force: true });
        assert.equal(existsSync(failure.root), false);
        process.stdout.write(
          `SETUP_CLI_TRACE_RECOVERY ${JSON.stringify({ fault, root: failure.root, quiescenceRechecked: true, removed: true })}\n`,
        );
      }
      sharedOutputRead.unboundedReads = 0;
    }
  },
);
