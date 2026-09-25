import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

import { DeliveryError } from '../errors.js';

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

const Role = z
  .object({
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
        contract: z.literal(DELIVERY_POLICY_CONTRACT),
        module: z.string().regex(/^\.\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\s]+\.(?:mjs|js)$/u),
      })
      .strict(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    roles: z.object({ author: Role, reviewer: Role }).strict(),
    schemaVersion: z.literal('ai-delivery.config@1'),
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
      [value.roles.author.identity, value.roles.reviewer.identity].some((identity) =>
        /^personal(?:$|[-_])/iu.test(identity),
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
    if (new Set([...authorEnv, ...reviewerEnv]).size !== 6) {
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

export interface LoadedDeliveryConfig {
  config: DeliveryConfig;
  configDigest: string;
  configPath: string;
  policyModulePath: string;
}

export function loadDeliveryConfig(repositoryRoot: string): LoadedDeliveryConfig {
  const root = realpathSync(repositoryRoot);
  const configPath = join(root, DELIVERY_CONFIG_FILE);
  let bytes: Buffer;
  try {
    if (!isWithin(root, realpathSync(configPath))) {
      throw new DeliveryError(`${DELIVERY_CONFIG_FILE} must be a repository-root source file.`);
    }
    bytes = readFileSync(configPath);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError(
      `Missing repository-root ${DELIVERY_CONFIG_FILE}. Configure repository, native fields, policy and distinct App roles.`,
    );
  }
  assertSourceControlled({ filePath: configPath, label: DELIVERY_CONFIG_FILE, root });
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new DeliveryError(`Invalid ${DELIVERY_CONFIG_FILE}: expected JSON.`);
  }
  const config = parseDeliveryConfig(raw);
  const selectedPath = resolve(root, config.policy.module);
  if (isAbsolute(config.policy.module) || !isWithin(root, selectedPath)) {
    throw new DeliveryError(`Invalid ${DELIVERY_CONFIG_FILE}: policy module must stay within the repository root.`);
  }
  let policyModulePath: string;
  try {
    policyModulePath = realpathSync(selectedPath);
  } catch {
    throw new DeliveryError(`Policy module selected by ${DELIVERY_CONFIG_FILE} is missing.`);
  }
  if (!isWithin(root, policyModulePath)) {
    throw new DeliveryError(`Policy module selected by ${DELIVERY_CONFIG_FILE} escapes the repository root.`);
  }
  assertSourceControlled({
    filePath: policyModulePath,
    label: `Policy module selected by ${DELIVERY_CONFIG_FILE}`,
    root,
  });
  return {
    config,
    configDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    configPath,
    policyModulePath,
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
  config: DeliveryConfig;
  env?: NodeJS.ProcessEnv;
  role: DeliveryRole;
}): { appId: string; installationId: number; privateKeyPath: string } {
  const { config, role } = input;
  const env = input.env ?? process.env;
  const names = config.roles[role].credentialEnv;
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

function assertSourceControlled(input: { filePath: string; label: string; root: string }): void {
  const { filePath, label, root } = input;
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relative(root, filePath)], {
    cwd: root,
    stdio: 'ignore',
  });
  if (result.status !== 0) {
    throw new DeliveryError(`${label} must be source-controlled.`);
  }
}

function isWithin(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(relation)
  );
}
