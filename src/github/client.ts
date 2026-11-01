import { createAppAuth } from '@octokit/auth-app';
import { graphql } from '@octokit/graphql';
import type { graphql as GraphQLType } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { homedir } from 'node:os';
import { types } from 'node:util';

import type { DeliveryConfig, DeliveryRole, LoadedDeliverySettings } from '../config/deliveryConfig.js';

import {
  appCredentialSource,
  privateKeyVariable,
  resolveDeliveryRoleCredentials,
  type ConfiguredApp,
} from '../config/deliveryConfig.js';
import { runStageCommand } from '../verification.js';
import {
  DeliveryError,
  setMachineRequestDiagnostics,
  getRateLimitDiagnostics,
  type RateLimitDiagnostics,
  type SafeMachineRequestDiagnostics,
} from '../errors.js';
import {
  assertSupportedAuthorHost,
  machineAuthorEligible,
  withMachineAuthorCredential,
  MACHINE_AUTH_ENV_NAMES,
} from './machineAuth.js';

export interface GitHubClients {
  authSource: 'app' | 'personal';
  credentialSource?: string;
  effectiveContentsPermission?: DeliveryPermission | 'admin';
  role: DeliveryRole;
  appActorLogin?: (signal?: AbortSignal) => Promise<string>;
  authenticatedAuthor?: (signal?: AbortSignal) => Promise<{ actorLogin: string; credentialIdentity: string }>;
  graphql: typeof GraphQLType;
  rest: Octokit;
  /** Last positively identified request limit; retained across legacy helper error wrapping. */
  rateLimitObservation?: () => RateLimitDiagnostics | undefined;
}

const authorGitTokens = new WeakMap<GitHubClients, string>();
const machineClients = new WeakSet<GitHubClients>();
const machineProtectionAbsence = new WeakMap<
  DeliveryError,
  { clients: GitHubClients; owner: string; repo: string; branch: string }
>();
interface MachineSelection {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal | undefined;
  selectors: string;
}
const machineAuthorSelections = new WeakMap<GitHubClients, MachineSelection>();
const resolvedMachineAuthors = new WeakMap<DeliveryConfig['roles'], MachineSelection & { clients: GitHubClients }>();

/** Keep repository discovery and command execution on one resolved account. */
export function retainMachineAuthorForConfiguration(
  config: Pick<DeliveryConfig, 'roles'>,
  clients: GitHubClients,
  signal?: AbortSignal,
): void {
  const selection = machineAuthorSelections.get(clients);
  if (selection !== undefined) {
    if (selection.signal !== signal)
      throw new DeliveryError('Machine GitHub session command context changed; resolve the command again.');
    resolvedMachineAuthors.set(config.roles, { clients, ...selection });
  }
}

function sessionSelectors(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(MACHINE_AUTH_ENV_NAMES.map((name) => [name, env[name]]));
}

/** Pass the selected author token only to the operation that needs Git HTTP auth. */
export async function withAuthorGitToken<T>(
  clients: GitHubClients,
  callback: (token: string) => Promise<T> | T,
): Promise<T> {
  const token = clients.role === 'author' ? authorGitTokens.get(clients) : undefined;
  if (!token) throw new DeliveryError('Git push requires the selected author credential token.');
  return callback(token);
}

export type DeliveryPermission = 'read' | 'write';

export function assertDeliveryRolePermissions(input: {
  additional?: Readonly<Record<string, DeliveryPermission>>;
  permissions: unknown;
  role: DeliveryRole;
}): void {
  if (typeof input.permissions !== 'object' || input.permissions === null || Array.isArray(input.permissions)) {
    throw new DeliveryError(`GitHub App ${input.role} role did not return installation permissions.`);
  }
  const permissions = input.permissions as Record<string, unknown>;
  const required =
    input.role === 'author'
      ? { contents: 'write', issues: 'write', organization_projects: 'write', pull_requests: 'write' }
      : { contents: 'read', pull_requests: 'write' };
  for (const [name, level] of [...Object.entries(required), ...Object.entries(input.additional ?? {})]) {
    const actual = permissions[name];
    if (actual !== 'admin' && actual !== 'write' && (level === 'write' || actual !== 'read')) {
      throw new DeliveryError(`GitHub App ${input.role} role lacks required ${name}:${level} permission.`);
    }
  }
}

