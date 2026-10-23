import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';

import { git } from '../git.js';

import { DeliveryError } from '../errors.js';
import { digestValue } from '../delivery/common.js';
import { createDeliveryGitHubClients, retainMachineAuthorForConfiguration } from '../github/client.js';
import { resolveRepoFromRemote } from '../github/repo.js';
import { discoverDeliveryRouting, type DiscoveryClients, type DeliveryRouting } from '../github/discovery.js';
import { MACHINE_AUTH_ENV_NAMES } from '../github/machineAuth.js';

export const DELIVERY_CONFIG_FILE = 'ai-delivery.config.json';
export const DELIVERY_POLICY_CONTRACT = 'RepositoryDeliveryPolicy@1';

function configurationIssueMessages(
  issues: readonly z.core.$ZodIssue[],
  root: string,
  prefix: PropertyKey[] = [],
): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    return issue.code === 'invalid_union'
      ? issue.errors.flatMap((branch) => configurationIssueMessages(branch, root, path))
      : [`${path.join('.') || root}: ${issue.message}`];
  });
}

const Name = z.string().trim().min(1);
const MergeQueueApprovers = z
  .record(
    z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    z.array(
      z
        .string()
        .max(39)
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u),
    ),
  )
  .superRefine((repositories, context) => {
    const names = Object.keys(repositories).map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length)
      context.addIssue({ code: 'custom', message: 'Queue approver repositories must be unique.' });
    for (const [repository, logins] of Object.entries(repositories))
      if (new Set(logins.map((login) => login.toLowerCase())).size !== logins.length)
        context.addIssue({ code: 'custom', path: [repository], message: 'Queue approver logins must be unique.' });
  });
export const WipLimits = z
  .array(
    z.strictObject({
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      name: Name,
      match: z.union([
        z.strictObject({ label: Name }),
        z.strictObject({ field: Name, value: z.union([z.string().min(1), z.number().finite()]) }),
      ]),
      limit: z.number().int().nonnegative().safe(),
    }),
  )
  .superRefine((lanes, context) => {
    const identities = lanes.map((lane) => JSON.stringify([lane.repository.toLowerCase(), lane.name]));
    if (new Set(identities).size !== identities.length)
      context.addIssue({ code: 'custom', message: 'WIP lane names must be unique within each repository.' });
  });
export type WipLane = z.infer<typeof WipLimits>[number];
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

