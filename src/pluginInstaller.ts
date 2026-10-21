import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  constants,
  fstatSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { marketplaceDocuments, nativePluginArgs } from '@aviaratech/ai-plugin-tools';

import { loadDeliverySettings, resolveDeliveryRoleCredentials } from './config/deliveryConfig.js';
import { captureAuthenticationProbe } from './pluginAuthProbe.js';
import { assertSupportedAuthorHost, machineAuthorEligible, MACHINE_AUTH_ENV_NAMES } from './github/machineAuth.js';
import { ensurePrivateDirectoryDurably, writePrivateJsonFileAtomically } from './utils/atomicJson.js';
import { withLock } from './utils/lockfile.js';
import {
  confirmOwnedCleanup,
  processSnapshot,
  retainedWorktreeTransitionProducerDigest,
  runStageCommand,
  terminateOwnedProcesses,
  type OwnedProcessState,
} from './verification.js';

const Version = z
  .string()
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const InputSchema = z.strictObject({
  action: z.enum(['install', 'doctor', 'preview', 'update', 'rollback', 'remove']),
  host: z.enum(['codex', 'claude-code']),
  scope: z.enum(['user', 'project', 'local']),
  version: Version.optional(),
  dryRun: z.boolean().default(false),
  checkAuth: z.boolean().default(false),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .optional(),
  repoRoot: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;
const ProcessIdentity = z.strictObject({ pid: z.number().int().positive(), birth: z.string().min(1) });
const Pending = z.strictObject({
  action: InputSchema.shape.action,
  targetVersion: Version.nullable(),
  owner: ProcessIdentity,
  producerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  staging: z
    .strictObject({
      path: z.string(),
      device: z.number().int().nonnegative().optional(),
      inode: z.number().int().nonnegative().optional(),
    })
    .optional(),
  command: z.discriminatedUnion('phase', [
    z.strictObject({ phase: z.literal('idle') }),
    z.strictObject({ phase: z.literal('starting') }),
    z.strictObject({
      phase: z.literal('running'),
      process: ProcessIdentity,
      tracked: z.array(ProcessIdentity.extend({ pgid: z.number().int().positive() })).max(256),
    }),
  ]),
});
const StateSchema = z.strictObject({
  owner: z.literal('@aviaratech/ai-delivery.plugin@1'),
  host: InputSchema.shape.host,
  scope: InputSchema.shape.scope,
  projectRoot: z.string().nullable(),
  nativeHome: z.string().min(1),
  marketplace: z.string(),
  currentVersion: Version.nullable(),
  previousVersion: Version.nullable(),
  installedPath: z.string().nullable(),
  nativeVersion: z.string().optional(),
  pending: Pending.optional(),
});
type State = z.infer<typeof StateSchema>;
const Unit = z.strictObject({
  owner: z.literal('@aviaratech/ai-delivery.plugin-version@1'),
  version: Version,
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
});
type Target = ReturnType<typeof targetFor>;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface PluginResult {
  action: Input['action'];
  host: Input['host'];
  scope: Input['scope'];
  version: string | null;
  changed: boolean;
  dryRun: boolean;
  installed: boolean;
  marketplace: string;
  managedDirectory: string;
  repositoryAdmission: 'explicit_stage_and_admit_required';
  nativePluginRoot?: string;
  nativeCachePath?: string;
  nativeVersion?: string;
  sourceIntegrity?: boolean;
  enabled?: boolean;
  skills?: string[];
  mcp?: { configuration: string; startup: string; version?: string; error?: string };
  restartRequired?: boolean;
  recoveryRequired?: boolean;
  authProbe?: PluginAuthProbe;
  diagnostics?: {
    completeness: 'incomplete';
    registrations: RegistrationObservation[];
    nativeInventory: 'not_checked' | 'observed' | 'unavailable';
    findings: string[];
    plannedChanges: [];
    migration: 'refused';
  };
  activation?: { installedVersion: string | null; startupVersion: string | null; loadedVersion: null };
}

interface RegistrationObservation {
  kind: 'standalone' | 'plugin';
  scope: 'user' | 'project' | 'local' | 'unknown';
  ownership: 'managed' | 'external' | 'unknown';
  source: 'managed_archive' | 'unknown';
  version: string | null;
  enabled: boolean | null;
}

function sourceDiagnostics(input: Input, target: Target): NonNullable<PluginResult['diagnostics']> {
  const report: NonNullable<PluginResult['diagnostics']> = {
    completeness: 'incomplete',
    registrations: [],
    nativeInventory: 'not_checked',
    plannedChanges: [],
    migration: 'refused',
    findings: ['native_session_scope_unverified', 'settings_preservation_unproved', 'native_writer_exclusion_unproved'],
  };
  const text = (path: string): string | undefined => {
    let descriptor: number | undefined;
    try {
      assertCanonical(path);
      if (!existsSync(path)) return undefined;
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024)
        throw new Error('Unsafe configuration');
      // Nonblocking open also protects against replacement with a FIFO between
      // lstat and open; descriptor validation remains authoritative.
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('Unsafe configuration');
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(descriptor, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > 1024 * 1024) throw new Error('Configuration exceeded read limit');
      return bytes.subarray(0, size).toString('utf8');
    } catch {
      report.findings.push('configuration_unavailable');
      return undefined;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
  const json = (path: string): Record<string, unknown> | undefined => {
    const value = text(path);
    if (value === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return z.record(z.string(), z.unknown()).parse(parsed);
    } catch {
      report.findings.push('configuration_unavailable');
      return undefined;
    }
  };
  const observe = (scope: RegistrationObservation['scope'], servers: unknown) => {
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      if (servers !== undefined) report.findings.push('configuration_unavailable');
      return;
    }
    // Names and launcher text identify candidates, never ownership. Nothing from
    // command arguments, URLs, environments or permission values reaches output.
    const candidate = Object.entries(servers).some(([name, value]) => {
      if (name === 'ai-delivery') return true;
      if (typeof value !== 'object' || value === null) return false;
      const entry = value as Record<string, unknown>;
      return (
        entry.command === 'ai-delivery' ||
        (Array.isArray(entry.args) &&
          entry.args.some((arg: unknown) => typeof arg === 'string' && arg.includes('@aviaratech/ai-delivery')))
      );
    });
    if (candidate)
      report.registrations.push({
        kind: 'standalone',
        scope,
        ownership: 'unknown',
        source: 'unknown',
        version: null,
        enabled: null,
      });
  };
  if (input.host === 'claude-code') {
    if (process.env.CLAUDE_CONFIG_DIR) {
      report.findings.push('custom_profile_configuration_unverified');
    } else {
      const user = json(join(realpathSync(homedir()), '.claude.json'));
      const projects = user?.projects;
      if (typeof projects === 'object' && projects !== null && !Array.isArray(projects)) {
        const local = (projects as Record<string, unknown>)[target.projectRoot];
        if (typeof local === 'object' && local !== null)
          observe('local', (local as Record<string, unknown>).mcpServers);
      }
      observe('user', user?.mcpServers);
    }
    const project = json(join(target.projectRoot, '.mcp.json'))?.mcpServers;
    const userIndex = report.registrations.findIndex((entry) => entry.scope === 'user');
    observe('project', project);
    if (userIndex !== -1 && report.registrations.at(-1)?.scope === 'project') {
      const entry = report.registrations.pop()!;
      report.registrations.splice(userIndex, 0, entry);
    }
  } else {
    for (const [scope, path] of [
      ['project', join(target.projectRoot, '.codex/config.toml')],
      ['user', join(target.nativeHome, 'config.toml')],
    ] as const) {
      if (scope === 'project' && path === join(target.nativeHome, 'config.toml')) continue;
      const value = text(path);
      if (value === undefined) continue;
      // This is a conservative header observation, not a TOML resolver. Quoted
      // strings, profiles, managed and CLI overlays stay explicitly unverified.
      report.findings.push('codex_configuration_not_fully_resolved');
      if (/^\s*\[\s*mcp_servers\.(?:"ai-delivery"|'ai-delivery'|ai-delivery)\s*\]/mu.test(value))
        observe(scope, { 'ai-delivery': {} });
    }
  }
  report.findings = [...new Set(report.findings)];
  return report;
}

function observeNativePlugins(
  result: PluginResult,
  input: Input,
  target: Target,
  entries: Record<string, unknown>[],
  verifiedRegistration?: Record<string, unknown>,
): void {
  const report = result.diagnostics!;
  report.nativeInventory = 'observed';
  let count = 0;
  for (const entry of entries) {
    const id = entry.pluginId ?? entry.id;
    if (!(entry.name === 'ai-delivery' || (typeof id === 'string' && id.startsWith('ai-delivery@')))) continue;
    if (input.host === 'codex' && entry.installed !== true) continue;
    if (input.host === 'claude-code' && (entry.scope === 'project' || entry.scope === 'local')) {
      if (typeof entry.projectPath === 'string' && entry.projectPath !== target.projectRoot) continue;
      if (typeof entry.projectPath !== 'string') report.findings.push('native_registration_project_unverified');
    }
    if (++count > 256) {
      report.findings.push('native_inventory_truncated');
      break;
    }
    const managed = result.sourceIntegrity === true && entry === verifiedRegistration;
    const version = Version.safeParse(entry.version);
    const scope =
      input.host === 'codex'
        ? 'user'
        : entry.scope === 'user' || entry.scope === 'project' || entry.scope === 'local'
          ? entry.scope
          : 'unknown';
    report.registrations.push({
      kind: 'plugin',
      scope,
      ownership: managed ? 'managed' : 'external',
      source: managed ? 'managed_archive' : 'unknown',
      version: version.success ? version.data : null,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : null,
    });
  }
}

export interface PluginAuthProbe {
  invocationContext: 'selected_runtime_cli';
  nativeGuiPropagation: 'unverified';
  settings: 'not_checked' | 'valid' | 'unavailable_or_invalid';
  processReferences: {
    status: 'not_checked' | 'complete' | 'missing' | 'invalid';
    requiredNames: string[];
    missingNames: string[];
  };
  authentication: {
    status: 'not_checked' | 'verified' | 'failed' | 'unverified';
    author?: { actorLogin: string; authSource: 'app' | 'personal'; credentialSource?: string };
    reviewer?: { actorLogin: string; authSource: 'app' };
  };
  repositoryAccess: { repository: string; status: 'not_checked' | 'verified' | 'denied' | 'unverified' };
  reviewRules?: {
    visibility: 'complete' | 'partial' | 'unknown';
    observedRequiredApprovals: number | null;
    approvalEligibility: 'unknown' | 'insufficient-permission';
  };
  outcome: 'not_checked' | 'blocked' | 'failed' | 'readback_complete';
  reason?:
    | 'dry_run'
    | 'native_plugin_not_ready'
    | 'settings_unavailable_or_invalid'
    | 'missing_references'
    | 'invalid_references'
    | 'authentication_failed'
    | 'repository_denied'
    | 'probe_failed'
    | 'probe_cleanup_unverified'
    | 'invalid_readback';
}

// Native inventory and startup must not inherit the caller's credentials or
// runtime injection flags. Install/update/recovery keep their existing owner.
function doctorEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', DISABLE_AUTOUPDATER: '1' };
  for (const name of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

const AuthReadback = z.object({
  routing: z.object({ repository: InputSchema.shape.repo.unwrap() }),
  reviewRoute: z.object({
    author: z.object({
      actorLogin: z
        .string()
        .regex(/^[A-Za-z0-9-]+(?:\[bot\])?$/u)
        .max(200),
      authSource: z.enum(['app', 'personal']),
      credentialSource: z.string().optional(),
      identity: z.string(),
    }),
    reviewer: z.object({
      actorLogin: z
        .string()
        .regex(/^[A-Za-z0-9-]+(?:\[bot\])?$/u)
        .max(200),
      identity: z.string(),
      repositoryAccess: z.literal('readable'),
    }),
    rules: z.object({
      visibility: z.enum(['complete', 'partial', 'unknown']),
      observedRequiredApprovals: z.number().int().nonnegative().nullable(),
    }),
    approvalEligibility: z.enum(['unknown', 'insufficient-permission']),
  }),
});

async function checkAuthentication(input: Input, root: string, probe: PluginAuthProbe): Promise<void> {
  let settings: Awaited<ReturnType<typeof loadDeliverySettings>>;
  try {
    settings = await loadDeliverySettings();
    probe.settings = 'valid';
  } catch {
    probe.settings = 'unavailable_or_invalid';
    probe.outcome = 'blocked';
    probe.reason = 'settings_unavailable_or_invalid';
    return;
  }
  const names = Object.values(settings.roles).flatMap((role) => Object.values(role.credentialEnv));
  const author = settings.roles.author;
  const machineSession =
    author.authSource === 'personal' && machineAuthorEligible(author.credentialEnv.token, process.env);
  const requiredNames = machineSession ? names.filter((name) => name !== 'GH_TOKEN') : names;
  probe.processReferences.requiredNames = requiredNames;
  const missing = requiredNames.filter((name) => !process.env[name]?.trim());
  probe.processReferences.missingNames = missing;
  if (missing.length > 0) {
    probe.processReferences.status = 'missing';
    probe.outcome = 'blocked';
    probe.reason = 'missing_references';
    return;
  }
  // A credential reference cannot also change the selected Node/configuration
  // boundary. No legacy personal override or ambient fallback is forwarded.
  if (
    names.some(
      (name) =>
        /^(?:NODE_|NPM_|GIT_)/u.test(name) ||
        [
          ...MACHINE_AUTH_ENV_NAMES,
          'PATH',
          'HOME',
          'CODEX_HOME',
          'CLAUDE_CONFIG_DIR',
          'AI_DELIVERY_CONFIG',
          'AI_DELIVERY_IDENTITY',
          'DISABLE_AUTOUPDATER',
        ].includes(name),
    )
  ) {
    probe.processReferences.status = 'invalid';
    probe.outcome = 'blocked';
    probe.reason = 'invalid_references';
    return;
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    AI_DELIVERY_CONFIG: settings.configPath,
    NODE_OPTIONS: '--max-old-space-size=512 --v8-pool-size=1',
    DISABLE_AUTOUPDATER: '1',
  };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name]!.trim();
  if (machineSession)
    for (const name of MACHINE_AUTH_ENV_NAMES) if (process.env[name] !== undefined) env[name] = process.env[name];
  try {
    if (author.authSource === 'personal') assertSupportedAuthorHost(process.env);
    for (const role of ['author', 'reviewer'] as const)
      if (settings.roles[role].authSource !== 'personal')
        resolveDeliveryRoleCredentials({ config: settings, role, env });
  } catch {
    probe.processReferences.status = 'invalid';
    probe.outcome = 'blocked';
    probe.reason = 'invalid_references';
    return;
  }
  probe.processReferences.status = 'complete';
  // Supervise the selected CLI and its descendants with the existing owned
  // process runner. Timeout and host cancellation await identity-checked
  // cleanup; authentication output stays in bounded memory, never a stage log.
  const captured = await captureAuthenticationProbe(
    input.repoRoot,
    [process.execPath, join(root, 'runtime/dist/cli.js'), '--repo', input.repo!, 'config:resolve'],
    env,
  );
  if (!captured.cleanupConfirmed) {
    probe.outcome = 'failed';
    probe.authentication.status = 'unverified';
    probe.repositoryAccess.status = 'unverified';
    probe.reason = 'probe_cleanup_unverified';
    return;
  }
  if (captured.failed) {
    probe.outcome = 'failed';
    probe.authentication.status = 'unverified';
    probe.repositoryAccess.status = 'unverified';
    // REST request logging can precede the CLI-owned final diagnostic. Classify
    // only that exact final line; all surrounding opaque output stays withheld.
    const diagnostic = captured.diagnostic;
    if (
      diagnostic ===
        'ai-delivery: Configured personal author token is invalid or expired; refresh the selected token.' ||
      diagnostic ===
        'ai-delivery: Machine GitHub session is invalid or expired; verify the selected github.com account.'
    ) {
      probe.authentication.status = 'failed';
      probe.reason = 'authentication_failed';
    } else if (
      [
        'ai-delivery: Author cannot read the selected GitHub repository; verify configured access.',
        'ai-delivery: Reviewer GitHub App cannot read the selected repository; verify its installation and repository access.',
      ].includes(diagnostic ?? '')
    ) {
      probe.repositoryAccess.status = 'denied';
      probe.reason = 'repository_denied';
    } else probe.reason = 'probe_failed';
    return;
  }
  try {
    const data = AuthReadback.parse(JSON.parse(captured.stdout) as unknown);
    const route = data.reviewRoute;
    if (
      data.routing.repository.toLowerCase() !== input.repo!.toLowerCase() ||
      route.author.authSource !== (settings.roles.author.authSource ?? 'app') ||
      route.author.identity !== settings.roles.author.identity ||
      route.reviewer.identity !== settings.roles.reviewer.identity ||
      route.author.actorLogin.toLowerCase() === route.reviewer.actorLogin.toLowerCase()
    )
      throw new Error('Inconsistent readback');
    const projected = {
      author: {
        actorLogin: route.author.actorLogin,
        authSource: route.author.authSource,
        ...(machineSession && route.author.credentialSource !== undefined
          ? { credentialSource: route.author.credentialSource }
          : {}),
      },
      reviewer: { actorLogin: route.reviewer.actorLogin, authSource: 'app' as const },
    };
    // Even a syntactically valid actor must not reproduce a supplied credential.
    if (machineSession && !route.author.credentialSource?.startsWith('gh:github.com:'))
      throw new Error('Missing session route');
    if (names.some((name) => env[name] !== undefined && JSON.stringify(projected).includes(env[name]!)))
      throw new Error('Unsafe readback');
    probe.authentication = { status: 'verified', ...projected };
    probe.repositoryAccess.status = 'verified';
    probe.reviewRules = { ...route.rules, approvalEligibility: route.approvalEligibility };
    probe.outcome = 'readback_complete';
  } catch {
    probe.authentication.status = 'unverified';
    probe.repositoryAccess.status = 'unverified';
    probe.outcome = 'failed';
    probe.reason = 'invalid_readback';
  }
}

function assertCanonical(path: string): void {
  let cursor = resolve(path);
  while (true) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error('Managed plugin paths must not use symlinks.');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function targetFor(input: Input) {
  const projectRoot = realpathSync(resolve(input.repoRoot));
  const nativeProfile = resolve(
    projectRoot,
    (input.host === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR) ??
      join(homedir(), input.host === 'codex' ? '.codex' : '.claude'),
  );
  let ancestor = nativeProfile;
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const nativeHome = join(realpathSync(ancestor), ...missing);
  const scopeKey =
    input.scope === 'user'
      ? 'user'
      : `${input.scope}-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)}`;
  const directory = join(homedir(), '.cache', 'ai-delivery', 'plugins', input.host, scopeKey);
  assertCanonical(directory);
  if (existsSync(directory) && (!lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o077) !== 0))
    throw new Error('Managed plugin directory is not private.');
  return {
    directory,
    projectRoot,
    nativeHome,
    marketplace: `ai-delivery-${scopeKey}`,
    catalog: join(directory, 'marketplace'),
    statePath: join(directory, 'state.json'),
    tool: input.host === 'codex' ? 'codex' : 'claude',
  };
}
function readState(input: Input, target: Target): State | undefined {
  if (!existsSync(target.statePath)) return undefined;
  const metadata = lstatSync(target.statePath);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 || metadata.size > 65536)
    throw new Error('Managed plugin state is unsafe.');
  const state = StateSchema.parse(JSON.parse(readFileSync(target.statePath, 'utf8')));
  if (state.nativeHome !== target.nativeHome)
    throw new Error('Managed plugin state belongs to a different native profile.');
  if (
    state.host !== input.host ||
    state.scope !== input.scope ||
    state.marketplace !== target.marketplace ||
    state.projectRoot !== (input.scope === 'user' ? null : target.projectRoot)
  )
    throw new Error('Managed plugin state belongs to a different target.');
  return state;
}
function identity(pid: number): string | undefined {
  const member = processSnapshot().get(pid);
  return member && !member.status.startsWith('Z') ? member.identity : undefined;
}
async function recover(pending: z.infer<typeof Pending>): Promise<void> {
  if (identity(pending.owner.pid) === pending.owner.birth)
    throw new Error('A live plugin installer still owns this target.');
  if (pending.command.phase === 'starting')
    throw new Error('Interrupted installer command ownership is unknown; preserve its state before recovery.');
  if (pending.command.phase !== 'running') return;
  const owned: OwnedProcessState = {
    rootPid: pending.command.process.pid,
    rootIdentity: pending.command.process.birth,
    sampled: true,
    tracked: new Map(
      pending.command.tracked.map(({ pid, birth, pgid }) => [
        pid,
        { pid, identity: birth, pgid, ppid: 0, rssBytes: 0, status: '' },
      ]),
    ),
  };
  terminateOwnedProcesses(owned);
  await confirmOwnedCleanup(owned);
}
async function command(
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  publish?: (command: z.infer<typeof Pending>['command']) => void,
  credentialFreeDoctor = false,
): Promise<string> {
  const output = await runStageCommand(
    cwd,
    [binary, ...args],
    signal,
    undefined,
    { maxAggregateRssBytes: 1024 ** 3, minFreeDiskBytes: 256 * 1024 ** 2, maxNewOutputBytes: 512 * 1024 ** 2 },
    undefined,
    undefined,
    {
      starting: () => publish?.({ phase: 'starting' }),
      observed: (owned) =>
        publish?.({
          phase: 'running',
          process: { pid: owned.rootPid, birth: owned.rootIdentity! },
          tracked: [...owned.tracked.values()].map(({ pid, identity: birth, pgid }) => ({ pid, birth, pgid })),
        }),
      idle: () => publish?.({ phase: 'idle' }),
      assertQuiescent: () => {},
    },
    {
      environment: credentialFreeDoctor ? doctorEnvironment() : { ...process.env, DISABLE_AUTOUPDATER: '1' },
      cwd,
      maxCapturedOutputBytes: 1024 * 1024,
      stdoutOnly: true,
      failedOutput: (bytes) =>
        credentialFreeDoctor
          ? ' Native inventory failed; raw output withheld.'
          : ` Native command output: ${bytes.toString('utf8').slice(-2000)}`,
    },
  );
  return output.toString('utf8');
}
function sync(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function pluginRoot(target: Target, version: string) {
  return join(target.catalog, 'versions', version, 'plugins', 'ai-delivery');
}
function unitDirectory(target: Target, version: string) {
  return join(target.catalog, 'versions', version);
}
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let entries = 0;
  const visit = (directory: string, prefix: string, depth: number) => {
    if (depth > 16) throw new Error('Plugin tree exceeds the depth bound.');
    for (const name of readdirSync(directory).sort()) {
      if (++entries > 4096) throw new Error('Plugin tree exceeds the entry bound.');
      const path = join(directory, name),
        relative = `${prefix}${name}`,
        metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1)))
        throw new Error('Plugin tree contains links or special files.');
      if (metadata.isDirectory()) visit(path, `${relative}/`, depth + 1);
      else {
        if (metadata.size > 32 * 1024 ** 2) throw new Error('Plugin file exceeds the size bound.');
        files[relative] = sha(readFileSync(path));
      }
    }
  };
  visit(root, '', 0);
  return files;
}
function verifiedUnit(target: Target, version: string): z.infer<typeof Unit> {
  const directory = unitDirectory(target, version);
  assertCanonical(directory);
  const path = join(directory, 'version.json');
  if (!existsSync(path)) throw new Error(`No completed immutable plugin unit for ${version}.`);
  const metadata = lstatSync(path),
    archive = join(directory, 'archive.tgz'),
    archiveMetadata = lstatSync(archive);
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > 1024 * 1024 ||
    !archiveMetadata.isFile() ||
    archiveMetadata.nlink !== 1 ||
    archiveMetadata.size > 32 * 1024 ** 2
  )
    throw new Error('Immutable plugin unit metadata is unsafe.');
  const unit = Unit.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (
    unit.version !== version ||
    JSON.stringify(tree(pluginRoot(target, version))) !== JSON.stringify(unit.files) ||
    sha(readFileSync(archive)) !== unit.archiveSha256
  )
    throw new Error('Immutable plugin unit integrity changed.');
  return unit;
}
function unpack(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > 32 * 1024 ** 2) throw new Error('Plugin archive exceeds 32 MiB.');
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 ** 2 });
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/su, '')
        .trim();
    const octal = (start: number, length: number) => {
      const value = text(start, length);
      if (!/^[0-7]+$/u.test(value)) throw new Error('Unsupported tar numeric header.');
      return Number.parseInt(value, 8);
    };
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(148, 8)) throw new Error('Plugin archive header checksum mismatch.');
    const name = `${text(345, 155) ? `${text(345, 155)}/` : ''}${text(0, 100)}`,
      size = octal(124, 12),
      kind = text(156, 1);
    if (
      !/^package\/[A-Za-z0-9_./-]+$/u.test(name) ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      name.split('/').length > 16 ||
      !['', '0', '5'].includes(kind) ||
      offset + 512 + size > tar.length ||
      files.has(name) ||
      files.size >= 4096
    )
      throw new Error('Unsafe or unsupported plugin archive member.');
    if (kind !== '5') files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function stageVersion(
  target: Target,
  version: string,
  signal: AbortSignal,
  publish: (command: z.infer<typeof Pending>['command']) => void,
  staging: (value: z.infer<typeof Pending>['staging']) => void,
): Promise<void> {
  const unit = unitDirectory(target, version);
  if (existsSync(unit)) {
    verifiedUnit(target, version);
    return;
  }
  const parent = dirname(unit);
  ensurePrivateDirectoryDurably(parent);
  const temporary = join(parent, `.stage-${randomUUID()}`);
  staging({ path: temporary });
  mkdirSync(temporary, { mode: 0o700 });
  const allocation = lstatSync(temporary);
  sync(parent);
  staging({ path: temporary, device: allocation.dev, inode: allocation.ino });
  let quiescent = true;
  let failed = false;
  let failure: unknown;
  const unitPublish = (value: z.infer<typeof Pending>['command']) => {
    quiescent = value.phase === 'idle';
    publish(value);
  };
  try {
    const packed = JSON.parse(
      await command(
        'npm',
        [
          'pack',
          `@aviaratech/ai-delivery@${version}`,
          '--ignore-scripts',
          '--json',
          '--logs-max',
          '0',
          '--cache',
          join(target.directory, 'npm-cache'),
          '--pack-destination',
          temporary,
        ],
        temporary,
        signal,
        unitPublish,
      ),
    ) as { filename?: unknown }[];
    const filename = packed[0]?.filename;
    if (typeof filename !== 'string' || !/^aviaratech-ai-delivery-[A-Za-z0-9.+_-]+\.tgz$/u.test(filename))
      throw new Error('npm returned an unsafe archive path.');
    const bytes = readFileSync(join(temporary, filename)),
      files = unpack(bytes);
    const packageInfo = JSON.parse(files.get('package/package.json')?.toString() ?? 'null') as {
      name?: string;
      version?: string;
    } | null;
    if (packageInfo?.name !== '@aviaratech/ai-delivery' || packageInfo.version !== version)
      throw new Error('Archive package identity does not match the explicit version.');
    const prefix = 'package/plugins/ai-delivery/';
    const destination = join(temporary, 'plugins', 'ai-delivery');
    for (const [name, content] of files)
      if (name.startsWith(prefix)) {
        const path = join(destination, name.slice(prefix.length));
        ensurePrivateDirectoryDurably(dirname(path));
        writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
        sync(path);
      }
    const portable = JSON.parse(readFileSync(join(destination, 'plugin.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const native = JSON.parse(readFileSync(join(destination, '.claude-plugin/plugin.json'), 'utf8')) as {
      name: string;
      version: string;
      packageVersion: string;
      deliveryCapabilityVersion: number;
    };
    const runtime = JSON.parse(readFileSync(join(destination, 'runtime/package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    if (
      portable.name !== 'ai-delivery' ||
      portable.version !== version ||
      native.name !== portable.name ||
      native.version !== version ||
      native.packageVersion !== version ||
      native.deliveryCapabilityVersion !== 2 ||
      runtime.name !== packageInfo.name ||
      runtime.version !== version
    )
      throw new Error('Archive does not contain a coherent self-contained native plugin.');
    if (
      (
        await command(
          process.execPath,
          [join(destination, 'runtime/dist/cli.js'), '--version'],
          temporary,
          signal,
          unitPublish,
        )
      ).trim() !== version
    )
      throw new Error('Built native CLI version does not match its archive.');
    renameSync(join(temporary, filename), join(temporary, 'archive.tgz'));
    sync(join(temporary, 'archive.tgz'));
    writePrivateJsonFileAtomically(join(temporary, 'version.json'), {
      owner: '@aviaratech/ai-delivery.plugin-version@1',
      version,
      archiveSha256: sha(bytes),
      files: tree(destination),
    });
    renameSync(temporary, unit);
    sync(parent);
    staging(undefined);
    verifiedUnit(target, version);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    if (quiescent && existsSync(temporary)) {
      const current = lstatSync(temporary);
      if (
        current.dev !== allocation.dev ||
        current.ino !== allocation.ino ||
        !current.isDirectory() ||
        current.isSymbolicLink()
      )
        throw new Error('Owned staging directory identity changed.');
      rmSync(temporary, { recursive: true });
      sync(parent);
    }
    if (quiescent) staging(undefined);
  } catch (error) {
    failure = failed
      ? new AggregateError([failure, error], 'Plugin preparation failed and staging cleanup also failed.')
      : error;
    failed = true;
  }
  if (failed) throw failure;
}
function catalogDocuments(target: Target, version: string): { path: string; value: unknown }[] {
  const source = `./versions/${version}/plugins/ai-delivery`;
  const { codexDocument, claudeDocument } = marketplaceDocuments({
    marketplaceName: target.marketplace,
    pluginName: 'ai-delivery',
    relativeSource: source,
    version,
    ownerName: 'AviaraTech',
    metadata: {
      kind: 'interface-policy',
      displayName: 'ai-delivery',
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  });
  return [
    {
      path: join(target.catalog, '.agents/plugins/marketplace.json'),
      value: codexDocument,
    },
    {
      path: join(target.catalog, '.claude-plugin/marketplace.json'),
      value: claudeDocument,
    },
  ];
}
type CatalogSnapshot = { path: string; bytes: Buffer; device: number; inode: number }[];
function readCatalog(target: Target, version: string): CatalogSnapshot {
  return catalogDocuments(target, version).map(({ path }) => {
    assertCanonical(path);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 || metadata.size > 1024 ** 2)
      throw new Error('Managed catalog is unsafe.');
    return { path, bytes: readFileSync(path), device: metadata.dev, inode: metadata.ino };
  });
}
function catalogMatches(snapshot: CatalogSnapshot, target: Target, version: string): boolean[] {
  return catalogDocuments(target, version).map(
    ({ value }, index) => JSON.stringify(JSON.parse(snapshot[index]!.bytes.toString())) === JSON.stringify(value),
  );
}
function assertCatalogUnchanged(entry: CatalogSnapshot[number]): void {
  assertCanonical(entry.path);
  const current = lstatSync(entry.path);
  if (
    !current.isFile() ||
    current.nlink !== 1 ||
    (current.mode & 0o777) !== 0o600 ||
    current.size !== entry.bytes.length ||
    current.dev !== entry.device ||
    current.ino !== entry.inode ||
    !readFileSync(entry.path).equals(entry.bytes)
  )
    throw new Error('Managed catalog changed during this operation.');
}
function catalog(target: Target, version: string, expected?: CatalogSnapshot): void {
  verifiedUnit(target, version);
  for (const [index, document] of catalogDocuments(target, version).entries()) {
    if (expected) assertCatalogUnchanged(expected[index]!);
    writePrivateJsonFileAtomically(document.path, document.value);
  }
}
interface NativeEntry {
  registration: Record<string, unknown>;
  version: string;
  installedPath?: string;
  enabled: boolean;
  sourceRoot?: string;
  mcpServers?: Record<string, unknown>;
}
async function inventory(
  input: Input,
  target: Target,
  signal: AbortSignal,
  publish?: (command: z.infer<typeof Pending>['command']) => void,
  allPlugins = false,
): Promise<Record<string, unknown>[]> {
  const value: unknown = JSON.parse(
    await command(
      target.tool,
      [
        'plugin',
        'list',
        ...(input.host === 'codex' && !allPlugins ? ['--marketplace', target.marketplace, '--available'] : []),
        '--json',
      ],
      target.projectRoot,
      signal,
      publish,
      input.action === 'doctor',
    ),
  );
  if (input.host === 'claude-code') return z.array(z.record(z.string(), z.unknown())).parse(value);
  const all = z
    .object({
      installed: z.array(z.record(z.string(), z.unknown())),
      available: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(value);
  return [
    ...all.installed.map((entry) => ({ ...entry, installed: true })),
    ...all.available.map((entry) => ({ ...entry, installed: false })),
  ];
}
function registration(input: Input, target: Target, entries: Record<string, unknown>[]): boolean {
  if (input.host === 'claude-code') {
    const path = join(target.nativeHome, 'plugins/known_marketplaces.json');
    if (!existsSync(path)) return false;
    if (!lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024)
      throw new Error('Native marketplace registry is unsafe.');
    const markets = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, 'utf8')));
    if (markets[target.marketplace] === undefined) return false;
    const selected = z
      .object({ source: z.object({ source: z.literal('directory'), path: z.string() }), installLocation: z.string() })
      .parse(markets[target.marketplace]);
    if (resolve(selected.source.path) !== target.catalog || resolve(selected.installLocation) !== target.catalog)
      throw new Error('Native marketplace name belongs to an unmanaged source.');
    return true;
  }
  const selected = entries.filter((entry) => entry.marketplaceName === target.marketplace);
  for (const entry of selected) {
    const source = z.object({ sourceType: z.literal('local'), source: z.string() }).parse(entry.marketplaceSource);
    if (resolve(source.source) !== target.catalog)
      throw new Error('Native marketplace name belongs to an unmanaged source.');
  }
  return selected.length > 0;
}
function nativeEntry(input: Input, target: Target, entries: Record<string, unknown>[]): NativeEntry | undefined {
  const matches = entries.filter(
    (entry) =>
      (entry.pluginId ?? entry.id) === `ai-delivery@${target.marketplace}` &&
      (input.host === 'codex' ? entry.installed === true : entry.scope === input.scope) &&
      (input.scope === 'user' || entry.projectPath === target.projectRoot),
  );
  if (matches.length > 1) throw new Error('Native plugin readback is ambiguous.');
  const entry = matches[0];
  if (!entry) return undefined;
  const sourceRoot =
    input.host === 'codex'
      ? z.object({ source: z.literal('local'), path: z.string() }).parse(entry.source).path
      : undefined;
  return {
    registration: entry,
    version: Version.parse(entry.version),
    enabled: z.boolean().parse(entry.enabled),
    ...(typeof entry.installPath === 'string' ? { installedPath: entry.installPath } : {}),
    ...(sourceRoot ? { sourceRoot } : {}),
    ...(entry.mcpServers ? { mcpServers: z.record(z.string(), z.unknown()).parse(entry.mcpServers) } : {}),
  };
}
function claudeCatalogSelection(target: Target) {
  const path = join(target.catalog, '.claude-plugin/marketplace.json');
  assertCanonical(path);
  if (!lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024)
    throw new Error('Managed Claude catalog is unsafe.');
  const catalog = z
    .object({
      name: z.literal(target.marketplace),
      plugins: z.array(z.object({ name: z.string(), version: Version, source: z.string() })),
    })
    .parse(JSON.parse(readFileSync(path, 'utf8')));
  const entries = catalog.plugins.filter((entry) => entry.name === 'ai-delivery');
  if (entries.length !== 1) throw new Error('Managed Claude catalog selection is ambiguous.');
  const entry = entries[0]!;
  if (!entry.source.startsWith('./') || resolve(target.catalog, entry.source) !== pluginRoot(target, entry.version))
    throw new Error('Claude catalog source differs from the immutable managed unit.');
  return entry;
}
function selectedRoot(
  input: Input,
  target: Target,
  entry: NativeEntry,
  cachePath: string | null,
  sourceVersion = entry.version,
): string {
  const unit = verifiedUnit(target, entry.version),
    source = pluginRoot(target, sourceVersion);
  if (sourceVersion !== entry.version) verifiedUnit(target, sourceVersion);
  if (input.host === 'claude-code' && claudeCatalogSelection(target).version !== sourceVersion)
    throw new Error('Claude catalog version differs from its native selection.');
  if (input.host === 'codex' && resolve(entry.sourceRoot!) !== source)
    throw new Error('Native plugin source differs from the managed version.');
  const root = cachePath;
  if (!root) throw new Error('Native cache path is missing.');
  if (
    input.host === 'claude-code' &&
    (entry.installedPath === undefined || resolve(entry.installedPath) !== resolve(root))
  )
    throw new Error('Native cache path differs from the managed native selection.');
  if (resolve(root) !== join(target.nativeHome, 'plugins/cache', target.marketplace, 'ai-delivery', entry.version))
    throw new Error('Native cache path is outside the managed native selection.');
  assertCanonical(root);
  if (JSON.stringify(tree(root)) !== JSON.stringify(unit.files))
    throw new Error('Selected native plugin bytes differ from the verified archive.');
  if (input.host === 'claude-code') {
    const server = z
      .object({ command: z.literal('node'), args: z.tuple([z.literal('${CLAUDE_PLUGIN_ROOT}/dist/mcp-launcher.js')]) })
      .parse(entry.mcpServers?.['ai-delivery']);
    if (!server) throw new Error('Native MCP binding is missing.');
  }
  return root;
}
async function startup(root: string, version: string, cwd: string): Promise<NonNullable<PluginResult['mcp']>> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist/mcp-launcher.js')],
    cwd,
    // The SDK merges its default inherited names even when env is supplied.
    // Explicitly mask every one; startup needs no caller environment values.
    env: {
      ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, ''])),
      NODE_OPTIONS: '--max-old-space-size=1024',
    },
    stderr: 'pipe',
    maxBufferSize: 1024 * 1024,
  });
  const client = new Client({ name: 'ai-delivery-plugin-doctor', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 30000 });
    if (client.getServerVersion()?.version !== version)
      throw new Error('MCP server version differs from the selected archive.');
    await client.listTools({}, { timeout: 30000 });
    return { configuration: 'native_manifest_present', startup: 'ready', version };
  } catch {
    return {
      configuration: 'native_manifest_present',
      startup: 'failed',
      error: 'Bundled MCP startup failed; raw output withheld.',
    };
  } finally {
    await client.close();
    await transport.close();
  }
}

