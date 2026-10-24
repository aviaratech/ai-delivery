#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {NodeJS.ProcessEnv} Environment */
/** @typedef {{file:string,title:string}} CaseIdentity */
/** @typedef {{contractPath:string,checkpoint:{path:string,sha256:string},sourceCommit:string,sourceTree:string,sourceManifestSha256:string,sourceLockSha256:string,producerSha256:string,archiveSha256:string}} ReleaseContext */
/** @typedef {{ppid:number, pgid:number, rss:number, zombie:boolean, birth:string}} ProcessRow */
/** @typedef {{cwd:string, env:Environment, directory:string, signal?:AbortSignal, timeoutMs?:number, maxOutputBytes?:number, maxRssBytes?:number, progress?:(record:CommandRecord)=>void}} CommandOptions */
/** @typedef {{command:string[], startedAt:string, stdoutPath:string, stderrPath:string, outputBytes:number, peakRssBytes:number, timeoutMs:number, exitCode:number|null, signal:NodeJS.Signals|null, status:string, ownedProcesses:{pid:number,birth:string}[], observedProcesses:{pid:number,birth:string}[], pid?:number, spawnError?:string, error?:string, cleanupConfirmed?:boolean, completedAt?:string}} CommandRecord */
/** @typedef {{controller:{version:string, executable:string}, npm:{version:string, executable:string}, libraryConsumer:{version:string, executable:string}} Toolchain */
/** @typedef {{kind:string, sha256:string, fileCount:number, stagedGitTree?:string}} TreeIdentity */
/** @typedef {{success:boolean, numTotalTests:number, numPassedTests:number, testResults:{name:string, status:string, assertionResults:{fullName:string, status:string,tags?:string[]}[]}[]}} TestReport */
/** @typedef {{name:string, version:string, bin:Record<string,string>, exports:Record<string,Record<string,string>>}} Manifest */
/** @typedef {{name:string, version:string, files:{path:string,mode:number,size:number}[]}} PackInventory */
/** @typedef {{result?:{url:string, functions:{ranges:{startOffset:number,endOffset:number,count:number}[]}[]}[]}} V8Report */
/** @typedef {Partial<CommandRecord> & {stage:string, command:string[], status:string, directory:string}} StageRecord */
/** @typedef {{path:string,dev:number,ino:number,quiescent:boolean,removed:boolean,error?:string}} ReleaseTemporary */
/** @typedef {{schemaVersion:string, runId:string, startedAt:string, scope:string, status:string, fullSuccess:boolean, artifactQualified:boolean, artifactOmitted:string[], gates:string[], omitted:string[], commands:StageRecord[], resultsDir:string, timeoutMs:number, cancellationGraceMs:number, tree?:TreeIdentity, toolchain?:Toolchain, environmentKeys?:string[], selectedTestFiles?:string[], tests?:ReturnType<typeof analyzeTests>, release?:ReleaseContext & {contractSha256:string,historicalInputSupplied:boolean,temporary?:ReleaseTemporary}, observedTests?:{files:number,total:number,passed:number,failed:number,skips:{file:string,title:string,reason:string}[]}, inventory?:ReturnType<typeof analyzeInventory>, coverage?:ReturnType<typeof coverageBaseline>, error?:string, completedAt?:string, exitCode?:number}} CheckReport */
/** @typedef {{cwd?:string, resultsDir?:string, fast?:boolean, testFiles?:string[], buildPlugin?:boolean, release?:ReleaseContext, install?:boolean, stagedTree?:string, signal?:AbortSignal, timeoutMs?:number, execute?:typeof executeCommand, toolchain?:typeof validateToolchain, environment?:Environment}} CheckOptions */

