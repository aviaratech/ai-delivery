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

export default defineConfig({
  test: {
    tags: [{ name: 'release', description: 'Owned archive/install qualification', skip: lane !== 'release' }],
    include: ['dist/**/*.test.js'],
    fileParallelism: false,
    maxWorkers: 1,
    // Recovery checks prove bounded operations and cancellation; elapsed test time is not their completion contract.
    testTimeout: 0,
  },
});
