#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  confirmCommandQuiescence,
  errorMessage,
  executeCommand,
  runChecks,
  safeEnvironment,
  treeIdentity,
  RELEASE_CASES,
} from './checks.mjs';
import { inspectCandidate, sha256, verifyProducerJoin } from './current-consumer.mjs';

/** @typedef {import('./current-consumer.mjs').Contract} Contract */
/** @typedef {{commit:string,tree:string,manifestSha256:string,lockSha256:string,fingerprint:ReturnType<typeof treeIdentity>}} Source */
/** @typedef {{schemaVersion:string,status:string,contract:Contract,contractSha256:string,source:Source}} Checkpoint */
/** @typedef {{path:string,sha256:string}} Reference */
/** @typedef {{schemaVersion:string,runId:string,startedAt:string,status:string,qualified:boolean,omitted:string[],resultsDir:string,source?:Source,producer?:Reference,pack?:import('./checks.mjs').CommandRecord,artifact?:Reference,checkpoint?:Reference,releaseTests?:Reference,consumer?:Reference,consumerAttempt?:Reference,consumerProcess?:import('./checks.mjs').CommandRecord,error?:string,completedAt?:string,exitCode?:number}} Qualification */
/** @typedef {{stage:string,runId:string,checkpointSha256:string,contractSha256:string,status:string,directory:string,resultPath:string,command?:import('./checks.mjs').StageRecord,receipt?:Reference}} ReleaseAttempt */
/** @typedef {{schemaVersion:string,runId:string,checkpointSha256:string,contractSha256:string,status:string,startedAt:string,directory:string,tempRoot:string,consumerPath:string,temporaryRemoved?:boolean,command?:import('./checks.mjs').CommandRecord,receipt?:{path:string,sha256:string},reconciliation?:ReturnType<typeof confirmCommandQuiescence>}} ConsumerAttempt */
/** @typedef {{cwd?:string,resultsDir?:string,producerOnly?:boolean,resume?:string,consumerResult?:string,reconcileConsumer?:boolean,signal?:AbortSignal,timeoutMs?:number,checks?:typeof runChecks,execute?:typeof executeCommand,inspect?:typeof inspectCandidate}} Options */