/** @param {unknown} error */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export const FULL_GATES = ['format', 'lint', 'types', 'build', 'tests', 'inventory'];
export const FAST_GATES = ['format', 'lint', 'types'];
/** @type {(CaseIdentity & {kind:"mandatory"|"external-historical-qualification"})[]} */
export const RELEASE_CASES = [
  {
    file: 'dist/setup.test.js',
    title: 'real npm success disables file logs and preserves unrelated host destinations',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'real npm failure disables file logs and preserves unrelated host destinations',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'real npm cancel disables file logs and preserves unrelated host destinations',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'real npm keeps the reviewed tarball closure after hidden-lock invalidation and completed reuse',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'CLI stage/admit separates preparation from substantive command progress',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'CLI prepared handoff rejects a mismatched stage identity without reinstall or admission',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'CLI preparation failure retains owned evidence through native drain',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'CLI preparation cancel retains owned evidence through native drain',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title: 'CLI stage/admit keeps a stalled admission response owned until native quiescence',
    kind: 'mandatory',
  },
  {
    file: 'dist/setup.test.js',
    title:
      'actual reviewed 0.3.4 archive qualifies with real npm production installation in a temporary synthetic consumer',
    kind: 'external-historical-qualification',
  },
  {
    file: 'dist/lifecycle.test.js',
    title:
      'filesystem fixture gate deterministically queues a scan through reader rejection and pass teardown on node26',
    kind: 'mandatory',
  },
  {
    file: 'dist/lifecycle.test.js',
    title:
      'filesystem fixture gate deterministically queues a scan through reader rejection and assertion teardown on node26',
    kind: 'mandatory',
  },
  {
    file: 'dist/lifecycle.test.js',
    title: 'filesystem fixture gate preserves leaked FIFO and unrelated files after abrupt on node26',
    kind: 'mandatory',
  },
  {
    file: 'dist/lifecycle.test.js',
    title: 'filesystem fixture gate preserves leaked FIFO and unrelated files after block on node26',
    kind: 'mandatory',
  },
  {
    file: 'dist/lifecycle.test.js',
    title: 'filesystem fixture gate preserves leaked FIFO and unrelated files after cancel on node26',
    kind: 'mandatory',
  },
  {
    file: 'dist/lifecycle.test.js',
    title: 'filesystem fixture gate still enforces positive byte limits after deterministic contention on node26',
    kind: 'mandatory',
  },
  {
    file: 'dist/lifecycle.test.js',
    title: 'Node 26 packed public exports preserve standalone and malformed-capability behavior',
    kind: 'mandatory',
  },
  {
    file: 'dist/targetPolicyLocal.test.js',
    title:
      'per-operation runtime preparation (15s asserted work, 15s drain) public MCP runtime_stage asserts bounded first install and exact reuse/lifecycle control with tracked policy inert',
    kind: 'mandatory',
  },
  {
    file: 'dist/targetPolicyLocal.test.js',
    title:
      'per-operation runtime preparation (15s asserted work, 15s drain) public MCP runtime_admit binds and reuses exact stage bytes after bounded real stage setup and leaves tracked policy inert',
    kind: 'mandatory',
  },
  {
    file: 'dist/targetPolicyLocal.test.js',
    title:
      'per-operation runtime preparation (15s asserted work, 15s drain) public MCP runtime_admit refuses primary source edits and leaves edited policy inert',
    kind: 'mandatory',
  },
  {
    file: 'dist/targetPolicyLocal.test.js',
    title:
      'per-operation runtime preparation (15s asserted work, 15s drain) edited runtime_admit refusal keeps bounded preparation outside its asserted-work budget',
    kind: 'mandatory',
  },
  {
    file: 'dist/targetPolicyLocal.test.js',
    title:
      'per-operation runtime preparation (15s asserted work, 15s drain) public MCP transition apply reaches unsupported historical binding after bounded stage/admit/reconnect without loading tracked policy',
    kind: 'mandatory',
  },
  {
    file: 'dist/targetPolicyLocal.test.js',
    title:
      'per-operation runtime preparation (15s asserted work, 15s drain) public MCP transition apply reaches unsupported historical binding after bounded stage/admit/reconnect without loading edited policy',
    kind: 'mandatory',
  },
  {
    file: 'dist/pluginPackaging.test.js',
    title:
      'the packed launcher creates, updates and journals repository B from a non-Git directory without an identity environment',
    kind: 'mandatory',
  },
];

export const SKIP_ALLOWLIST = [
  {
    file: 'dist/setup.test.js',
    title: 'setup interruption child',
    reason: 'Top-level helper lacks synthetic child input; passing hard-interruption parents launch it separately.',
    kind: 'parent-launched-helper',
  },
  {
    file: 'dist/setup.test.js',
    title:
      'actual reviewed 0.3.4 archive qualifies with real npm production installation in a temporary synthetic consumer',
    reason:
      'Historical reviewed 0.3.4 archive input is absent. Its qualification is unexecuted; this is no current tarball or host adoption proof.',
    kind: 'external-historical-qualification',
  },
];

/** @param {Environment} [input] @returns {Environment} */
export function safeEnvironment(input = process.env) {
  /** @type {Environment} */
  const env = {};
  for (const key of [
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'PATH',
    'SYSTEMROOT',
    'RAYON_NUM_THREADS',
    'npm_config_cache',
    'npm_config_userconfig',
    'npm_config_globalconfig',
    'AI_DELIVERY_NODE26_EXECUTABLE',
    'AI_DELIVERY_REAL_PACKAGE_ARCHIVE',
    'AI_DELIVERY_TEST_LANE',
    'AI_DELIVERY_RELEASE_CONTRACT',
  ]) {
    if (input[key] !== undefined) env[key] = input[key];
  }
  env.PATH = `${dirname(process.execPath)}:${env.PATH ?? '/usr/bin:/bin'}`;
  // macOS exposes its existing temp directory through /var or /tmp aliases.
  // Resolve that same directory so strict synthetic path checks see physical paths.
  env.TMPDIR = realpathSync(env.TMPDIR ?? tmpdir());
  for (const key of ['TEMP', 'TMP']) if (env[key] !== undefined) env[key] = realpathSync(env[key]);
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  return env;
}

