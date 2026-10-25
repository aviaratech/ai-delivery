import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

const lane = process.env.AI_DELIVERY_TEST_LANE ?? 'pr';
if (lane !== 'pr' && lane !== 'release') throw new Error('Unknown test lane; use pr or release.');
if (lane === 'release') {
  const owner = (await import(new URL('./scripts/current-qualification.mjs', import.meta.url).href)) as {
    validateReleaseEntry(contractPath: string, cwd: string): unknown;
  };
  try {
    owner.validateReleaseEntry(process.env.AI_DELIVERY_RELEASE_CONTRACT ?? '', process.cwd());
  } catch (cause) {
    throw new Error('Invalid release contract; no release cases may start.', { cause });
  }
}

// Files own disjoint temporary roots. Forks isolate mutable test ports; the
// producer finishes before source/archive readers, with existing RSS/cleanup guards.
export default defineConfig(({ mode }) => ({
  test: {
    tags: [{ name: 'release', description: 'Owned process/archive/install qualification', skip: lane !== 'release' }],
    pool: 'forks',
    testTimeout: 60_000,
    include: [mode === 'compiled' || lane === 'release' ? 'dist/**/*.test.js' : 'src/**/*.test.ts'],
    fileParallelism: true,
    maxWorkers: availableParallelism(),
  },
}));
