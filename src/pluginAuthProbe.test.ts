import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { captureAuthenticationProbe } from './pluginAuthProbe.js';
import { processSnapshot } from './verification.js';

// Entirely fictional selected CLI/gh processes: no credentials, keyring, native
// selection, or network. Exercise real owned-tree termination and readback.
let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ai-delivery-auth-probe-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function command(): string[] {
  const gh = join(root, 'gh');
  writeFileSync(
    gh,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'gh-pid.json'))}, JSON.stringify({pid:process.pid,parent:process.ppid}));
process.stdout.write('fictional_auth_secret_stdout');
process.stderr.write('fictional_auth_secret_stderr');
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`,
  );
  chmodSync(gh, 0o755);
  const cli = join(root, 'cli.mjs');
  writeFileSync(
    cli,
    `import { execFile } from 'node:child_process';
execFile(${JSON.stringify(gh)}, ['auth','status'], {encoding:'utf8'}, (error,stdout,stderr)=>{
  process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode=error?1:0;
});
`,
  );
  return [process.execPath, cli];
}
function assertQuiescent(): void {
  const pids = JSON.parse(readFileSync(join(root, 'gh-pid.json'), 'utf8')) as { pid: number; parent: number };
  const snapshot = processSnapshot();
  for (const pid of [pids.pid, pids.parent]) {
    const observed = snapshot.get(pid);
    assert.ok(observed === undefined || /^[ZX]/u.test(observed.status), `Owned fixture PID ${pid} still running.`);
  }
  assert.deepEqual(readdirSync(root).sort(), ['cli.mjs', 'gh', 'gh-pid.json']);
}
const environment = (): NodeJS.ProcessEnv => ({ HOME: root, PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' });

test(
  'authentication timeout confirms cleanup of a hanging gh descendant and withholds output',
  { tags: ['release'] },
  async () => {
    const result = await captureAuthenticationProbe(root, command(), environment(), 2000);
    assert.deepEqual(result, { failed: true, stdout: '', diagnostic: '', cleanupConfirmed: true });
    assertQuiescent();
  },
);

test(
  'authentication cancellation confirms cleanup of a hanging gh descendant and withholds output',
  { tags: ['release'] },
  async () => {
    const cancellation = new AbortController();
    const result = captureAuthenticationProbe(root, command(), environment(), 5000, cancellation.signal);
    const deadline = Date.now() + 4000;
    while (!existsSync(join(root, 'gh-pid.json')) && Date.now() < deadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    cancellation.abort();
    assert.deepEqual(await result, { failed: true, stdout: '', diagnostic: '', cleanupConfirmed: true });
    assertQuiescent();
  },
);

test('successful authentication capture returns stdout only after owned cleanup', { tags: ['release'] }, async () => {
  const result = await captureAuthenticationProbe(
    root,
    [process.execPath, '-e', "process.stdout.write('fictional-readback');process.stderr.write('fictional-secret');"],
    environment(),
  );
  assert.deepEqual(result, { failed: false, stdout: 'fictional-readback', diagnostic: '', cleanupConfirmed: true });
  assert.deepEqual(readdirSync(root), []);
});

test(
  'the production error renderer preserves the owned authentication probe final-line classification',
  { tags: ['release'] },
  async () => {
    const cli = join(root, 'renderer.mjs');
    writeFileSync(
      cli,
      `import { writeFileSync } from 'node:fs';
import { DeliveryError,setMachineRequestDiagnostics } from ${JSON.stringify(new URL('./errors.js', import.meta.url).href)};
import { printCommandError } from ${JSON.stringify(new URL('./cliResult.js', import.meta.url).href)};
writeFileSync(${JSON.stringify(join(root, 'renderer-pid.json'))},JSON.stringify({pid:process.pid}));
process.stdout.write('fictional_private_stdout');process.stderr.write('fictional_private_stderr\\n');
const error=new DeliveryError('Machine GitHub session is invalid or expired; verify the selected github.com account.');
setMachineRequestDiagnostics(error,{phase:'rest.request',endpoint:'issues.get',status:401,code:'UNKNOWN',requestId:'ABCD:1234:5678:9ABC:DEF0'});
printCommandError(error);
`,
    );
    const result = await captureAuthenticationProbe(root, [process.execPath, cli], environment());
    assert.deepEqual(result, {
      failed: true,
      stdout: '',
      diagnostic: 'ai-delivery: Machine GitHub session is invalid or expired; verify the selected github.com account.',
      cleanupConfirmed: true,
    });
    assert.equal(JSON.stringify(result).includes('fictional_private'), false);
    assert.equal(JSON.stringify(result).includes('ABCD:'), false);
    const pid = (JSON.parse(readFileSync(join(root, 'renderer-pid.json'), 'utf8')) as { pid: number }).pid;
    const observed = processSnapshot().get(pid);
    assert.ok(observed === undefined || /^[ZX]/u.test(observed.status));
    assert.deepEqual(readdirSync(root).sort(), ['renderer-pid.json', 'renderer.mjs']);
  },
);
