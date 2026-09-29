import { createAppAuth } from '@octokit/auth-app';
import { graphql } from '@octokit/graphql';
import type { graphql as GraphQLType } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'node:fs';

import type { DeliveryConfig, DeliveryRole } from '../config/deliveryConfig.js';

import { resolveDeliveryRoleCredentials } from '../config/deliveryConfig.js';
import { DeliveryError } from '../errors.js';

export interface GitHubClients {
  authSource: 'app' | 'personal';
  credentialSource?: string;
  effectiveContentsPermission?: DeliveryPermission | 'admin';
  role: DeliveryRole;
  appActorLogin?: () => Promise<string>;
  authenticatedAuthor?: () => Promise<{ actorLogin: string; credentialIdentity: string }>;
  graphql: typeof GraphQLType;
  rest: Octokit;
}

const authorGitTokens = new WeakMap<GitHubClients, string>();

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
  additionalPermissions?: Readonly<Record<string, DeliveryPermission>>;
  role: DeliveryRole;
}): Promise<GitHubClients> {
  const env = input.env ?? process.env;
  const selected = input.config.roles[input.role];
  if (selected.authSource === 'personal') {
    if (input.role !== 'author' || input.identity.trim().toLowerCase() !== selected.identity.toLowerCase()) {
      throw new DeliveryError('Personal author operation requires the configured author identity.');
    }
    const token = env[selected.credentialEnv.token]?.trim();
    if (!token) {
      throw new DeliveryError(`Missing personal author token in ${selected.credentialEnv.token}.`);
    }
    return personalClients(token, `env:${selected.credentialEnv.token}`);
  }
  if (input.personalAuth !== undefined) {
    if (
      input.personalAuth.enabled !== true ||
      input.role !== 'author' ||
      input.identity.trim().toLowerCase() !== 'personal'
    ) {
      throw new DeliveryError('Personal-token auth requires the explicit personal author identity.');
    }
    const token = input.personalAuth.token?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
    if (!token) throw new DeliveryError('Explicit personal-token auth requested but no token was supplied.');
    const source = input.personalAuth.token?.trim()
      ? 'explicit-personal-token'
      : env.GH_TOKEN?.trim()
        ? 'env:GH_TOKEN'
        : 'env:GITHUB_TOKEN';
    return personalClients(token, source);
  }

  if (input.identity.trim().toLowerCase() !== selected.identity.toLowerCase()) {
    throw new DeliveryError(`GitHub ${input.role} operation requires the configured ${input.role} identity.`);
  }
  const credentials = resolveDeliveryRoleCredentials({ config: input.config, env, role: input.role });
  const otherRole: DeliveryRole = input.role === 'author' ? 'reviewer' : 'author';
  if (input.config.roles[otherRole].authSource !== 'personal') {
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
    const auth = createAppAuth({ appId: credentials.appId, privateKey });
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
        ? async () => {
            try {
              const app = await new Octokit({ auth: (await auth({ type: 'app' })).token }).rest.apps.getAuthenticated();
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
        ? async () => {
            try {
              const app = await new Octokit({ auth: (await auth({ type: 'app' })).token }).rest.apps.getAuthenticated();
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
    );
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(`GitHub App authentication failed for ${input.role} role.`);
  }
}

function personalClients(token: string, credentialSource: string): GitHubClients {
  return buildClients(token, 'personal', 'author', credentialSource, undefined, async () => {
    try {
      const user = (await new Octokit({ auth: token }).rest.users.getAuthenticated()).data;
      if (!Number.isSafeInteger(user.id) || user.id <= 0 || !user.login) {
        throw new DeliveryError('Personal author identity readback is incomplete.');
      }
      return { actorLogin: user.login, credentialIdentity: `user:${String(user.id)}` };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      if ((error as { status?: number }).status === 401) {
        throw new DeliveryError('Configured personal author token is invalid or expired; refresh the selected token.');
      }
      throw new DeliveryError('Personal author identity readback failed.');
    }
  });
}

function buildClients(
  token: string,
  authSource: GitHubClients['authSource'],
  role: DeliveryRole,
  credentialSource: string,
  appActorLogin?: () => Promise<string>,
  authenticatedAuthor?: GitHubClients['authenticatedAuthor'],
  effectiveContentsPermission?: GitHubClients['effectiveContentsPermission'],
): GitHubClients {
  const clients: GitHubClients = {
    authSource,
    credentialSource,
    ...(effectiveContentsPermission ? { effectiveContentsPermission } : {}),
    role,
    ...(appActorLogin ? { appActorLogin } : {}),
    ...(authenticatedAuthor ? { authenticatedAuthor } : {}),
    graphql: graphql.defaults({ headers: { authorization: `token ${token}` } }),
    rest: new Octokit({ auth: token }),
  };
  if (role === 'author') authorGitTokens.set(clients, token);
  return clients;
}
