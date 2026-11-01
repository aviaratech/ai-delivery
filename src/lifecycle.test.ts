import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, test } from 'vitest';

const qualificationOwner = (await import(new URL('../scripts/current-qualification.mjs', import.meta.url).href)) as {
  copyReleaseArchive(
    contractPath: string,
    cwd: string,
    destination: string,
  ): { archivePath: string; archiveSha256: string };
};
let node26Package: { executable: string; root: string; temporary: string } | undefined;
afterAll(() => {
  if (node26Package) rmSync(node26Package.temporary, { recursive: true, force: true });
});

function packedNode26Consumer(): { executable: string; root: string; temporary: string } {
  if (node26Package !== undefined) return node26Package;
  assert.equal(process.version, 'v24.21.0', 'canonical verification controller must remain Node 24.21.0');
  const executable = process.env['AI_DELIVERY_NODE26_EXECUTABLE'];
  assert.ok(executable, 'set AI_DELIVERY_NODE26_EXECUTABLE to the actual Node 26.2.0 executable');
  assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(), 'v26.2.0');
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-node26-')));
  try {
    const source = fileURLToPath(new URL('../', import.meta.url));
    const archive = qualificationOwner.copyReleaseArchive(
      process.env.AI_DELIVERY_RELEASE_CONTRACT ?? '',
      source,
      join(temporary, 'qualified.tgz'),
    );
    execFileSync('tar', ['-xzf', archive.archivePath, '-C', temporary]);
    const root = join(temporary, 'package');
    symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    process.stderr.write(
      `ai-delivery.node26-consumer ${JSON.stringify({
        controller: process.version,
        consumer: 'v26.2.0',
        archiveSha256: archive.archiveSha256,
        manifestSha256: createHash('sha256')
          .update(readFileSync(join(root, 'package.json')))
          .digest('hex'),
      })}\n`,
    );
    node26Package = { executable: realpathSync(executable), root, temporary };
    return node26Package;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

// Shared by both readiness producers and the controlled partial-write regression.
const readinessPublisher = `async function publishReadiness(file, bytes, pause) {
  const temporary = file + '.pending';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    if (pause) {
      fs.writeSync(fd, bytes.slice(0, 1));
      await pause();
      fs.writeSync(fd, bytes.slice(1));
    } else fs.writeFileSync(fd, bytes);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}`;

for (const name of ['capability', 'pids'])
  test(
    `readiness record ${name} is unavailable during a controlled partial publication`,
    { tags: ['release'] },
    async ({ signal }) => {
      const output = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-readiness-')));
      const file = join(output, name);
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
      const fs = require('node:fs');
      ${readinessPublisher}
      publishReadiness(${JSON.stringify(file)}, '{"root":17,"descendant":23}', async () => {
        const resumed = new Promise(resolve => process.once('message', resolve));
        process.send('partial');
        await resumed;
      }).then(() => process.disconnect());
    `,
        ],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 5_000 },
      );
      const closed = once(child, 'close');
      try {
        const [message] = (await once(child, 'message', {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        })) as unknown[];
        assert.equal(message, 'partial');
        assert.equal(existsSync(file), false, 'Existence must mean a completely closed readiness record');
      } finally {
        if (child.connected) child.send('complete');
        const [code] = (await closed) as unknown[];
        try {
          assert.equal(code, 0);
          assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { root: 17, descendant: 23 });
          // A fully published malformed record is an immediate failure, never retried.
          writeFileSync(file, '{');
          assert.throws(() => JSON.parse(readFileSync(file, 'utf8')), SyntaxError);
        } finally {
          rmSync(output, { recursive: true, force: true });
        }
      }
    },
  );

test('Node 26 packed public exports load from a consumer', { tags: ['release'] }, () => {
  const consumer = packedNode26Consumer();
  execFileSync(
    consumer.executable,
    [
      '-e',
      `
(async () => {
  const assert = require('node:assert/strict');
  assert.equal(process.version, 'v26.2.0');
  const [root, agent, delivery, mcp] = await Promise.all([
    import('@aviaratech/ai-delivery'), import('@aviaratech/ai-delivery/agent'),
    import('@aviaratech/ai-delivery/delivery'), import('@aviaratech/ai-delivery/mcp'),
  ]);
  assert.equal(root.executeTool, agent.executeTool);
  assert.equal(typeof agent.verifyIssue, 'undefined');
  assert.equal(typeof delivery.loadValidRepositoryDeliveryEvidence, 'undefined');
  assert.equal(typeof mcp.createAiDeliveryMcpServer, 'function');
  const manifest = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './agent', './delivery', './mcp']);
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    ],
    { cwd: consumer.root, stdio: 'pipe' },
  );
});