/** @param {string} path */
function bytes(path) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 ** 2,
    'Evidence requires a bounded regular file.',
  );
  return readFileSync(path);
}
/** @param {string} path */
function reference(path) {
  return { path, sha256: sha256(bytes(path)) };
}
/** @param {string} path @param {unknown} value */
function save(path, value) {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

/** Producer member digests precede packing, including ignored generated files.
 * @param {import('./checks.mjs').CheckReport} producer
 * @param {ReturnType<typeof inspectCandidate>} candidate */
export function verifyProducedBytes(producer, candidate) {
  assert.ok(producer.inventory?.files.length, 'Producer member-byte inventory is missing.');
  const files = producer.inventory.files;
  for (const file of files) assert.match(file.sha256, /^[a-f0-9]{64}$/u, 'Producer member digest is missing.');
  /** @param {{path:string,size:number,mode:number,sha256:string}[]} entries */
  const normalize = (entries) =>
    entries
      .map(({ path, size, mode, sha256 }) => ({ path, size, mode, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    normalize(candidate.inventory),
    normalize(files),
    'Archive bytes differ from the successful producer.',
  );
}

/** Clean Git identity is mandatory for an actual artifact, never for the staged hook.
 * @param {string} cwd @returns {Source} */
export function sourceIdentity(cwd) {
  /** @param {string[]} args */
  const git = (args) => {
    const result = spawnSync('git', args, { cwd, env: safeEnvironment(), encoding: 'utf8' });
    assert.equal(result.status, 0, 'Source Git identity unavailable.');
    return result.stdout.trim();
  };
  assert.equal(
    git(['status', '--porcelain=v1', '--untracked-files=all']),
    '',
    'Actual artifact requires a clean source including untracked files.',
  );
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert.match(tree, /^[a-f0-9]{40}$/u);
  return {
    commit,
    tree,
    manifestSha256: sha256(bytes(join(cwd, 'package.json'))),
    lockSha256: sha256(bytes(join(cwd, 'package-lock.json'))),
    fingerprint: treeIdentity(cwd),
  };
}

/** Immutable checkpoint validation runs no producer, pack or installation.
 * @param {string} path @param {string} cwd @param {typeof inspectCandidate} [inspect] */
export function validateCheckpoint(path, cwd, inspect = inspectCandidate) {
  const checkpoint = /** @type {Checkpoint} */ (JSON.parse(bytes(path).toString('utf8')));
  assert.equal(checkpoint.schemaVersion, 'ai-delivery.current-qualification-checkpoint@1');
  assert.equal(checkpoint.status, 'producer-passed-consumer-required');
  assert.equal(
    checkpoint.contractSha256,
    sha256(JSON.stringify(checkpoint.contract)),
    'Checkpoint contract integrity differs.',
  );
  assert.equal(resolve(checkpoint.contract.sourceRoot), resolve(cwd), 'Checkpoint belongs to a different source root.');
  assert.deepEqual(sourceIdentity(cwd), checkpoint.source, 'Checkpoint source HEAD/tree/fingerprint differs.');
  assert.equal(checkpoint.contract.sourceCommit, checkpoint.source.commit);
  assert.equal(checkpoint.contract.sourceTree, checkpoint.source.tree);
  assert.equal(checkpoint.contract.sourceManifestSha256, checkpoint.source.manifestSha256);
  assert.equal(checkpoint.contract.sourceLockSha256, checkpoint.source.lockSha256);
  const candidate = inspect(checkpoint.contract);
  const joinProof = verifyProducerJoin(checkpoint.contract, candidate);
  assert.ok(checkpoint.contract.producer);
  verifyProducedBytes(
    /** @type {import('./checks.mjs').CheckReport} */ (
      JSON.parse(bytes(checkpoint.contract.producer.checksResultPath).toString('utf8'))
    ),
    candidate,
  );
  return { checkpoint, candidate, joinProof };
}

/** Direct test entry must validate the same immutable source/producer/archive boundary as its owner.
 * This performs no build, pack, dependency installation or test launch.
 * @param {string} contractPath @param {string} [cwd] */
export function validateReleaseEntry(contractPath, cwd = process.cwd()) {
  assert.ok(typeof contractPath === 'string' && isAbsolute(contractPath), 'Release contract path is required.');
  assert.equal(basename(contractPath), 'contract.json', 'Release contract filename differs.');
  const root = dirname(contractPath);
  assert.equal(realpathSync(root), root, 'Release evidence root is aliased.');
  const checkpointPath = join(root, 'checkpoint.json');
  for (const path of [contractPath, checkpointPath])
    assert.equal(realpathSync(path), path, 'Release contract/checkpoint is aliased.');
  const { checkpoint } = validateCheckpoint(checkpointPath, cwd);
  const contract = checkpoint.contract;
  assert.deepEqual(
    JSON.parse(bytes(contractPath).toString('utf8')),
    contract,
    'Release contract differs from checkpoint.',
  );
  assert.ok(contract.producer, 'Release producer reference is missing.');
  for (const path of [
    contract.archivePath,
    contract.producer.checksResultPath,
    contract.producer.artifactReceiptPath,
  ]) {
    const part = relative(root, path);
    assert.ok(
      isAbsolute(path) && part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part),
      'Release reference escapes original evidence.',
    );
    assert.equal(realpathSync(path), path, 'Release reference is aliased.');
    assert.ok(lstatSync(path).isFile(), 'Release reference is not a regular file.');
  }
  assert.equal(contract.archivePath, join(root, 'pack', `aviaratech-ai-delivery-${contract.packageVersion}.tgz`));
  assert.equal(process.version, 'v24.21.0', 'Release tests require the admitted controller.');
  assert.equal(
    realpathSync(process.execPath),
    realpathSync(contract.node24),
    'Release controller differs from producer.',
  );
  return releaseContext(checkpoint, reference(checkpointPath));
}

/** @param {Checkpoint} checkpoint @param {Reference} checkpointReference */
function releaseContext(checkpoint, checkpointReference) {
  const contract = checkpoint.contract;
  assert.ok(contract.producer);
  return {
    contractPath: join(dirname(checkpointReference.path), 'contract.json'),
    checkpoint: checkpointReference,
    sourceCommit: checkpoint.source.commit,
    sourceTree: checkpoint.source.tree,
    sourceManifestSha256: checkpoint.source.manifestSha256,
    sourceLockSha256: checkpoint.source.lockSha256,
    producerSha256: contract.producer.checksResultSha256,
    archiveSha256: contract.archiveSha256,
  };
}

/** Shared by checkpoint reuse and portable release verification; no execution or filesystem reads.
 * @param {unknown} input @param {Checkpoint} checkpoint @param {Reference} checkpointReference @param {string} contractDigest */
export function validateReleaseTests(input, checkpoint, checkpointReference, contractDigest) {
  const report = /** @type {import('./checks.mjs').CheckReport} */ (input);
  assert.equal(report.schemaVersion, 'contributor-checks@1');
  assert.equal(report.scope, 'release', 'PR-only proof cannot qualify release cases.');
  assert.equal(report.status, 'passed');
  assert.equal(report.exitCode, 0);
  assert.equal(report.fullSuccess, false);
  assert.equal(report.artifactQualified, false);
  assert.deepEqual(report.gates, ['tests']);
  assert.ok(report.omitted.length > 0);
  assert.ok(report.release, 'Release context is missing.');
  const { contractSha256, historicalInputSupplied, temporary, ...context } = report.release;
  assert.deepEqual(
    context,
    releaseContext(checkpoint, checkpointReference),
    'Release proof belongs to different inputs.',
  );
  assert.equal(contractSha256, contractDigest, 'Release contract bytes differ.');
  assert.equal(typeof historicalInputSupplied, 'boolean');
  assert.deepEqual(report.tree, checkpoint.source.fingerprint);
  assert.equal(report.toolchain?.controller.executable, checkpoint.contract.node24);
  assert.equal(report.toolchain.controller.version, 'v24.21.0');
  assert.equal(report.toolchain.libraryConsumer.executable, checkpoint.contract.node26);
  assert.equal(report.toolchain.libraryConsumer.version, 'v26.2.0');
  assert.equal(report.toolchain.npm.executable, checkpoint.contract.npmCli);
  assert.equal(report.toolchain.npm.version, '11.19.0');
  assert.deepEqual(
    report.commands.map((command) => command.stage),
    ['tests'],
  );
  for (const command of report.commands) {
    assert.equal(command.status, 'passed');
    assert.equal(command.exitCode, 0);
    assert.equal(command.signal, null);
    assert.equal(command.cleanupConfirmed, true, 'Release command cleanup is unproved.');
  }
  assert.ok(
    temporary && temporary.quiescent && temporary.removed && !temporary.error,
    'Release temporary cleanup is unproved.',
  );
  assert.equal(temporary.path, join(report.resultsDir, 'temporary'));
  assert.ok(Number.isSafeInteger(temporary.dev) && Number.isSafeInteger(temporary.ino));
  const files = [...new Set(RELEASE_CASES.map((test) => test.file))].sort();
  assert.deepEqual(report.selectedTestFiles?.slice().sort(), files);
  assert.ok(report.tests);
  assert.equal(report.tests.lane, 'release');
  assert.equal(report.tests.files, files.length);
  assert.equal(report.tests.total, report.tests.passed + report.tests.skips.length);
  const expected = RELEASE_CASES.filter(
    (test) =>
      test.kind === 'mandatory' || (test.kind === 'external-historical-qualification' && historicalInputSupplied),
  );
  assert.equal(report.tests.passed, expected.length, 'Mandatory release pass count differs.');
  const skipped = report.tests.skips;
  const expectedSkips = RELEASE_CASES.filter(
    (test) =>
      test.kind === 'parent-launched-helper' ||
      (test.kind === 'external-historical-qualification' && !historicalInputSupplied),
  );
  assert.deepEqual(
    skipped.map(({ file, title, kind }) => JSON.stringify({ file, title, kind })).sort(),
    expectedSkips.map(({ file, title, kind }) => JSON.stringify({ file, title, kind })).sort(),
    'Release skip identities differ from the explicit helper/historical inventory.',
  );
  /** @param {{file:string,title:string}} test */
  const key = (test) => JSON.stringify([test.file, test.title]);
  assert.deepEqual(
    report.tests.selectedCases.map(key).sort(),
    RELEASE_CASES.map(key).sort(),
    'Release identities are missing, duplicated or unexpected.',
  );
  return report;
}

/** @param {Checkpoint} checkpoint @param {Reference} checkpointReference @param {string} contractDigest
 * @param {string} path */
function retainedRelease(checkpoint, checkpointReference, contractDigest, path) {
  const original = bytes(path);
  const attempt = /** @type {ReleaseAttempt} */ (JSON.parse(original.toString('utf8')));
  assert.equal(attempt.stage, 'release-tests');
  assert.equal(attempt.checkpointSha256, checkpointReference.sha256, 'Release attempt checkpoint differs.');
  assert.equal(attempt.contractSha256, checkpoint.contractSha256, 'Release attempt contract differs.');
  assert.equal(dirname(attempt.directory), dirname(checkpointReference.path));
  assert.match(basename(attempt.directory), /^release-tests-[a-f0-9-]{36}$/u);
  assert.equal(attempt.resultPath, join(attempt.directory, 'result.json'));
  assert.equal(
    attempt.status,
    'completed',
    `Unresolved release attempt: ${path}; reconcile retained ownership before retry.`,
  );
  assert.ok(attempt.receipt, 'Release result reference is missing.');
  assert.deepEqual(reference(attempt.resultPath), attempt.receipt, 'Retained release result changed.');
  const report = /** @type {import('./checks.mjs').CheckReport} */ (
    JSON.parse(bytes(attempt.resultPath).toString('utf8'))
  );
  assert.equal(report.resultsDir, attempt.directory, 'Release report ownership differs.');
  assert.deepEqual(attempt.command, report.commands[0], 'Retained release command differs.');
  if (report.status === 'passed') {
    validateReleaseTests(report, checkpoint, checkpointReference, contractDigest);
    assert.ok(report.release?.temporary);
    assert.equal(
      lstatSync(report.release.temporary.path, { throwIfNoEntry: false }),
      undefined,
      'Release temporary root remains.',
    );
    return { attempt, reusable: true };
  }
  assert.ok(['failed', 'cancelled'].includes(report.status), 'Unresolved release status.');
  assert.ok(
    report.commands.length === 1 && report.commands.every((command) => command.cleanupConfirmed === true),
    'Release quiescence is unconfirmed; preserve the reservation.',
  );
  assert.ok(
    report.release?.temporary?.removed && report.release.temporary.quiescent && !report.release.temporary.error,
    'Release temporary cleanup is unconfirmed; preserve the reservation.',
  );
  assert.equal(
    report.release.temporary.path,
    join(attempt.directory, 'temporary'),
    'Release temporary ownership differs.',
  );
  const { contractSha256, historicalInputSupplied: _historical, temporary: _temporary, ...context } = report.release;
  assert.deepEqual(context, releaseContext(checkpoint, checkpointReference), 'Interrupted release inputs differ.');
  assert.equal(contractSha256, contractDigest, 'Interrupted release contract changed.');
  assert.equal(
    lstatSync(report.release.temporary.path, { throwIfNoEntry: false }),
    undefined,
    'Release temporary root remains.',
  );
  if (attempt.command?.pid)
    confirmCommandQuiescence(/** @type {import('./checks.mjs').CommandRecord} */ (attempt.command));
  // The exclusive retained copy is also the retry ownership claim. A second
  // contender or a lost retirement acknowledgement must stop, never overwrite.
  writeFileSync(join(attempt.directory, 'retired-attempt.json'), original, { flag: 'wx', mode: 0o600 });
  assert.deepEqual(bytes(path), original, 'Release reservation changed during retirement.');
  return { attempt, reusable: false };
}

/** The two packed test helpers consume a private copy of the one retained candidate.
 * @param {string} contractPath @param {string} cwd @param {string} destination */
export function copyReleaseArchive(contractPath, cwd, destination) {
  assert.ok(
    isAbsolute(destination) && resolve(destination) === destination,
    'Helper archive destination must be canonical.',
  );
  assert.equal(realpathSync(dirname(destination)), dirname(destination), 'Helper destination parent is aliased.');
  const context = validateReleaseEntry(contractPath, cwd);
  const checkpointBytes = bytes(context.checkpoint.path);
  assert.equal(sha256(checkpointBytes), context.checkpoint.sha256, 'Helper checkpoint changed.');
  const checkpoint = /** @type {Checkpoint} */ (JSON.parse(checkpointBytes.toString('utf8')));
  const original = checkpoint.contract.archivePath;
  assert.notEqual(destination, original, 'Helper copy cannot replace the retained archive.');
  assert.ok(lstatSync(original).size <= 128 * 1024 ** 2, 'Helper archive exceeds its bound.');
  copyFileSync(original, destination, constants.COPYFILE_EXCL);
  const stat = lstatSync(destination);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 ** 2,
    'Helper copy is not a bounded regular file.',
  );
  assert.equal(
    sha256(readFileSync(destination)),
    context.archiveSha256,
    'Helper copy differs from the qualified archive.',
  );
  assert.deepEqual(validateReleaseEntry(contractPath, cwd), context, 'Release context changed during helper copy.');
  return { archivePath: destination, archiveSha256: context.archiveSha256 };
}

/** The checkpoint-wide reservation survives controller loss and blocks duplicate installs.
 * Completion with a lost controller can be reconciled only with a fully qualified
 * retained receipt plus absence of every observed PID/birth. No process is killed.
 * @param {string} path @param {string} checkpointPath @param {Checkpoint} checkpoint
 * @param {ReturnType<typeof inspectCandidate>} candidate @param {boolean} reconcile */
function retainedConsumer(path, checkpointPath, checkpoint, candidate, reconcile) {
  const attempt = /** @type {ConsumerAttempt} */ (JSON.parse(bytes(path).toString('utf8')));
  assert.equal(attempt.schemaVersion, 'ai-delivery.current-consumer-attempt@1');
  assert.equal(
    attempt.checkpointSha256,
    reference(checkpointPath).sha256,
    'Consumer attempt belongs to another checkpoint.',
  );
  assert.equal(attempt.contractSha256, checkpoint.contractSha256, 'Consumer attempt contract differs.');
  assert.equal(dirname(attempt.directory), dirname(checkpointPath), 'Consumer ownership directory differs.');
  assert.match(basename(attempt.directory), /^consumer-[a-f0-9-]{36}$/u);
  assert.equal(attempt.tempRoot, join(attempt.directory, 'temporary'), 'Consumer temporary ownership differs.');
  assert.equal(attempt.consumerPath, join(attempt.directory, 'result.json'), 'Consumer receipt ownership differs.');
  if (!['completed', 'reconciled'].includes(attempt.status)) {
    assert.ok(
      reconcile,
      `Unresolved consumer attempt: ${path}. Reconcile its retained PID/birth, temporary root and receipt before resume.`,
    );
    assert.ok(
      attempt.command,
      'Consumer launch identity is unavailable; keep the reservation and reconcile with its owner.',
    );
    const receipt = /** @type {unknown} */ (JSON.parse(bytes(attempt.consumerPath).toString('utf8')));
    validateConsumer(receipt, checkpoint.contract, candidate);
    attempt.reconciliation = confirmCommandQuiescence(attempt.command);
    attempt.receipt = reference(attempt.consumerPath);
    attempt.status = 'reconciled';
    save(path, attempt);
  }
  if (attempt.status === 'completed')
    assert.equal(attempt.command?.cleanupConfirmed, true, 'Retained consumer command quiescence is unconfirmed.');
  if (attempt.receipt)
    assert.deepEqual(reference(attempt.consumerPath), attempt.receipt, 'Retained consumer receipt changed.');
  return attempt;
}

/** A standalone qualified flag cannot complete the graph without exact joins and cleanup.
 * @param {unknown} input @param {Contract} contract @param {ReturnType<typeof inspectCandidate>} candidate */
export function validateConsumer(input, contract, candidate) {
  assert.ok(input && typeof input === 'object');
  const result = /** @type {import('./current-consumer.mjs').Receipt} */ (input);
  assert.equal(result.schemaVersion, 'ai-delivery.current-consumer@1');
  assert.equal(result.status, 'passed');
  assert.equal(result.qualified, true);
  assert.equal(result.sourceIdentityVerified, true);
  assert.equal(result.scriptsDisabled, true);
  for (const key of /** @type {const} */ ([
    'sourceCommit',
    'sourceTree',
    'sourceManifestSha256',
    'sourceLockSha256',
    'archiveSha256',
    'packageVersion',
  ]))
    assert.equal(result[key], contract[key], `Consumer ${key} differs.`);
  assert.equal(result.archiveManifestSha256, contract.sourceManifestSha256);
  assert.equal(result.inventorySha256, candidate.inventorySha256);
  assert.deepEqual(result.inventory, candidate.inventory);
  assert.deepEqual(result.producerJoin, verifyProducerJoin(contract, candidate));
  assert.equal(result.cleanup?.quiescent, true, 'Consumer owned quiescence is unconfirmed.');
  assert.equal(result.cleanup.removed, true, 'Consumer owned removal is unconfirmed.');
  const phases = [
    'node24',
    'node26',
    'npm',
    'production-install',
    'production-closure',
    'cli-version',
    'exports-node24',
    'library-node26',
    'packaged-mcp',
  ];
  assert.deepEqual(
    result.phases.map((phase) => phase.phase),
    phases,
    'Consumer application phases differ.',
  );
  for (const phase of result.phases) {
    assert.equal(phase.code, 0);
    assert.equal(phase.signal, null);
    assert.equal(phase.quiescent, true);
  }
  assert.ok(
    result.productionClosure && result.mcp && result.skills?.length === 3 && result.resolutions?.length,
    'Consumer application/resolution evidence is missing.',
  );
  return result;
}

/** Exactly one immutable producer and scripts-disabled pack, then release tests and the reviewed consumer.
 * Dependencies are explicit fictional fixture injection points, never CLI options.
 * @param {Options} [options] @returns {Promise<Qualification>} */
export async function runQualification({
  cwd = process.cwd(),
  resultsDir,
  producerOnly = false,
  resume,
  consumerResult,
  reconcileConsumer = false,
  signal,
  timeoutMs = 0,
  checks = runChecks,
  execute = executeCommand,
  inspect = inspectCandidate,
} = {}) {
  const directory = resolve(resultsDir ?? join(tmpdir(), `ai-delivery-qualification-${randomUUID()}`));
  assert.ok(
    !existsSync(join(directory, 'result.json')),
    'Existing overall result: reconcile completion before another attempt.',
  );
  // Receipts and archives outside source do not change the source fingerprint.
  const resultRelative = relative(resolve(cwd), directory);
  assert.ok(
    resultRelative === '..' || resultRelative.startsWith('..' + sep) || isAbsolute(resultRelative),
    'Qualification evidence must be outside source.',
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  /** @type {Qualification} */
  const result = {
    schemaVersion: 'ai-delivery.current-qualification@1',
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: 'running',
    qualified: false,
    omitted: [],
    resultsDir: directory,
  };
  const persist = () => save(join(directory, 'result.json'), result);
  persist();
  try {
    assert.ok(!consumerResult || resume, 'An external consumer result requires a retained checkpoint.');
    assert.ok(!producerOnly || !resume, 'Producer-only and resume cannot be combined.');
    assert.ok(!reconcileConsumer || resume, 'Consumer reconciliation requires a retained checkpoint.');
    if (signal?.aborted) throw new Error('Cancelled before qualification.');
    /** @type {string} */ let checkpointPath;
    if (resume) checkpointPath = resolve(resume);
    else {
      const source = sourceIdentity(cwd);
      result.source = source;
      persist();
      const producer = await checks({ cwd, resultsDir: join(directory, 'producer'), signal, timeoutMs });
      result.producer = reference(join(directory, 'producer/result.json'));
      persist();
      assert.equal(producer.fullSuccess, true, 'Canonical producer is incomplete.');
      assert.deepEqual(sourceIdentity(cwd), source, 'Source changed during the producer.');
      if (signal?.aborted) throw new Error('Cancelled after producer; no pack launched.');
      const packDirectory = join(directory, 'pack');
      mkdirSync(packDirectory);
      assert.ok(producer.toolchain && producer.inventory, 'Producer toolchain/inventory missing.');
      const pack = await execute(
        [
          producer.toolchain.controller.executable,
          producer.toolchain.npm.executable,
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          packDirectory,
        ],
        {
          cwd,
          env: safeEnvironment(),
          directory: join(packDirectory, 'command'),
          signal,
          timeoutMs,
          progress: (partial) => {
            result.pack = partial;
            persist();
          },
        },
      );
      result.pack = pack;
      persist();
      assert.equal(pack.status, 'passed', 'Actual pack failed or was interrupted.');
      assert.equal(pack.exitCode, 0);
      assert.equal(pack.signal, null);
      assert.equal(pack.cleanupConfirmed, true, 'Actual pack quiescence unconfirmed.');
      const actual = /** @type {{filename:string,files:{path:string,size:number,mode:number}[]}[]} */ (
        JSON.parse(bytes(pack.stdoutPath).toString('utf8'))
      );
      assert.equal(actual.length, 1, 'Expected exactly one actual pack.');
      const filename = actual[0].filename;
      assert.equal(basename(filename), filename, 'Unsafe actual pack filename.');
      assert.ok(filename.endsWith('.tgz'));
      const archivePath = join(packDirectory, filename);
      const archiveStat = lstatSync(archivePath);
      assert.ok(
        archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.size <= 128 * 1024 ** 2,
        'Actual pack requires a bounded regular archive.',
      );
      const manifest = /** @type {{version:string}} */ (JSON.parse(bytes(join(cwd, 'package.json')).toString('utf8')));
      /** @type {Contract} */
      const contract = {
        sourceRoot: resolve(cwd),
        sourceCommit: source.commit,
        sourceTree: source.tree,
        sourceManifestSha256: source.manifestSha256,
        sourceLockSha256: source.lockSha256,
        packageVersion: manifest.version,
        archivePath,
        archiveSha256: sha256(readFileSync(archivePath)),
        dryInventory: producer.inventory.files.map(({ path, size, mode }) => ({ path, size, mode })),
        node24: producer.toolchain.controller.executable,
        node26: producer.toolchain.libraryConsumer.executable,
        npmCli: producer.toolchain.npm.executable,
      };
      const candidate = inspect(contract);
      /** @param {{path:string,size:number,mode:number}[]} entries */
      const normalize = (entries) =>
        entries.map(({ path, size, mode }) => ({ path, size, mode })).sort((a, b) => a.path.localeCompare(b.path));
      assert.deepEqual(
        normalize(actual[0].files),
        normalize(contract.dryInventory),
        'Actual npm inventory differs from successful dry inventory.',
      );
      verifyProducedBytes(producer, candidate);
      assert.deepEqual(sourceIdentity(cwd), source, 'Source changed during actual pack.');
      const artifactPath = join(packDirectory, 'producer.json');
      save(artifactPath, {
        schemaVersion: 'ai-delivery.current-artifact-producer@1',
        status: 'passed',
        sourceCommit: source.commit,
        sourceTree: source.tree,
        sourceManifestSha256: source.manifestSha256,
        sourceLockSha256: source.lockSha256,
        packageVersion: manifest.version,
        archiveSha256: contract.archiveSha256,
        inventorySha256: candidate.inventorySha256,
        checksResultSha256: result.producer.sha256,
        sourceFingerprint: source.fingerprint,
        pack: {
          status: pack.status,
          exitCode: pack.exitCode,
          quiescent: pack.cleanupConfirmed,
          archiveSha256: contract.archiveSha256,
          command: pack,
          sourceBefore: source,
          sourceAfter: sourceIdentity(cwd),
        },
        portableCliSha256: candidate.inventory.find((entry) => entry.path === 'plugins/ai-delivery/runtime/dist/cli.js')
          ?.sha256,
        inventory: candidate.inventory,
        confidentialityLimits:
          'Safe full member paths and exact built byte/mode checks; public dependency text may contain secret-related markers. No universal absence-of-secrets claim; CI secrets remains separate.',
      });
      result.artifact = reference(artifactPath);
      contract.producer = {
        checksResultPath: result.producer.path,
        checksResultSha256: result.producer.sha256,
        artifactReceiptPath: artifactPath,
        artifactReceiptSha256: result.artifact.sha256,
      };
      verifyProducerJoin(contract, candidate);
      save(join(directory, 'contract.json'), contract);
      checkpointPath = join(directory, 'checkpoint.json');
      save(checkpointPath, {
        schemaVersion: 'ai-delivery.current-qualification-checkpoint@1',
        status: 'producer-passed-consumer-required',
        source,
        contract,
        contractSha256: sha256(JSON.stringify(contract)),
      });
    }
    const { checkpoint, candidate } = validateCheckpoint(checkpointPath, cwd, inspect);
    result.source = checkpoint.source;
    result.checkpoint = reference(checkpointPath);
    const contract = checkpoint.contract;
    assert.ok(contract.producer);
    result.producer = { path: contract.producer.checksResultPath, sha256: contract.producer.checksResultSha256 };
    result.artifact = { path: contract.producer.artifactReceiptPath, sha256: contract.producer.artifactReceiptSha256 };
    const artifact = /** @type {{pack:{command:import('./checks.mjs').CommandRecord}}} */ (
      JSON.parse(bytes(result.artifact.path).toString('utf8'))
    );
    result.pack = artifact.pack.command;
    persist();
    if (producerOnly) {
      result.status = 'incomplete';
      result.omitted = [
        'release tests and their owned cleanup',
        'current-consumer production install, resolution, CLI, exports, MCP, Node26 and owned cleanup',
      ];
    } else {
      if (signal?.aborted) throw new Error('Cancelled at release checkpoint.');
      const context = releaseContext(checkpoint, result.checkpoint);
      assert.deepEqual(
        JSON.parse(bytes(context.contractPath).toString('utf8')),
        contract,
        'Original release contract changed.',
      );
      const contractDigest = reference(context.contractPath).sha256;
      const releaseAttemptPath = join(dirname(checkpointPath), 'release-tests-attempt.json');
      const retained = existsSync(releaseAttemptPath)
        ? retainedRelease(checkpoint, result.checkpoint, contractDigest, releaseAttemptPath)
        : undefined;
      if (retained?.reusable) result.releaseTests = retained.attempt.receipt;
      else {
        const releaseDirectory = join(dirname(checkpointPath), `release-tests-${randomUUID()}`);
        /** @type {ReleaseAttempt} */
        const releaseAttempt = {
          stage: 'release-tests',
          runId: result.runId,
          checkpointSha256: result.checkpoint.sha256,
          contractSha256: checkpoint.contractSha256,
          status: 'starting',
          directory: releaseDirectory,
          resultPath: join(releaseDirectory, 'result.json'),
        };
        if (retained) save(releaseAttemptPath, releaseAttempt);
        else
          writeFileSync(releaseAttemptPath, JSON.stringify(releaseAttempt, null, 2) + '\n', {
            flag: 'wx',
            mode: 0o600,
          });
        releaseAttempt.status = 'running';
        save(releaseAttemptPath, releaseAttempt);
        const releaseReport = await checks({
          cwd,
          resultsDir: releaseDirectory,
          release: context,
          signal,
          timeoutMs,
          execute: async (command, options) =>
            execute(command, {
              ...options,
              progress: (partial) => {
                options.progress?.(partial);
                releaseAttempt.command = { stage: 'tests', directory: options.directory, ...partial };
                save(releaseAttemptPath, releaseAttempt);
              },
            }),
        });
        releaseAttempt.command = releaseReport.commands[0];
        releaseAttempt.receipt = reference(releaseAttempt.resultPath);
        releaseAttempt.status = 'completed';
        save(releaseAttemptPath, releaseAttempt);
        result.releaseTests = releaseAttempt.receipt;
        persist();
        validateCheckpoint(checkpointPath, cwd, inspect);
        assert.equal(reference(context.contractPath).sha256, contractDigest, 'Contract changed during release tests.');
        validateReleaseTests(releaseReport, checkpoint, result.checkpoint, contractDigest);
      }
      persist();
      if (signal?.aborted) throw new Error('Cancelled at consumer checkpoint.');
      const attemptPath = join(dirname(checkpointPath), 'consumer-attempt.json');
      /** @type {ConsumerAttempt|undefined} */ let attempt;
      if (existsSync(attemptPath)) {
        attempt = retainedConsumer(attemptPath, checkpointPath, checkpoint, candidate, reconcileConsumer);
        result.consumerProcess = attempt.command;
        result.consumerAttempt = reference(attemptPath);
        persist();
      }
      if (!consumerResult && !attempt) {
        const attemptDirectory = join(dirname(checkpointPath), `consumer-${randomUUID()}`);
        attempt = {
          schemaVersion: 'ai-delivery.current-consumer-attempt@1',
          runId: result.runId,
          checkpointSha256: result.checkpoint.sha256,
          contractSha256: checkpoint.contractSha256,
          status: 'starting',
          startedAt: new Date().toISOString(),
          directory: attemptDirectory,
          tempRoot: join(attemptDirectory, 'temporary'),
          consumerPath: join(attemptDirectory, 'result.json'),
        };
        // Exclusive reservation is durable before any child, even if the next
        // mkdir/spawn fails or the controller disappears before its first sample.
        writeFileSync(attemptPath, JSON.stringify(attempt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        result.consumerAttempt = reference(attemptPath);
        persist();
        mkdirSync(attempt.tempRoot, { recursive: true, mode: 0o700 });
        const contractPath = join(attemptDirectory, 'contract.json');
        save(contractPath, contract);
        const env = safeEnvironment();
        env.TMPDIR = env.TEMP = env.TMP = attempt.tempRoot;
        const retained = attempt;
        const command = await execute(
          [
            contract.node24,
            join(cwd, 'scripts/current-consumer.mjs'),
            contractPath,
            attempt.consumerPath,
            '--authorize-install',
          ],
          {
            cwd,
            env,
            directory: join(attemptDirectory, 'command'),
            signal,
            timeoutMs,
            progress: (partial) => {
              retained.command = partial;
              retained.status = partial.completedAt ? 'completed' : 'running';
              save(attemptPath, retained);
              result.consumerProcess = partial;
              result.consumerAttempt = reference(attemptPath);
              persist();
            },
          },
        );
        attempt.command = command;
        attempt.status = 'completed';
        if (existsSync(attempt.consumerPath)) attempt.receipt = reference(attempt.consumerPath);
        save(attemptPath, attempt);
        result.consumerProcess = command;
        result.consumerAttempt = reference(attemptPath);
        persist();
        assert.equal(command.cleanupConfirmed, true, 'Consumer supervisor quiescence is unconfirmed.');
      }
      const consumerPath = consumerResult ? resolve(consumerResult) : attempt?.consumerPath;
      assert.ok(consumerPath, 'Consumer result is missing.');
      result.consumer = reference(consumerPath);
      persist();
      const receipt = /** @type {import('./current-consumer.mjs').Receipt} */ (
        JSON.parse(bytes(consumerPath).toString('utf8'))
      );
      validateCheckpoint(checkpointPath, cwd, inspect);
      if (receipt.qualified !== true) {
        result.status =
          receipt.status === 'cancelled' ? 'cancelled' : receipt.status === 'failed' ? 'failed' : 'incomplete';
        result.omitted = ['successful current-consumer application and owned cleanup'];
      } else {
        if (!consumerResult && attempt?.status === 'completed') {
          assert.equal(attempt.command?.status, 'passed', 'Consumer supervisor did not pass.');
          assert.equal(attempt.command.exitCode, 0);
          assert.equal(attempt.command.signal, null);
        }
        validateConsumer(receipt, contract, candidate);
        if (attempt) {
          // The helper removes its own workspace. Remove only our empty launch
          // root; leftovers or a replaced link remain an explicit blocker.
          if (existsSync(attempt.tempRoot)) {
            assert.ok(
              lstatSync(attempt.tempRoot).isDirectory() && !lstatSync(attempt.tempRoot).isSymbolicLink(),
              'Consumer temporary root changed.',
            );
            rmdirSync(attempt.tempRoot);
          }
          attempt.temporaryRemoved = true;
          save(attemptPath, attempt);
          result.consumerAttempt = reference(attemptPath);
        }
        result.status = 'passed';
        result.qualified = true;
      }
    }
  } catch (error) {
    result.status = signal?.aborted ? 'cancelled' : 'failed';
    result.error = errorMessage(error);
  }
  result.completedAt = new Date().toISOString();
  result.exitCode = result.qualified ? 0 : result.status === 'cancelled' ? 130 : result.status === 'incomplete' ? 2 : 1;
  persist();
  writeFileSync(
    join(directory, 'result.txt'),
    `${result.status.toUpperCase()}; qualified=${result.qualified}; omitted=${result.omitted.join('; ') || 'none'}; evidence=${directory}\n${result.error ?? ''}\n`,
  );
  process.stdout.write(readFileSync(join(directory, 'result.txt'), 'utf8'));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @type {Options} */ const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--producer-only') options.producerOnly = true;
    else if (args[i] === '--results-dir') options.resultsDir = args[++i];
    else if (args[i] === '--resume') options.resume = args[++i];
    else if (args[i] === '--consumer-result') options.consumerResult = args[++i];
    else if (args[i] === '--reconcile-consumer') options.reconcileConsumer = true;
    else if (args[i] === '--command-timeout-ms') options.timeoutMs = Number(args[++i]);
    else throw new Error(`Unknown qualification option: ${args[i]}`);
  }
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort(signal));
  // Complete module evaluation before an owned release stage imports these validators.
  // Pending/unsettled work stays fail-closed even if it leaves no active handles.
  process.exitCode = 1;
  void runQualification({ ...options, signal: controller.signal }).then(
    (result) => {
      process.exitCode = result.exitCode;
    },
    (error) => {
      process.stderr.write(errorMessage(error) + '\n');
      process.exitCode = 1;
    },
  );
}
