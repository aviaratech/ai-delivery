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

// These fixtures assert process ownership, interruption or shared checkout state.
const serialFiles = [
  'dist/contributorChecks.test.js',
  'dist/currentConsumer.test.js',
  'dist/delivery/delivery.test.js',
  'dist/lifecycle.test.js',
  'dist/pluginAuthProbe.test.js',
  'dist/pluginInstaller.test.js',
  'dist/pluginPackaging.test.js',
  'dist/setup.test.js',
  'dist/stagedChecks.test.js',
  'dist/targetPolicyLocal.test.js',
  'dist/worktreeTransition.test.js',
];

export default defineConfig(({ mode }) => {
  const compiled = mode === 'compiled' || lane === 'release';
  const serial = compiled
    ? serialFiles
    : serialFiles.map((file) => file.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts'));
  return {
    test: {
      tags: [{ name: 'release', description: 'Owned archive/install qualification', skip: lane !== 'release' }],
      pool: 'forks',
      testTimeout: 60_000,
      projects: [
        {
          test: {
            name: 'parallel',
            include: [compiled ? 'dist/**/*.test.js' : 'src/**/*.test.ts'],
            exclude: serial,
            fileParallelism: true,
            maxWorkers: availableParallelism(),
            sequence: { groupOrder: 0 },
          },
        },
        {
          test: {
            name: 'serial',
            include: serial,
            fileParallelism: false,
            maxWorkers: 1,
            sequence: { groupOrder: 1 },
          },
        },
      ],
    },
  };
});