const LegacyAppRole = z
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
export const ReviewProvider = z.enum(['openai', 'anthropic', 'google', 'qwen']);
const Encoding = z.enum(['pem', 'base64']).optional();
const CredentialSource = z.union([
  z.strictObject({ type: z.literal('env'), variable: EnvName.optional(), encoding: Encoding }),
  z.strictObject({ type: z.literal('file'), path: Name.refine(isAbsolute, 'Key path must be absolute.') }),
  z.strictObject({
    type: z.literal('command'),
    argv: z
      .array(z.string().max(4096))
      .min(1)
      .max(64)
      .refine(
        (argv) => isAbsolute(argv[0]!) && argv.every((part) => !part.includes('\0')),
        'Command requires an absolute executable and literal argv without NUL.',
      ),
    encoding: Encoding,
    env: z.array(EnvName).max(32).optional(),
  }),
]);
const ConfiguredAppRole = z.strictObject({
  authSource: z.literal('app'),
  identity: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u),
  appId: PositiveInteger.safe(),
  installationId: PositiveInteger.safe(),
  actorLogin: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\[bot\]$/u),
  provider: ReviewProvider,
  credentialSource: CredentialSource.optional(),
});
const AppRole = z.union([LegacyAppRole, ConfiguredAppRole]);
export type ConfiguredApp = z.infer<typeof ConfiguredAppRole>;
export type AppCredentialSource = z.infer<typeof CredentialSource>;
export function appCredentialSource(role: ConfiguredApp): AppCredentialSource {
  return role.credentialSource ?? { type: 'env' };
}
export function privateKeyVariable(role: ConfiguredApp): string {
  const source = appCredentialSource(role);
  return source.type === 'env' && source.variable !== undefined
    ? source.variable
    : `GH_PRIVATE_KEY_${role.identity.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`;
}
/** Names only: readiness and environment selection must never resolve a secret. */
export function credentialReferenceNames(
  role: z.infer<typeof AppRole> | { credentialEnv: { token: string } },
): string[] {
  if ('credentialEnv' in role) return Object.values(role.credentialEnv);
  const source = appCredentialSource(role);
  return source.type === 'env' ? [privateKeyVariable(role)] : source.type === 'command' ? (source.env ?? []) : [];
}
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
    wipLimits: WipLimits.optional(),
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
    const authorEnv = credentialReferenceNames(value.roles.author);
    const reviewerEnv = credentialReferenceNames(value.roles.reviewer);
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
export const NativeDeliveryConfigSchema = DeliveryConfigSchema.shape.native;
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
  /** Command-local names only, captured before profile selection. */
  credentialKeyReferences?: readonly string[];
  schemaVersion: 'ai-delivery.github@1';
  wipLimits?: WipLane[] | undefined;
  mergeQueueApprovers?: Record<string, string[]> | undefined;
};
export interface LoadedGitHubConfig {
  config: GitHubDeliveryConfig;
  configDigest: string;
  configPath: string | null;
  routing: DeliveryRouting;
}
const UserSettingsSchema = z
  .strictObject({
    wipLimits: WipLimits.optional(),
    mergeQueueApprovers: MergeQueueApprovers.optional(),
    schemaVersion: z.literal('ai-delivery.user@1'),
    roles: z.strictObject({
      author: AuthorRole,
      reviewer: AppRole,
    }),
    reviewerProfiles: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u), ConfiguredAppRole).optional(),
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
    const profiles = [roles.reviewer, ...Object.values(value.reviewerProfiles ?? {})];
    if (new Set(profiles.map((profile) => profile.identity.toLowerCase())).size !== profiles.length)
      context.addIssue({
        code: 'custom',
        path: ['reviewerProfiles'],
        message: 'Reviewer profile identities must be distinct; ambiguous selection is refused.',
      });
    for (const [name, profile] of Object.entries(value.reviewerProfiles ?? {})) {
      if (
        name !== profile.identity ||
        profile.identity.toLowerCase() === roles.author.identity.toLowerCase() ||
        /^personal(?:$|[-_])/iu.test(profile.identity)
      )
        context.addIssue({
          code: 'custom',
          path: ['reviewerProfiles', name],
          message: 'Profile key must equal its distinct reviewer identity.',
        });
    }
    for (const profile of profiles) {
      const names = [...credentialReferenceNames(roles.author), ...credentialReferenceNames(profile)];
      if (new Set(names).size !== names.length)
        context.addIssue({
          code: 'custom',
          path: ['roles'],
          message: 'Credential environment names must be distinct.',
        });
    }
  });