export async function managePlugin(value: unknown): Promise<PluginResult> {
  const input = InputSchema.parse(value);
  if (input.checkAuth && input.action !== 'doctor') throw new Error('--check-auth is supported only for doctor.');
  if (input.checkAuth && input.repo === undefined)
    throw new Error('doctor --check-auth requires explicit --repo owner/name.');
  if (input.host === 'codex' && input.scope !== 'user')
    throw new Error('Codex currently supports user plugin installation; select --scope user.');
  if ((input.action === 'install' || input.action === 'update') && input.version === undefined)
    throw new Error('An explicit --version is required for install and update.');
  if (input.version !== undefined && input.action !== 'install' && input.action !== 'update')
    throw new Error(
      '--version is supported only for install and update; rollback selects the recorded previous version.',
    );
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Plugin management requires the supported POSIX runtime environment.');
  const target = targetFor(input);
  let state = readState(input, target);
  const result: PluginResult = {
    action: input.action,
    host: input.host,
    scope: input.scope,
    version:
      input.action === 'remove'
        ? null
        : (input.version ?? (input.action === 'rollback' ? state?.previousVersion : state?.currentVersion) ?? null),
    changed: false,
    dryRun: input.dryRun,
    installed: false,
    marketplace: target.marketplace,
    managedDirectory: target.directory,
    repositoryAdmission: 'explicit_stage_and_admit_required',
  };
  if (input.checkAuth)
    result.authProbe = {
      invocationContext: 'selected_runtime_cli',
      nativeGuiPropagation: 'unverified',
      settings: 'not_checked',
      processReferences: { status: 'not_checked', requiredNames: [], missingNames: [] },
      authentication: { status: 'not_checked' },
      repositoryAccess: { repository: input.repo!, status: 'not_checked' },
      outcome: input.dryRun ? 'not_checked' : 'blocked',
      reason: input.dryRun ? 'dry_run' : 'native_plugin_not_ready',
    };
  if (input.dryRun) return result;
  result.diagnostics = sourceDiagnostics(input, target);
  result.activation = { installedVersion: null, startupVersion: null, loadedVersion: null };
  if (input.action === 'preview') return result;
  if (input.action === 'doctor') {
    if (state) result.recoveryRequired = state.pending !== undefined;
    if (state?.pending) return result;
    if (!state?.currentVersion) {
      try {
        observeNativePlugins(
          result,
          input,
          target,
          await inventory(input, target, new AbortController().signal, undefined, true),
        );
      } catch {
        result.diagnostics.nativeInventory = 'unavailable';
        result.diagnostics.findings.push('native_inventory_unavailable');
      }
      return result;
    }
    try {
      verifiedUnit(target, state.currentVersion);
    } catch {
      result.sourceIntegrity = false;
      result.mcp = { configuration: 'unverified', startup: 'not_checked', error: 'Managed archive integrity failed.' };
      return result;
    }
    const entries = await inventory(input, target, new AbortController().signal);
    const registered = registration(input, target, entries),
      entry = nativeEntry(input, target, entries);
    result.installed = entry?.version === state.currentVersion;
    result.enabled = entry?.enabled ?? false;
    if (state.installedPath) result.nativeCachePath = state.installedPath;
    if (state.nativeVersion) result.nativeVersion = state.nativeVersion;
    if (!registered || !result.installed) {
      result.mcp = { configuration: 'missing', startup: 'not_checked' };
      try {
        observeNativePlugins(
          result,
          input,
          target,
          await inventory(input, target, new AbortController().signal, undefined, true),
        );
      } catch {
        result.diagnostics.nativeInventory = 'unavailable';
        result.diagnostics.findings.push('native_inventory_unavailable');
      }
      return result;
    }
    result.activation.installedVersion = state.currentVersion;
    try {
      result.nativePluginRoot = selectedRoot(input, target, entry!, state.installedPath);
      result.sourceIntegrity = true;
      result.skills = readdirSync(join(result.nativePluginRoot, 'skills')).sort();
      result.mcp = entry!.enabled
        ? await startup(result.nativePluginRoot, state.currentVersion, target.projectRoot)
        : { configuration: 'disabled', startup: 'not_checked' };
    } catch (error) {
      result.sourceIntegrity = false;
      result.mcp = {
        configuration: 'unverified',
        startup: 'not_checked',
        error: input.checkAuth
          ? 'Selected native plugin integrity failed; raw output withheld.'
          : (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      };
    }
    observeNativePlugins(result, input, target, entries, entry!.registration);
    if (input.host === 'codex') {
      try {
        const global = await inventory(input, target, new AbortController().signal, undefined, true);
        const selectedIds = new Set(
          entries.flatMap((entry) => (typeof entry.pluginId === 'string' ? [entry.pluginId] : [])),
        );
        observeNativePlugins(
          result,
          input,
          target,
          global.filter((entry) => typeof entry.pluginId !== 'string' || !selectedIds.has(entry.pluginId)),
        );
      } catch {
        result.diagnostics.nativeInventory = 'unavailable';
        result.diagnostics.findings.push('native_inventory_unavailable');
      }
    }
    if (result.mcp?.startup === 'ready') result.activation.startupVersion = result.mcp.version ?? null;
    if (result.authProbe && result.sourceIntegrity && result.enabled && result.mcp?.startup === 'ready') {
      delete result.authProbe.reason;
      await checkAuthentication(input, result.nativePluginRoot!, result.authProbe);
    }
    return result;
  }
  if (!state && input.action === 'remove') return result;
  if (!state && existsSync(target.directory) && readdirSync(target.directory).length > 0)
    throw new Error('Managed plugin directory contains unrecognized content.');
  ensurePrivateDirectoryDurably(target.directory);
  return withLock(target.statePath, {
    projectRoot: target.directory,
    timeout: 200,
    onReleaseError: (error) => {
      throw error;
    },
    operation: async () => {
      state = readState(input, target);
      if (input.action === 'rollback') {
        if (!state?.currentVersion)
          throw new Error(
            'Preserving rollback requires a current managed selection; it cannot reinstall a removed plugin.',
          );
        if (state.previousVersion !== result.version)
          throw new Error('Managed rollback target changed before acquiring its ownership lock.');
      }
      let expectedState = existsSync(target.statePath)
        ? { bytes: readFileSync(target.statePath), metadata: lstatSync(target.statePath) }
        : undefined;
      // Guard the cooperative owned record; this is not a native-settings CAS.
      const persist = () => {
        assertCanonical(target.statePath);
        if (expectedState) {
          readState(input, target);
          const current = lstatSync(target.statePath);
          if (
            current.dev !== expectedState.metadata.dev ||
            current.ino !== expectedState.metadata.ino ||
            (current.mode & 0o777) !== 0o600 ||
            current.mode !== expectedState.metadata.mode ||
            !readFileSync(target.statePath).equals(expectedState.bytes)
          )
            throw new Error('Managed state changed during this operation.');
        } else if (existsSync(target.statePath)) {
          throw new Error('Managed state appeared during this operation.');
        }
        writePrivateJsonFileAtomically(target.statePath, state);
        expectedState = { bytes: readFileSync(target.statePath), metadata: lstatSync(target.statePath) };
      };
      const resuming = state?.pending !== undefined;
      if (state?.pending) {
        await recover(state.pending);
        if (
          state.pending.producerDigest !==
          retainedWorktreeTransitionProducerDigest(dirname(fileURLToPath(import.meta.url)))
        )
          throw new Error(
            'Interrupted plugin operation belongs to a different controller; resume with its original version.',
          );
        const allocation = state.pending.staging;
        if (allocation && existsSync(allocation.path)) {
          const parent = dirname(unitDirectory(target, state.pending.targetVersion!));
          if (
            dirname(allocation.path) !== parent ||
            !/^\.stage-[a-f0-9-]{36}$/u.test(allocation.path.slice(parent.length + 1))
          )
            throw new Error('Recorded staging path is outside this version target.');
          assertCanonical(allocation.path);
          const current = lstatSync(allocation.path);
          if (
            !current.isDirectory() ||
            (allocation.device === undefined
              ? readdirSync(allocation.path).length !== 0
              : current.dev !== allocation.device || current.ino !== allocation.inode)
          )
            throw new Error('Interrupted staging directory ownership is unresolved.');
          rmSync(allocation.path, { recursive: true });
          sync(parent);
        }
        if (state.pending.action !== input.action || state.pending.targetVersion !== result.version)
          throw new Error('Resume the interrupted original plugin command before selecting a different operation.');
      }
      if (input.action === 'update' && !state?.currentVersion)
        throw new Error('Install a managed plugin before updating or rolling it back.');
      const version = input.action === 'remove' ? null : result.version;
      if (version === null && input.action !== 'remove')
        throw new Error('No previous managed plugin version is available.');
      const prior = state?.currentVersion ?? null;
      state ??= {
        owner: '@aviaratech/ai-delivery.plugin@1',
        host: input.host,
        scope: input.scope,
        projectRoot: input.scope === 'user' ? null : target.projectRoot,
        nativeHome: target.nativeHome,
        marketplace: target.marketplace,
        currentVersion: null,
        previousVersion: null,
        installedPath: null,
      };
      const birth = identity(process.pid);
      if (!birth) throw new Error('Installer owner identity is unknown.');
      state.pending = {
        action: input.action,
        targetVersion: version,
        owner: { pid: process.pid, birth },
        producerDigest: retainedWorktreeTransitionProducerDigest(dirname(fileURLToPath(import.meta.url))),
        command: { phase: 'idle' },
      };
      persist();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      const publish = (command: z.infer<typeof Pending>['command']) => {
        state!.pending!.command = command;
        persist();
      };
      const native = (args: string[]) => command(target.tool, args, target.projectRoot, controller.signal, publish);
      const selector = `ai-delivery@${target.marketplace}`;
      const nativeTarget =
        input.host === 'codex'
          ? ({ host: input.host, scope: 'user', pluginId: selector } as const)
          : { host: input.host, scope: input.scope, pluginId: selector };
      const removeArgs = nativePluginArgs({ ...nativeTarget, action: 'remove' });
      const installArgs = nativePluginArgs({ ...nativeTarget, action: prior ? 'update' : 'install' });
      let selectionStarted = false;
      try {
        state.nativeVersion = (await native(['--version'])).trim();
        if (prior && version) {
          if (input.host === 'claude-code') {
            // Qualified against this native binary in an isolated USER profile,
            // including unknown settings, unrelated selections and a catalog path change.
            const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
            if (
              state.nativeVersion !== '2.1.296 (Claude Code)' ||
              input.scope !== 'user' ||
              !stable.test(prior) ||
              !stable.test(version) ||
              (version
                .split('.')
                .map(BigInt)
                .map((part, index) => part - BigInt(prior.split('.')[index]!))
                .find((part) => part !== 0n) ?? 0n) < 0n
            )
              throw new Error(
                'Claude preserving replacement is unqualified; no catalog or native selection was changed.',
              );
          }
          // Only this pinned native source has a qualified preserving-add footprint.
          // This does not establish exclusion of concurrent, unrelated native writers.
          if (input.host === 'codex' && state.nativeVersion !== 'codex-cli 0.162.1')
            throw new Error('This native version has no qualified preserving replacement route.');
        }
        if (input.host === 'claude-code' && !(await native(['plugin', 'uninstall', '--help'])).includes('--keep-data'))
          throw new Error('This Claude Code version cannot preserve plugin data; upgrade the native tool first.');
        process.stderr.write(
          `ai-delivery.plugin ${JSON.stringify({ action: input.action, host: input.host, scope: input.scope, stage: version ? 'prepare_version' : 'native_remove', version })}\n`,
        );
        const before = await inventory(input, target, controller.signal, publish);
        const registered = registration(input, target, before),
          current = nativeEntry(input, target, before);
        if (current && !prior && !(resuming && current.version === version))
          throw new Error('Existing native plugin is not owned by managed state.');
        let recoverySourceVersion = current?.version;
        if (current && resuming && input.host === 'claude-code') {
          recoverySourceVersion = claudeCatalogSelection(target).version;
          if (recoverySourceVersion !== prior && recoverySourceVersion !== version)
            throw new Error('Interrupted native selection has an incompatible catalog version.');
        }
        if (current && version && !current.enabled)
          throw new Error('Native plugin selection is disabled; preserving replacement cannot enable it.');
        let catalogBefore: CatalogSnapshot | undefined;
        let reuseSelection = false;
        if (prior && version) {
          if (!registered || !current || (current.version !== prior && !(resuming && current.version === version)))
            throw new Error('Managed native selection changed; replacement ownership is unresolved.');
          catalogBefore = readCatalog(target, prior);
          const priorMatches = catalogMatches(catalogBefore, target, prior);
          const targetMatches = catalogMatches(catalogBefore, target, version);
          const priorCatalog = priorMatches.every(Boolean),
            targetCatalog = targetMatches.every(Boolean);
          const partialCatalog = resuming && targetMatches[0] && priorMatches[1];
          if (!priorCatalog && !targetCatalog && !partialCatalog)
            throw new Error('Managed catalog differs from the owned prior or target publication.');
          // The installed cache and the host-specific catalog source are separate observations.
          recoverySourceVersion = targetMatches[input.host === 'codex' ? 0 : 1] ? version : prior;
          if (current.version === version) {
            if (!targetCatalog) throw new Error('Selected target has an incompatible managed catalog.');
            reuseSelection = true;
          } else if (targetCatalog) {
            throw new Error('Interrupted replacement is ambiguous; native selection will not be repeated.');
          }
        } else if (version && current && resuming) {
          catalogBefore = readCatalog(target, version);
          if (!catalogMatches(catalogBefore, target, version).every(Boolean))
            throw new Error('Selected target has an incompatible managed catalog.');
          reuseSelection = current.version === version;
        }
        let observedRoot: string | undefined;
        if (current)
          observedRoot = selectedRoot(
            input,
            target,
            current,
            current.installedPath ??
              (current.version === prior
                ? state.installedPath
                : join(target.nativeHome, 'plugins/cache', target.marketplace, 'ai-delivery', current.version)),
            recoverySourceVersion,
          );
        if (version) {
          await stageVersion(target, version, controller.signal, publish, (allocation) => {
            if (allocation) state!.pending!.staging = allocation;
            else delete state!.pending!.staging;
            persist();
          });
          if (!reuseSelection) {
            selectionStarted = true;
            catalog(target, version, catalogBefore);
          }
          if (!registered && !reuseSelection)
            await native([
              'plugin',
              'marketplace',
              'add',
              target.catalog,
              ...(input.host === 'codex' ? ['--json'] : ['--scope', input.scope]),
            ]);
        }
        if (current && input.action === 'remove') {
          selectionStarted = true;
          await native(removeArgs);
        }
        let installedPath = reuseSelection
          ? (current?.installedPath ?? observedRoot ?? state.installedPath)
          : state.installedPath;
        if (version && !reuseSelection) {
          const installed = await native(installArgs);
          if (input.host === 'codex')
            installedPath = z.object({ installedPath: z.string() }).parse(JSON.parse(installed)).installedPath;
        }
        const after = await inventory(input, target, controller.signal, publish);
        if (!registration(input, target, after) && version)
          throw new Error('Native marketplace registration is missing.');
        const readback = nativeEntry(input, target, after);
        if (version ? readback?.version !== version : readback !== undefined)
          throw new Error('Native installation readback does not match the selected version.');
        if (version) {
          selectedRoot(input, target, readback!, readback?.installedPath ?? installedPath);
          if (!readback!.enabled) throw new Error('Native plugin selection is disabled.');
        }
        state.currentVersion = version;
        if (prior !== version) state.previousVersion = prior;
        state.installedPath = version ? (readback?.installedPath ?? installedPath) : null;
        delete state.pending;
        persist();
        result.version = version;
        result.changed = prior !== version;
        result.installed = version !== null;
        result.activation = { installedVersion: version, startupVersion: null, loadedVersion: null };
        if (version) result.nativePluginRoot = state.installedPath ?? pluginRoot(target, version);
        return result;
      } catch (error) {
        if (
          !resuming &&
          !controller.signal.aborted &&
          !selectionStarted &&
          state.pending?.command.phase === 'idle' &&
          state.pending.staging === undefined
        ) {
          delete state.pending;
          try {
            persist();
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              'Plugin preparation failed and pending-state cleanup also failed.',
            );
          }
        }
        // A failed acknowledgement may follow a successful selection. Retain the
        // catalog and pending intent for exact postimage reconciliation, not rollback.
        throw error;
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
    },
  });
}
