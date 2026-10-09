/// <reference types="node" />
// @ts-check
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
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
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
// Consume the reviewed runner's public evidence ABI without changing its
// independent JavaScript type-check policy in this focused helper check.
const { FULL_GATES, SKIP_ALLOWLIST, treeIdentity } =
  /** @type {{FULL_GATES:string[],SKIP_ALLOWLIST:{file:string,title:string,kind:string}[],treeIdentity:(cwd:string)=>{kind:string,sha256:string,fileCount:number}}} */ (
    await import(new URL('./checks.mjs', import.meta.url).href)
  );

/** @typedef {{path:string, mode:number, size:number}} DryMember */
/** @typedef {DryMember & {sha256:string}} InventoryMember */
/** @typedef {InventoryMember & {bytes:Buffer}} ArchiveMember */
/** @typedef {{checksResultPath:string,checksResultSha256:string,artifactReceiptPath:string,artifactReceiptSha256:string}} Producer */
/** @typedef {{sourceRoot:string, archivePath:string, archiveSha256:string, packageVersion:string,
 * dryInventory:DryMember[], sourceManifestSha256:string, sourceLockSha256:string, sourceCommit?:string, sourceTree?:string, node24?:string, node26?:string, npmCli?:string,producer?:Producer}} Contract */
/** @typedef {{pid:number,birth:string,rssBytes:number}} ProcessIdentity */
/** @typedef {{cwd:string,env:Record<string,string>,signal?:AbortSignal,maxOutputBytes?:number,
 * onSpawn?:(pid:number)=>void,snapshot?:(group:number)=>ProcessIdentity[]|null}} ProcessOptions */
/** @typedef {{schemaVersion:string,boundary:string,status:string,qualified:boolean,sourceCommit?:string,
 * sourceTree?:string,archiveSha256:string,inventorySha256:string,inventory:InventoryMember[],packageVersion:string,
 * scriptsDisabled:boolean,sourceManifestSha256:string,sourceLockSha256:string,archiveManifestSha256:string,sourceIdentityVerified:boolean,networkBoundary:string,phases:Record<string,unknown>[],cleanup:Record<string,unknown>|null,
 * producerJoin?:Record<string,unknown>,productionClosure?:Record<string,unknown>,reason?:string,failure?:Record<string,unknown>,mcp?:Record<string,unknown>,skills?:unknown[],resolutions?:unknown[]}} Receipt */

/** @param {unknown} value @param {string} [code] @returns {Record<string,unknown>} */
function record(value, code = 'package-identity') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConsumerFailure(code, 'Expected an object');
  return /** @type {Record<string,unknown>} */ (value);
}
/** @param {unknown} value @param {string} [code] @returns {string} */
function string(value, code = 'package-identity') {
  if (typeof value !== 'string') throw new ConsumerFailure(code, 'Expected a string');
  return value;
}
/** @param {unknown} error */
function errorCode(error) {
  if (error instanceof ConsumerFailure) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'process';
}

// This helper does not build, pack, publish, or activate anything. The caller
// supplies one exact built archive, its complete npm dry inventory and source.
const NAME = '@aviaratech/ai-delivery';
const EXPORTS = ['.', './agent', './delivery', './mcp'];
const MAX_TAR_BYTES = 128 * 1024 ** 2;
/** @param {Buffer|string} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {string} root @param {string} path */
const inside = (root, path) => path === root || path.startsWith(root + sep);

export class ConsumerFailure extends Error {
  /** @param {string} code @param {string} message @param {Record<string,unknown>} [evidence] */
  constructor(code, message, evidence = {}) {
    super(message);
    this.name = 'ConsumerFailure';
    this.code = code;
    this.evidence = evidence;
  }
}
/** @param {unknown} condition @param {string} code @param {string} message */
const requireProof = (condition, code, message) => {
  if (!condition) throw new ConsumerFailure(code, message);
};

/** @param {string} name */
function safeMember(name) {
  requireProof(
    name.startsWith('package/') &&
      !name.includes('\\') &&
      !name.includes('\0') &&
      name
        .split('/')
        .every((part, index, parts) => part !== '.' && part !== '..' && (part !== '' || index === parts.length - 1)) &&
      !/(?:^|\/)\.(?:env|npmrc|git|aws|codex|agents)(?:$|[/.])/u.test(name),
    'unsafe-inventory',
    'Archive member is not a safe package path',
  );
  return name.slice(8);
}
/** @param {Buffer} bytes */
const octal = (bytes) => {
  const value = bytes.toString('ascii').replaceAll('\0', '').trim();
  requireProof(/^[0-7]+$/u.test(value), 'unsafe-inventory', 'Unsupported tar numeric field');
  return parseInt(value, 8);
};

/** Inert tar inspection; no external extractor gets unvalidated members.
 * @param {Buffer} bytes @param {string} expectedSha256 */
