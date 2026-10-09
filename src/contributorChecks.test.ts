import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

type CommandResult = {
  status: string;
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  cleanupConfirmed?: boolean;
  observedProcesses?: { pid: number; birth: string }[];
};
type CommandOptions = {
  cwd: string;
  env: Record<string, string>;
  directory: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  progress?: (record: object) => void;
};
type Report = {
  status: string;
  fullSuccess: boolean;
  exitCode: number;
  omitted: string[];
  commands: { stage: string; status: string }[];
  selectedTestFiles?: string[];
  error?: string;
  observedTests?: { total: number; passed: number; failed: number };
};
type TestReport = {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  testResults: { name: string; status: string; assertionResults: { fullName: string; status: string }[] }[];
};
type Toolchain = {
  controller: { version: string; executable: string };
  npm: { version: string; executable: string };
  libraryConsumer: { version: string; executable: string };
};
type Checks = {
  FULL_GATES: string[];
  FAST_GATES: string[];
  safeEnvironment(input: Record<string, string>): Record<string, string>;
  validateToolchain(cwd: string, env: Record<string, string>): Toolchain;
  assertCleanSelection(cwd: string): string[];
  treeIdentity(cwd: string): { sha256: string };
  analyzeTests(
    report: TestReport,
    expected: string[],
    cwd: string,
    output: string,
  ): { files: number; total: number; passed: number; skips: object[] };
  executeCommand(command: string[], options: CommandOptions): Promise<CommandResult>;
  runChecks(options: {
    cwd: string;
    resultsDir: string;
    fast?: boolean;
    toolchain?: () => Toolchain;
    execute?: Checks['executeCommand'];
  }): Promise<Report>;
};
const checks = (await import(new URL('../scripts/checks.mjs', import.meta.url).href)) as Checks;
const repository = fileURLToPath(new URL('../', import.meta.url));

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'contributor-check-fixture-'));
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), '/dist/\n/node_modules/\n');
  writeFileSync(join(cwd, 'src/original.test.ts'), '// synthetic original test\n');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: '@example/fixture',
      version: '1.0.0',
      bin: { fixture: './dist/cli.js' },
      exports: { '.': { default: './dist/index.js' } },
    }),
  );
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['add', '.'], { cwd });
  const toolchain: Toolchain = {
    controller: { version: 'v24.21.0', executable: process.execPath },
    npm: { version: '11.19.0', executable: 'synthetic-npm' },
    libraryConsumer: { version: 'v26.2.0', executable: 'synthetic-node26' },
  };
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  return { base, cwd, toolchain, cleanup };
}

function passingReport(cwd: string, names: string[]): TestReport {
  return {
    success: true,
    numTotalTests: names.length,
    numPassedTests: names.length,
    testResults: names.map((name) => ({
      name: join(cwd, name),
      status: 'passed',
      assertionResults: [{ fullName: 'synthetic assertion', status: 'passed' }],
    })),
  };
}