export type UserDeliverySettings = z.infer<typeof UserSettingsSchema>;
export interface LoadedDeliverySettings {
  credentialKeyReferences?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  wipLimits?: WipLane[] | undefined;
  mergeQueueApprovers?: Record<string, string[]> | undefined;
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
export async function loadDeliverySettings(
  _repositoryRoot?: string,
  options: {
    reviewerIdentity?: string;
    prepareEnvironment?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LoadedDeliverySettings> {
  const inherited = options.env ?? process.env;
  const path = inherited.AI_DELIVERY_CONFIG ?? join(homedir(), '.config', 'aviaratech-ai', 'ai-delivery.json');
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
    const details = configurationIssueMessages(result.error.issues, 'configuration').join('; ');
    throw new DeliveryError(`Invalid user configuration ${path}: ${details}`);
  }
  const sourceDigest = digestValue(result.data);
  const {
    roles,
    reviewerProfiles,
    checkoutRoots,
    wipLimits,
    mergeQueueApprovers,
    schemaVersion: _schema,
    ...overrides
  } = result.data;
  const credentialKeyReferences = [
    ...new Set(
      [roles.author, roles.reviewer, ...Object.values(reviewerProfiles ?? {})].flatMap((role) =>
        'credentialEnv' in role
          ? role.authSource === 'personal'
            ? [role.credentialEnv.token]
            : [role.credentialEnv.privateKeyPath]
          : appCredentialSource(role).type === 'env'
            ? [privateKeyVariable(role)]
            : [],
      ),
    ),
  ];
  if (options.reviewerIdentity !== undefined) {
    const identity = options.reviewerIdentity;
    const selected = identity === roles.reviewer.identity ? roles.reviewer : reviewerProfiles?.[identity];
    if (!selected || !('appId' in selected) || identity === roles.author.identity)
      throw new DeliveryError(
        'identity: Select an explicit configured reviewer profile with provider, App ID and actorLogin.',
      );
    roles.reviewer = selected;
  }
  const environment: NodeJS.ProcessEnv = {};
  if (options.prepareEnvironment) {
    const selectors: readonly string[] = [...MACHINE_AUTH_ENV_NAMES, 'TMPDIR', 'TEMP', 'TMP'];
    if (credentialKeyReferences.some((name) => selectors.includes(name)))
      throw new DeliveryError('Credential reference conflicts with an implicit execution selector.');
    const reviewerSource = 'appId' in roles.reviewer ? appCredentialSource(roles.reviewer) : undefined;
    if (
      reviewerSource?.type === 'command' &&
      reviewerSource.env?.some((name) => credentialKeyReferences.includes(name))
    )
      throw new DeliveryError(
        'Selected helper environment cannot include an author or configured private-key reference.',
      );
    const names = new Set<string>([
      ...MACHINE_AUTH_ENV_NAMES,
      'TMPDIR',
      'TEMP',
      'TMP',
      ...Object.values(roles).flatMap(credentialReferenceNames),
    ]);
    for (const name of names) {
      if (
        /^(?:NODE_|NPM_|DYLD_|LD_|BASH_|GIT_)/u.test(name) ||
        ['ENV', 'BASH_ENV', 'SHELLOPTS', 'CDPATH'].includes(name)
      )
        throw new DeliveryError('Credential environment reference conflicts with an execution selector.');
      if (inherited[name] !== undefined) environment[name] = inherited[name];
    }
    environment.AI_DELIVERY_CONFIG = path;
  }
  return {
    credentialKeyReferences,
    ...(options.prepareEnvironment ? { environment } : {}),
    roles,
    checkoutRoots,
    ...(wipLimits === undefined ? {} : { wipLimits }),
    ...(mergeQueueApprovers === undefined ? {} : { mergeQueueApprovers }),
    configPath: path,
    overrides,
    sourceDigest,
  };
}

export async function loadDeliveryConfig(
  repositoryRoot: string,
  options: {
    clients?: DiscoveryClients;
    personalAuth?: boolean;
    signal?: AbortSignal;
    repository?: string;
    readPageLimit?: number;
    requireWritableProject?: boolean;
    settings?: LoadedDeliverySettings;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LoadedGitHubConfig> {
  options.signal?.throwIfAborted();
  const settings = options.settings ?? (await loadDeliverySettings());
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
      ...(options.env === undefined ? {} : { env: options.env }),
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
      ...(options.readPageLimit === undefined ? {} : { maxPages: options.readPageLimit }),
      ...(options.requireWritableProject === undefined
        ? {}
        : { requireWritableProject: options.requireWritableProject }),
    });
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    if (
      options.clients === undefined &&
      settings.roles.author.authSource === 'personal' &&
      (error as { status?: number }).status === 401
    )
      throw new DeliveryError('Configured personal author token is invalid or expired; refresh the selected token.');
    throw error;
  }
  const config: GitHubDeliveryConfig = {
    ...(settings.credentialKeyReferences === undefined
      ? {}
      : { credentialKeyReferences: settings.credentialKeyReferences }),
    ...(settings.wipLimits === undefined ? {} : { wipLimits: settings.wipLimits }),
    ...(settings.mergeQueueApprovers === undefined ? {} : { mergeQueueApprovers: settings.mergeQueueApprovers }),
    schemaVersion: 'ai-delivery.github@1',
    repository: routing.repository,
    roles: settings.roles,
    native: routing.native,
  };
  if (options.clients === undefined)
    retainMachineAuthorForConfiguration(
      config,
      clients as Awaited<ReturnType<typeof createDeliveryGitHubClients>>,
      options.signal,
    );
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
    const details = configurationIssueMessages(result.error.issues, 'config').join('; ');
    throw new DeliveryError(`Invalid ${DELIVERY_CONFIG_FILE}: ${details}`);
  }
  return result.data;
}

export function resolveDeliveryRoleCredentials(input: {
  config: Pick<DeliveryConfig, 'roles'>;
  env?: NodeJS.ProcessEnv;
  role: DeliveryRole;
}): { appId: string; installationId: number; privateKeyPath?: string; profile?: ConfiguredApp } {
  const { config, role } = input;
  if (config.roles[role].authSource === 'personal') {
    throw new DeliveryError('Personal author credentials use the configured token environment variable.');
  }
  const env = input.env ?? process.env;
  const selected = config.roles[role];
  if ('appId' in selected)
    return { appId: String(selected.appId), installationId: selected.installationId, profile: selected };
  const names = selected.credentialEnv as { appId: string; installationId: string; privateKeyPath: string };
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