export function readArchive(bytes, expectedSha256) {
  requireProof(
    /^[a-f0-9]{64}$/u.test(expectedSha256) && sha256(bytes) === expectedSha256,
    'archive-digest',
    'Archive digest differs from the accepted bytes',
  );
  requireProof(bytes.length <= MAX_TAR_BYTES, 'unsafe-inventory', 'Archive exceeds inspection bound');
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    throw new ConsumerFailure('unsafe-inventory', 'Archive gzip is corrupt or exceeds inspection bound');
  }
  /** @type {ArchiveMember[]} */
  const members = [];
  const names = new Set();
  /** @type {Record<string,string>} */
  let pax = {};
  let ended = false;
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    requireProof(header.length === 512, 'unsafe-inventory', 'Truncated tar header');
    if (header.every((byte) => byte === 0)) {
      requireProof(
        tar.length - offset >= 1024 && tar.subarray(offset).every((byte) => byte === 0),
        'unsafe-inventory',
        'Tar has missing terminator or trailing data',
      );
      ended = true;
      break;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    requireProof(checksum === octal(header.subarray(148, 156)), 'unsafe-inventory', 'Tar checksum mismatch');
    /** @param {number} start @param {number} end */
    const field = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];
    const prefix = field(345, 500);
    const headerName = (prefix ? prefix + '/' : '') + field(0, 100);
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    const type = field(156, 157) || '0';
    const data = tar.subarray(offset + 512, offset + 512 + size);
    requireProof(data.length === size && Number.isSafeInteger(size), 'unsafe-inventory', 'Truncated tar data');
    offset += 512 + Math.ceil(size / 512) * 512;
    requireProof(offset <= tar.length && members.length < 10000, 'unsafe-inventory', 'Invalid tar extent');
    if (type === 'x') {
      requireProof(Object.keys(pax).length === 0, 'unsafe-inventory', 'Repeated extended tar header');
      let cursor = 0;
      while (cursor < data.length) {
        const space = data.indexOf(32, cursor);
        const count = Number(data.subarray(cursor, space).toString('ascii'));
        requireProof(
          space > cursor && Number.isSafeInteger(count) && count > space - cursor + 1 && cursor + count <= data.length,
          'unsafe-inventory',
          'Malformed extended tar record',
        );
        const record = data.subarray(space + 1, cursor + count).toString('utf8');
        requireProof(record.endsWith('\n') && record.includes('='), 'unsafe-inventory', 'Malformed extended tar value');
        const equal = record.indexOf('=');
        const key = record.slice(0, equal);
        requireProof(
          ['path', 'mtime', 'atime', 'ctime'].includes(key) && !(key in pax),
          'unsafe-inventory',
          'Unsupported extended tar attribute',
        );
        pax[key] = record.slice(equal + 1, -1);
        cursor += count;
      }
      continue;
    }
    const path = safeMember(pax.path ?? headerName);
    pax = {};
    requireProof(type === '0' || type === '5', 'unsafe-inventory', 'Links and special archive members are forbidden');
    requireProof(!names.has(path), 'unsafe-inventory', 'Duplicate archive member');
    names.add(path);
    if (type === '5') {
      requireProof(size === 0 && mode === 0o755, 'unsafe-inventory', 'Unexpected directory member');
      continue;
    }
    requireProof(
      path.length > 0 && !path.endsWith('/') && (mode === 0o644 || mode === 0o755),
      'unsafe-inventory',
      'Unexpected file path or mode',
    );
    requireProof(
      /^(?:package\.json|LICENSE|README\.md|CONTRIBUTING\.md|dist\/.+|plugins\/ai-delivery\/.+)$/u.test(path),
      'unsafe-inventory',
      'Unexpected packaged surface',
    );
    members.push({ path, mode, size, sha256: sha256(data), bytes: data });
  }
  requireProof(ended && Object.keys(pax).length === 0, 'unsafe-inventory', 'Incomplete tar terminator');
  return members.sort((a, b) => a.path.localeCompare(b.path));
}

