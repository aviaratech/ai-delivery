#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
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
} from './checks.mjs';
import { inspectCandidate, sha256, verifyProducerJoin } from './current-consumer.mjs';

/** @typedef {import('./current-consumer.mjs').Contract} Contract */
/** @typedef {{commit:string,tree:string,manifestSha256:string,lockSha256:string,fingerprint:ReturnType<typeof treeIdentity>}} Source */
/** @typedef {{schemaVersion:string,status:string,contract:Contract,contractSha256:string,source:Source}} Checkpoint */
/** @typedef {{schemaVersion:string,runId:string,startedAt:string,status:string,qualified:boolean,omitted:string[],resultsDir:string,source?:Source,producer?:{path:string,sha256:string},pack?:import('./checks.mjs').CommandRecord,artifact?:{path:string,sha256:string},checkpoint?:{path:string,sha256:string},consumer?:{path:string,sha256:string},consumerAttempt?:{path:string,sha256:string},consumerProcess?:import('./checks.mjs').CommandRecord,error?:string,completedAt?:string,exitCode?:number}} Qualification */
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
    'cli-json',
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

/** Exactly one immutable producer, one scripts-disabled pack, then the reviewed consumer.
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
    persist();
    if (producerOnly) {
      result.status = 'incomplete';
      result.omitted = ['current-consumer production install, resolution, CLI, exports, MCP, Node26 and owned cleanup'];
    } else {
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
  const result = await runQualification({ ...options, signal: controller.signal });
  process.exitCode = result.exitCode;
}
