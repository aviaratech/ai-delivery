import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';

const observation = vi.hoisted(() => ({ mode: 'healthy', directory: '', calls: 0 }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      if (args[0] !== '/usr/bin/ps' && args[0] !== '/bin/ps') return actual.spawnSync(...args);
      observation.calls++;
      if (
        observation.mode === 'unavailable' ||
        (observation.mode === 'after-lock' && existsSync(join(observation.directory, 'held')))
      )
        return {
          status: null,
          error: Object.assign(new Error('synthetic observation timeout'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
          stdout: '',
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
const { withVerificationFilesystemFixture } = await import('./verification.js');

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function gate(unrelated = false) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-delivery-gate-refusal-'));
  directories.push(directory);
  mkdirSync(join(directory, 'requests'), { mode: 0o700 });
  const capability = {
    directory,
    id: randomUUID(),
    owner: unrelated ? { pid: 999999, identity: 'unrelated birth' } : { pid: process.pid, identity: 'current birth' },
  };
  writeFileSync(join(directory, 'gate.json'), JSON.stringify(capability), { mode: 0o600 });
  vi.stubEnv('AI_DELIVERY_OUTPUT_OBSERVATION_GATE', JSON.stringify(capability));
  observation.directory = directory;
  observation.mode = 'healthy';
  observation.calls = 0;
  return capability;
}

test('filesystem gate refuses unavailable full observation before invoking its fixture', async () => {
  const current = gate();
  observation.mode = 'unavailable';
  let invoked = false;
  await assert.rejects(
    withVerificationFilesystemFixture(() => {
      invoked = true;
    }),
    /observation failed/u,
  );
  assert.equal(invoked, false);
  assert.equal(existsSync(join(current.directory, 'held')), false);
});

test('filesystem gate still observes after lock publication and releases its own lock on refusal', async () => {
  const current = gate();
  observation.mode = 'after-lock';
  let invoked = false;
  await assert.rejects(
    withVerificationFilesystemFixture(() => {
      invoked = true;
    }),
    /observation failed/u,
  );
  assert.equal(invoked, false);
  assert.equal(existsSync(join(current.directory, 'held')), false);
  assert.equal(existsSync(join(current.directory, 'gate.json')), true);
});

test('filesystem gate preserves an abandoned scan request and never invokes the fixture', async () => {
  const current = gate();
  const requestId = randomUUID();
  const path = join(current.directory, 'requests', requestId + '.json');
  const bytes = JSON.stringify({
    gateId: current.id,
    id: requestId,
    kind: 'scan',
    owner: { pid: 999998, identity: 'absent birth' },
  });
  writeFileSync(path, bytes, { mode: 0o600 });
  let invoked = false;
  await assert.rejects(
    withVerificationFilesystemFixture(() => {
      invoked = true;
    }),
    /scan request was abandoned/u,
  );
  assert.equal(invoked, false);
  assert.equal(readFileSync(path, 'utf8'), bytes);
  assert.equal(existsSync(join(current.directory, 'held')), false);
});

test('filesystem gate refuses a live unrelated owner that is not an inherited ancestor', async () => {
  const current = gate(true);
  let invoked = false;
  await assert.rejects(
    withVerificationFilesystemFixture(() => {
      invoked = true;
    }),
    /not an inherited ancestor/u,
  );
  assert.equal(invoked, false);
  assert.equal(existsSync(join(current.directory, 'held')), false);
});