/** The author role may use a personal token only after an explicit operator opt-in. */
export async function createDeliveryGitHubClients(input: {
  config: Pick<DeliveryConfig, 'roles'> & Pick<LoadedDeliverySettings, 'credentialKeyReferences'>;
  env?: NodeJS.ProcessEnv;
  identity: string;
  personalAuth?: { enabled: true; token?: string };
  selectedAuthor?: GitHubClients;
  additionalPermissions?: Readonly<Record<string, DeliveryPermission>>;
  role: DeliveryRole;
  signal?: AbortSignal;
}): Promise<GitHubClients> {
  input.signal?.throwIfAborted();
  const env = input.env ?? process.env;
  const selected = input.config.roles[input.role];
  const retained = input.role === 'author' ? resolvedMachineAuthors.get(input.config.roles) : undefined;
  if (retained !== undefined) {
    // A command that discovered its repository as account A must not acquire
    // a newly supplied token/profile and then operate as account B.
    if (
      selected.authSource !== 'personal' ||
      input.identity.trim().toLowerCase() !== selected.identity.toLowerCase() ||
      !machineAuthorEligible(selected.credentialEnv.token, env) ||
      retained.env !== env ||
      retained.signal !== input.signal ||
      retained.selectors !== sessionSelectors(env)
    )
      throw new DeliveryError(
        'Machine GitHub session environment changed after repository selection; resolve the command again.',
      );
    assertSupportedAuthorHost(env);
    return retained.clients;
  }
  if (selected.authSource === 'personal') {
    if (input.role !== 'author' || input.identity.trim().toLowerCase() !== selected.identity.toLowerCase()) {
      throw new DeliveryError('Personal author operation requires the configured author identity.');
    }
    assertSupportedAuthorHost(env);
    if (machineAuthorEligible(selected.credentialEnv.token, env)) {
      const selection: MachineSelection = { env, signal: input.signal, selectors: sessionSelectors(env) };
      return withMachineAuthorCredential(env, input.signal, async (token, session) => {
        const clients = personalClients(token, `gh:github.com:${session.executable}`, input.signal, session.login);
        await clients.authenticatedAuthor!(input.signal);
        machineAuthorSelections.set(clients, selection);
        return clients;
      });
    }
    const token = env[selected.credentialEnv.token]?.trim();
    if (!token) {
      throw new DeliveryError(`Missing personal author token in ${selected.credentialEnv.token}.`);
    }
    return personalClients(token, `env:${selected.credentialEnv.token}`, input.signal);
  }
  if (input.personalAuth !== undefined) {
    if (
      input.personalAuth.enabled !== true ||
      input.role !== 'author' ||
      input.identity.trim().toLowerCase() !== 'personal'
    ) {
      throw new DeliveryError('Personal-token auth requires the explicit personal author identity.');
    }
    assertSupportedAuthorHost(env);
    const token = (input.personalAuth.token ?? env.GH_TOKEN ?? env.GITHUB_TOKEN)?.trim();
    if (!token) throw new DeliveryError('Explicit personal-token auth requested but no token was supplied.');
    const source =
      input.personalAuth.token !== undefined
        ? 'explicit-personal-token'
        : env.GH_TOKEN !== undefined
          ? 'env:GH_TOKEN'
          : 'env:GITHUB_TOKEN';
    return personalClients(token, source, input.signal);
  }

  if (input.identity.trim().toLowerCase() !== selected.identity.toLowerCase()) {
    throw new DeliveryError(`GitHub ${input.role} operation requires the configured ${input.role} identity.`);
  }
  const credentials = resolveDeliveryRoleCredentials({ config: input.config, env, role: input.role });
  const otherRole: DeliveryRole = input.role === 'author' ? 'reviewer' : 'author';
  const personalAuthorSelected =
    input.role === 'reviewer' &&
    input.selectedAuthor?.role === 'author' &&
    input.selectedAuthor.authSource === 'personal';
  if (!personalAuthorSelected && input.config.roles[otherRole].authSource !== 'personal') {
    const otherRoleConfig = input.config.roles[otherRole];
    // Explicit profiles compare only other-role metadata. Doctor must not need
    // another identity's key reference or resolve its credential source.
    const other =
      credentials.profile === undefined
        ? resolveDeliveryRoleCredentials({ config: input.config, env, role: otherRole })
        : 'appId' in otherRoleConfig
          ? {
              appId: String(otherRoleConfig.appId),
              installationId: otherRoleConfig.installationId,
              privateKeyPath: undefined,
            }
          : {
              appId: env[otherRoleConfig.credentialEnv.appId]?.trim(),
              installationId: Number(env[otherRoleConfig.credentialEnv.installationId]),
              privateKeyPath: undefined,
            };
    if (
      credentials.appId === other.appId ||
      credentials.installationId === other.installationId ||
      (credentials.privateKeyPath !== undefined && credentials.privateKeyPath === other.privateKeyPath)
    ) {
      throw new DeliveryError('Author and reviewer must use distinct GitHub App credentials.');
    }
  }
  let privateKey: string;
  if (credentials.profile !== undefined) {
    privateKey = await selectedPrivateKey(credentials.profile, env, input.config, input.signal);
  } else {
    try {
      privateKey = readFileSync(credentials.privateKeyPath!, 'utf8');
    } catch {
      throw new DeliveryError(`GitHub App private key for ${input.role} role is unavailable.`);
    }
  }
  try {
    const auth = createAppAuth({
      appId: credentials.appId,
      privateKey,
      ...(input.signal === undefined ? {} : { request: new Octokit({ request: { signal: input.signal } }).request }),
    });
    const result = await auth({ installationId: credentials.installationId, type: 'installation' });
    if (typeof result.token !== 'string' || !result.token.startsWith('ghs_')) {
      throw new DeliveryError(`GitHub ${input.role} role did not receive an App installation token.`);
    }
    assertDeliveryRolePermissions({
      ...(input.additionalPermissions === undefined ? {} : { additional: input.additionalPermissions }),
      permissions: result.permissions,
      role: input.role,
    });
    const appActorLogin =
      input.role === 'reviewer'
        ? async (signal?: AbortSignal) => {
            const requestSignal = signal ?? input.signal;
            try {
              const app = await new Octokit({
                auth: (await auth({ type: 'app' })).token,
                ...(requestSignal === undefined ? {} : { request: { signal: requestSignal } }),
              }).rest.apps.getAuthenticated();
              if (!app.data || app.data.id !== Number(credentials.appId) || !app.data.slug) {
                throw new DeliveryError('Reviewer GitHub App identity did not match its configured App ID.');
              }
              const actor = `${app.data.slug}[bot]`;
              if (credentials.profile !== undefined && actor !== credentials.profile.actorLogin)
                throw new DeliveryError('Reviewer GitHub App actor did not match its configured actorLogin.');
              return actor;
            } catch (error) {
              if (error instanceof DeliveryError) throw error;
              throw new DeliveryError('Reviewer GitHub App actor lookup failed.');
            }
          }
        : undefined;
    const authenticatedAuthor =
      input.role === 'author'
        ? async (signal?: AbortSignal) => {
            const requestSignal = signal ?? input.signal;
            try {
              const app = await new Octokit({
                auth: (await auth({ type: 'app' })).token,
                ...(requestSignal === undefined ? {} : { request: { signal: requestSignal } }),
              }).rest.apps.getAuthenticated();
              if (!app.data || app.data.id !== Number(credentials.appId) || !app.data.slug) {
                throw new DeliveryError('Author GitHub App identity did not match its configured App ID.');
              }
              return {
                actorLogin: `${app.data.slug}[bot]`,
                credentialIdentity: `app:${String(app.data.id)}:installation:${credentials.installationId}`,
              };
            } catch (error) {
              if (error instanceof DeliveryError) throw error;
              throw new DeliveryError('Author GitHub App actor lookup failed.');
            }
          }
        : undefined;
    return buildClients(
      result.token,
      'app',
      input.role,
      `app:${credentials.appId}:installation:${credentials.installationId}`,
      appActorLogin,
      authenticatedAuthor,
      (result.permissions as Record<string, DeliveryPermission | 'admin'>).contents,
      input.signal,
    );
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(`GitHub App authentication failed for ${input.role} role.`);
  }
}