function executor(f: ReturnType<typeof fixture>, failStage = ''): Checks['executeCommand'] {
  return async (command, options) => {
    mkdirSync(options.directory, { recursive: true });
    const stdoutPath = join(options.directory, 'stdout.txt');
    const stderrPath = join(options.directory, 'stderr.txt');
    writeFileSync(stdoutPath, '');
    writeFileSync(stderrPath, '');
    const stage = options.directory.split('/').at(-1)!;
    if (stage === 'build') {
      assert.equal(
        existsSync(join(f.cwd, 'dist/stale.test.js')),
        false,
        'clean before build, rather than after selection',
      );
      mkdirSync(join(f.cwd, 'dist'), { recursive: true });
      const source = existsSync(join(f.cwd, 'src/renamed.test.ts')) ? 'renamed' : 'original';
      writeFileSync(join(f.cwd, `dist/${source}.test.js`), '// compiled synthetic test\n');
    }
    if (stage === 'tests') {
      const names = command.filter((arg) => arg.startsWith('dist/') && arg.endsWith('.test.js'));
      assert.equal(names.length, 1);
      const path = command
        .find((arg) => arg.startsWith('--outputFile.json='))!
        .split('=')
        .slice(1)
        .join('=');
      writeFileSync(path, JSON.stringify(passingReport(f.cwd, names)));
    }
    if (stage === 'inventory') {
      writeFileSync(
        stdoutPath,
        JSON.stringify([
          {
            name: '@example/fixture',
            version: '1.0.0',
            files: [
              'dist/cli.js',
              'dist/index.js',
              'plugins/ai-delivery/runtime/dist/cli.js',
              'plugins/ai-delivery/dist/mcp-launcher.js',
            ].map((path) => ({ path, mode: 0o755 })),
          },
        ]),
      );
      const coverage = options.env.NODE_V8_COVERAGE!;
      mkdirSync(coverage, { recursive: true });
      writeFileSync(
        join(coverage, 'synthetic.json'),
        JSON.stringify({
          result: [
            {
              url: new URL(`file://${join(f.cwd, 'dist/index.js')}`).href,
              functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
            },
          ],
        }),
      );
    }
    const result = {
      status: stage === failStage ? 'failed' : 'passed',
      exitCode: stage === failStage ? 7 : 0,
      stdoutPath,
      stderrPath,
    };
    options.progress?.(result);
    return result;
  };
}

test('local and CI share full entry; fast explicitly omits gates and no CI duplicate build', () => {
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts.checks, 'node scripts/checks.mjs');
  assert.equal(manifest.scripts['checks:fast'], 'node scripts/checks.mjs --fast');
  const ci = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run checks -- --results-dir/u);
  assert.doesNotMatch(ci, /npm run build|npm pack/u);
  assert.match(ci, /if: always\(\)/u);
  assert.deepEqual(checks.FULL_GATES, ['format', 'lint', 'types', 'build', 'tests', 'inventory']);
});

test('clean full graph removes deleted/renamed compiled tests and retains exact command evidence', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.cwd, 'dist'));
    writeFileSync(join(f.cwd, 'dist/stale.test.js'), '// deleted source output\n');
    renameSync(join(f.cwd, 'src/original.test.ts'), join(f.cwd, 'src/renamed.test.ts'));
    const resultsDir = join(f.base, 'results');
    const report = await checks.runChecks({
      cwd: f.cwd,
      resultsDir,
      toolchain: () => f.toolchain,
      execute: executor(f),
    });
    assert.equal(report.fullSuccess, true);
    assert.deepEqual(
      report.commands.map((entry) => entry.stage),
      checks.FULL_GATES,
    );
    assert.deepEqual(report.selectedTestFiles, ['dist/renamed.test.js']);
    assert.match(readFileSync(join(resultsDir, 'result.txt'), 'utf8'), /FULL contributor checks: passed/u);
    assert.equal(existsSync(join(f.cwd, 'dist/stale.test.js')), false);
    await assert.rejects(checks.runChecks({ cwd: f.cwd, resultsDir }), /Existing result/u);
    writeFileSync(join(f.cwd, 'dist/stale.test.js'), '// unexpected survivor\n');
    assert.throws(() => checks.assertCleanSelection(f.cwd), /stale, deleted, renamed/u);
  } finally {
    f.cleanup();
  }
});

