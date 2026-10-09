import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { loadDeliveryConfig, type LoadedDeliveryConfig, type LoadedGitHubConfig } from '../config/deliveryConfig.js';
import { assertPrivateFile } from '../delivery/common.js';
import { digestValue } from '../delivery/index.js';
import { DeliveryError } from '../errors.js';
import { gitCommonDir, gitRoot } from '../git.js';

const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const CAPABILITY = 2;
export const RuntimeAdmissionSchema = z
  .object({
    admissionId: Sha256,
    capability: z.object({ cli: z.number().int().positive(), mcp: z.number().int().positive() }).strict(),
    cliPath: z.string().min(1),
    cliSha256: Sha256,
    configDigest: Sha256,
    mcpLauncherPath: z.string().min(1),
    mcpLauncherSha256: Sha256,
    packageDistSha256: Sha256,
    packageManifestSha256: Sha256,
    packageVersion: z.string().min(1),
    pluginManifestPath: z.string().min(1),
    pluginManifestSha256: Sha256,
    repository: z.string().min(1),
    schemaVersion: z.literal('ai-delivery.runtime-admission@2'),
    sourceArchiveSha256: Sha256,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  })
  .strict()
  .superRefine((value, context) => {
    const { admissionId, ...content } = value;
    if (admissionId !== digestValue(content)) {
      context.addIssue({ code: 'custom', message: 'Runtime admission identity is invalid.' });
    }
  });

export type RuntimeAdmission = z.infer<typeof RuntimeAdmissionSchema>;

function fileDigest(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function directoryDigest(path: string): string {
  const entries: { path: string; sha256: string }[] = [];
  const visit = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const child = join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) entries.push({ path: childRelative, sha256: fileDigest(child) });
      else throw new DeliveryError('Runtime distribution contains an unsupported link or file type.');
    }
  };
  visit(path, '');
  if (entries.length === 0) throw new DeliveryError('Runtime distribution is empty.');
  return digestValue(entries);
}

function manifest(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryError('Runtime package or plugin manifest is invalid.');
  }
  return value as Record<string, unknown>;
}

/**
 * An installer-owned, private, immutable admission binds the actual CLI and MCP
 * bytes to one source archive and the consuming repository configuration.
 * Neither invocation surface can refresh its own admission during a mutation.
 */
export async function assertDeliveryRuntimeAdmitted(input: {
  repoRoot: string;
  runtimeEntryPath?: string;
  personalAuth?: boolean;
  configuration?: LoadedDeliveryConfig | LoadedGitHubConfig;
}): Promise<RuntimeAdmission> {
  const root = gitRoot(input.repoRoot);
  const loaded =
    input.configuration ??
    (await loadDeliveryConfig(root, input.personalAuth === undefined ? {} : { personalAuth: input.personalAuth }));
  const path = join(gitCommonDir(root), 'ai-delivery', 'runtime-admission.json');
  let admission: RuntimeAdmission;
  try {
    admission = RuntimeAdmissionSchema.parse(JSON.parse(assertPrivateFile(path).toString('utf8')) as unknown);
  } catch {
    throw new DeliveryError(
      'Missing or invalid private ai-delivery runtime admission; refresh the installed binding before lifecycle mutation.',
    );
  }
  return validateRuntimeAdmission(admission, loaded, input.runtimeEntryPath);
}

