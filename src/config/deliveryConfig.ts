import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';

import { git } from '../git.js';

import { DeliveryError } from '../errors.js';
import { digestValue } from '../delivery/common.js';
import { createDeliveryGitHubClients } from '../github/client.js';
import { resolveRepoFromRemote } from '../github/repo.js';
import { discoverDeliveryRouting, type DiscoveryClients, type DeliveryRouting } from '../github/discovery.js';

export const DELIVERY_CONFIG_FILE = 'ai-delivery.config.json';
export const DELIVERY_POLICY_CONTRACT = 'RepositoryDeliveryPolicy@1';

const Name = z.string().trim().min(1);
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const PositiveInteger = z.number().int().positive();
const NativeFieldId = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .refine((value) => Number.isSafeInteger(Number(value)));
const UniqueNames = z
  .array(Name)
  .min(1)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Values must be unique.' });
    }
  });

const NativeField = z
  .object({
    databaseId: NativeFieldId,
    name: Name,
    values: UniqueNames,
  })
  .strict();

const AppRole = z
  .object({
    authSource: z.literal('app').optional(),
    credentialEnv: z
      .object({
        appId: EnvName,
        installationId: EnvName,
        privateKeyPath: EnvName,
      })
      .strict(),
    identity: Name,
  })
  .strict();
const AuthorRole = z.union([
  AppRole,
  z
    .object({
      authSource: z.literal('personal'),
      credentialEnv: z.object({ token: EnvName }).strict(),
      identity: Name,
    })
    .strict(),
]);

const DeliveryConfigSchema = z
  .object({
    commandPolicy: z
      .object({
        checks: z
          .object({
            format: z.enum(['REQUIRED', 'OPTIONAL', 'SKIP']),
            gitClean: z.enum(['REQUIRED', 'OPTIONAL', 'SKIP']),
            lint: z.enum(['REQUIRED', 'OPTIONAL', 'SKIP']),
            test: z.enum(['REQUIRED', 'OPTIONAL', 'SKIP']),
            typecheck: z.enum(['REQUIRED', 'OPTIONAL', 'SKIP']),
          })
          .strict(),
        timeoutsMs: z
          .object({
            lint: PositiveInteger,
            test: PositiveInteger,
            typecheck: PositiveInteger,
          })
          .strict(),
      })
      .strict(),
    native: z
      .object({
        issueTypes: UniqueNames,
        milestones: z.literal('repository'),
        organization: Name,
        points: NativeField,
        priority: NativeField,
        project: z
          .object({
            number: PositiveInteger,
            statuses: z
              .object({
                blocked: Name,
                done: Name,
                inProgress: Name,
                todo: Name,
              })
              .strict(),
            statusField: Name,
            title: Name,
          })
          .strict(),
        relationships: z
          .object({
            blockedBy: z.literal('native'),
            parent: z.literal('native'),
          })
          .strict(),
      })
      .strict(),
    policy: z
      .object({
        contract: z.enum([DELIVERY_POLICY_CONTRACT, 'RepositoryDeliveryPolicy@2']),
        module: z.string().regex(/^\.\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\s]+\.(?:mjs|js)$/u),
      })
      .strict(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    roles: z.object({ author: AuthorRole, reviewer: AppRole }).strict(),
    schemaVersion: z.literal('ai-delivery.config@2'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.repository.split('/')[0]?.toLowerCase() !== value.native.organization.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        message: 'Organization must match repository owner.',
        path: ['native', 'organization'],
      });
    }
    if (value.roles.author.identity.toLowerCase() === value.roles.reviewer.identity.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        message: 'Author and reviewer identities must be distinct.',
        path: ['roles'],
      });
    }
    if (
      [value.roles.author, value.roles.reviewer].some(
        (role) => role.authSource !== 'personal' && /^personal(?:$|[-_])/iu.test(role.identity),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'App role identities cannot be personal identities.',
        path: ['roles'],
      });
    }
    const authorEnv = Object.values(value.roles.author.credentialEnv);
    const reviewerEnv = Object.values(value.roles.reviewer.credentialEnv);
    if (new Set([...authorEnv, ...reviewerEnv]).size !== authorEnv.length + reviewerEnv.length) {
      context.addIssue({
        code: 'custom',
        message: 'Author and reviewer credential environment names must be distinct.',
        path: ['roles'],
      });
    }
    if (new Set(Object.values(value.native.project.statuses)).size !== 4) {
      context.addIssue({
        code: 'custom',
        message: 'Project statuses must be distinct.',
        path: ['native', 'project', 'statuses'],
      });
    }
    if (
      value.native.points.values.some((point) => !/^[1-9]\d*$/u.test(point) || !Number.isSafeInteger(Number(point)))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Point values must be positive safe integers.',
        path: ['native', 'points', 'values'],
      });
    }
    if (value.native.points.name === value.native.priority.name) {
      context.addIssue({ code: 'custom', message: 'Points and priority fields must be distinct.', path: ['native'] });
    }
    if (value.native.points.databaseId === value.native.priority.databaseId) {
      context.addIssue({
        code: 'custom',
        message: 'Points and priority field IDs must be distinct.',
        path: ['native'],
      });
    }
  });