test('fast success and command failure remain partial and preserve omitted/remaining proof', async () => {
  const f = fixture();
  try {
    const fast = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'fast'),
      fast: true,
      toolchain: () => f.toolchain,
      execute: executor(f),
    });
    assert.equal(fast.status, 'partial-passed');
    assert.equal(fast.fullSuccess, false);
    assert.deepEqual(fast.omitted, ['build', 'tests', 'inventory']);
    const failed = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'failed'),
      toolchain: () => f.toolchain,
      execute: executor(f, 'lint'),
    });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.fullSuccess, false);
    assert.deepEqual(
      failed.commands.map((entry) => entry.stage),
      ['format', 'lint'],
    );
    assert.match(failed.error!, /lint: failed/u);
    const testFailure = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'failed-tests'),
      toolchain: () => f.toolchain,
      execute: executor(f, 'tests'),
    });
    assert.equal(testFailure.fullSuccess, false);
    assert.equal(testFailure.observedTests?.total, 1);
    assert.match(readFileSync(join(f.base, 'failed-tests/result.txt'), 'utf8'), /Observed test results/u);
    assert.equal(testFailure.commands.at(-1)!.status, 'failed');
  } finally {
    f.cleanup();
  }
});

test('toolchain preflight rejects absent/inaccessible/wrong consumer before gates; environment excludes credentials and ambient preloads', async () => {
  const env = checks.safeEnvironment({
    PATH: process.env.PATH!,
    HOME: process.env.HOME!,
    GH_TOKEN: 'fictional-do-not-forward',
    GH_PRIVATE_KEY_GPT_REVIEWER: 'fictional-ref',
    NODE_OPTIONS: '--require fictional',
    NODE_PATH: 'checkout-only',
    NPM_TOKEN: 'fictional-token',
  });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.throws(() => checks.validateToolchain(repository, env), /AI_DELIVERY_NODE26_EXECUTABLE/u);
  assert.throws(
    () =>
      checks.validateToolchain(repository, { ...env, AI_DELIVERY_NODE26_EXECUTABLE: '/nonexistent/synthetic-node' }),
    /ENOENT/u,
  );
  assert.throws(
    () => checks.validateToolchain(repository, { ...env, AI_DELIVERY_NODE26_EXECUTABLE: process.execPath }),
    /Node 26\.2\.0/u,
  );
  const f = fixture();
  try {
    const report = await checks.runChecks({
      cwd: f.cwd,
      resultsDir: join(f.base, 'missing'),
      toolchain: () => {
        throw new Error('missing runtime');
      },
    });
    assert.equal(report.fullSuccess, false);
    assert.deepEqual(report.commands, []);
  } finally {
    f.cleanup();
  }
});

test('selection, counts and explicit skip reasons reject unexpected/zero/excluded or unproved results', () => {
  const cwd = '/synthetic/repo';
  const report = passingReport(cwd, ['dist/setup.test.js']);
  const file = report.testResults[0]!;
  file.assertionResults = [
    {
      fullName:
        'stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install',
      status: 'passed',
    },
    {
      fullName:
        'native stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install',
      status: 'passed',
    },
    { fullName: 'setup interruption child', status: 'pending' },
    {
      fullName:
        'actual reviewed 0.3.4 archive qualifies with real npm production installation in a temporary synthetic consumer',
      status: 'pending',
    },
  ];
  report.numTotalTests = 4;
  report.numPassedTests = 2;
  const result = checks.analyzeTests(report, ['dist/setup.test.js'], cwd, 'SETUP_INTERRUPTION_RECEIPT');
  assert.equal(result.skips.length, 2);
  assert.match(JSON.stringify(result.skips), /qualification is unexecuted/u);
  assert.throws(() => checks.analyzeTests(report, ['dist/setup.test.js'], cwd, ''), /proof is missing/u);
  assert.throws(() => checks.analyzeTests(report, ['dist/other.test.js'], cwd, ''), /unexpected file/u);
  file.assertionResults[2]!.fullName = 'unexpected conditional skip';
  assert.throws(() => checks.analyzeTests(report, ['dist/setup.test.js'], cwd, ''), /Unexpected skip/u);
  assert.throws(
    () => checks.analyzeTests({ success: true, numTotalTests: 0, numPassedTests: 0, testResults: [] }, [], cwd, ''),
    /Zero tests/u,
  );
});