/** @internal Shared installed-byte validation for explicit setup and lifecycle admission. */
export function validateRuntimeAdmission(
  admission: RuntimeAdmission,
  loaded: LoadedDeliveryConfig | LoadedGitHubConfig,
  runtimeEntryPath?: string,
): RuntimeAdmission {
  const entry = runtimeEntryPath ?? process.argv[1];
  if (!entry) throw new DeliveryError('Running ai-delivery entry path is unavailable.');
  try {
    const cliPath = realpathSync(entry);
    const launcherPath = realpathSync(admission.mcpLauncherPath);
    const pluginManifestPath = realpathSync(admission.pluginManifestPath);
    const distPath = dirname(cliPath);
    const packageManifestPath = join(dirname(distPath), 'package.json');
    const packageManifest = manifest(packageManifestPath);
    const pluginManifest = manifest(pluginManifestPath);
    if (
      cliPath !== admission.cliPath ||
      launcherPath !== admission.mcpLauncherPath ||
      pluginManifestPath !== admission.pluginManifestPath ||
      realpathSync(join(dirname(dirname(launcherPath)), '.claude-plugin', 'plugin.json')) !== pluginManifestPath ||
      fileDigest(cliPath) !== admission.cliSha256 ||
      fileDigest(launcherPath) !== admission.mcpLauncherSha256 ||
      fileDigest(pluginManifestPath) !== admission.pluginManifestSha256 ||
      fileDigest(packageManifestPath) !== admission.packageManifestSha256 ||
      directoryDigest(distPath) !== admission.packageDistSha256 ||
      admission.configDigest !== loaded.configDigest ||
      admission.repository !== loaded.config.repository ||
      admission.capability.cli !== CAPABILITY ||
      admission.capability.mcp !== CAPABILITY ||
      packageManifest.name !== '@aviaratech/ai-delivery' ||
      packageManifest.version !== admission.packageVersion ||
      pluginManifest.name !== 'ai-delivery' ||
      pluginManifest.packageVersion !== admission.packageVersion ||
      pluginManifest.deliveryCapabilityVersion !== CAPABILITY
    ) {
      throw new DeliveryError(
        'Installed CLI/MCP source, capability or repository admission disagrees with the running delivery contract.',
      );
    }
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError('Installed CLI/MCP source or capability readback is unavailable.');
  }
  return admission;
}

/** @internal Build the existing schema from actual installed bytes, never caller-supplied hashes. */
export function buildRuntimeAdmission(input: {
  cliPath: string;
  mcpLauncherPath: string;
  pluginManifestPath: string;
  packageVersion: string;
  sourceArchiveSha256: string;
  sourceCommit: string;
  configuration: LoadedDeliveryConfig | LoadedGitHubConfig;
}): RuntimeAdmission {
  for (const path of [input.cliPath, input.mcpLauncherPath, input.pluginManifestPath]) {
    if (realpathSync(path) !== path)
      throw new DeliveryError('Installed runtime paths must be canonical regular files.');
  }
  const dist = dirname(input.cliPath);
  const packagePath = join(dirname(dist), 'package.json');
  const packageManifest = manifest(packagePath);
  const bin = packageManifest.bin;
  if (
    typeof bin !== 'object' ||
    bin === null ||
    !('ai-delivery' in bin) ||
    (bin as Record<string, unknown>)['ai-delivery'] !== './dist/cli.js'
  ) {
    throw new DeliveryError('Installed package CLI entry is not the supported ai-delivery executable.');
  }
  const content = {
    capability: { cli: CAPABILITY, mcp: CAPABILITY },
    cliPath: input.cliPath,
    cliSha256: fileDigest(input.cliPath),
    configDigest: input.configuration.configDigest,
    mcpLauncherPath: input.mcpLauncherPath,
    mcpLauncherSha256: fileDigest(input.mcpLauncherPath),
    packageDistSha256: directoryDigest(dist),
    packageManifestSha256: fileDigest(packagePath),
    packageVersion: input.packageVersion,
    pluginManifestPath: input.pluginManifestPath,
    pluginManifestSha256: fileDigest(input.pluginManifestPath),
    repository: input.configuration.config.repository,
    schemaVersion: 'ai-delivery.runtime-admission@2' as const,
    sourceArchiveSha256: input.sourceArchiveSha256,
    sourceCommit: input.sourceCommit,
  };
  return validateRuntimeAdmission(
    RuntimeAdmissionSchema.parse({ ...content, admissionId: digestValue(content) }),
    input.configuration,
    input.cliPath,
  );
}
