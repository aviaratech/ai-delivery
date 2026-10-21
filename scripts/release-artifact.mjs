#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, sha256 } from './current-consumer.mjs';
import { FULL_GATES, SKIP_ALLOWLIST } from './checks.mjs';
import { sourceIdentity, validateCheckpoint, validateConsumer } from './current-qualification.mjs';

/** @typedef {{source:string,version:string}} SelectionInputs */
/** @typedef {SelectionInputs & {digest:string}} Inputs */
/** @typedef {{sha256:string,contents:string}} Retained */
/** @typedef {{overall:Retained,checkpoint:Retained,contract:Retained,producer:Retained,artifact:Retained,consumer:Retained,attempt:Retained}} Records */
/** @typedef {{schemaVersion:string,sourceCommit:string,sourceTree:string,packageVersion:string,archive:{filename:string,sha256:string,size:number},records:Records,limits:string}} Bundle */

/** @param {string} root @param {string} path */
function inside(root, path) {
  const name = relative(root, path);
  return name !== '' && name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name);
}

/** Reject linked evidence and path escapes before opening it.
 * @param {string} root @param {string} path @param {number} [limit] */
function bytes(root, path, limit = 32 * 1024 ** 2) {
  assert.ok(isAbsolute(path) && inside(root, path), 'Evidence path escapes the qualification directory.');
  assert.equal(realpathSync(path), path, 'Evidence path contains a symlink or alias.');
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'Evidence is not a bounded regular file.');
  return readFileSync(path);
}

/** @param {SelectionInputs} inputs */
function validSelection({ source, version }) {
  assert.match(source, /^[a-f0-9]{40}$/u, 'Reviewed source is missing.');
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 'Reviewed stable version is missing.');
}

/** @param {Inputs} inputs */
function validInputs(inputs) {
  validSelection(inputs);
  assert.match(inputs.digest, /^[a-f0-9]{64}$/u, 'Reviewed archive digest is missing.');
}

/** Bind an independently accepted artifact ID to its original successful qualification attempt.
 * Native metadata retrieval belongs to the workflow; this validator performs no requests.
 * @param {{artifact:unknown,attempt:unknown,workflow:unknown,jobs:unknown}} metadata
 * @param {{repository:string,repositoryId:number,source:string,artifactId:number}} inputs */
export function validateQualificationOrigin(metadata, { repository, repositoryId, source, artifactId }) {
  /** @param {unknown} value @returns {Record<string,unknown>} */
  const object = (value) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Native metadata is missing.');
    return /** @type {Record<string,unknown>} */ (value);
  };
  /** @param {unknown} value @returns {number} */
  const positive = (value) => {
    assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'Native ID is unsafe.');
    return value;
  };
  assert.equal(repository, 'aviaratech/ai-delivery', 'Qualification repository differs.');
  positive(repositoryId);
  positive(artifactId);
  assert.match(source, /^[a-f0-9]{40}$/u, 'Reviewed source is missing.');
  const artifact = object(metadata.artifact);
  const attempt = object(metadata.attempt);
  const workflow = object(metadata.workflow);
  const listing = object(metadata.jobs);
  assert.equal(artifact.id, artifactId, 'Native artifact ID differs.');
  assert.equal(artifact.expired, false, 'Qualification artifact expired.');
  assert.equal(typeof artifact.expires_at, 'string', 'Artifact expiry is missing.');
  assert.ok(Date.parse(/** @type {string} */ (artifact.expires_at)) > Date.now(), 'Artifact expiry is invalid.');
  assert.equal(typeof artifact.name, 'string', 'Artifact namespace is missing.');
  const artifactName = /** @type {string} */ (artifact.name);
  const name = /^npm-qualified-([1-9]\d*)$/u.exec(artifactName);
  assert.ok(name, 'Artifact is not original qualification evidence.');
  const runAttempt = positive(Number(name[1]));
  const run = object(artifact.workflow_run);
  const runId = positive(run.id);
  assert.equal(run.repository_id, repositoryId, 'Artifact repository differs.');
  assert.equal(run.head_repository_id, repositoryId, 'Fork qualification is forbidden.');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, source);
  assert.equal(attempt.id, runId);
  assert.equal(attempt.run_attempt, runAttempt, 'Original attempt differs; latest is not a substitute.');
  assert.equal(attempt.event, 'workflow_dispatch');
  assert.equal(attempt.head_branch, 'main');
  assert.equal(attempt.head_sha, source);
  assert.equal(attempt.status, 'completed');
  assert.equal(attempt.conclusion, 'success', 'Original qualification attempt did not succeed.');
  for (const field of ['repository', 'head_repository']) {
    const repo = object(attempt[field]);
    assert.equal(repo.id, repositoryId);
    assert.equal(repo.full_name, repository);
  }
  positive(workflow.id);
  assert.equal(attempt.workflow_id, workflow.id);
  assert.equal(workflow.path, '.github/workflows/release.yml');
  assert.equal(workflow.state, 'active');
  assert.ok(Array.isArray(listing.jobs), 'Original attempt jobs are missing.');
  const jobs = listing.jobs.map(object);
  assert.ok(jobs.length > 0 && jobs.length <= 100 && listing.total_count === jobs.length, 'Job listing is incomplete.');
  for (const job of jobs) {
    assert.equal(job.run_id, runId);
    assert.equal(job.run_attempt, runAttempt);
    assert.equal(job.head_sha, source);
  }
  const packages = jobs.filter((job) => job.name === 'package');
  assert.equal(packages.length, 1, 'Qualified package job is missing or ambiguous.');
  const job = packages[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  assert.ok(Array.isArray(job.steps), 'Qualification steps are missing.');
  const steps = job.steps.map(object);
  for (const name of ['Qualify and retain the exact archive', 'Scan source history', 'Upload qualified package']) {
    const matches = steps.filter((step) => step.name === name);
    assert.equal(matches.length, 1, `Original qualification step is missing or ambiguous: ${name}`);
    assert.equal(matches[0].status, 'completed');
    assert.equal(matches[0].conclusion, 'success');
  }
  for (const publish of jobs.filter((entry) => entry.name === 'publish'))
    assert.equal(publish.conclusion, 'skipped', 'Qualification unexpectedly entered publication.');
  return { artifactId, runId, runAttempt, artifactName };
}