export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;
export type DeliveryRole = keyof DeliveryConfig['roles'];

const ModulePath = z.string().regex(/^\.\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\s]+\.(?:mjs|js)$/u);
const OverridesSchema = z
  .object({
    schemaVersion: z.literal('ai-delivery.config@2').optional(),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
      .optional(),
    remote: Name.optional(),
    policy: z.object({ module: ModulePath }).strict().optional(),
    project: PositiveInteger.optional(),
    pointsField: Name.optional(),
    priorityField: Name.optional(),
    statusField: Name.optional(),
    statuses: z.object({ blocked: Name, done: Name, inProgress: Name, todo: Name }).strict().optional(),
    issueTypes: UniqueNames.optional(),
  })
  .strict();
export type DeliveryOverrides = z.infer<typeof OverridesSchema>;
export type DeliveryPolicySettings = Pick<DeliveryConfig, 'roles' | 'commandPolicy'>;
/** Historical schema parsing preserves identities; new configuration never imports it. */
export interface LoadedDeliveryConfig {
  config: DeliveryConfig;
  configDigest: string;
  configPath: string | null;
  policyModulePath: string;
  remote: string | undefined;
  routing: DeliveryRouting;
}
export type GitHubDeliveryConfig = Pick<DeliveryConfig, 'roles' | 'repository' | 'native'> & {
  schemaVersion: 'ai-delivery.github@1';
};
export interface LoadedGitHubConfig {
  config: GitHubDeliveryConfig;
  configDigest: string;
  configPath: string | null;
  routing: DeliveryRouting;
}
const UserSettingsSchema = z
  .strictObject({
    schemaVersion: z.literal('ai-delivery.user@1'),
    roles: z.strictObject({
      author: z.discriminatedUnion('authSource', [AppRole, AuthorRole.options[1]]),
      reviewer: AppRole,
    }),
    project: PositiveInteger,
    checkoutRoots: z.array(z.string().min(1).refine(isAbsolute, 'Checkout roots must be absolute.')),
    pointsField: Name.optional(),
    priorityField: Name.optional(),
    statusField: Name.optional(),
    statuses: OverridesSchema.shape.statuses,
    issueTypes: UniqueNames.optional(),
  })
  .superRefine((value, context) => {
    const roles = value.roles;
    if (roles.author.identity.toLowerCase() === roles.reviewer.identity.toLowerCase())
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'Author and reviewer identities must be distinct.',
      });
    if (
      [roles.author, roles.reviewer].some(
        (role) => role.authSource !== 'personal' && /^personal(?:$|[-_])/iu.test(role.identity),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'App role identities cannot be personal identities.',
      });
    if (value.statuses && new Set(Object.values(value.statuses)).size !== 4)
      context.addIssue({ code: 'custom', path: ['statuses'], message: 'Project statuses must be distinct.' });
    const names = [...Object.values(roles.author.credentialEnv), ...Object.values(roles.reviewer.credentialEnv)];
    if (new Set(names).size !== names.length)
      context.addIssue({ code: 'custom', path: ['roles'], message: 'Credential environment names must be distinct.' });
  });
export type UserDeliverySettings = z.infer<typeof UserSettingsSchema>;
export interface LoadedDeliverySettings {
  roles: DeliveryConfig['roles'];
  configPath: string;
  overrides: DeliveryOverrides;
  checkoutRoots: string[];
  sourceDigest: string;
}

/** The optional file contains choices, never a required copy of GitHub metadata. */
export function readDeliveryOverrides(repositoryRoot: string): {
  overrides: DeliveryOverrides;
  bytes: Buffer;
  path: string | null;
} {
  const root = realpathSync(repositoryRoot);
  const path = join(root, DELIVERY_CONFIG_FILE);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { overrides: {}, bytes: Buffer.alloc(0), path: null };
    throw new DeliveryError(`Unable to read ${DELIVERY_CONFIG_FILE}.`);
  }
  if (!isWithin(root, realpathSync(path)))
    throw new DeliveryError(`${DELIVERY_CONFIG_FILE} must stay within the repository root.`);
  try {
    git(root, 'ls-files', '--error-unmatch', '--', DELIVERY_CONFIG_FILE);
  } catch {
    throw new DeliveryError(`${DELIVERY_CONFIG_FILE} must be source-controlled for historical parsing.`);
  }
  const bytes = readFileSync(path);
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8')) as unknown;
    return { overrides: OverridesSchema.parse(raw), bytes, path };
  } catch {
    throw new DeliveryError(
      `Invalid ${DELIVERY_CONFIG_FILE}; expected optional ai-delivery.config@2 routing overrides. Migrate authentication and command settings to the policy module's deliverySettings export.`,
    );
  }
}