/** @param {Contract} contract */
export function inspectCandidate(contract) {
  const archive = readFileSync(contract.archivePath);
  const members = readArchive(archive, contract.archiveSha256);
  const inventory = members.map(({ bytes: _bytes, ...entry }) => entry);
  const dry = contract.dryInventory
    .map(({ path, mode, size }) => ({ path, mode, size }))
    .sort((a, b) => a.path.localeCompare(b.path));
  requireProof(
    JSON.stringify(inventory.map(({ sha256: _digest, ...entry }) => entry)) === JSON.stringify(dry),
    'inventory-mismatch',
    'Actual archive and complete dry inventory disagree',
  );
  const byPath = new Map(members.map((entry) => [entry.path, entry]));
  /** @param {string} path */
  const json = (path) => {
    requireProof(byPath.has(path), 'missing-file', 'Required packaged file is absent');
    try {
      const member = byPath.get(path);
      if (!member) throw new ConsumerFailure('missing-file', 'Required metadata is absent');
      return record(parseJsonOutput(member.bytes.toString('utf8')));
    } catch {
      throw new ConsumerFailure('package-identity', 'Packaged metadata is invalid JSON');
    }
  };
  const manifest = json('package.json');
  const version = string(manifest.version);
  const engines = record(manifest.engines);
  const exports = record(manifest.exports);
  requireProof(
    manifest.name === NAME &&
      manifest.version === contract.packageVersion &&
      /^\d+\.\d+\.\d+$/u.test(version) &&
      manifest.type === 'module',
    'package-identity',
    'Package name, version or module boundary differs',
  );
  requireProof(
    engines.node === '>=24.21.0 <25 || 26.2.0' && engines.npm === '11.19.0',
    'runtime',
    'Declared package runtime differs',
  );
  requireProof(
    JSON.stringify(Object.keys(exports).sort()) === JSON.stringify(EXPORTS),
    'package-identity',
    'Public export set differs',
  );
  const required = [
    'LICENSE',
    'README.md',
    'CONTRIBUTING.md',
    'plugins/ai-delivery/dist/mcp-launcher.js',
    'plugins/ai-delivery/runtime/dist/cli.js',
    'plugins/ai-delivery/runtime/dist/THIRD-PARTY-NOTICES.md',
  ];
  for (const target of Object.values(exports)) {
    const value = record(target);
    for (const kind of ['default', 'types']) {
      requireProof(
        typeof value[kind] === 'string' && value[kind].startsWith('./dist/') && !value[kind].includes('..'),
        'package-identity',
        'Unsafe public export target',
      );
      required.push(string(value[kind]).slice(2));
    }
  }
  requireProof(
    record(manifest.bin)['ai-delivery'] === './dist/cli.js' && manifest.main === './dist/index.js',
    'package-identity',
    'Controller entry point differs',
  );
  required.push('dist/cli.js');
  for (const path of required) requireProof(byPath.has(path), 'missing-file', 'Required packaged entry is absent');
  for (const path of [
    'dist/cli.js',
    'plugins/ai-delivery/dist/mcp-launcher.js',
    'plugins/ai-delivery/runtime/dist/cli.js',
  ])
    requireProof(byPath.get(path)?.mode === 0o755, 'entry-mode', 'Controller or launcher is not executable');
  for (const path of ['plugins/ai-delivery/plugin.json', 'plugins/ai-delivery/.claude-plugin/plugin.json']) {
    const plugin = json(path);
    requireProof(
      plugin.name === 'ai-delivery' && plugin.version === manifest.version,
      'package-identity',
      'Plugin version differs from the current archive',
    );
  }
  requireProof(
    json('plugins/ai-delivery/runtime/package.json').version === manifest.version,
    'package-identity',
    'Bundled runtime version differs',
  );
  const mcp = record(record(json('plugins/ai-delivery/mcp.json').mcpServers)['ai-delivery']);
  requireProof(
    mcp?.type === 'stdio' &&
      mcp.command === 'node' &&
      JSON.stringify(mcp.args) === JSON.stringify(['${PLUGIN_ROOT}/dist/mcp-launcher.js']),
    'package-identity',
    'Packaged MCP launch contract differs',
  );
  const skills = [];
  for (const skill of ['intake-create', 'worktree-lifecycle', 'pr-handoff']) {
    const path = `plugins/ai-delivery/skills/${skill}/SKILL.md`;
    requireProof(byPath.has(path), 'missing-file', 'Packaged skill is absent');
    const member = byPath.get(path);
    if (!member) throw new ConsumerFailure('missing-file', 'Packaged skill is absent');
    const text = member.bytes.toString('utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(text)?.[1];
    requireProof(
      frontmatter !== undefined &&
        new RegExp(`^name: ["']?ai-delivery:${skill}["']?$`, 'mu').test(frontmatter) &&
        /^description: \S.+$/mu.test(frontmatter),
      'schema',
      'Packaged skill frontmatter differs',
    );
    skills.push({ path, sha256: member.sha256 });
  }
  const source = realpathSync(contract.sourceRoot);
  for (const [name, digest] of [
    ['package.json', contract.sourceManifestSha256],
    ['package-lock.json', contract.sourceLockSha256],
  ]) {
    const path = join(source, name);
    requireProof(
      /^[a-f0-9]{64}$/u.test(digest) &&
        existsSync(path) &&
        lstatSync(path).isFile() &&
        !lstatSync(path).isSymbolicLink() &&
        inside(source, realpathSync(path)) &&
        sha256(readFileSync(path)) === digest,
      'source-identity',
      'Integrated manifest or lock binding differs',
    );
  }
  requireProof(
    byPath.get('package.json')?.sha256 === contract.sourceManifestSha256,
    'source-identity',
    'Archive manifest differs from integrated manifest',
  );
  for (const member of members) {
    const path = join(source, member.path);
    requireProof(
      existsSync(path) &&
        lstatSync(path).isFile() &&
        !lstatSync(path).isSymbolicLink() &&
        inside(source, realpathSync(path)),
      'built-bytes',
      'Packaged member is absent or aliased in the built source',
    );
    requireProof(
      sha256(readFileSync(path)) === member.sha256 && (lstatSync(path).mode & 0o777) === member.mode,
      'built-bytes',
      'Actual archive differs from the built source bytes or mode',
    );
  }
  return {
    archiveSha256: sha256(archive),
    sourceManifestSha256: contract.sourceManifestSha256,
    sourceLockSha256: contract.sourceLockSha256,
    archiveManifestSha256: contract.sourceManifestSha256,
    packageVersion: version,
    manifest,
    inventory,
    inventorySha256: sha256(JSON.stringify(inventory)),
    skills,
  };
}

/** Bind the reviewed canonical six-gate result to this exact rebuilt artifact.
 * This verifies retained evidence, never launches a producer or installs.
 * @param {Contract} contract @param {ReturnType<typeof inspectCandidate>} candidate */
export function verifyProducerJoin(contract, candidate) {
  const producer = contract.producer;
  if (!producer) throw new ConsumerFailure('producer', 'Fresh canonical producer evidence is required');
  /** @param {string} path @param {string} digest */
  const proof = (path, digest) => {
    const stat = lstatSync(path);
    requireProof(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024,
      'producer',
      'Producer receipt must be a bounded regular file',
    );
    const bytes = readFileSync(path);
    requireProof(/^[a-f0-9]{64}$/u.test(digest) && sha256(bytes) === digest, 'producer', 'Producer digest differs');
    return record(parseJsonOutput(bytes.toString('utf8')), 'producer');
  };
  const checks = proof(producer.checksResultPath, producer.checksResultSha256);
  const artifact = proof(producer.artifactReceiptPath, producer.artifactReceiptSha256);
  const fingerprint = treeIdentity(contract.sourceRoot);
  /** @param {unknown} value */
  const sameFingerprint = (value) => {
    const observed = record(value, 'producer');
    return (
      observed.kind === fingerprint.kind &&
      observed.sha256 === fingerprint.sha256 &&
      observed.fileCount === fingerprint.fileCount &&
      observed.stagedGitTree === undefined
    );
  };
  requireProof(
    checks.schemaVersion === 'contributor-checks@1' &&
      checks.scope === 'full' &&
      checks.status === 'passed' &&
      checks.fullSuccess === true &&
      checks.exitCode === 0 &&
      JSON.stringify(checks.gates) === JSON.stringify(FULL_GATES) &&
      JSON.stringify(checks.omitted) === '[]' &&
      sameFingerprint(checks.tree),
    'producer',
    'Canonical full checks are incomplete or stale',
  );
  if (!Array.isArray(checks.commands)) throw new ConsumerFailure('producer', 'Canonical command evidence is missing');
  const commands = checks.commands.map((value) => record(value, 'producer'));
  requireProof(
    JSON.stringify(commands.map((step) => step.stage)) === JSON.stringify(FULL_GATES) &&
      commands.every(
        (step) =>
          step.status === 'passed' && step.exitCode === 0 && step.signal === null && step.cleanupConfirmed === true,
      ),
    'producer',
    'Canonical gates or owned cleanup are incomplete',
  );
  const tests = record(checks.tests, 'producer');
  if (!Array.isArray(checks.selectedTestFiles) || !Array.isArray(tests.skips))
    throw new ConsumerFailure('producer', 'Canonical test selection or skip proof is missing');
  requireProof(
    Number.isSafeInteger(tests.files) &&
      Number(tests.files) > 0 &&
      tests.files === checks.selectedTestFiles.length &&
      Number.isSafeInteger(tests.passed) &&
      Number(tests.passed) > 0 &&
      tests.total === Number(tests.passed) + tests.skips.length &&
      new Set(checks.selectedTestFiles).size === checks.selectedTestFiles.length &&
      checks.selectedTestFiles.every((value) => typeof value === 'string' && /^dist\/.*\.test\.js$/u.test(value)) &&
      tests.skips.every((value) => {
        const skip = record(value, 'producer');
        return SKIP_ALLOWLIST.some(
          (allowed) => allowed.file === skip.file && allowed.title === skip.title && allowed.kind === skip.kind,
        );
      }),
    'producer',
    'Canonical tests are zero, incomplete, or contain unreviewed skips',
  );
  const toolchain = record(checks.toolchain, 'producer');
  for (const [name, version, executable] of [
    ['controller', 'v24.21.0', contract.node24],
    ['npm', '11.19.0', contract.npmCli],
    ['libraryConsumer', 'v26.2.0', contract.node26],
  ]) {
    const runtime = record(toolchain[string(name)], 'producer');
    requireProof(
      runtime.version === version && runtime.executable === string(executable, 'producer'),
      'producer',
      'Producer toolchain differs',
    );
  }
  const inventory = record(checks.inventory, 'producer');
  if (!Array.isArray(inventory.files)) throw new ConsumerFailure('producer', 'Canonical dry inventory is missing');
  const dry = inventory.files
    .map((value) => {
      const member = record(value, 'producer');
      return { path: string(member.path, 'producer'), mode: member.mode, size: member.size };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const expectedDry = contract.dryInventory
    .map(({ path, mode, size }) => ({ path, mode, size }))
    .sort((a, b) => a.path.localeCompare(b.path));
  requireProof(
    inventory.kind === 'dry-inventory-only' &&
      inventory.name === '@aviaratech/ai-delivery' &&
      inventory.version === candidate.packageVersion &&
      inventory.fileCount === dry.length &&
      JSON.stringify(dry) === JSON.stringify(expectedDry),
    'producer',
    'Producer dry inventory differs from the actual archive contract',
  );
  for (const key of /** @type {(keyof Contract)[]} */ ([
    'sourceCommit',
    'sourceTree',
    'sourceManifestSha256',
    'sourceLockSha256',
    'packageVersion',
    'archiveSha256',
  ]))
    requireProof(artifact[key] === contract[key], 'producer', 'Artifact producer source or archive binding differs');
  const pack = record(artifact.pack, 'producer');
  requireProof(
    artifact.schemaVersion === 'ai-delivery.current-artifact-producer@1' &&
      artifact.status === 'passed' &&
      artifact.checksResultSha256 === producer.checksResultSha256 &&
      artifact.inventorySha256 === candidate.inventorySha256 &&
      sameFingerprint(artifact.sourceFingerprint) &&
      pack.status === 'passed' &&
      pack.exitCode === 0 &&
      pack.quiescent === true &&
      pack.archiveSha256 === candidate.archiveSha256,
    'producer',
    'Actual pack producer or freshness join is incomplete',
  );
  return {
    checksResultSha256: producer.checksResultSha256,
    artifactReceiptSha256: producer.artifactReceiptSha256,
    sourceFingerprint: fingerprint,
    canonicalRunId: string(checks.runId, 'producer'),
    actualArchiveSha256: candidate.archiveSha256,
  };
}

/** Explicit allowlist; no ambient author/reviewer credentials, NODE_PATH or npm settings.
 * @param {string} directory @param {string} nodeExecutable */
export function consumerEnvironment(directory, nodeExecutable) {
  for (const name of ['home', 'tmp', 'cache']) mkdirSync(join(directory, name), { recursive: true });
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(directory, name), '');
  return {
    PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(directory, 'home'),
    TMPDIR: join(directory, 'tmp'),
    npm_config_cache: join(directory, 'cache'),
    npm_config_userconfig: join(directory, 'user.npmrc'),
    npm_config_globalconfig: join(directory, 'global.npmrc'),
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    NO_COLOR: '1',
  };
}

/** @param {number} group @returns {ProcessIdentity[]|null} */
function groupSnapshot(group) {
  const ps = spawnSync('/bin/ps', ['-axo', 'pid=,pgid=,rss=,lstart='], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  });
  if (ps.status !== 0) return null;
  return ps.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match && Number(match[2]) === group
      ? [{ pid: Number(match[1]), birth: match[4], rssBytes: Number(match[3]) * 1024 }]
      : [];
  });
}