/** @param {string} command @param {string[]} args @param {string} cwd @param {Environment} [env] */
function sync(command, args, cwd, env = safeEnvironment()) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`${basename(command)} ${args[0] ?? ''} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return args.includes('-z') ? result.stdout : result.stdout.trim();
}

/** @param {string} name @param {Environment} env */
function executable(name, env) {
  for (const directory of (env.PATH ?? '').split(':')) {
    const path = join(directory, name);
    if (existsSync(path)) return realpathSync(path);
  }
  throw new Error(`Missing executable: ${name}`);
}

/** @param {string} cwd @param {Environment} [env] @returns {Toolchain} */
export function validateToolchain(cwd, env = safeEnvironment()) {
  assert.equal(
    process.version,
    'v24.21.0',
    'Full checks require controller Node 24.21.0; Node 26 is the library consumer only.',
  );
  const npm = executable('npm', env);
  assert.equal(sync(process.execPath, [npm, '--version'], cwd, env), '11.19.0', 'Full checks require npm 11.19.0.');
  assert.ok(
    env.AI_DELIVERY_NODE26_EXECUTABLE,
    'Set AI_DELIVERY_NODE26_EXECUTABLE to the actual Node 26.2.0 executable.',
  );
  const node26 = realpathSync(env.AI_DELIVERY_NODE26_EXECUTABLE);
  const observed = /** @type {{version:string,execPath:string}} */ (
    JSON.parse(sync(node26, ['-p', 'JSON.stringify({version:process.version,execPath:process.execPath})'], cwd, env))
  );
  assert.equal(observed.version, 'v26.2.0', 'Library consumer executable must actually be Node 26.2.0.');
  assert.equal(realpathSync(observed.execPath), node26);
  return {
    controller: { version: process.version, executable: realpathSync(process.execPath) },
    npm: { version: '11.19.0', executable: npm },
    libraryConsumer: { version: observed.version, executable: node26 },
  };
}

/** @param {string} root @param {string} [path] @returns {string[]} */
function walk(root, path = '') {
  return readdirSync(join(root, path), { withFileTypes: true })
    .flatMap((entry) => {
      const name = join(path, entry.name);
      return entry.isDirectory() ? walk(root, name) : [name.replaceAll('\\', '/')];
    })
    .sort();
}

/** @param {string} file */
export function compiledTestFile(file) {
  return file.replace(/^src\/(.*)\.test\.ts$/u, 'dist/$1.test.js');
}

/** @param {string} cwd @param {'source'|'compiled'} [mode] */
export function expectedTests(cwd, mode = 'compiled') {
  assert.ok(mode === 'source' || mode === 'compiled', 'Unknown test input mode.');
  const sources = walk(join(cwd, 'src')).filter((path) => path.endsWith('.test.ts'));
  assert.ok(sources.length, 'No intended source tests selected.');
  return sources.map((path) => (mode === 'source' ? `src/${path}` : `dist/${path.slice(0, -3)}.js`));
}

/** @param {string} cwd @param {string[]} requested */
export function selectFocusedTests(cwd, requested) {
  assert.ok(
    Array.isArray(requested) && requested.length > 0,
    'An explicit nonempty focused test selection is required.',
  );
  const intended = new Set(expectedTests(cwd));
  assert.equal(new Set(requested).size, requested.length, 'Duplicate focused test selection.');
  for (const file of requested)
    assert.ok(
      typeof file === 'string' && intended.has(file) && !/[\\*?[\]{}]/u.test(file),
      `Invalid focused test selection: ${file}`,
    );
  return [...requested].sort();
}

/** @param {string} cwd */
export function assertCleanSelection(cwd) {
  const expected = expectedTests(cwd);
  const built = walk(join(cwd, 'dist'))
    .filter((path) => path.endsWith('.test.js'))
    .map((path) => `dist/${path}`);
  assert.deepEqual(
    built,
    expected,
    'Compiled selection differs from source: stale, deleted, renamed or missing tests.',
  );
  return expected;
}

/** @param {string} cwd */
export function treeIdentity(cwd) {
  const paths = sync('git', ['ls-files', '-co', '--exclude-standard', '-z'], cwd).split('\0').filter(Boolean);
  const files = [...new Set(paths)].sort().map((path) => {
    const full = join(cwd, path);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat) return { path, deleted: true };
    assert.ok(stat.isFile(), `Contributor snapshot requires regular tracked/source files: ${path}`);
    return {
      path,
      executable: Boolean(stat.mode & 0o111),
      sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
    };
  });
  return {
    kind: 'working-copy',
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    fileCount: files.length,
  };
}

/** @returns {Map<number,ProcessRow>} */
function processes() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss=,stat=,lstart='], { encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(`PID/birth observation unavailable: ${result.error?.message ?? result.stderr.trim()}`);
  return new Map(
    result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const fields = line.trim().split(/\s+/u);
        return /** @type {[number, ProcessRow]} */ ([
          Number(fields[0]),
          {
            ppid: Number(fields[1]),
            pgid: Number(fields[2]),
            rss: Number(fields[3]) * 1024,
            zombie: fields[4].startsWith('Z'),
            birth: fields.slice(5).join(' '),
          },
        ]);
      }),
  );
}

/** Read-only reconciliation never signals a retained process or guesses ownership.
 * @param {CommandRecord} command */
export function confirmCommandQuiescence(command) {
  assert.ok(
    command.pid && command.observedProcesses.some(({ pid, birth }) => pid === command.pid && birth),
    'Retained command lacks its observed root PID/birth; completion cannot be reconciled.',
  );
  const rows = processes();
  for (const { pid, birth } of command.observedProcesses) {
    assert.ok(birth, 'Retained process birth is missing.');
    const current = rows.get(pid);
    assert.ok(!current || current.birth !== birth || current.zombie, `Retained owned PID ${pid} is still active.`);
  }
  return { checkedAt: new Date().toISOString(), observedProcesses: command.observedProcesses, quiescent: true };
}

/** @param {number} milliseconds @returns {Promise<void>} */
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/** @param {string[]} command @param {CommandOptions} options @returns {Promise<CommandRecord>} */
export async function executeCommand(
  command,
  {
    cwd,
    env,
    directory,
    signal,
    timeoutMs = 0,
    maxOutputBytes = 32 * 1024 * 1024,
    maxRssBytes = 3 * 1024 ** 3,
    progress = () => {},
  },
) {
  mkdirSync(directory, { recursive: true });
  const stdoutPath = join(directory, 'stdout.txt');
  const stderrPath = join(directory, 'stderr.txt');
  const out = openSync(stdoutPath, 'w', 0o600);
  const err = openSync(stderrPath, 'w', 0o600);
  /** @type {CommandRecord} */
  const record = {
    command,
    startedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    outputBytes: 0,
    peakRssBytes: 0,
    timeoutMs,
    exitCode: null,
    signal: null,
    status: 'running',
    ownedProcesses: [],
    observedProcesses: [],
  };
  /** @type {Map<number,string>} */
  const owned = new Map();
  /** @type {string|undefined} */
  let reason;
  /** @type {import('node:child_process').ChildProcessByStdio<null,import('node:stream').Readable,import('node:stream').Readable>|undefined} */
  let child;
  let closed = false;
  const observe = () => {
    const rows = processes();
    const root = child?.pid;
    const rootRow = root ? rows.get(root) : undefined;
    const knownBirth = root ? owned.get(root) : undefined;
    // Known descendants can create more children after the original root exits.
    // Continue discovery from every live identity-checked owned process.
    const descendants = new Set(
      [...owned].filter(([pid, birth]) => rows.get(pid)?.birth === birth && !rows.get(pid).zombie).map(([pid]) => pid),
    );
    if (!closed && root && rootRow && !rootRow.zombie && (!knownBirth || rootRow.birth === knownBirth))
      descendants.add(root);
    for (let changed = true; changed;) {
      const size = descendants.size;
      for (const [pid, row] of rows) if (descendants.has(row.ppid)) descendants.add(pid);
      changed = descendants.size !== size;
    }
    for (const pid of descendants) if (rows.has(pid)) owned.set(pid, rows.get(pid).birth);
    const live = [...owned].filter(([pid, birth]) => rows.get(pid)?.birth === birth && !rows.get(pid).zombie);
    record.peakRssBytes = Math.max(
      record.peakRssBytes,
      (rows.get(process.pid)?.rss ?? 0) + live.reduce((sum, [pid]) => sum + rows.get(pid).rss, 0),
    );
    record.ownedProcesses = live.map(([pid, birth]) => ({ pid, birth }));
    record.observedProcesses = [...owned].map(([pid, birth]) => ({ pid, birth }));
    return { rows, live };
  };
  const terminate = async () => {
    /** @param {NodeJS.Signals} kind */
    const send = (kind) => {
      const { rows, live } = observe();
      // Identity-checked descendants include children that created their own session.
      for (const [pid, birth] of live.reverse())
        if (rows.get(pid)?.birth === birth) {
          try {
            process.kill(pid, kind);
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
          }
        }
    };
    send('SIGTERM');
    const until = Date.now() + 3000;
    while (Date.now() < until && observe().live.length) await delay(50);
    if (observe().live.length) {
      send('SIGKILL');
      const confirmation = Date.now() + 1000;
      while (Date.now() < confirmation && observe().live.length) await delay(50);
    }
  };
  try {
    processes(); // Fail before launch when owned cleanup cannot be observed.
    if (signal?.aborted) throw new Error('Cancelled before command launch.');
    child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    record.pid = child.pid;
    const completion = /** @type {Promise<void>} */ (
      new Promise((done) => {
        child.once('error', (error) => {
          record.spawnError = error.message;
        });
        child.once('close', (code, kind) => {
          closed = true;
          record.exitCode = code;
          record.signal = kind;
          done();
        });
      })
    );
    /** @param {number} fd @returns {(bytes:Buffer)=>void} */
    const capture = (fd) => (bytes) => {
      const room = Math.max(0, maxOutputBytes - record.outputBytes);
      if (room) writeSync(fd, bytes.subarray(0, room));
      record.outputBytes += bytes.length;
      if (record.outputBytes > maxOutputBytes) reason ??= 'output-limit';
    };
    child.stdout.on('data', capture(out));
    child.stderr.on('data', capture(err));
    const started = Date.now();
    while (!closed) {
      observe();
      if (signal?.aborted) reason ??= 'cancelled';
      if (timeoutMs > 0 && Date.now() - started >= timeoutMs) reason ??= 'command-timeout';
      if (record.peakRssBytes > maxRssBytes) reason ??= 'sampled-memory-limit';
      progress(record);
      if (reason) {
        await terminate();
        break;
      }
      await delay(100);
    }
    await completion;
    if (observe().live.length) {
      reason ??= 'owned-child-remained-after-command';
      await terminate();
    }
    record.cleanupConfirmed = observe().live.length === 0;
    record.status = reason ?? (record.exitCode === 0 && !record.spawnError ? 'passed' : 'failed');
  } catch (error) {
    record.status = signal?.aborted ? 'cancelled' : 'failed';
    record.error = errorMessage(error);
    if (child && !closed) {
      await terminate();
    }
  } finally {
    closeSync(out);
    closeSync(err);
    record.completedAt = new Date().toISOString();
    progress(record);
  }
  return record;
}

/** @param {TestReport} report @param {string[]} expected @param {string} cwd @param {string} output @param {Environment} [env] @param {'pr'|'release'} [lane] */
export function analyzeTests(report, expected, cwd, output, env = {}, lane = 'pr') {
  assert.ok(lane === 'pr' || lane === 'release', 'Unknown test lane.');
  assert.equal(report.success, true, 'Vitest did not report success.');
  assert.ok(
    report.testResults.every((file) => file.status === 'passed'),
    'A selected test file failed or remained incomplete.',
  );
  const selected = report.testResults.map((file) => relative(cwd, file.name).replaceAll('\\', '/')).sort();
  assert.deepEqual(selected, [...expected].sort(), 'Vitest selected/excluded an unexpected file.');
  const cases = report.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({ ...test, file: relative(cwd, file.name).replaceAll('\\', '/') })),
  );
  assert.ok(cases.length, 'Zero tests cannot establish full success.');
  assert.ok(
    cases.every((test) => typeof test.fullName === 'string' && ['passed', 'pending', 'skipped'].includes(test.status)),
    'Failed, todo or unknown test results are not full success.',
  );
  assert.equal(report.numTotalTests, cases.length, 'Reported test count mismatch.');
  assert.equal(
    report.numPassedTests,
    cases.filter((test) => test.status === 'passed').length,
    'Reported passing count mismatch.',
  );
  /** @param {string} file @param {string} title */
  const key = (file, title) => JSON.stringify([file, title]);
  const inventory = new Map(RELEASE_CASES.map((test) => [key(test.file, test.title), test]));
  /** @param {{file:string,fullName:string}} test */
  const releaseCase = (test) => inventory.has(key(compiledTestFile(test.file), test.fullName));
  for (const test of cases) {
    if (test.tags !== undefined)
      assert.equal(test.tags.includes('release'), releaseCase(test), 'Tags differ from reviewed release inventory.');
    if ((lane === 'pr' && releaseCase(test)) || (lane === 'release' && !releaseCase(test)))
      assert.notEqual(test.status, 'passed', 'A case executed outside its owned lane.');
  }
  for (const expected of RELEASE_CASES.filter((test) =>
    selected.some((file) => compiledTestFile(file) === test.file),
  )) {
    const observed = cases.filter(
      (test) => key(compiledTestFile(test.file), test.fullName) === key(expected.file, expected.title),
    );
    assert.ok(observed.length <= 1, 'A release identity executed more than once.');
    if (lane === 'release' && (expected.kind === 'mandatory' || env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE)) {
      assert.equal(observed.length, 1, 'Required release case is missing.');
      assert.equal(observed[0].status, 'passed', 'Required release case did not pass.');
    }
    if (
      lane === 'release' &&
      expected.kind === 'external-historical-qualification' &&
      !env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE
    )
      assert.ok(
        observed.every((test) => test.status !== 'passed'),
        'Historical qualification ran without its genuine input.',
      );
  }
  const owned = cases.filter((test) => (lane === 'release' ? releaseCase(test) : !releaseCase(test)));
  const passed = owned.filter((test) => test.status === 'passed');
  assert.ok(passed.length, 'Zero passing owned cases cannot establish success.');
  const skips = owned
    .filter((test) => ['pending', 'skipped'].includes(test.status))
    .map((test) => {
      const allowed = SKIP_ALLOWLIST.find(
        (entry) => entry.file === compiledTestFile(test.file) && entry.title === test.fullName,
      );
      assert.ok(allowed, `Unexpected skip: ${test.file}: ${test.fullName}`);
      assert.ok(
        allowed.kind !== 'external-historical-qualification' || !env.AI_DELIVERY_REAL_PACKAGE_ARCHIVE,
        'Historical archive qualification skipped despite explicit AI_DELIVERY_REAL_PACKAGE_ARCHIVE input.',
      );
      return { ...allowed, file: test.file };
    });
  if (skips.some((entry) => entry.kind === 'parent-launched-helper')) {
    assert.ok(
      passed.some(
        (test) =>
          test.fullName ===
          'stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install',
      ),
    );
    assert.ok(
      passed.some(
        (test) =>
          test.fullName ===
          'native stopped setup owners stay busy and orphan recovery confirms cleanup before retrying the incomplete install',
      ),
    );
    assert.ok(output.includes('SETUP_INTERRUPTION_RECEIPT'), 'Parent-launched helper proof is missing.');
  }
  return {
    files: selected.length,
    total: owned.length,
    passed: passed.length,
    skips,
    parentLaunchedHelperProved: skips.some((entry) => entry.kind === 'parent-launched-helper'),
    lane,
    selectedCases: owned.map((test) => ({ file: test.file, title: test.fullName })),
    laneExcluded:
      lane === 'pr'
        ? RELEASE_CASES.filter((test) => selected.some((file) => compiledTestFile(file) === test.file)).map(
            ({ file, title }) => ({
              file: selected.some((name) => name.startsWith('src/'))
                ? file.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts')
                : file,
              title,
            }),
          )
        : cases.filter((test) => !releaseCase(test)).map((test) => ({ file: test.file, title: test.fullName })),
  };
}

/** @param {PackInventory[]} pack @param {string} cwd */
export function analyzeInventory(pack, cwd) {
  assert.equal(pack.length, 1, 'Expected one inventory.');
  const manifest = /** @type {Manifest} */ (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')));
  const item = pack[0];
  assert.equal(item.name, manifest.name);
  assert.equal(item.version, manifest.version);
  const paths = item.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length, 'Duplicate inventory members.');
  assert.ok(
    paths.every((path) => !isAbsolute(path) && !path.split('/').includes('..') && !path.includes('\\')),
    'Unsafe inventory member.',
  );
  const expected = [
    ...Object.values(manifest.bin),
    ...Object.values(manifest.exports).flatMap((entry) => Object.values(entry)),
    'plugins/ai-delivery/runtime/dist/cli.js',
    'plugins/ai-delivery/dist/mcp-launcher.js',
  ];
  for (const entry of expected)
    assert.ok(paths.includes(entry.replace(/^\.\//u, '')), `Missing packaged entry: ${entry}`);
  const cli = item.files.find((file) => file.path === 'dist/cli.js');
  assert.equal(cli.mode & 0o111, 0o111, 'CLI executable mode missing.');
  // Ignored build files are outside the source fingerprint. Capture their bytes
  // now, inside the successful producer, before an actual archive can be packed.
  const files = item.files.map(({ path, size, mode }) => {
    const full = join(cwd, path);
    assert.equal(realpathSync(full), join(realpathSync(cwd), path), 'Aliased inventory member.');
    const stat = lstatSync(full);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Inventory member requires a regular file.');
    const content = readFileSync(full);
    assert.equal(content.length, size, `Inventory byte count differs: ${path}`);
    assert.equal(stat.mode & 0o777, mode, `Inventory mode differs: ${path}`);
    return { path, size, mode, sha256: createHash('sha256').update(content).digest('hex') };
  });
  return {
    kind: 'dry-inventory-only',
    name: item.name,
    version: item.version,
    fileCount: paths.length,
    files,
    currentTarballConsumerGate: 'unexecuted; issue90 owns the separately reviewed gate',
  };
}

/** @param {string} directory @param {string} cwd */
export function coverageBaseline(directory, cwd) {
  /** @type {Map<string,Map<string,boolean>>} */
  const files = new Map();
  for (const path of existsSync(directory) ? walk(directory).filter((name) => name.endsWith('.json')) : []) {
    const report = /** @type {V8Report} */ (JSON.parse(readFileSync(join(directory, path), 'utf8')));
    for (const script of report.result ?? []) {
      if (!script.url.startsWith('file:')) continue;
      const name = relative(cwd, fileURLToPath(script.url)).replaceAll('\\', '/');
      if (!/^(?:dist\/|scripts\/)/u.test(name) || name.endsWith('.test.js') || name.startsWith('dist/fixtures/'))
        continue;
      const ranges = files.get(name) ?? new Map(/** @type {[string,boolean][]} */ ([]));
      for (const fn of script.functions)
        for (const range of fn.ranges) {
          const key = `${range.startOffset}:${range.endOffset}`;
          ranges.set(key, (ranges.get(key) ?? false) || range.count > 0);
        }
      files.set(name, ranges);
    }
  }
  assert.ok(files.size, 'No V8 coverage evidence collected.');
  const baseline = [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, ranges]) => ({
      path,
      executedRanges: [...ranges.values()].filter(Boolean).length,
      observedRanges: ranges.size,
      percent: Math.round(([...ranges.values()].filter(Boolean).length / ranges.size) * 10000) / 100,
    }));
  return {
    metric: 'V8 executed observed ranges in compiled/library and contributor scripts; not source line/branch coverage',
    files: baseline,
    instrumentationLimits:
      'Startup collection measures native child invocations, including synthetic Git hooks; it does not instrument the main canonical controller or Vitest-transformed imports. Runner counters cover native fixture paths only.',
    unmeasuredContributorScripts: [
      'scripts/checks.mjs',
      'scripts/pre-commit.mjs',
      'scripts/current-qualification.mjs',
      'scripts/current-consumer.mjs',
    ]
      .filter((path) => !files.has(path))
      .map((path) => ({
        path,
        reason: 'Startup V8 collection does not observe this controller or Vitest-transformed module in this graph.',
        threshold: null,
      })),
    thresholdProposal:
      'For measured files, review a staged floor five percentage points below the first measured baseline using the same Node/V8 graph. Unmeasured contributor scripts have no derived floor until actual instrumentation measures them. No global arbitrary percentage is enforced.',
  };
}

/** @param {string} directory @param {CheckReport} report */
function persist(directory, report) {
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, 'result.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, join(directory, 'result.json'));
  const lines = [
    `${report.scope.toUpperCase()} contributor checks: ${report.status}`,
    `Tree: ${JSON.stringify(report.tree ?? null)}`,
    `Results: ${directory}`,
    `Gates: ${report.gates.join(', ')}`,
    `Omitted: ${report.omitted.join(', ') || 'none'}`,
    `Actual artifact qualified: false; omitted: ${report.artifactOmitted.join(', ')}`,
    ...report.commands.map(
      (step) => `${step.stage}: ${step.status}; exit=${step.exitCode}; signal=${step.signal}; log=${step.directory}`,
    ),
  ];
  if (report.selectedTestFiles) lines.push(`Selected compiled test files: ${report.selectedTestFiles.length}`);
  if (report.observedTests)
    lines.push(
      `Observed test results (full success still requires validated proof): ${report.observedTests.files} files; ${report.observedTests.passed}/${report.observedTests.total} passed; ${report.observedTests.failed} failed`,
      ...report.observedTests.skips.map((skip) => `OBSERVED SKIP ${skip.file}: ${skip.title}: ${skip.reason}`),
    );
  if (report.tests)
    lines.push(
      `Tests: ${report.tests.files} files, ${report.tests.passed}/${report.tests.total} passed`,
      ...report.tests.skips.map((skip) => `SKIP ${skip.title}: ${skip.reason}`),
    );
  if (report.error) lines.push(`Failure: ${report.error}`);
  if (report.coverage)
    lines.push(
      `Coverage: ${report.coverage.files.length} measured files; ${report.coverage.metric}`,
      `Coverage limits: ${report.coverage.instrumentationLimits}`,
      ...report.coverage.unmeasuredContributorScripts.map(
        (entry) => `UNMEASURED ${entry.path}: ${entry.reason} No derived threshold.`,
      ),
      `Threshold proposal: ${report.coverage.thresholdProposal}`,
    );
  writeFileSync(join(directory, 'result.txt'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** @param {CheckOptions} [options] @returns {Promise<CheckReport>} */
export async function runChecks({
  cwd = process.cwd(),
  resultsDir,
  fast = false,
  testFiles,
  buildPlugin = false,
  release,
  install = false,
  stagedTree,
  signal,
  timeoutMs = 0,
  execute = executeCommand,
  toolchain = validateToolchain,
  environment = safeEnvironment(),
} = {}) {
  const directory = resolve(resultsDir ?? join(tmpdir(), `ai-delivery-checks-${randomUUID()}`));
  assert.ok(
    !existsSync(join(directory, 'result.json')),
    'Existing result: reconcile uncertain prior completion before retrying with a fresh run directory.',
  );
  /** @type {CheckReport} */
  const report = {
    schemaVersion: 'contributor-checks@1',
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    scope: release ? 'release' : testFiles !== undefined ? 'focused' : fast ? 'fast' : 'full',
    status: 'running',
    fullSuccess: false,
    artifactQualified: false,
    artifactOmitted: release
      ? ['full PR producer', 'current-consumer application and owned cleanup']
      : [
          'release install/archive cases',
          'actual scripts-disabled archive',
          'current-consumer application and owned cleanup',
        ],
    gates: release
      ? ['tests']
      : testFiles !== undefined
        ? [...FAST_GATES, 'build', ...(buildPlugin ? ['plugin-build'] : []), 'tests']
        : fast
          ? FAST_GATES
          : FULL_GATES,
    omitted: release
      ? [
          ...FULL_GATES.filter((gate) => gate !== 'tests'),
          'PR test cases',
          'full producer and production consumer proof',
        ]
      : testFiles !== undefined
        ? ['unselected tests', 'inventory', ...(buildPlugin ? [] : ['plugin bundle'])]
        : fast
          ? FULL_GATES.filter((gate) => !FAST_GATES.includes(gate))
          : [],
    commands: [],
    resultsDir: directory,
    timeoutMs,
    cancellationGraceMs: 3000,
  };
  persist(directory, report);
  /** @param {string} message */
  const notify = (message) => process.stdout.write(`[${report.scope}] ${message}\n`);
  try {
    assert.ok(
      environment.AI_DELIVERY_TEST_LANE === undefined || ['pr', 'release'].includes(environment.AI_DELIVERY_TEST_LANE),
      'Unknown test lane.',
    );
    if (release) {
      assert.ok(
        !fast && testFiles === undefined && !buildPlugin && !install && stagedTree === undefined,
        'Release scope cannot combine with ordinary/staged gates.',
      );
      const { validateReleaseEntry } = await import('./current-qualification.mjs');
      const validated = validateReleaseEntry(release.contractPath, cwd);
      assert.deepEqual(
        validated,
        release,
        'Release context differs from its immutable source/producer/archive contract.',
      );
      report.release = {
        ...validated,
        contractSha256: createHash('sha256').update(readFileSync(validated.contractPath)).digest('hex'),
        historicalInputSupplied: Boolean(environment.AI_DELIVERY_REAL_PACKAGE_ARCHIVE),
      };
      environment = {
        ...environment,
        AI_DELIVERY_TEST_LANE: 'release',
        AI_DELIVERY_RELEASE_CONTRACT: validated.contractPath,
      };
    } else {
      environment = { ...environment, AI_DELIVERY_TEST_LANE: 'pr' };
      delete environment.AI_DELIVERY_RELEASE_CONTRACT;
    }
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0, 'Command timeout must be a nonnegative integer.');
    assert.ok(
      !fast || !install,
      'Local fast/focused checks never install dependencies; complete explicit setup separately.',
    );
    assert.ok(testFiles === undefined || fast, 'Explicit focused selection requires --fast.');
    assert.ok(!buildPlugin || testFiles !== undefined, 'Plugin bundling requires an explicit focused selection.');
    if (testFiles !== undefined) report.selectedTestFiles = selectFocusedTests(cwd, testFiles);
    report.tree = treeIdentity(cwd);
    if (stagedTree !== undefined) {
      assert.match(stagedTree, /^[0-9a-f]{40}$/u);
      report.tree = { ...report.tree, stagedGitTree: stagedTree };
    }
    report.toolchain = toolchain(cwd, environment);
    report.environmentKeys = Object.keys(environment).sort();
    const npm = [process.execPath, report.toolchain.npm.executable];
    /** @param {string} stage @param {string[]} command */
    const run = async (stage, command) => {
      if (signal?.aborted) throw new Error('Cancelled before next gate.');
      /** @type {StageRecord} */
      const entry = { stage, command, status: 'starting', directory: join(directory, stage) };
      report.commands.push(entry);
      persist(directory, report);
      notify(`START ${stage}`);
      const result = await execute(command, {
        cwd,
        env: fast || release ? environment : { ...environment, NODE_V8_COVERAGE: join(directory, 'v8') },
        directory: entry.directory,
        signal,
        timeoutMs,
        progress: (partial) => {
          Object.assign(entry, partial);
          persist(directory, report);
        },
      });
      Object.assign(entry, result);
      // Keep raw scope/count/skip observations even when the test command fails.
      const testResult = join(directory, 'vitest.json');
      if (stage === 'tests' && existsSync(testResult)) {
        const observed = /** @type {TestReport} */ (JSON.parse(readFileSync(testResult, 'utf8')));
        const cases = observed.testResults.flatMap((file) =>
          file.assertionResults.map((test) => ({ ...test, file: relative(cwd, file.name).replaceAll('\\', '/') })),
        );
        report.observedTests = {
          files: observed.testResults.length,
          total: cases.length,
          passed: cases.filter((test) => test.status === 'passed').length,
          failed: cases.filter((test) => test.status === 'failed').length,
          skips: cases
            .filter((test) => ['pending', 'skipped'].includes(test.status))
            .map((test) => {
              const allowed = SKIP_ALLOWLIST.find(
                (entry) => entry.file === compiledTestFile(test.file) && entry.title === test.fullName,
              );
              return {
                file: test.file,
                title: test.fullName,
                reason:
                  allowed?.kind === 'external-historical-qualification' && environment.AI_DELIVERY_REAL_PACKAGE_ARCHIVE
                    ? 'Explicit historical archive input was supplied but qualification skipped; full-check validation rejects it.'
                    : (allowed?.reason ?? 'Unexpected skip; full-check validation rejects it.'),
              };
            }),
        };
      }
      persist(directory, report);
      assert.equal(
        result.status,
        'passed',
        `${stage}: ${result.status}; inspect ${entry.directory} and owned process state before retry.`,
      );
      notify(`EXIT ${stage}: 0`);
      return result;
    };
    /** @param {string[]} allTests */
    const testSelected = async (allTests) => {
      assert.ok(report.selectedTestFiles?.length, 'Selected test files are missing.');
      const testReport = join(directory, 'vitest.json');
      const testRun = await run('tests', [
        process.execPath,
        join(cwd, 'node_modules/vitest/vitest.mjs'),
        'run',
        `--mode=${fast || release ? 'compiled' : 'source'}`,
        `--tags-filter=${release ? 'release' : '!release'}`,
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${testReport}`,
        ...(fast || release
          ? [
              '--no-cache',
              ...allTests
                .filter((file) => !report.selectedTestFiles?.includes(file))
                .map((file) => `--exclude=${file}`),
            ]
          : []),
        ...report.selectedTestFiles,
      ]);
      report.tests = analyzeTests(
        /** @type {TestReport} */ (JSON.parse(readFileSync(testReport, 'utf8'))),
        report.selectedTestFiles,
        cwd,
        readFileSync(testRun.stdoutPath, 'utf8'),
        environment,
        release ? 'release' : 'pr',
      );
    };
    if (release) {
      const temporary = join(directory, 'temporary');
      mkdirSync(temporary, { mode: 0o700 });
      const identity = lstatSync(temporary);
      assert.equal(realpathSync(temporary), temporary, 'Release temporary directory is aliased.');
      assert.ok(report.release);
      report.release.temporary = {
        path: temporary,
        dev: identity.dev,
        ino: identity.ino,
        quiescent: false,
        removed: false,
      };
      environment = { ...environment, TMPDIR: temporary, TEMP: temporary, TMP: temporary };
      report.selectedTestFiles = [...new Set(RELEASE_CASES.map((test) => test.file))];
      await testSelected(report.selectedTestFiles);
      const { validateReleaseEntry } = await import('./current-qualification.mjs');
      assert.deepEqual(
        validateReleaseEntry(release.contractPath, cwd),
        release,
        'Release inputs changed during tests.',
      );
      assert.equal(
        createHash('sha256').update(readFileSync(release.contractPath)).digest('hex'),
        report.release?.contractSha256,
        'Release contract bytes changed during tests.',
      );
    } else {
      if (install) await run('dependency-provisioning', [...npm, 'ci', '--no-audit', '--no-fund']);
      await run('format', [...npm, 'run', 'format:check']);
      await run('lint', [...npm, 'run', 'lint']);
      // Native declaration analysis runs once in the producer; fast mode stays noEmit.
      if (!fast || report.selectedTestFiles) rmSync(join(cwd, 'dist'), { recursive: true, force: true });
      await run('types', [
        ...npm,
        'run',
        'typecheck',
        ...(!fast ? ['--', '--noEmit', 'false', '--emitDeclarationOnly'] : []),
      ]);
      if (!fast || report.selectedTestFiles) {
        await run('build', [process.execPath, join(cwd, 'scripts/build.mjs'), ...(!fast ? ['--plugin'] : [])]);
        if (fast && buildPlugin) await run('plugin-build', [process.execPath, join(cwd, 'scripts/build-plugin.mjs')]);
        const allTests = assertCleanSelection(cwd);
        report.selectedTestFiles ??= expectedTests(cwd, 'source');
        await testSelected(allTests);
        if (!fast) {
          const inventory = await run('inventory', [...npm, 'pack', '--dry-run', '--ignore-scripts', '--json']);
          report.inventory = analyzeInventory(
            /** @type {PackInventory[]} */ (JSON.parse(readFileSync(inventory.stdoutPath, 'utf8'))),
            cwd,
          );
          report.coverage = coverageBaseline(join(directory, 'v8'), cwd);
        }
      }
    }
    assert.deepEqual(
      treeIdentity(cwd),
      report.tree.stagedGitTree
        ? { kind: report.tree.kind, sha256: report.tree.sha256, fileCount: report.tree.fileCount }
        : report.tree,
      'Source tree changed during checks.',
    );
    report.status = fast ? 'partial-passed' : 'passed';
    report.fullSuccess = !fast && !release;
  } catch (error) {
    report.status =
      signal?.aborted || report.commands.some((entry) => entry.status === 'cancelled') ? 'cancelled' : 'failed';
    report.error = errorMessage(error);
  }
  if (report.release?.temporary) {
    const temporary = report.release.temporary;
    try {
      assert.ok(
        report.commands.every((command) => command.cleanupConfirmed === true),
        'Release command quiescence is unconfirmed.',
      );
      temporary.quiescent = true;
      const identity = lstatSync(temporary.path);
      assert.ok(
        identity.isDirectory() &&
          !identity.isSymbolicLink() &&
          identity.dev === temporary.dev &&
          identity.ino === temporary.ino,
        'Release temporary identity changed; preserve it for reconciliation.',
      );
      assert.equal(realpathSync(temporary.path), temporary.path, 'Release temporary path changed.');
      rmSync(temporary.path, { recursive: true });
      assert.equal(
        lstatSync(temporary.path, { throwIfNoEntry: false }),
        undefined,
        'Release temporary directory remains.',
      );
      temporary.removed = true;
    } catch (error) {
      temporary.error = errorMessage(error);
      report.error = [report.error, `Release cleanup failed: ${temporary.error}`].filter(Boolean).join('; ');
      if (report.status !== 'cancelled') report.status = 'failed';
    }
  }
  report.completedAt = new Date().toISOString();
  report.exitCode =
    report.status === 'passed' || report.status === 'partial-passed' ? 0 : report.status === 'cancelled' ? 130 : 1;
  persist(directory, report);
  notify(`${report.status.toUpperCase()}; fullSuccess=${report.fullSuccess}; results=${directory}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @type {CheckOptions} */
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fast') options.fast = true;
    else if (args[i] === '--test-file') (options.testFiles ??= []).push(args[++i]);
    else if (args[i] === '--build-plugin') options.buildPlugin = true;
    else if (args[i] === '--install') options.install = true;
    else if (args[i] === '--results-dir') options.resultsDir = args[++i];
    else if (args[i] === '--staged-tree') options.stagedTree = args[++i];
    else if (args[i] === '--command-timeout-ms') options.timeoutMs = Number(args[++i]);
    else throw new Error(`Unknown contributor check option: ${args[i]}`);
  }
  const controller = new AbortController();
  for (const kind of ['SIGINT', 'SIGTERM']) process.once(kind, () => controller.abort(kind));
  const report = await runChecks({ ...options, signal: controller.signal });
  process.exitCode = report.exitCode;
}