test('real failed and explicitly timed-out commands preserve logs and prove owned cleanup', async () => {
  const f = fixture();
  try {
    const env = checks.safeEnvironment(process.env as Record<string, string>);
    const failed = await checks.executeCommand(
      [process.execPath, '-e', "console.log('partial failure evidence');process.exit(7)"],
      { cwd: f.cwd, env, directory: join(f.base, 'failure') },
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.exitCode, 7);
    assert.match(readFileSync(failed.stdoutPath, 'utf8'), /partial failure evidence/u);
    const timed = await checks.executeCommand(
      [process.execPath, '-e', "console.log('started');setInterval(()=>{},1000)"],
      { cwd: f.cwd, env, directory: join(f.base, 'timeout'), timeoutMs: 200 },
    );
    assert.equal(timed.status, 'command-timeout');
    assert.equal(timed.cleanupConfirmed, true);
    assert.ok(timed.observedProcesses!.length > 0);
    assert.ok(timed.observedProcesses!.every((row) => row.birth.length > 0));
  } finally {
    f.cleanup();
  }
});

test('cancellation reaps observed detached descendants and preserves an unrelated peer', async () => {
  const f = fixture();
  const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const controller = new AbortController();
    const marker = join(f.base, 'owned-child');
    const script = `const cp=require('node:child_process'),fs=require('node:fs');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`;
    const timer = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(timer);
        setTimeout(() => controller.abort(), 250);
      }
    }, 20);
    const result = await checks.executeCommand([process.execPath, '-e', script], {
      cwd: f.cwd,
      env: checks.safeEnvironment(process.env as Record<string, string>),
      directory: join(f.base, 'cancelled'),
      signal: controller.signal,
    });
    clearInterval(timer);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cleanupConfirmed, true);
    const ownedPid = readFileSync(marker, 'utf8');
    const state = execFileSync('/bin/ps', ['-p', ownedPid, '-o', 'stat='], { encoding: 'utf8' }).trim();
    assert.ok(state.startsWith('Z'));
    process.kill(peer.pid!, 0);
  } catch (error) {
    // ps exits1 for an absent child, which is also confirmed cleanup.
    if (!(error instanceof Error && 'status' in error && error.status === 1)) throw error;
    process.kill(peer.pid!, 0);
  } finally {
    peer.kill('SIGKILL');
    await new Promise<void>((done) => {
      if (peer.exitCode !== null || peer.signalCode !== null) done();
      else peer.once('close', () => done());
    });
    f.cleanup();
  }
});

test('existing temporary aliases resolve to the same physical directory without creating a new destination', () => {
  const f = fixture();
  try {
    const target = join(f.base, 'existing-temp');
    const alias = join(f.base, 'temp-alias');
    mkdirSync(target);
    symlinkSync(target, alias);
    const env = checks.safeEnvironment({ TMPDIR: alias, TEMP: alias, TMP: alias });
    assert.equal(env.TMPDIR, realpathSync(target));
    assert.equal(env.TEMP, realpathSync(target));
    assert.equal(env.TMP, realpathSync(target));
    assert.equal(readFileSync(join(f.cwd, 'src/original.test.ts'), 'utf8'), '// synthetic original test\n');
  } finally {
    f.cleanup();
  }
});

test('source identity preserves leading filename whitespace and refuses dangling tracked symlinks', () => {
  const f = fixture();
  try {
    const path = join(f.cwd, ' leading.txt');
    writeFileSync(path, 'first source bytes');
    execFileSync('git', ['add', '--', ' leading.txt'], { cwd: f.cwd });
    const before = checks.treeIdentity(f.cwd).sha256;
    writeFileSync(path, 'changed source bytes');
    assert.notEqual(checks.treeIdentity(f.cwd).sha256, before);
    symlinkSync('nonexistent-target', join(f.cwd, 'dangling-link'));
    execFileSync('git', ['add', '--', 'dangling-link'], { cwd: f.cwd });
    assert.throws(() => checks.treeIdentity(f.cwd), /regular tracked\/source files/u);
  } finally {
    f.cleanup();
  }
});