/** Portable copies retain the original receipt bytes, including their digests.
 * Validation does not execute a producer, pack, consumer or process observer.
 * @param {Bundle} bundle @param {Inputs} inputs */
export function validateBundle(bundle, inputs) {
  validInputs(inputs);
  assert.equal(bundle.schemaVersion, 'ai-delivery.release-artifact@1');
  assert.equal(bundle.sourceCommit, inputs.source);
  assert.match(bundle.sourceTree, /^[a-f0-9]{40}$/u);
  assert.equal(bundle.packageVersion, inputs.version);
  assert.deepEqual(bundle.archive, {
    filename: `aviaratech-ai-delivery-${inputs.version}.tgz`,
    sha256: inputs.digest,
    size: bundle.archive.size,
  });
  assert.ok(
    Number.isSafeInteger(bundle.archive.size) && bundle.archive.size > 0 && bundle.archive.size <= 128 * 1024 ** 2,
  );
  /** @param {keyof Records} name */
  const parse = (name) => {
    const record = bundle.records[name];
    assert.match(record.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(sha256(record.contents), record.sha256, `Retained ${name} digest differs.`);
    return /** @type {unknown} */ (JSON.parse(record.contents));
  };
  const overall = /** @type {import('./current-qualification.mjs').Qualification} */ (parse('overall'));
  const checkpoint = /** @type {import('./current-qualification.mjs').Checkpoint} */ (parse('checkpoint'));
  const contract = /** @type {import('./current-consumer.mjs').Contract} */ (parse('contract'));
  const producer = /** @type {import('./checks.mjs').CheckReport} */ (parse('producer'));
  const artifact =
    /** @type {{schemaVersion:string,status:string,sourceCommit:string,sourceTree:string,sourceManifestSha256:string,sourceLockSha256:string,packageVersion:string,archiveSha256:string,checksResultSha256:string,pack:{command:unknown,sourceBefore:unknown,sourceAfter:unknown}}} */ (
      parse('artifact')
    );
  const consumer = /** @type {import('./current-consumer.mjs').Receipt} */ (parse('consumer'));
  const attempt = /** @type {import('./current-qualification.mjs').ConsumerAttempt} */ (parse('attempt'));
  assert.equal(overall.schemaVersion, 'ai-delivery.current-qualification@1');
  assert.equal(overall.status, 'passed');
  assert.equal(overall.qualified, true);
  assert.equal(overall.exitCode, 0);
  assert.deepEqual(overall.omitted, []);
  assert.equal(checkpoint.schemaVersion, 'ai-delivery.current-qualification-checkpoint@1');
  assert.equal(checkpoint.status, 'producer-passed-consumer-required');
  assert.deepEqual(checkpoint.contract, contract);
  assert.equal(checkpoint.contractSha256, sha256(JSON.stringify(contract)));
  assert.deepEqual(overall.source, checkpoint.source);
  assert.equal(checkpoint.source.commit, inputs.source);
  assert.equal(checkpoint.source.tree, bundle.sourceTree);
  for (const [field, expected] of /** @type {const} */ ([
    ['sourceCommit', inputs.source],
    ['sourceTree', bundle.sourceTree],
    ['sourceManifestSha256', checkpoint.source.manifestSha256],
    ['sourceLockSha256', checkpoint.source.lockSha256],
    ['packageVersion', inputs.version],
    ['archiveSha256', inputs.digest],
  ])) {
    assert.equal(contract[field], expected);
    assert.equal(artifact[field], expected);
    assert.equal(consumer[field], expected);
  }
  for (const name of /** @type {const} */ (['checkpoint', 'producer', 'artifact', 'consumer']))
    assert.equal(overall[name]?.sha256, bundle.records[name].sha256);
  assert.equal(overall.consumerAttempt?.sha256, bundle.records.attempt.sha256);
  assert.equal(contract.producer?.checksResultSha256, bundle.records.producer.sha256);
  assert.equal(contract.producer.artifactReceiptSha256, bundle.records.artifact.sha256);
  assert.equal(artifact.checksResultSha256, bundle.records.producer.sha256);
  assert.equal(producer.schemaVersion, 'contributor-checks@1');
  assert.equal(producer.status, 'passed');
  assert.equal(producer.fullSuccess, true);
  assert.equal(producer.exitCode, 0);
  assert.deepEqual(producer.omitted, []);
  assert.equal(producer.scope, 'full');
  assert.deepEqual(producer.tree, checkpoint.source.fingerprint);
  assert.deepEqual(producer.gates, FULL_GATES);
  assert.deepEqual(
    producer.commands.map((command) => command.stage),
    FULL_GATES,
  );
  for (const command of producer.commands) {
    assert.equal(command.status, 'passed');
    assert.equal(command.exitCode, 0);
    assert.equal(command.signal, null);
    assert.equal(command.cleanupConfirmed, true);
  }
  assert.ok(producer.tests && producer.selectedTestFiles && producer.inventory);
  assert.ok(producer.tests.passed > 0 && producer.tests.files > 0);
  assert.equal(producer.tests.files, producer.selectedTestFiles.length);
  assert.equal(producer.tests.total, producer.tests.passed + producer.tests.skips.length);
  assert.equal(new Set(producer.selectedTestFiles).size, producer.tests.files);
  for (const skip of producer.tests.skips)
    assert.ok(
      SKIP_ALLOWLIST.some(
        (allowed) => allowed.file === skip.file && allowed.title === skip.title && allowed.kind === skip.kind,
      ),
    );
  assert.equal(artifact.schemaVersion, 'ai-delivery.current-artifact-producer@1');
  assert.equal(artifact.status, 'passed');
  assert.deepEqual(artifact.pack.sourceBefore, checkpoint.source);
  assert.deepEqual(artifact.pack.sourceAfter, checkpoint.source);
  assert.deepEqual(artifact.pack.command, overall.pack);
  assert.equal(overall.pack?.status, 'passed');
  assert.equal(overall.pack.exitCode, 0);
  assert.equal(overall.pack.signal, null);
  assert.equal(overall.pack.cleanupConfirmed, true);
  assert.deepEqual(overall.pack.command, [
    contract.node24,
    contract.npmCli,
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    dirname(contract.archivePath),
  ]);
  assert.equal(consumer.schemaVersion, 'ai-delivery.current-consumer@1');
  assert.equal(consumer.status, 'passed');
  assert.equal(consumer.qualified, true);
  assert.equal(consumer.sourceIdentityVerified, true);
  assert.equal(consumer.scriptsDisabled, true);
  assert.equal(consumer.archiveManifestSha256, contract.sourceManifestSha256);
  assert.equal(consumer.producerJoin?.checksResultSha256, bundle.records.producer.sha256);
  assert.equal(consumer.producerJoin.artifactReceiptSha256, bundle.records.artifact.sha256);
  assert.deepEqual(
    consumer.phases.map((phase) => phase.phase),
    [
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
    ],
  );
  for (const phase of consumer.phases) {
    assert.equal(phase.code, 0);
    assert.equal(phase.signal, null);
    assert.equal(phase.quiescent, true);
  }
  assert.equal(consumer.cleanup?.removed, true);
  assert.equal(consumer.cleanup.quiescent, true);
  assert.equal(attempt.schemaVersion, 'ai-delivery.current-consumer-attempt@1');
  assert.equal(attempt.status, 'completed');
  assert.equal(attempt.temporaryRemoved, true);
  assert.equal(attempt.checkpointSha256, bundle.records.checkpoint.sha256);
  assert.equal(attempt.contractSha256, checkpoint.contractSha256);
  assert.equal(attempt.receipt?.sha256, bundle.records.consumer.sha256);
  assert.deepEqual(attempt.command, overall.consumerProcess);
  assert.equal(attempt.command?.status, 'passed');
  assert.equal(attempt.command.exitCode, 0);
  assert.equal(attempt.command.signal, null);
  assert.equal(attempt.command.cleanupConfirmed, true);
  return { overall, checkpoint, contract, producer, artifact, consumer, attempt };
}

/** Select the original archive from a complete fresh or compatibly resumed result.
 * Selection observes a digest; only publication verification receives an accepted digest.
 * @param {string} qualification @param {string} destination @param {SelectionInputs} inputs @param {string} [cwd] */
export function selectReleaseArtifact(qualification, destination, inputs, cwd = process.cwd()) {
  validSelection(inputs);
  const outer = realpathSync(qualification);
  assert.equal(resolve(qualification), outer, 'Qualification directory is aliased.');
  const source = realpathSync(cwd);
  const output = resolve(destination);
  assert.ok(!inside(source, output) && output !== source, 'Release evidence must be outside source.');
  assert.ok(!inside(outer, output) && output !== outer, 'Release output must preserve overall evidence.');
  assert.equal(realpathSync(dirname(output)), dirname(output), 'Release destination parent is aliased.');
  const overallBytes = bytes(outer, join(outer, 'result.json'));
  const overall = /** @type {import('./current-qualification.mjs').Qualification} */ (
    JSON.parse(overallBytes.toString('utf8'))
  );
  assert.equal(overall.resultsDir, outer, 'Qualification directory differs.');
  assert.ok(overall.checkpoint && isAbsolute(overall.checkpoint.path), 'Original checkpoint is missing.');
  assert.equal(basename(overall.checkpoint.path), 'checkpoint.json');
  const root = dirname(overall.checkpoint.path);
  assert.equal(realpathSync(root), root, 'Original evidence directory is aliased.');
  assert.ok(!inside(source, root) && root !== source, 'Original evidence must be outside source.');
  assert.ok(!inside(root, output) && output !== root, 'Release output must preserve original evidence.');
  /** @param {{path:string,sha256:string}|undefined} ref */
  const retain = (ref) => {
    assert.ok(ref, 'Qualification reference is missing.');
    const data = bytes(root, ref.path);
    assert.equal(sha256(data), ref.sha256, 'Qualification reference digest differs.');
    return { sha256: ref.sha256, contents: data.toString('utf8') };
  };
  const checkpointRecord = retain(overall.checkpoint);
  const checkpoint = /** @type {import('./current-qualification.mjs').Checkpoint} */ (
    JSON.parse(checkpointRecord.contents)
  );
  const contract = checkpoint.contract;
  assert.equal(contract.sourceRoot, source);
  assert.equal(
    contract.archivePath,
    join(root, 'pack', `aviaratech-ai-delivery-${inputs.version}.tgz`),
    'Archive path is not the qualified pack.',
  );
  assert.deepEqual(overall.producer, {
    path: contract.producer?.checksResultPath,
    sha256: contract.producer?.checksResultSha256,
  });
  assert.deepEqual(overall.artifact, {
    path: contract.producer?.artifactReceiptPath,
    sha256: contract.producer?.artifactReceiptSha256,
  });
  const archive = bytes(root, contract.archivePath, 128 * 1024 ** 2);
  const digest = sha256(archive);
  assert.equal(digest, contract.archiveSha256, 'Archive bytes differ from the qualified contract.');
  const contractBytes = bytes(root, join(root, 'contract.json'));
  /** @type {Bundle} */
  const bundle = {
    schemaVersion: 'ai-delivery.release-artifact@1',
    sourceCommit: inputs.source,
    sourceTree: checkpoint.source.tree,
    packageVersion: inputs.version,
    archive: { filename: basename(contract.archivePath), sha256: digest, size: archive.length },
    records: {
      overall: { sha256: sha256(overallBytes), contents: overallBytes.toString('utf8') },
      checkpoint: checkpointRecord,
      contract: { sha256: sha256(contractBytes), contents: contractBytes.toString('utf8') },
      producer: retain(overall.producer),
      artifact: retain(overall.artifact),
      consumer: retain(overall.consumer),
      attempt: retain(overall.consumerAttempt),
    },
    limits:
      'Retained source-bound execution receipts from the reviewed workflow; hashes alone are not execution or cryptographic provenance proof. Confidentiality scan and registry provenance readback remain separate.',
  };
  const proof = validateBundle(bundle, { ...inputs, digest });
  assert.ok(overall.checkpoint && overall.consumer);
  assert.deepEqual(sourceIdentity(source), checkpoint.source);
  const validated = validateCheckpoint(overall.checkpoint.path, source);
  validateConsumer(proof.consumer, contract, validated.candidate);
  assert.equal(proof.attempt.directory, dirname(overall.consumer.path));
  assert.equal(proof.attempt.consumerPath, overall.consumer.path);
  assert.match(basename(proof.attempt.directory), /^consumer-[a-f0-9-]{36}$/u);
  assert.equal(proof.attempt.tempRoot, join(proof.attempt.directory, 'temporary'));
  assert.equal(
    lstatSync(proof.attempt.tempRoot, { throwIfNoEntry: false }),
    undefined,
    'Consumer temporary root remains.',
  );
  assert.deepEqual(proof.attempt.receipt, overall.consumer);
  assert.deepEqual(sourceIdentity(source), checkpoint.source);
  mkdirSync(output, { mode: 0o700 }); // Exclusive fresh destination, after validation.
  const archivePath = join(output, bundle.archive.filename);
  copyFileSync(contract.archivePath, archivePath);
  assert.equal(sha256(readFileSync(archivePath)), digest, 'Archive changed during copy.');
  writeFileSync(join(output, 'qualification.json'), JSON.stringify(bundle, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return bundle;
}

/** Verify the downloaded retained bytes without executing checks or a consumer.
 * @param {string} directory @param {Inputs} inputs */
export function verifyReleaseArtifact(directory, inputs) {
  const root = realpathSync(directory);
  const bundle = /** @type {Bundle} */ (JSON.parse(bytes(root, join(root, 'qualification.json')).toString('utf8')));
  const proof = validateBundle(bundle, inputs);
  const archive = bytes(root, join(root, bundle.archive.filename), 128 * 1024 ** 2);
  assert.equal(archive.length, bundle.archive.size);
  assert.equal(sha256(archive), inputs.digest, 'Downloaded archive differs.');
  const inventory = readArchive(archive, inputs.digest).map(({ bytes: _bytes, ...entry }) => entry);
  assert.deepEqual(
    inventory,
    proof.producer.inventory?.files.slice().sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.deepEqual(inventory, proof.consumer.inventory);
  assert.equal(sha256(JSON.stringify(inventory)), proof.consumer.inventorySha256);
  return join(root, bundle.archive.filename);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output] = process.argv.slice(2);
  const inputs = {
    source: process.env.REVIEWED_SOURCE_SHA ?? '',
    version: process.env.RELEASE_VERSION ?? '',
    digest: process.env.REVIEWED_ARCHIVE_SHA256 ?? '',
  };
  if (mode === 'select' && input && output && process.argv.length === 5) selectReleaseArtifact(input, output, inputs);
  else if (mode === 'verify' && input && !output && process.argv.length === 4)
    process.stdout.write(verifyReleaseArtifact(input, inputs) + '\n');
  else
    throw new Error(
      'Use release-artifact.mjs select <qualification-directory> <new-artifact-directory> or verify <artifact-directory>.',
    );
}