/** Selected-source output stays in memory; the existing runner owns command cleanup. */
async function selectedPrivateKey(
  profile: ConfiguredApp,
  env: NodeJS.ProcessEnv,
  config: Pick<DeliveryConfig, 'roles'> & Pick<LoadedDeliverySettings, 'credentialKeyReferences'>,
  signal?: AbortSignal,
): Promise<string> {
  const source = appCredentialSource(profile);
  const failure = (reason: string) =>
    new DeliveryError(`Reviewer ${profile.identity} credential source ${source.type}: ${reason}`);
  let bytes: Buffer;
  try {
    signal?.throwIfAborted();
    if (source.type === 'env') {
      const value = env[privateKeyVariable(profile)];
      if (!value) throw failure('selected variable is missing or empty; configure this identity.');
      if (Buffer.byteLength(value) > 64 * 1024) throw failure('response exceeds 64 KiB.');
      bytes = Buffer.from(value);
    } else if (source.type === 'file') {
      const fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== 1 ||
          (process.getuid !== undefined && stat.uid !== process.getuid())
        )
          throw failure('key file must be a regular, owned, single-link file with mode 0600.');
        const buffer = Buffer.alloc(64 * 1024 + 1);
        let size = 0;
        for (;;) {
          const read = readSync(fd, buffer, size, buffer.length - size, null);
          if (read === 0) break;
          size += read;
          if (size === buffer.length) throw failure('response exceeds 64 KiB.');
        }
        bytes = buffer.subarray(0, size);
      } finally {
        closeSync(fd);
      }
    } else {
      if (process.platform === 'win32')
        throw failure('command sources currently require a POSIX process supervisor; use env on Windows.');
      const commandEnv: NodeJS.ProcessEnv = {};
      const forbidden = new Set([
        ...(config.credentialKeyReferences ?? []),
        ...Object.values(config.roles).flatMap((role) =>
          'credentialEnv' in role
            ? Object.values(role.credentialEnv)
            : appCredentialSource(role).type === 'env'
              ? [privateKeyVariable(role)]
              : [],
        ),
      ]);
      for (const name of [
        'HOME',
        'USER',
        'LOGNAME',
        'PATH',
        'LANG',
        'LC_ALL',
        'TMPDIR',
        'TEMP',
        'TMP',
        'SystemRoot',
        'USERPROFILE',
        'APPDATA',
        'LOCALAPPDATA',
      ]) {
        if (forbidden.has(name)) throw failure('credential reference conflicts with an implicit OS selector.');
        if (env[name] !== undefined) commandEnv[name] = env[name];
      }
      for (const name of source.env ?? []) {
        if (
          forbidden.has(name) ||
          /^(?:NODE_|NPM_|DYLD_|LD_|BASH_|GIT_|GH_PRIVATE_KEY)/u.test(name) ||
          ['ENV', 'SHELLOPTS', 'CDPATH'].includes(name)
        )
          throw failure('helper environment reference conflicts with author/key or execution selectors.');
        if (env[name] === undefined) throw failure('a configured helper environment reference is missing.');
        commandEnv[name] = env[name];
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 30_000);
      let cleanupFailed = false;
      try {
        bytes = await runStageCommand(
          env.HOME ?? homedir(),
          source.argv,
          signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]),
          undefined,
          undefined,
          {
            environment: commandEnv,
            cwd: env.HOME ?? homedir(),
            maxCapturedOutputBytes: 64 * 1024,
            stdoutOnly: true,
            failedOutput: () => '',
            onCleanupFailure: () => {
              cleanupFailed = true;
            },
          },
        );
      } catch {
        throw failure(
          cleanupFailed
            ? 'helper failed and owned process cleanup is unverified; reconcile before retrying.'
            : timeout.signal.aborted
              ? 'helper response timed out; verify the selected command.'
              : signal?.aborted
                ? 'helper request cancelled.'
                : 'helper failed; verify its executable, access and bounded output.',
        );
      } finally {
        clearTimeout(timer);
      }
    }
    if (bytes.length === 0 || bytes.length > 64 * 1024) throw failure('response is empty or exceeds 64 KiB.');
    let pem = bytes.toString('utf8');
    if (!Buffer.from(pem).equals(bytes)) throw failure('response must be valid UTF-8.');
    if (source.type !== 'file' && source.encoding === 'base64') {
      const encoded = pem.trim();
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))
        throw failure('response must be canonical base64.');
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded) throw failure('response must be canonical base64.');
      pem = decoded.toString('utf8');
      if (!Buffer.from(pem).equals(decoded)) throw failure('decoded response must be UTF-8 PEM.');
    }
    if (
      !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END (?:RSA )?PRIVATE KEY-----\s*$/u.test(pem) ||
      createPrivateKey(pem).asymmetricKeyType !== 'rsa'
    )
      throw failure('response must be an unencrypted RSA private key in PEM format.');
    signal?.throwIfAborted();
    return pem;
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw failure('selected key is unavailable or malformed; verify this source.');
  }
}