/** Revalidate numeric process identities before any signal. Unknown/reused PIDs are refused.
 * @param {ProcessIdentity[]} observed @param {ProcessIdentity[]|null} current */
export function ownedSignalTargets(observed, current) {
  if (current === null) return { targets: [], unknown: true };
  const known = new Map(observed.map((item) => [item.pid, item.birth]));
  return {
    targets: current.filter((item) => known.get(item.pid) === item.birth),
    unknown: current.some((item) => known.get(item.pid) !== item.birth),
  };
}

/** @param {string} command @param {string[]} args @param {ProcessOptions} options */
export async function runOwnedProcess(
  command,
  args,
  { cwd, env, signal, maxOutputBytes = 1024 * 1024, onSpawn, snapshot = groupSnapshot },
) {
  requireProof(env && typeof env === 'object', 'environment', 'An explicit credential-free environment is required');
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'npm_config_cache',
    'npm_config_userconfig',
    'npm_config_globalconfig',
    'npm_config_audit',
    'npm_config_fund',
    'NO_COLOR',
    'NODE_OPTIONS',
  ];
  requireProof(
    Object.keys(env).every((key) => allowed.includes(key)),
    'environment',
    'Environment contains an unapproved ambient reference',
  );
  if (signal?.aborted) throw new ConsumerFailure('cancelled', 'Operation cancelled before spawn', { quiescent: true });
  // Node's coverage propagation can add a key to options.env during spawn.
  // Keep that internal mutation separate from the validated caller-owned input.
  const child = spawn(command, args, { cwd, env: { ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0);
  let outputBytes = 0;
  const stderrDigest = createHash('sha256');
  /** @type {string|undefined} */ let reason;
  /** @type {string|undefined} */ let birth;
  /** @type {Map<number,ProcessIdentity>} */ const observed = new Map();
  /** @type {{at:string,groupRssBytes:number,helperRssBytes:number}[]} */ const samples = [];
  const sample = () => {
    const group = child.pid === undefined ? null : snapshot(child.pid);
    if (group !== null) {
      birth ??= group.find((item) => item.pid === child.pid)?.birth;
      // Extend ownership only while a previously identified group member survives.
      const anchored = group.some(
        (item) => observed.get(item.pid)?.birth === item.birth || (item.pid === child.pid && item.birth === birth),
      );
      if (anchored) for (const item of group) if (!observed.has(item.pid)) observed.set(item.pid, item);
      samples.push({
        at: new Date().toISOString(),
        groupRssBytes: group.reduce((sum, item) => sum + item.rssBytes, 0),
        helperRssBytes: process.memoryUsage().rss,
      });
      if (samples.length > 128) samples.splice(1, 1);
    }
    return group;
  };
  /** @param {NodeJS.Signals} signalName */
  const terminate = (signalName) => {
    const selection = ownedSignalTargets([...observed.values()], sample());
    for (const item of selection.targets) {
      // Re-sample immediately before each signal; never signal a reused PID/group.
      const now = child.pid === undefined ? null : snapshot(child.pid);
      if (!now?.some((current) => current.pid === item.pid && current.birth === item.birth)) continue;
      try {
        process.kill(item.pid, signalName);
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') reason ??= 'cleanup';
      }
    }
  };
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let grace;
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let stop;
  /** @type {(value:{code:number|null,signal:NodeJS.Signals|null})=>void} */ let settle;
  let settled = false;
  /** @type {{code:number|null,signal:NodeJS.Signals|null}|undefined} */ let closeResult;
  /** @type {Promise<{code:number|null,signal:NodeJS.Signals|null}>} */
  const completion = new Promise((done) => {
    settle = done;
  });
  const beginCancellation = () => {
    if (stop) return;
    terminate('SIGTERM');
    grace = setTimeout(() => terminate('SIGKILL'), 250);
    // Cancellation-only grace: unknown ownership settles as cleanup failure and
    // retains the directory. It is not a deadline for healthy commands.
    stop = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle({ code: child.exitCode, signal: child.signalCode });
      }
    }, 2000);
  };
  const abort = () => {
    reason ??= 'cancelled';
    beginCancellation();
  };
  /** @type {ReturnType<typeof setInterval>|undefined} */ let interval;
  let stderrTail = '';
  /** @type {string|undefined} */ let failureKind;
  child.once('spawn', () => {
    sample();
    interval = setInterval(() => {
      const remaining = sample();
      if (closeResult && remaining !== null && remaining.length === 0 && !settled) {
        settled = true;
        settle(closeResult);
      }
    }, 50);
    if (child.pid !== undefined) onSpawn?.(child.pid);
  });
  child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= maxOutputBytes) stdout = Buffer.concat([stdout, chunk]);
    else {
      reason ??= 'output-bound';
      beginCancellation();
    }
  });
  child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
    outputBytes += chunk.length;
    stderrDigest.update(chunk);
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
    const probeFailure = /(?:^|\n)AI_DELIVERY_OWNED_PROBE_FAILURE:(schema|cleanup)(?:\n|$)/u.exec(stderrTail);
    if (probeFailure) {
      reason ??= probeFailure[1];
      beginCancellation();
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/u.test(stderrTail)) failureKind = 'network';
    else if (/EACCES|EPERM/u.test(stderrTail)) failureKind = 'permission';
    else if (/Resolution outside consumer closure/u.test(stderrTail)) failureKind = 'isolation';
    else if (/Undeclared dependency lookup|ERR_MODULE_NOT_FOUND/u.test(stderrTail)) failureKind = 'dependency';
    if (outputBytes > maxOutputBytes) {
      reason ??= 'output-bound';
      beginCancellation();
    }
  });
  child.once('error', (error) => {
    reason ??= ['EACCES', 'EPERM'].includes(errorCode(error)) ? 'permission' : 'spawn';
  });
  child.once('exit', () => {
    if (sample()?.length) {
      reason ??= 'cleanup';
      beginCancellation();
    }
  });
  child.once('close', (code, exitSignal) => {
    closeResult = { code, signal: exitSignal };
    const remaining = sample();
    if (remaining !== null && remaining.length === 0) {
      if (!settled) {
        settled = true;
        settle(closeResult);
      }
    } else {
      reason ??= 'cleanup';
      beginCancellation();
    }
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  /** @type {{code:number|null,signal:NodeJS.Signals|null}} */
  const result = await completion;
  clearInterval(interval);
  clearTimeout(grace);
  clearTimeout(stop);
  signal?.removeEventListener('abort', abort);
  const remaining = child.pid === undefined ? [] : snapshot(child.pid);
  const evidence = {
    pid: child.pid ?? null,
    birth: birth ?? null,
    ...result,
    samples,
    observed: [...observed.values()],
    outputBytes,
    stderrSha256: stderrDigest.digest('hex'),
    quiescent: remaining === null ? null : remaining.length === 0,
  };
  if (evidence.quiescent !== true)
    throw new ConsumerFailure('cleanup', 'Owned process group quiescence could not be proved', evidence);
  if (reason || result.code !== 0)
    throw new ConsumerFailure(
      reason ?? failureKind ?? 'process',
      'Owned command did not complete successfully',
      evidence,
    );
  return { stdout: stdout.toString('utf8'), evidence };
}

// This is a named, owned probe preload, never inherited ambient NODE_OPTIONS.
/** @param {string} consumer */
export function resolutionGuard(consumer) {
  return `import {registerHooks,isBuiltin} from 'node:module';
import {realpathSync,readFileSync,existsSync,appendFileSync} from 'node:fs';
import {join,sep} from 'node:path'; import {fileURLToPath} from 'node:url';
const root=${JSON.stringify(consumer)};
const inside=p=>p===root||p.startsWith(root+sep);
globalThis.fetch=async()=>{throw new Error('Owned offline probe forbids network');};
registerHooks({resolve(specifier,context,next){
 if(isBuiltin(specifier)) return next(specifier,context);
 const result=next(specifier,context);
 if(!result.url.startsWith('file:')||!inside(realpathSync(fileURLToPath(result.url))))throw new Error('Resolution outside consumer closure');
 if(!specifier.startsWith('.')&&!specifier.startsWith('/')&&!specifier.startsWith('file:')&&!specifier.startsWith('#')&&context.parentURL?.startsWith('file:')){
  const parent=realpathSync(fileURLToPath(context.parentURL));if(!inside(parent))throw new Error('Resolution outside consumer closure');
  const relative=parent.slice(root.length+1).split(sep);const index=relative.lastIndexOf('node_modules');
  let owner=root;let identity;
  if(index>=0){const scoped=relative[index+1]?.startsWith('@');const count=scoped?2:1;
   identity=relative.slice(index+1,index+1+count).join('/');owner=join(root,...relative.slice(0,index+1+count));}
  if(!inside(owner)||realpathSync(owner)!==owner||!existsSync(join(owner,'package.json')))throw new Error('No consumer package owner');
  const pkg=JSON.parse(readFileSync(join(owner,'package.json'),'utf8'));
  if(identity&&pkg.name!==identity)throw new Error('Consumer package owner identity differs');
  const name=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
  if(name!==pkg.name&&!Object.hasOwn({...pkg.dependencies,...pkg.optionalDependencies,...pkg.peerDependencies},name))throw new Error('Undeclared dependency lookup');
 }
 appendFileSync(join(root,'resolution.ndjson'),JSON.stringify({specifier,parent:context.parentURL??null,resolved:result.url})+'\\n');
 return result;
}});`;
}

const EXPORT_PROBE = `import assert from 'node:assert/strict';
const root=await import('@aviaratech/ai-delivery');const agent=await import('@aviaratech/ai-delivery/agent');
const delivery=await import('@aviaratech/ai-delivery/delivery');const mcp=await import('@aviaratech/ai-delivery/mcp');
assert.equal(typeof root.withVerificationFilesystemFixture,'function');
assert.equal(root.withVerificationFilesystemFixture,agent.withVerificationFilesystemFixture);
assert.equal(typeof agent.verifyIssue,'undefined');assert.equal(typeof delivery.loadValidRepositoryDeliveryEvidence,'undefined');
assert.equal(typeof mcp.createAiDeliveryMcpServer,'function');
console.log(JSON.stringify({runtime:process.version,exports:['.','./agent','./delivery','./mcp']}));`;

export const MCP_PROBE = `import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const mcp=await import('@aviaratech/ai-delivery/mcp');
const require=createRequire(import.meta.resolve('@aviaratech/ai-delivery/mcp'));
const z=require('zod');const expected=mcp.AI_DELIVERY_MCP_TOOLS.map(t=>({name:t.name,inputSchema:z.toJSONSchema(t.inputSchema,{target:'draft-7',io:'input'})}));
const child=spawn(process.execPath,[process.argv[2]],{env:process.env,stdio:['pipe','pipe','pipe']});
let bytes=0;let buffer='';let timer;let close;
const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
const result=new Promise((resolve,reject)=>{
 timer=setTimeout(()=>reject(new Error('MCP startup/schema response incomplete')),30000);
 child.once('error',reject);child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576)reject(new Error('MCP output bound'));});
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){reject(new Error('MCP output bound'));return;}buffer+=chunk;
  while(buffer.includes('\\n')){const end=buffer.indexOf('\\n');const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   try{const message=JSON.parse(line);if(message.error)throw new Error('MCP returned protocol error');
    if(message.id===1){assert.equal(message.result.serverInfo.version,process.argv[3]);
     child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
     child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\\n');}
    if(message.id===2){assert.equal(message.result.nextCursor,undefined);
     const normalize=o=>{if(Array.isArray(o))return o.map(normalize);if(o&&typeof o==='object')return Object.fromEntries(Object.entries(o).filter(([k])=>k!=='$schema').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)]));return o;};
     assert.deepEqual(normalize(message.result.tools.map(t=>({name:t.name,inputSchema:t.inputSchema})).sort((a,b)=>a.name.localeCompare(b.name))),normalize(expected.sort((a,b)=>a.name.localeCompare(b.name))));
     resolve({toolCount:expected.length,schemas:expected,protocol:'stdio initialize/tools/list',version:process.argv[3]});}
   }catch(error){reject(error);}
  }
 });child.once('close',()=>reject(new Error('MCP closed before complete schema response')));
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'owned-current-consumer',version:'1'}}})+'\\n');
});
try{const proof=await result;console.log(JSON.stringify(proof));}
catch(error){process.stderr.write('AI_DELIVERY_OWNED_PROBE_FAILURE:schema\\n');throw error;}
finally{clearTimeout(timer);child.kill('SIGTERM');
 const shutdown=setTimeout(()=>process.stderr.write('AI_DELIVERY_OWNED_PROBE_FAILURE:cleanup\\n'),500);
 try{close=await closed;}finally{clearTimeout(shutdown);}
}
assert.equal(close.code,0);`;

/** @param {string} stdout @returns {unknown} */
export function parseJsonOutput(stdout) {
  try {
    return /** @type {unknown} */ (JSON.parse(stdout));
  } catch {
    throw new ConsumerFailure('schema', 'Expected one JSON value on stdout');
  }
}

/** @param {string} packageRoot @param {InventoryMember[]} inventory */
export function verifyInstalledPackage(packageRoot, inventory) {
  const root = realpathSync(packageRoot);
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory @param {string} [prefix] */
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory)) {
      // Nested declared dependency installations are checked by npm ls and the
      // resolution guard, separately from this package's artifact members.
      if (!prefix && name === 'node_modules') continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      requireProof(
        !stat.isSymbolicLink() && inside(root, realpathSync(path)),
        'installed-bytes',
        'Installed artifact contains an alias',
      );
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (stat.isDirectory()) visit(path, relativePath);
      else {
        requireProof(stat.isFile(), 'installed-bytes', 'Installed artifact has a special file');
        files.push(relativePath);
      }
    }
  };
  visit(root);
  requireProof(
    JSON.stringify(files.sort()) === JSON.stringify(inventory.map((entry) => entry.path).sort()),
    'installed-bytes',
    'Installed artifact has missing or unexpected files',
  );
  for (const member of inventory) {
    safeMember('package/' + member.path);
    const path = join(root, member.path);
    requireProof(
      sha256(readFileSync(path)) === member.sha256 && (lstatSync(path).mode & 0o777) === member.mode,
      'installed-bytes',
      'Installed package does not match archive bytes or modes',
    );
  }
}

