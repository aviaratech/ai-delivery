#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, executeCommand, safeEnvironment, selectFocusedTests } from './checks.mjs';

/** @typedef {{root:string,index:string,originalIndexSha256:string,tree:string,snapshot:string,directory:string,fileCount:number}} StagedSnapshot */
/** @typedef {{lockfileVersion:number,packages:Record<string,Record<string,unknown>>}} DependencyLock */
/** @typedef {{schemaVersion:string,startedAt:string,status:string,resultsDir:string,ownedDirectory:string,cleanupConfirmed:boolean,fullSuccess:boolean, artifactQualified:boolean, artifactOmitted:string[], stagedTree?:string,fileCount?:number,sourceIndexPath?:string,sourceIndexSha256?:string,command?:string[],process?:import('./checks.mjs').CommandRecord,error?:string,completedAt?:string,exitCode?:number,sourceIndexUnchanged?:boolean}} StagedReport */
/** @typedef {{cwd?:string,resultsDir?:string,testFiles?:string[],buildPlugin?:boolean,signal?:AbortSignal,execute?:typeof executeCommand}} StagedOptions */

/** @param {string} cwd @param {string[]} args @param {NodeJS.ProcessEnv} env */
function git(cwd, args, env) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`Staged snapshot Git read failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}
/** @param {string} path */
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** @param {string} cwd @param {string} directory @returns {StagedSnapshot} */
export function prepareStagedSnapshot(cwd, directory) {
  const env = safeEnvironment();
  // Git supplies temporary indexes for commit -a/path-limited commits. Capture
  // that one caller input before sanitizing child environments; never mutate it.
  const indexEnv = process.env.GIT_INDEX_FILE
    ? { ...env, GIT_INDEX_FILE: resolve(cwd, process.env.GIT_INDEX_FILE) }
    : env;
  const root = git(cwd, ['rev-parse', '--show-toplevel'], indexEnv);
  const index = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index'], indexEnv));
  assert.ok(existsSync(index), 'No staged index exists.');
  const originalIndexSha256 = digest(index);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const snapshot = join(directory, 'snapshot');
  const objects = join(directory, 'objects');
  mkdirSync(snapshot);
  mkdirSync(objects);
  const privateIndex = join(directory, 'index');
  copyFileSync(index, privateIndex);
  const objectDirectory = realpathSync(resolve(root, git(root, ['rev-parse', '--git-path', 'objects'], env)));
  const privateEnv = {
    ...env,
    GIT_INDEX_FILE: privateIndex,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objectDirectory),
  };
  const entries = git(root, ['ls-files', '--stage', '-z'], privateEnv).split('\0').filter(Boolean);
  assert.ok(entries.length, 'Empty staged snapshot.');
  for (const entry of entries) {
    const match = /^(100644|100755) ([0-9a-f]{40}) 0\t([^\0]+)$/u.exec(entry);
    assert.ok(match, 'Unmerged, submodule or symlink index entry cannot be safely checked by this contributor hook.');
    assert.ok(!match[3].startsWith('/') && !match[3].split('/').includes('..'), 'Unsafe staged path.');
  }
  const tree = git(root, ['write-tree'], privateEnv);
  git(root, ['checkout-index', '--all', '--ignore-skip-worktree-bits', `--prefix=${snapshot}${sep}`], privateEnv);
  // All repository metadata written below belongs to the disposable snapshot.
  git(snapshot, ['init', '-q'], env);
  git(snapshot, ['add', '--force', '--all'], env);
  assert.equal(
    git(snapshot, ['write-tree'], env),
    tree,
    'Materialized snapshot differs from the exact staged Git tree.',
  );
  assert.equal(
    digest(index),
    originalIndexSha256,
    'The source index changed during snapshot preparation; no restoration is attempted.',
  );
  return { root, index, originalIndexSha256, tree, snapshot, directory, fileCount: entries.length };
}

/** @param {StagedOptions} [options] @returns {Promise<StagedReport>} */
export async function runStagedChecks({
  cwd = process.cwd(),
  resultsDir,
  testFiles,
  buildPlugin = false,
  signal,
  execute = executeCommand,
} = {}) {
  const results = resolve(resultsDir ?? join(tmpdir(), `ai-delivery-staged-results-${randomUUID()}`));
  mkdirSync(results, { recursive: true, mode: 0o700 });
  assert.ok(
    !existsSync(join(results, 'staged.json')),
    'Existing staged result: inspect prior completion/process state before retrying.',
  );
  const owned = join(tmpdir(), `ai-delivery-staged-${randomUUID()}`);
  /** @type {StagedReport} */
  const record = {
    schemaVersion: 'staged-contributor-checks@1',
    startedAt: new Date().toISOString(),
    status: 'preparing',
    resultsDir: results,
    ownedDirectory: owned,
    cleanupConfirmed: false,
    fullSuccess: false,
    artifactQualified: false,
    artifactOmitted: ['actual archive', 'clean-HEAD production consumer and owned cleanup'],
  };
  const save = () => {
    const temporary = join(results, 'staged.json.tmp');
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, join(results, 'staged.json'));
  };
  save();
  /** @type {StagedSnapshot|undefined} */
  let snapshot;
  let launched = false;
  try {
    assert.ok(
      Array.isArray(testFiles) && testFiles.length,
      'An explicit focused test selection is required; use --test-file or AI_DELIVERY_FOCUSED_TESTS.',
    );
    snapshot = prepareStagedSnapshot(cwd, owned);
    const selected = selectFocusedTests(snapshot.snapshot, testFiles);
    Object.assign(record, {
      stagedTree: snapshot.tree,
      fileCount: snapshot.fileCount,
      sourceIndexPath: snapshot.index,
      sourceIndexSha256: snapshot.originalIndexSha256,
    });
    const runner = join(snapshot.snapshot, 'scripts/checks.mjs');
    assert.ok(existsSync(runner), 'Stage scripts/checks.mjs: unstaged check code cannot validate the staged snapshot.');
    const env = safeEnvironment();
    const userConfig = join(owned, 'npm-user-empty.rc');
    const globalConfig = join(owned, 'npm-global-empty.rc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    env.npm_config_userconfig = userConfig;
    env.npm_config_globalconfig = globalConfig;
    env.npm_config_cache = join(owned, 'npm-cache');
    // Reuse installed package bytes, while the snapshot owns the node_modules
    // parent and all tool caches. Never provision or repair setup from a hook.
    const modules = join(snapshot.root, 'node_modules');
    const metadata = join(modules, '.package-lock.json');
    assert.ok(
      existsSync(metadata),
      'Compatible installed dependency metadata is missing; complete explicit setup before committing.',
    );
    const moduleRoot = realpathSync(modules);
    const metadataDigest = digest(metadata);
    const installed = /** @type {DependencyLock} */ (JSON.parse(readFileSync(metadata, 'utf8')));
    const stagedLock = /** @type {DependencyLock} */ (
      JSON.parse(readFileSync(join(snapshot.snapshot, 'package-lock.json'), 'utf8'))
    );
    assert.ok(
      stagedLock.lockfileVersion >= 2 && stagedLock.packages && installed.packages,
      'Staged dependency lock or installed metadata is incompatible; complete explicit setup.',
    );
    const stagedManifest = /** @type {Record<string,unknown>} */ (
      JSON.parse(readFileSync(join(snapshot.snapshot, 'package.json'), 'utf8'))
    );
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
    ])
      assert.deepEqual(
        stagedManifest[field] ?? {},
        stagedLock.packages['']?.[field] ?? {},
        'Staged dependency declarations differ from the lock; complete compatible setup.',
      );
    for (const [path, entry] of Object.entries(stagedLock.packages))
      if (path && !entry.optional)
        assert.ok(
          installed.packages[path],
          `Required staged dependency metadata is missing: ${path}; complete compatible setup.`,
        );
    /** @type {{path:string,sha256:string}[]} */
    const packageMetadata = [];
    for (const [path, entry] of Object.entries(installed.packages)) {
      const expected = stagedLock.packages[path];
      assert.ok(
        path.startsWith('node_modules/') &&
          !path.split('/').includes('..') &&
          expected &&
          !entry.link &&
          !expected.link,
        `Installed dependency is incompatible with the staged lock: ${path}`,
      );
      for (const field of ['version', 'resolved', 'integrity'])
        assert.equal(
          entry[field],
          expected[field],
          `Installed dependency differs from the staged lock: ${path} ${field}`,
        );
      const manifestPath = join(moduleRoot, path.slice('node_modules/'.length), 'package.json');
      assert.ok(
        existsSync(manifestPath),
        `Installed dependency package metadata is missing: ${path}; complete compatible setup.`,
      );
      assert.ok(
        realpathSync(manifestPath).startsWith(`${moduleRoot}${sep}`),
        'External dependency package metadata is incompatible.',
      );
      const manifest = /** @type {Record<string,unknown>} */ (JSON.parse(readFileSync(manifestPath, 'utf8')));
      assert.equal(
        manifest.version,
        entry.version,
        `Installed dependency version differs: ${path}; complete compatible setup.`,
      );
      packageMetadata.push({ path: manifestPath, sha256: digest(manifestPath) });
    }
    const snapshotModules = join(snapshot.snapshot, 'node_modules');
    mkdirSync(snapshotModules);
    for (const entry of readdirSync(moduleRoot)) {
      if (entry.startsWith('.') && entry !== '.bin') continue;
      const source = join(moduleRoot, entry);
      assert.ok(
        realpathSync(source).startsWith(`${moduleRoot}${sep}`),
        'External dependency link is incompatible with staged setup.',
      );
      symlinkSync(source, join(snapshotModules, entry), 'dir');
    }
    copyFileSync(metadata, join(snapshotModules, '.package-lock.json'));
    // Physical package links make npm follow their uninstalled development
    // dependencies. Check the staged lock graph, bound to installed metadata above.
    const compatibilityCommand = ['ls', '--all', '--json', '--offline', '--ignore-scripts', '--package-lock-only'];
    const compatibility = spawnSync('npm', compatibilityCommand, {
      cwd: snapshot.snapshot,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(
      join(results, 'dependencies.json'),
      JSON.stringify(
        {
          command: ['npm', ...compatibilityCommand],
          exitCode: compatibility.status,
          error: compatibility.error?.message,
          stdout: compatibility.stdout,
          stderr: compatibility.stderr,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    assert.ok(
      !compatibility.error && compatibility.status === 0,
      'Installed dependencies do not satisfy the staged manifest; complete explicit compatible setup.',
    );
    assert.equal(digest(metadata), metadataDigest, 'Installed dependency metadata changed during setup validation.');
    record.status = 'running';
    save();
    const command = [
      process.execPath,
      runner,
      '--fast',
      ...selected.flatMap((file) => ['--test-file', file]),
      ...(buildPlugin ? ['--build-plugin'] : []),
      '--staged-tree',
      snapshot.tree,
      '--results-dir',
      join(results, 'focused'),
    ];
    record.command = command;
    launched = true;
    const result = await execute(command, {
      cwd: snapshot.snapshot,
      env,
      directory: join(results, 'process'),
      signal,
      progress: (partial) => {
        record.process = partial;
        save();
      },
    });
    record.process = result;
    assert.equal(result.cleanupConfirmed, true, 'Staged child quiescence is unconfirmed; preserve the owned snapshot.');
    assert.equal(digest(metadata), metadataDigest, 'Installed dependency metadata changed during focused validation.');
    for (const manifest of packageMetadata)
      assert.equal(
        digest(manifest.path),
        manifest.sha256,
        'Installed dependency package metadata changed during focused validation.',
      );
    assert.equal(realpathSync(modules), moduleRoot, 'Installed dependency location changed during focused validation.');
    assert.equal(
      result.status,
      'passed',
      `Staged canonical graph ${result.status}; inspect retained results before retry.`,
    );
    const focused = /** @type {import('./checks.mjs').CheckReport} */ (
      JSON.parse(readFileSync(join(results, 'focused/result.json'), 'utf8'))
    );
    assert.equal(focused.scope, 'focused', 'Staged hook requires focused tests, not a fast-only result.');
    assert.equal(focused.status, 'partial-passed');
    assert.equal(focused.fullSuccess, false);
    assert.equal(focused.artifactQualified, false);
    assert.deepEqual(focused.selectedTestFiles, selected);
    assert.ok(
      focused.tests && focused.tests.total > 0 && focused.tests.total === focused.tests.passed,
      'Selected tests must pass.',
    );
    assert.equal(focused.tree.stagedGitTree, snapshot.tree, 'Returned checks are bound to a different staged tree.');
    assert.equal(
      digest(snapshot.index),
      snapshot.originalIndexSha256,
      'Source index changed while checks ran; do not restore or overwrite it.',
    );
    record.status = 'partial-passed';
    record.sourceIndexUnchanged = true;
  } catch (error) {
    record.status = signal?.aborted ? 'cancelled' : 'failed';
    record.error = errorMessage(error);
  } finally {
    if (snapshot) {
      try {
        record.sourceIndexUnchanged = digest(snapshot.index) === snapshot.originalIndexSha256;
        if (!record.sourceIndexUnchanged) {
          record.status = 'failed';
          record.fullSuccess = false;
          record.error = 'Source index changed; preserve user state and do not restore or overwrite it.';
        }
      } catch (error) {
        record.status = 'failed';
        record.fullSuccess = false;
        record.error = `Source index comparison unavailable: ${errorMessage(error)}`;
      }
    }
    if (!launched || record.process?.cleanupConfirmed === true) rmSync(owned, { recursive: true, force: true });
    record.cleanupConfirmed = !existsSync(owned);
    record.completedAt = new Date().toISOString();
    record.exitCode = record.status === 'partial-passed' ? 0 : record.status === 'cancelled' ? 130 : 1;
    save();
    writeFileSync(
      join(results, 'staged.txt'),
      `${record.status.toUpperCase()}; artifactQualified=false; omitted=${record.artifactOmitted.join(', ')}; stagedTree=${record.stagedTree ?? 'unavailable'}; sourceIndexUnchanged=${record.sourceIndexUnchanged ?? 'unproved'}; cleanup=${record.cleanupConfirmed}; results=${results}\n${record.error ?? ''}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(readFileSync(join(results, 'staged.txt'), 'utf8'));
  }
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /** @type {StagedOptions} */
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results-dir') options.resultsDir = args[++i];
    else if (args[i] === '--test-file') (options.testFiles ??= []).push(args[++i]);
    else if (args[i] === '--build-plugin') options.buildPlugin = true;
    else throw new Error(`Unknown staged check option: ${args[i]}`);
  }
  if (options.testFiles === undefined && process.env.AI_DELIVERY_FOCUSED_TESTS !== undefined)
    options.testFiles = /** @type {string[]} */ (JSON.parse(process.env.AI_DELIVERY_FOCUSED_TESTS));
  const controller = new AbortController();
  for (const kind of ['SIGINT', 'SIGTERM']) process.once(kind, () => controller.abort(kind));
  const result = await runStagedChecks({ ...options, signal: controller.signal });
  process.exitCode = result.exitCode;
}