function personalClients(
  token: string,
  credentialSource: string,
  signal?: AbortSignal,
  machineLogin?: string,
): GitHubClients {
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(token))
    throw new DeliveryError('Selected personal author token is malformed; verify the explicit credential.');
  if (machineLogin !== undefined && (credentialSource.includes(token) || machineLogin.includes(token)))
    throw new DeliveryError('Machine GitHub session readback is unsafe.');
  return buildClients(
    token,
    'personal',
    'author',
    credentialSource,
    undefined,
    async (requestSignal?: AbortSignal) => {
      const selectedSignal = requestSignal ?? signal;
      try {
        const user = (
          await new Octokit({
            auth: token,
            ...(machineLogin === undefined ? {} : { log: { debug() {}, info() {}, warn() {}, error() {} } }),
            ...(selectedSignal === undefined ? {} : { request: { signal: selectedSignal } }),
          }).rest.users.getAuthenticated()
        ).data;
        if (!Number.isSafeInteger(user.id) || user.id <= 0 || !user.login) {
          throw new DeliveryError('Personal author identity readback is incomplete.');
        }
        if (
          machineLogin !== undefined &&
          (user.type !== 'User' ||
            user.login.toLowerCase() !== machineLogin.toLowerCase() ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(user.login) ||
            user.login.includes(token))
        )
          throw new DeliveryError('Machine GitHub session identity does not match the selected active account.');
        return { actorLogin: user.login, credentialIdentity: `user:${String(user.id)}` };
      } catch (error) {
        if (error instanceof DeliveryError) throw error;
        if ((error as { status?: number }).status === 401) {
          throw new DeliveryError(
            machineLogin === undefined
              ? 'Configured personal author token is invalid or expired; refresh the selected token.'
              : 'Machine GitHub session is invalid or expired; verify the selected github.com account.',
          );
        }
        throw new DeliveryError('Personal author identity readback failed.');
      }
    },
    undefined,
    signal,
    machineLogin !== undefined,
  );
}

