import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fileDigest, directoryDigest } from './services/deliveryAdmission.js';
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
