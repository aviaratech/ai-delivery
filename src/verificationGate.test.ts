import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const observation = vi.hoisted(() => ({ mode: 'healthy', calls: 0 }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      if (args[0] !== '/usr/bin/ps' && args[0] !== '/bin/ps') return actual.spawnSync(...args);
      observation.calls++;
      if (observation.mode === 'unavailable' || observation.mode === 'partial-unavailable')
        return {
          status: null,
          error: Object.assign(new Error('synthetic observation timeout'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
          stdout: observation.mode === 'partial-unavailable' ? '1 0 1 1 S birth\n2 0' : '',
          stderr: '',
        };
      return {
        status: 0,
        signal: null,
        stdout: `${process.pid} ${process.ppid} ${process.pid} 32 S current birth\n999999 0 999999 32 S unrelated birth\n`,
        stderr: '',
      };
    },
  };
});
const { processSnapshot } = await import('./verification.js');

for (const mode of ['unavailable', 'partial-unavailable'] as const) {
  test(`observer failure preserves bounded numeric provenance for ${mode}`, () => {
    observation.mode = mode;
    assert.throws(processSnapshot, (error: unknown) => {
      assert.ok(error instanceof Error);
      const prefix = 'Owned process resource observation failed. ';
      assert.ok(error.message.startsWith(prefix));
      const metadata = JSON.parse(error.message.slice(prefix.length)) as Record<string, unknown>;
      assert.equal(metadata.status, null);
      assert.equal(metadata.errorCode, 'ETIMEDOUT');
      assert.equal(metadata.signal, 'SIGTERM');
      assert.equal(metadata.stdoutPresent, true);
      assert.equal(metadata.stdoutTerminated, false);
      assert.ok(typeof metadata.elapsedMs === 'number' && Number.isSafeInteger(metadata.elapsedMs));
      assert.ok(metadata.elapsedMs >= 0);
      assert.equal(metadata.stdoutBytes, mode === 'unavailable' ? 0 : 19);
      assert.equal(metadata.completeLines, mode === 'unavailable' ? 0 : 1);
      assert.equal(error.message.includes('birth'), false);
      return true;
    });
  });
}