function buildClients(
  token: string,
  authSource: GitHubClients['authSource'],
  role: DeliveryRole,
  credentialSource: string,
  appActorLogin?: GitHubClients['appActorLogin'],
  authenticatedAuthor?: GitHubClients['authenticatedAuthor'],
  effectiveContentsPermission?: GitHubClients['effectiveContentsPermission'],
  signal?: AbortSignal,
  machineSession = false,
): GitHubClients {
  const rest = new Octokit({
    auth: token,
    ...(machineSession ? { log: { debug() {}, info() {}, warn() {}, error() {} } } : {}),
    ...(signal === undefined ? {} : { request: { signal } }),
  });
  const rawGraphql = graphql.defaults({
    headers: { authorization: `token ${token}` },
    ...(signal === undefined ? {} : { request: { signal } }),
  });
  let observedRateLimit: RateLimitDiagnostics | undefined;
  const observeRateLimit = (error: unknown, graphqlFailure = false) => {
    observedRateLimit = getRateLimitDiagnostics(error, graphqlFailure) ?? observedRateLimit;
  };
  rest.hook.error('request', (error) => {
    observeRateLimit(error);
    throw error;
  });
  if (machineSession)
    rest.hook.error('request', (error, options) => {
      const safe = safeMachineRequestError(error, 'rest.request', restMachineEndpoint(options));
      const target = branchProtectionTarget(options);
      const responseTarget = branchProtectionTarget({ method: 'GET', url: ownData(ownData(error, 'response'), 'url') });
      if (
        target &&
        responseTarget &&
        target.owner.toLowerCase() === responseTarget.owner.toLowerCase() &&
        target.repo.toLowerCase() === responseTarget.repo.toLowerCase() &&
        target.branch === responseTarget.branch &&
        exactBranchProtectionAbsence(error)
      )
        machineProtectionAbsence.set(safe, { clients, ...target });
      throw safe;
    });
  const clients: GitHubClients = {
    authSource,
    credentialSource,
    ...(effectiveContentsPermission ? { effectiveContentsPermission } : {}),
    role,
    ...(appActorLogin ? { appActorLogin } : {}),
    ...(authenticatedAuthor ? { authenticatedAuthor } : {}),
    graphql: new Proxy(rawGraphql, {
      apply(target, receiver, args: unknown[]) {
        return (Reflect.apply(target, receiver, args) as Promise<unknown>).catch((error: unknown) => {
          observeRateLimit(error, true);
          throw machineSession ? safeMachineRequestError(error, 'graphql.request', 'graphql') : error;
        });
      },
    }),
    rest,
    rateLimitObservation: () => observedRateLimit,
  };
  if (machineSession) machineClients.add(clients);
  if (role === 'author') authorGitTokens.set(clients, token);
  return clients;
}

