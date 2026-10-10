import { createAppAuth } from '@octokit/auth-app';
import { graphql } from '@octokit/graphql';
import type { graphql as GraphQLType } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'node:fs';

import type { DeliveryConfig, DeliveryRole } from '../config/deliveryConfig.js';

import { resolveDeliveryRoleCredentials } from '../config/deliveryConfig.js';
import { DeliveryError } from '../errors.js';
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
}

const authorGitTokens = new WeakMap<GitHubClients, string>();
const resolvedMachineAuthors = new WeakMap<
  DeliveryConfig['roles'],
  {
    clients: GitHubClients;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal | undefined;
    selectors: string;
  }
>();

/** Keep repository discovery and command execution on one resolved account. */
export function retainMachineAuthorForConfiguration(
  config: Pick<DeliveryConfig, 'roles'>,
  clients: GitHubClients,
  signal?: AbortSignal,
): void {
  if (clients.role === 'author' && clients.credentialSource?.startsWith('gh:github.com:'))
    resolvedMachineAuthors.set(config.roles, {
      clients,
      env: process.env,
      signal,
      selectors: sessionSelectors(process.env),
    });
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
  config: Pick<DeliveryConfig, 'roles'>;
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
  if (selected.authSource === 'personal') {
    if (input.role !== 'author' || input.identity.trim().toLowerCase() !== selected.identity.toLowerCase()) {
      throw new DeliveryError('Personal author operation requires the configured author identity.');
    }
    assertSupportedAuthorHost(env);
    if (machineAuthorEligible(selected.credentialEnv.token, env)) {
      const retained = resolvedMachineAuthors.get(input.config.roles);
      if (retained?.env === env && retained.signal === input.signal) {
        if (retained.selectors !== sessionSelectors(env))
          throw new DeliveryError(
            'Machine GitHub session environment changed after repository selection; resolve the command again.',
          );
        return retained.clients;
      }
      return withMachineAuthorCredential(env, input.signal, async (token, session) => {
        const clients = personalClients(token, `gh:github.com:${session.executable}`, input.signal, session.login);
        await clients.authenticatedAuthor!(input.signal);
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
    const other = resolveDeliveryRoleCredentials({ config: input.config, env, role: otherRole });
    if (
      credentials.appId === other.appId ||
      credentials.installationId === other.installationId ||
      credentials.privateKeyPath === other.privateKeyPath
    ) {
      throw new DeliveryError('Author and reviewer must use distinct GitHub App credentials.');
    }
  }
  let privateKey: string;
  try {
    privateKey = readFileSync(credentials.privateKeyPath, 'utf8');
  } catch {
    throw new DeliveryError(`GitHub App private key for ${input.role} role is unavailable.`);
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
              return `${app.data.slug}[bot]`;
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
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(`GitHub App authentication failed for ${input.role} role.`);
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
  if (machineSession)
    rest.hook.error('request', (error) => {
      throw safeMachineRequestError(error);
    });
  const clients: GitHubClients = {
    authSource,
    credentialSource,
    ...(effectiveContentsPermission ? { effectiveContentsPermission } : {}),
    role,
    ...(appActorLogin ? { appActorLogin } : {}),
    ...(authenticatedAuthor ? { authenticatedAuthor } : {}),
    graphql: machineSession
      ? new Proxy(rawGraphql, {
          apply(target, receiver, args: unknown[]) {
            return (Reflect.apply(target, receiver, args) as Promise<unknown>).catch((error: unknown) => {
              throw safeMachineRequestError(error);
            });
          },
        })
      : rawGraphql,
    rest,
  };
  if (role === 'author') authorGitTokens.set(clients, token);
  return clients;
}

function safeMachineRequestError(error: unknown): DeliveryError {
  const status = (error as { status?: unknown } | null)?.status;
  const safe = new DeliveryError(
    status === 401
      ? 'Machine GitHub session is invalid or expired; verify the selected github.com account.'
      : status === 403 || status === 404
        ? 'Machine GitHub session cannot access the selected repository or operation; verify its existing permissions.'
        : 'Machine GitHub request failed; verify the selected account and repository access.',
  );
  if (typeof status === 'number' && Number.isSafeInteger(status) && status >= 400 && status <= 599)
    Object.assign(safe, { status });
  return safe;
}
