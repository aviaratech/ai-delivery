import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestValue } from './delivery/common.js';
import { DeliveryError } from './errors.js';

const packageMetadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (
  typeof packageMetadata !== 'object' ||
  packageMetadata === null ||
  !('version' in packageMetadata) ||
  typeof packageMetadata.version !== 'string' ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(packageMetadata.version)
)
  throw new Error('The adjacent ai-delivery package identity must contain a stable version.');

export const PACKAGE_VERSION = packageMetadata.version;

/** Module-relative identity of the executing distribution, including the single bundled CLI layout. */
export function readPackageArtifactIdentity(): {
  packageVersion: string;
  packageManifestDigest: string;
  packageDistDigest: string;
} {
  const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
  const distribution = fileURLToPath(new URL('.', import.meta.url));
  if (!lstatSync(manifest).isFile() || !lstatSync(distribution).isDirectory())
    throw new DeliveryError('Executing package identity contains an unsupported link or file type.');
  return {
    packageVersion: PACKAGE_VERSION,
    packageManifestDigest: fileDigest(manifest),
    packageDistDigest: directoryDigest(distribution),
  };
}

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