function ownData(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null || types.isProxy(value) || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function exactBranchProtectionAbsence(error: unknown): boolean {
  const response = ownData(error, 'response');
  return (
    ownData(error, 'status') === 404 &&
    ownData(response, 'status') === 404 &&
    ownData(ownData(response, 'data'), 'message') === 'Branch not protected'
  );
}

function branchProtectionTarget(options: unknown): { owner: string; repo: string; branch: string } | undefined {
  const url = ownData(options, 'url');
  if (ownData(options, 'method') !== 'GET' || typeof url !== 'string' || url.length > 1024 || /[^\x21-\x7e]/u.test(url))
    return undefined;
  let path: string;
  if (url.startsWith('/')) {
    if (ownData(options, 'baseUrl') !== 'https://api.github.com' || /[?#]/u.test(url)) return undefined;
    path = url;
  } else {
    try {
      const parsed = new URL(url);
      if (
        parsed.origin !== 'https://api.github.com' ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        return undefined;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  let owner: unknown, repo: unknown, branch: unknown;
  if (path === '/repos/{owner}/{repo}/branches/{branch}/protection') {
    owner = ownData(options, 'owner');
    repo = ownData(options, 'repo');
    branch = ownData(options, 'branch');
  } else {
    const match = /^\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)\/protection$/u.exec(path);
    if (!match) return undefined;
    try {
      [owner, repo, branch] = match.slice(1).map((part) => decodeURIComponent(part));
    } catch {
      return undefined;
    }
  }
  if (
    typeof owner !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/u.test(owner) ||
    typeof repo !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(repo) ||
    typeof branch !== 'string' ||
    !branch.length ||
    branch.length > 1024 ||
    /[^\x21-\x7e]/u.test(branch)
  )
    return undefined;
  return { owner, repo, branch };
}

/** Internal read-only predicate: machine absence never comes from copied error fields. */
export function hasBranchProtectionAbsence(
  error: unknown,
  clients: GitHubClients,
  repository: { owner: string; repo: string },
  branch: string,
): boolean {
  if (!machineClients.has(clients)) return exactBranchProtectionAbsence(error);
  if (typeof error !== 'object' || error === null || types.isProxy(error)) return false;
  const target = machineProtectionAbsence.get(error as DeliveryError);
  return (
    target?.clients === clients &&
    target.owner.toLowerCase() === repository.owner.toLowerCase() &&
    target.repo.toLowerCase() === repository.repo.toLowerCase() &&
    target.branch === branch
  );
}

function restMachineEndpoint(options: unknown): SafeMachineRequestDiagnostics['endpoint'] {
  const method = ownData(options, 'method'),
    url = ownData(options, 'url');
  if (typeof method !== 'string' || typeof url !== 'string' || url.length > 1024 || /[^\x21-\x7e]/u.test(url))
    return 'UNKNOWN';
  let path: string;
  if (url.startsWith('/')) {
    const base = ownData(options, 'baseUrl');
    if (base !== 'https://api.github.com') return 'UNKNOWN';
    path = url.split(/[?#]/u)[0]!;
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://api.github.com' || parsed.username || parsed.password) return 'UNKNOWN';
      path = parsed.pathname;
    } catch {
      return 'UNKNOWN';
    }
  }
  const prefix = '/repos/[^/]{1,100}/[^/]{1,100}';
  const number = '(?:[0-9]{1,20}|\\{pull_number\\})';
  const routes: readonly [string, RegExp, SafeMachineRequestDiagnostics['endpoint']][] = [
    ['PUT', new RegExp(`^${prefix}/pulls/${number}/merge$`, 'u'), 'pulls.merge'],
    ['GET', new RegExp(`^${prefix}/pulls/${number}$`, 'u'), 'pulls.get'],
    ['GET', new RegExp(`^${prefix}/pulls/${number}/reviews$`, 'u'), 'pulls.listReviews'],
    ['GET', new RegExp(`^${prefix}/pulls/${number}/reviews/(?:[0-9]{1,20}|\\{review_id\\})$`, 'u'), 'pulls.getReview'],
    ['GET', new RegExp(`^${prefix}/git/commits/[^/]{1,100}$`, 'u'), 'git.getCommit'],
    ['GET', new RegExp(`^${prefix}/git/ref/.{1,300}$`, 'u'), 'git.getRef'],
    ['GET', new RegExp(`^${prefix}/issues/(?:[0-9]{1,20}|\\{issue_number\\})$`, 'u'), 'issues.get'],
    ['PATCH', new RegExp(`^${prefix}/issues/(?:[0-9]{1,20}|\\{issue_number\\})$`, 'u'), 'issues.update'],
  ];
  return routes.find(([verb, pattern]) => verb === method && pattern.test(path))?.[2] ?? 'UNKNOWN';
}

function safeMachineRequestError(
  error: unknown,
  phase: 'rest.request' | 'graphql.request',
  endpoint: SafeMachineRequestDiagnostics['endpoint'],
): DeliveryError {
  const status = ownData(error, 'status');
  const safe = new DeliveryError(
    status === 401
      ? 'Machine GitHub session is invalid or expired; verify the selected github.com account.'
      : status === 403 || status === 404
        ? 'Machine GitHub session cannot access the selected repository or operation; verify its existing permissions.'
        : 'Machine GitHub request failed; verify the selected account and repository access.',
  );
  if (typeof status === 'number' && Number.isSafeInteger(status) && status >= 400 && status <= 599)
    Object.assign(safe, { status });
  const headers = ownData(error, 'headers') ?? ownData(ownData(error, 'response'), 'headers');
  setMachineRequestDiagnostics(safe, {
    phase,
    endpoint,
    status,
    code: ownData(error, 'code'),
    requestId: ownData(headers, 'x-github-request-id'),
    retryAfter: ownData(headers, 'retry-after'),
    resetAt: ownData(headers, 'x-ratelimit-reset'),
    remaining: ownData(headers, 'x-ratelimit-remaining'),
  });
  return safe;
}
