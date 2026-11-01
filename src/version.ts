import { readFileSync } from 'node:fs';

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