/** An omitted installation grant produces an explicit incomplete receipt.
 * @param {Contract} contract @param {{authorizeInstall?:boolean,signal?:AbortSignal}} [options] */
export async function runCurrentConsumer(contract, { authorizeInstall = false, signal } = {}) {
  const candidate = inspectCandidate(contract);
  /** @type {Receipt} */
  const receipt = {
    schemaVersion: 'ai-delivery.current-consumer@1',
    boundary: 'current-artifact',
    status: 'incomplete',
    qualified: false,
    sourceCommit: contract.sourceCommit,
    sourceTree: contract.sourceTree,
    archiveSha256: candidate.archiveSha256,
    sourceManifestSha256: candidate.sourceManifestSha256,
    sourceLockSha256: candidate.sourceLockSha256,
    archiveManifestSha256: candidate.archiveManifestSha256,
    sourceIdentityVerified: false,
    inventorySha256: candidate.inventorySha256,
    inventory: candidate.inventory,
    packageVersion: candidate.packageVersion,
    scriptsDisabled: true,
    networkBoundary: 'npm registry installation; named owned offline runtime probes',
    phases: [],
    cleanup: null,
  };
  if (contract.producer) receipt.producerJoin = verifyProducerJoin(contract, candidate);
  if (!authorizeInstall) {
    receipt.reason = 'Production closure installation has not been admitted';
    return receipt;
  }
  requireProof(process.version === 'v24.21.0', 'runtime', 'Controller must be actual Node 24.21.0');
  requireProof(
    /^[a-f0-9]{40}$/u.test(string(contract.sourceCommit, 'source-identity')) &&
      /^[a-f0-9]{40}$/u.test(string(contract.sourceTree, 'source-identity')),
    'source-identity',
    'Source commit/tree identity is incomplete',
  );
  const source = realpathSync(contract.sourceRoot);
  /** @param {string[]} arg */
  const sourceCheck = (arg) =>
    spawnSync('git', ['-C', source, ...arg], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  /** @type {[string[],string][]} */
  const sourceChecks = [
    [['rev-parse', 'HEAD'], string(contract.sourceCommit)],
    [['rev-parse', 'HEAD^{tree}'], string(contract.sourceTree)],
    [['status', '--porcelain=v1', '--untracked-files=all'], ''],
  ];
  for (const [args, expected] of sourceChecks) {
    const check = sourceCheck(args);
    requireProof(
      check.status === 0 && check.stdout.trim() === expected,
      'source-identity',
      'Source identity or clean-state drift',
    );
  }
  receipt.sourceIdentityVerified = true;
  receipt.producerJoin = verifyProducerJoin(contract, candidate);
  return withDisposableConsumer(
    source,
    string(string(contract.node24, 'runtime'), 'runtime'),
    candidate.archiveSha256,
    receipt,
    async ({ directory, consumer, env, setQuiescent }) => {
      /** @param {string} phase @param {string} command @param {string[]} args @param {Record<string,string>} [environment] */
      const run = async (phase, command, args, environment = env) => {
        try {
          const result = await runOwnedProcess(command, args, { cwd: consumer, env: environment, signal });
          receipt.phases.push({ phase, ...result.evidence, stdoutSha256: sha256(result.stdout) });
          return result.stdout;
        } catch (error) {
          const evidence = error instanceof ConsumerFailure ? error.evidence : {};
          setQuiescent(evidence.quiescent === true);
          receipt.phases.push({ phase, code: errorCode(error), ...evidence });
          throw error;
        }
      };
      try {
        requireProof(
          (await run('node24', string(contract.node24, 'runtime'), ['--version'])).trim() === 'v24.21.0',
          'runtime',
          'Node24 executable differs',
        );
        requireProof(
          (await run('node26', string(contract.node26, 'runtime'), ['--version'])).trim() === 'v26.2.0',
          'runtime',
          'Node26 library executable differs',
        );
        requireProof(
          (
            await run('npm', string(contract.node24, 'runtime'), [string(contract.npmCli, 'runtime'), '--version'])
          ).trim() === '11.19.0',
          'runtime',
          'npm version differs',
        );
        const snapshot = join(directory, 'candidate.tgz');
        writeFileSync(snapshot, readFileSync(contract.archivePath));
        requireProof(
          sha256(readFileSync(snapshot)) === candidate.archiveSha256,
          'archive-digest',
          'Archive changed before installation',
        );
        writeFileSync(
          join(consumer, 'package.json'),
          JSON.stringify({
            name: 'fictional-current-consumer',
            private: true,
            type: 'module',
            dependencies: { [NAME]: `file:${snapshot}` },
          }),
        );
        await run('production-install', string(contract.node24, 'runtime'), [
          string(contract.npmCli, 'runtime'),
          'install',
          '--omit=dev',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--fetch-retries=0',
          '--fetch-timeout=30000',
        ]);
        const installed = join(consumer, 'node_modules', '@aviaratech', 'ai-delivery');
        requireProof(
          !lstatSync(installed).isSymbolicLink() && inside(consumer, realpathSync(installed)),
          'isolation',
          'Installed package is borrowed or aliased',
        );
        verifyInstalledPackage(installed, candidate.inventory);
        const listing = record(
          parseJsonOutput(
            await run('production-closure', string(contract.node24, 'runtime'), [
              string(contract.npmCli, 'runtime'),
              'ls',
              '--omit=dev',
              '--all',
              '--json',
            ]),
          ),
        );
        requireProof(
          !Array.isArray(listing.problems) || listing.problems.length === 0,
          'dependency',
          'Production closure contains missing, invalid or extraneous packages',
        );
        receipt.productionClosure = listing;
        const guard = join(consumer, 'owned-offline-resolution.mjs');
        writeFileSync(guard, resolutionGuard(consumer));
        const probeEnv = { ...env, NODE_OPTIONS: `--import=${JSON.stringify(guard)}` };
        const cli = join(installed, 'dist', 'cli.js');
        requireProof(
          (await run('cli-version', string(contract.node24, 'runtime'), [cli, '--version'], probeEnv)).trim() ===
            candidate.packageVersion,
          'package-identity',
          'Installed CLI reports the wrong version',
        );
        writeFileSync(join(consumer, 'fictional-issues.json'), JSON.stringify({ issues: [] }));
        const cliJson = record(
          parseJsonOutput(
            await run(
              'cli-json',
              string(contract.node24, 'runtime'),
              [cli, 'migrate:legacy-issues', '--input-file', join(consumer, 'fictional-issues.json')],
              probeEnv,
            ),
          ),
        );
        requireProof(
          cliJson.schemaVersion === 'ai-delivery.legacy-issue-migration@1' &&
            cliJson.mode === 'dry-run' &&
            cliJson.validated === 0,
          'schema',
          'CLI JSON/stdout contract differs',
        );
        const exportsPath = join(consumer, 'owned-exports.mjs');
        writeFileSync(exportsPath, EXPORT_PROBE);
        /** @type {[string,string,string][]} */
        const exportChecks = [
          ['exports-node24', string(contract.node24, 'runtime'), 'v24.21.0'],
          ['library-node26', string(contract.node26, 'runtime'), 'v26.2.0'],
        ];
        for (const [phase, executable, version] of exportChecks) {
          const proof = record(parseJsonOutput(await run(phase, executable, [exportsPath], probeEnv)));
          requireProof(
            proof.runtime === version && JSON.stringify(proof.exports) === JSON.stringify(EXPORTS),
            'schema',
            'Public export proof differs',
          );
        }
        const mcpPath = join(consumer, 'owned-mcp.mjs');
        writeFileSync(mcpPath, MCP_PROBE);
        const mcpProof = record(
          parseJsonOutput(
            await run(
              'packaged-mcp',
              string(contract.node24, 'runtime'),
              [mcpPath, join(installed, 'plugins/ai-delivery/dist/mcp-launcher.js'), candidate.packageVersion],
              probeEnv,
            ),
          ),
        );
        receipt.mcp = { ...mcpProof, schemasSha256: sha256(JSON.stringify(mcpProof.schemas)) };
        receipt.skills = candidate.skills;
        const resolutions = readFileSync(join(consumer, 'resolution.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => parseJsonOutput(line));
        requireProof(resolutions.length > 0, 'isolation', 'No actual resolution evidence');
        receipt.resolutions = resolutions;
        requireProof(
          sha256(readFileSync(contract.archivePath)) === candidate.archiveSha256,
          'archive-digest',
          'Original archive drifted during smoke',
        );
        for (const [args, expected] of sourceChecks) {
          const check = sourceCheck(args);
          requireProof(
            check.status === 0 && check.stdout.trim() === expected,
            'source-identity',
            'Source drifted during smoke',
          );
        }
        verifyProducerJoin(contract, inspectCandidate(contract));
        receipt.status = 'passed';
        receipt.qualified = true;
      } catch (error) {
        receipt.status = signal?.aborted
          ? 'cancelled'
          : ['network', 'permission', 'spawn', 'EACCES', 'EPERM'].includes(errorCode(error))
            ? 'incomplete'
            : 'failed';
        receipt.failure = {
          code: errorCode(error),
          message: 'Current consumer phase failed; inspect bounded evidence',
        };
      }
      return receipt;
    },
  );
}

/** Receipt-aware disposable boundary. Faults are explicit fictional test injections.
 * @param {string} source @param {string} node24 @param {string} archiveSha256 @param {Receipt} receipt
 * @param {(context:{directory:string,consumer:string,env:Record<string,string>,setQuiescent:(value:boolean)=>void})=>Promise<Receipt>} action
 * @param {{fault?:(phase:string,directory:string)=>void}} [options] */
export async function withDisposableConsumer(source, node24, archiveSha256, receipt, action, { fault } = {}) {
  /** @type {string|undefined} */ let directory;
  let quiescent = true;
  let markerWritten = false;
  try {
    directory = mkdtempSync(join(tmpdir(), 'ai-delivery-current-consumer-'));
    directory = realpathSync(directory);
    requireProof(
      !inside(source, directory) && !inside(directory, source),
      'isolation',
      'Consumer must be unrelated to source',
    );
    fault?.('created', directory);
    const consumer = join(directory, 'consumer');
    mkdirSync(consumer);
    const env = consumerEnvironment(directory, node24);
    writeFileSync(join(directory, 'owned.json'), JSON.stringify({ pid: process.pid, archiveSha256 }));
    markerWritten = true;
    fault?.('prepared', directory);
    await action({
      directory,
      consumer,
      env,
      setQuiescent: (value) => {
        quiescent &&= value;
      },
    });
  } catch (error) {
    receipt.qualified = false;
    receipt.status = ['EACCES', 'EPERM', 'permission', 'spawn', 'network'].includes(errorCode(error))
      ? 'incomplete'
      : 'failed';
    receipt.failure = { code: errorCode(error), message: 'Disposable setup or consumer action failed' };
  } finally {
    if (!directory) receipt.cleanup = { quiescent: true, removed: true, created: false };
    else {
      let owned = !markerWritten; // mkdtemp path held by this invocation before marker creation.
      /** @type {string|undefined} */ let cleanupFailure;
      try {
        fault?.('cleanup', directory);
        if (markerWritten) {
          const marker = record(parseJsonOutput(readFileSync(join(directory, 'owned.json'), 'utf8')));
          owned = marker.pid === process.pid && marker.archiveSha256 === archiveSha256;
        }
        if (quiescent && owned) {
          rmSync(directory, { recursive: true });
          receipt.cleanup = { quiescent: true, removed: !existsSync(directory) };
        }
      } catch (error) {
        cleanupFailure = errorCode(error);
      }
      receipt.cleanup ??= {
        quiescent,
        removed: false,
        retainedDirectory: directory,
        ownershipVerified: owned,
        ...(cleanupFailure ? { failure: cleanupFailure } : {}),
      };
      if (receipt.cleanup.removed !== true) {
        receipt.qualified = false;
        receipt.status = 'incomplete';
      }
    }
  }
  return receipt;
}

/** @param {unknown} input @returns {Contract} */
function contractFromJson(input) {
  const value = record(input, 'contract');
  const inventory = value.dryInventory;
  requireProof(Array.isArray(inventory), 'contract', 'Expected complete dry inventory');
  if (!Array.isArray(inventory)) throw new ConsumerFailure('contract', 'Expected dry inventory');
  const dryInventory = inventory.map((/** @type {unknown} */ entry) => {
    const item = record(entry, 'contract');
    if (typeof item.mode !== 'number' || typeof item.size !== 'number')
      throw new ConsumerFailure('contract', 'Invalid dry inventory numbers');
    return { path: string(item.path, 'contract'), mode: item.mode, size: item.size };
  });
  return {
    sourceRoot: string(value.sourceRoot, 'contract'),
    archivePath: string(value.archivePath, 'contract'),
    archiveSha256: string(value.archiveSha256, 'contract'),
    sourceManifestSha256: string(value.sourceManifestSha256, 'contract'),
    sourceLockSha256: string(value.sourceLockSha256, 'contract'),
    packageVersion: string(value.packageVersion, 'contract'),
    dryInventory,
    ...(typeof value.sourceCommit === 'string' ? { sourceCommit: value.sourceCommit } : {}),
    ...(typeof value.sourceTree === 'string' ? { sourceTree: value.sourceTree } : {}),
    ...(typeof value.node24 === 'string' ? { node24: value.node24 } : {}),
    ...(typeof value.node26 === 'string' ? { node26: value.node26 } : {}),
    ...(typeof value.npmCli === 'string' ? { npmCli: value.npmCli } : {}),
    ...(value.producer === undefined
      ? {}
      : {
          producer: (() => {
            const producer = record(value.producer, 'contract');
            return {
              checksResultPath: string(producer.checksResultPath, 'contract'),
              checksResultSha256: string(producer.checksResultSha256, 'contract'),
              artifactReceiptPath: string(producer.artifactReceiptPath, 'contract'),
              artifactReceiptSha256: string(producer.artifactReceiptSha256, 'contract'),
            };
          })(),
        }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [contractPath, outputPath, grant] = process.argv.slice(2);
  const shutdown = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
  try {
    requireProof(
      contractPath && outputPath && (!grant || grant === '--authorize-install'),
      'invocation',
      'Usage: current-consumer.mjs contract.json result.json [--authorize-install]',
    );
    const receipt = await runCurrentConsumer(
      contractFromJson(parseJsonOutput(readFileSync(string(contractPath, 'invocation'), 'utf8'))),
      {
        authorizeInstall: grant === '--authorize-install',
        signal: shutdown.signal,
      },
    );
    writeFileSync(string(outputPath, 'invocation'), JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(
      JSON.stringify({ status: receipt.status, qualified: receipt.qualified, archiveSha256: receipt.archiveSha256 }) +
        '\n',
    );
    process.exitCode = receipt.qualified ? 0 : 2;
  } catch (error) {
    const receipt = {
      schemaVersion: 'ai-delivery.current-consumer@1',
      status: 'failed',
      qualified: false,
      failure: { code: errorCode(error), message: 'Candidate inspection failed' },
    };
    if (outputPath) writeFileSync(string(outputPath, 'invocation'), JSON.stringify(receipt, null, 2) + '\n');
    process.stderr.write(JSON.stringify(receipt.failure) + '\n');
    process.exitCode = 1;
  }
}