/** Only operator-owned JSON supplies settings. Target repository files are never loaded. */
export async function loadDeliverySettings(_repositoryRoot?: string): Promise<LoadedDeliverySettings> {
  const path = process.env.AI_DELIVERY_CONFIG ?? join(homedir(), '.config', 'aviaratech-ai', 'ai-delivery.json');
  if (!isAbsolute(path)) throw new DeliveryError('AI_DELIVERY_CONFIG must be an absolute user configuration path.');
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new DeliveryError(
      `Missing user configuration ${path}; configure roles.author, roles.reviewer, project and checkoutRoots.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new DeliveryError(`Invalid user configuration JSON at ${path}.`);
  }
  const result = UserSettingsSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
      .join('; ');
    throw new DeliveryError(`Invalid user configuration ${path}: ${details}`);
  }
  const { roles, checkoutRoots, schemaVersion: _schema, ...overrides } = result.data;
  return { roles, checkoutRoots, configPath: path, overrides, sourceDigest: digestValue(result.data) };
}

export async function loadDeliveryConfig(
  repositoryRoot: string,
  options: { clients?: DiscoveryClients; personalAuth?: boolean; signal?: AbortSignal; repository?: string } = {},
): Promise<LoadedGitHubConfig> {
  options.signal?.throwIfAborted();
  const settings = await loadDeliverySettings();
  const repository =
    options.repository ??
    (() => {
      const coordinates = resolveRepoFromRemote(repositoryRoot, 'origin');
      return `${coordinates.owner}/${coordinates.repo}`;
    })();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    throw new DeliveryError('Repository must be owner/name.');
  const clients =
    options.clients ??
    (await createDeliveryGitHubClients({
      config: settings,
      identity:
        options.personalAuth === true && settings.roles.author.authSource !== 'personal'
          ? 'personal'
          : settings.roles.author.identity,
      role: 'author',
      ...(options.personalAuth === true ? { personalAuth: { enabled: true as const } } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  let routing: DeliveryRouting;
  try {
    routing = await discoverDeliveryRouting({
      clients,
      repository,
      overrides: settings.overrides,
      repositorySelected: options.repository !== undefined,
    });
  } catch (error) {
    if (
      options.clients === undefined &&
      settings.roles.author.authSource === 'personal' &&
      (error as { status?: number }).status === 401
    )
      throw new DeliveryError('Configured personal author token is invalid or expired; refresh the selected token.');
    throw error;
  }
  const config: GitHubDeliveryConfig = {
    schemaVersion: 'ai-delivery.github@1',
    repository: routing.repository,
    roles: settings.roles,
    native: routing.native,
  };
  return {
    config,
    configDigest: digestValue({ sourceDigest: settings.sourceDigest, routing, roles: config.roles }),
    configPath: settings.configPath,
    routing,
  };
}

export function parseDeliveryConfig(input: unknown): DeliveryConfig {
  const result = DeliveryConfigSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new DeliveryError(`Invalid ${DELIVERY_CONFIG_FILE}: ${details}`);
  }
  return result.data;
}

export function resolveDeliveryRoleCredentials(input: {
  config: Pick<DeliveryConfig, 'roles'>;
  env?: NodeJS.ProcessEnv;
  role: DeliveryRole;
}): { appId: string; installationId: number; privateKeyPath: string } {
  const { config, role } = input;
  if (config.roles[role].authSource === 'personal') {
    throw new DeliveryError('Personal author credentials use the configured token environment variable.');
  }
  const env = input.env ?? process.env;
  const names = config.roles[role].credentialEnv as { appId: string; installationId: string; privateKeyPath: string };
  const values = {
    appId: env[names.appId]?.trim(),
    installationId: env[names.installationId]?.trim(),
    privateKeyPath: env[names.privateKeyPath]?.trim(),
  };
  if (!values.appId || !values.installationId || !values.privateKeyPath) {
    throw new DeliveryError(
      `Missing GitHub App credentials for ${role} role. Set ${names.appId}, ${names.installationId} and ${names.privateKeyPath}.`,
    );
  }
  if (!isAbsolute(values.privateKeyPath)) {
    throw new DeliveryError(`GitHub App private-key path for ${role} role (${names.privateKeyPath}) must be absolute.`);
  }
  const installationId = Number(values.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new DeliveryError(`Invalid GitHub App installation ID for ${role} role (${names.installationId}).`);
  }
  const appId = Number(values.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    throw new DeliveryError(`Invalid GitHub App ID for ${role} role (${names.appId}).`);
  }
  return { appId: values.appId, installationId, privateKeyPath: values.privateKeyPath };
}

function isWithin(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(relation)
  );
}
