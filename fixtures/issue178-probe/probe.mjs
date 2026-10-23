// Temporary issue178 experiment. No live credentials, package imports or host changes.
import { spawn, spawnSync, fork } from 'node:child_process';
import { createHash, generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, existsSync, copyFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';

/** @typedef {import('node:child_process').ChildProcess} Child */
/** @typedef {{pid:number,birth?:string}} Identity */
/** @typedef {Identity & {state:string,sameIdentity?:boolean,observerFailure?:object,observerMethod?:string}} Observation */
/** @typedef {{phase:string,identity:Identity,root?:Identity,jobZero?:boolean,pendingReadsSettled?:boolean,reason?:string}} Status */
/** @typedef {{id:string,childPid:number|null,supervisor:Identity|null,attempted:boolean,accepted:boolean,threw:boolean,signal:string,completedAt:string,exitCodeBefore:number|null,signalCodeBefore:NodeJS.Signals|null}} StopReceipt */
/** @typedef {{action:string,event:string,value:Status,request:unknown,code:number|null,signal:NodeJS.Signals|null,statuses:Status[],bytes:number,protocolBytes:number,nonProtocolLines:number,trailingProtocolBytes:number,output:string,stopId:string,stop:StopReceipt}} Message */
/** @typedef {{error:boolean,closed:boolean,code?:number|null,signal?:NodeJS.Signals|null,done:Promise<void>}} ChildOutcome */
/** @typedef {{schema:string,sourceSha:string,sourceTree:string,platform:string,arch:string,node:string,files:Record<string,string>}} Manifest */
/** @typedef {{mode:string,startedAt:string,identities:Identity[],passed:boolean,requestSent?:boolean,actionSent?:boolean,statuses?:Status[],final?:Status|null,transport?:object,boundary?:string,supervisorStop?:(StopReceipt & {observedAt:string}),supervisorAbsence?:Observation,jobZero?:string,literalArgumentsExact?:boolean,selectedRsaResponseExact?:boolean,sourceValidation?:string,nativeAbsence?:Observation[],peerPreserved?:boolean,completedAt?:string,driverRssBytes?:number}} Case */
/** @typedef {{identity:Identity,absent:boolean|'unknown',terminationNeeded?:boolean,replacementPreserved?:boolean,observation?:Observation}} Cleanup */
/** @typedef {{state?:string,directOwnedHandleExited?:boolean,launchFailed?:boolean}} PeerCleanup */
/** @typedef {{schema:string,source:Manifest,manifestSha256:string,platform:string,arch:string,osRelease:string,node:string,powershell:string,startedAt:string,complete:boolean,productAcceptance:boolean,liveCredentialAccess:boolean,cases:Case[],cleanup:Cleanup[],errors:{category:string,reason:string}[],unexecuted:string[],limits:object,peer?:Observation,peerAfterCases?:Observation,peerCleanup?:PeerCleanup,cleanupConfirmed?:boolean,cleanupContract?:string,completedAt?:string}} Report */

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'supervisor.ps1');
/** @param {import('node:crypto').BinaryLike} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const literal = ['', 'with spaces', 'snowman-\u2603', 'embedded"quote', 'trailing\\', ';$env:USERPROFILE|&%PATH%'];
const safe = () => Object.fromEntries(
  ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
);
/** @param {string} message @returns {never} */
const fail = (message) => { throw new Error(message); };
/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) fail(message); }
/** @param {number} ms */
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
/** @type {WeakMap<Child, ChildOutcome>} */
const childOutcomes = new WeakMap();
/** @template {Child} T @param {T} child @returns {T} */
function tracked(child) {
  /** @type {ChildOutcome} */
  const outcome = { error: false, closed: false, done: Promise.resolve() };
  outcome.done = new Promise((done) => {
    child.once('error', () => { outcome.error = true; });
    child.once('close', (code, signal) => {
      outcome.closed = true; outcome.code = code; outcome.signal = signal; done(outcome);
    });
  });
  childOutcomes.set(child, outcome);
  return child;
}
/** @param {string} path @param {unknown} value */
function atomic(path, value) {
  writeFileSync(path + '.partial', JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(path + '.partial', path);
}
function powershell() {
  check(process.platform === 'win32' && process.arch === 'x64', 'Native Windows x64 required');
  const root = process.env.SystemRoot;
  check(root && /^[A-Za-z]:\\/u.test(root), 'Missing fully qualified SystemRoot');
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  check(existsSync(executable), 'Stock PowerShell5.1 unavailable; no fallback');
  return executable;
}
/** @param {Identity} identity @param {boolean} terminate @returns {Observation} */
function inspect(identity, terminate = false) {
  // ESRCH proves this retained identity is absent without starting another observer.
  // Every other outcome uses the unchanged creation-identity inspector; this never terminates.
  if (!terminate && Number.isInteger(identity.pid) && identity.pid > 0 && /^[0-9]+$/u.test(identity.birth ?? '')) {
    try { process.kill(identity.pid, 0); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return { pid: identity.pid, birth: identity.birth, state: 'absent', observerMethod: 'node-signal-zero-ESRCH' };
      }
    }
  }
  const args = ['-NoProfile', '-NonInteractive', '-File', script, '-Mode', 'Inspect', '-TargetPid', String(identity.pid)];
  if (identity.birth) args.push('-ExpectedBirth', identity.birth);
  if (terminate) {
    check(/^[0-9]+$/u.test(identity.birth ?? ''), 'Cleanup requires retained creation identity');
    args.push('-TerminateOwned');
  }
  const observed = spawnSync(powershell(), args, { shell: false, env: safe(), encoding: 'utf8', maxBuffer: 16384 });
  const transport = { status: observed.status, signal: observed.signal,
    errorCode: /** @type {NodeJS.ErrnoException|undefined} */ (observed.error)?.code ?? null,
    stdoutBytes: Buffer.byteLength(observed.stdout ?? ''), stderrBytes: Buffer.byteLength(observed.stderr ?? '') };
  if (observed.status !== 0) return { pid: identity.pid, state: 'unknown', observerFailure: { kind: 'transport', ...transport } };
  try { return /** @type {Observation} */ (JSON.parse(observed.stdout)); }
  catch { return { pid: identity.pid, state: 'unknown', observerFailure: { kind: 'structured-proof', ...transport } }; }
}
/** @param {Identity} identity */
async function absent(identity) {
  const first = inspect(identity);
  if (first.state === 'absent') return { identity, absent: true, terminationNeeded: false };
  if (first.state === 'alive' && first.sameIdentity === false && first.pid === identity.pid &&
      /^[0-9]+$/u.test(identity.birth ?? '') && /^[0-9]+$/u.test(first.birth ?? '') && first.birth !== identity.birth) {
    return { identity, absent: true, terminationNeeded: false, replacementPreserved: true, observation: first };
  }
  if (first.state !== 'alive' || !first.sameIdentity) return { identity, absent: 'unknown', observation: first };
  const stopped = inspect(identity, true);
  return { identity, absent: stopped.state === 'absent' && stopped.sameIdentity ? true : 'unknown',
    terminationNeeded: true, observation: stopped };
}
/** @param {Child} child */
async function exited(child) {
  const outcome = childOutcomes.get(child);
  check(outcome, 'Child outcome was not retained before launch');
  return outcome.done;
}
/** @param {string} mode */
async function helper(mode) {
  if (mode === 'peer' || mode === 'hold') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'pem' || mode === 'base64') {
    check(JSON.stringify(process.argv.slice(4)) === JSON.stringify(literal), 'Literal argv changed');
    const key = process.env.ISSUE178_SYNTHETIC_KEY;
    check(key?.startsWith('-----BEGIN PRIVATE KEY-----'), 'Synthetic key absent');
    process.stdout.write(mode === 'base64' ? Buffer.from(key).toString('base64') : key);
    return;
  }
  if (mode === 'denied') { process.stderr.write('SYNTHETIC_PRIVATE_ERROR'); process.exitCode = 7; return; }
  if (mode === 'malformed') { process.stdout.write('SYNTHETIC_MALFORMED_KEY'); return; }
  if (mode === 'overflow' || mode === 'stderr-overflow') {
    (mode === 'overflow' ? process.stdout : process.stderr).write('x'.repeat(70 * 1024));
    setInterval(() => {}, 1000);
    return;
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'helper', 'hold'], {
    detached: true, stdio: 'ignore', shell: false, env: safe(),
  });
  child.once('error', () => process.exit(3));
  child.unref();
  process.stderr.write('synthetic-child-' + String(child.pid) + '\n');
  if (mode === 'immediate-exit') process.exit(0);
  else if (mode === 'descendant-exit') setTimeout(() => process.exit(0), 500);
  else setInterval(() => {}, 1000);
}
async function controller() {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams|undefined} */
  let child;
  /** @type {Identity|undefined} */
  let supervisorIdentity;
  /** @type {Buffer[]} */
  let output = [];
  let bytes = 0;
  let protocolBytes = 0;
  let pending = '';
  /** @type {Status[]} */
  let statuses = [];
  let nonProtocolLines = 0;
  const endInput = () => { try { child?.stdin.end(); } catch { try { child?.kill(); } catch { /* Retained close outcome owns cleanup. */ } } };
  /** @param {object} value @param {()=>void} [done] */
  function emit(value, done) {
    if (!process.connected) { endInput(); done?.(); return; }
    try { process.send(value, (error) => { if (error) endInput(); done?.(); }); }
    catch { endInput(); done?.(); }
  }
  process.once('disconnect', endInput);
  process.on('message', (raw) => {
    const message = /** @type {Message} */ (raw);
    try {
    if (message.action === 'launch') {
      child = tracked(spawn(powershell(), ['-NoProfile', '-NonInteractive', '-File', script], {
        shell: false, env: safe(), stdio: ['pipe', 'pipe', 'pipe'],
      }));
      child.stdin.on('error', () => {});
      child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
        bytes += chunk.length;
        if (bytes <= 65536) output.push(chunk);
        else { output = []; child.kill(); }
      });
      child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
        protocolBytes += chunk.length;
        if (protocolBytes > 65536) { child.kill(); return; }
        pending += chunk.toString('utf8');
        for (;;) {
          const index = pending.indexOf('\n');
          if (index < 0) break;
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          try {
            const value = /** @type {Status} */ (JSON.parse(line));
            if (value.phase === 'bootstrap') supervisorIdentity = value.identity;
            statuses.push(value);
            emit({ event: 'status', value });
          } catch { nonProtocolLines++; }
        }
      });
      child.once('error', () => emit({ event: 'spawn-error' }));
      child.once('close', (code, signal) => {
        emit({ event: 'finished', code, signal, statuses, bytes, protocolBytes, nonProtocolLines,
          trailingProtocolBytes: Buffer.byteLength(pending),
          output: Buffer.concat(output).toString('base64') }, () => process.exit(0));
      });
    } else if (message.action === 'request') child.stdin.write(JSON.stringify(message.request) + '\n');
    else if (message.action === 'cancel') child.stdin.write('cancel\n');
    else if (message.action === 'eof') endInput();
    else if (message.action === 'stop') {
      const exitCodeBefore = child?.exitCode ?? null;
      const signalCodeBefore = child?.signalCode ?? null;
      let attempted = false;
      let accepted = false;
      let threw = false;
      if (child && exitCodeBefore === null && signalCodeBefore === null) {
        attempted = true;
        try { accepted = child.kill('SIGTERM'); } catch { threw = true; }
      }
      const completedAt = new Date().toISOString();
      emit({ event: 'supervisor-stop-result', stop: { id: message.stopId, childPid: child?.pid ?? null,
        supervisor: supervisorIdentity ? { pid: supervisorIdentity.pid, birth: supervisorIdentity.birth } : null,
        attempted, accepted, threw, signal: 'SIGTERM', completedAt, exitCodeBefore, signalCodeBefore } });
    }
    } catch {
      endInput();
      emit({ event: 'controller-error' }, () => { if (!child) process.exit(2); });
    }
  });
}
/** @param {string} destination */
function stage(destination) {
  check(process.platform === 'linux', 'Staging proof requires native Linux');
  check(!existsSync(destination), 'Fresh staging directory required');
  mkdirSync(destination, { recursive: true });
  /** @type {Record<string,string>} */
  const files = {};
  for (const name of ['probe.mjs', 'supervisor.ps1']) {
    const source = join(here, name);
    check(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'Regular fixture file required');
    copyFileSync(source, join(destination, name));
    files[name] = sha256(readFileSync(source));
  }
  /** @param {string[]} args */
  const git = (args) => {
    const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 4096 });
    check(result.status === 0, 'Source identity unavailable');
    return result.stdout.trim();
  };
  const head = git(['rev-parse', 'HEAD']);
  check(head === process.env.PROBE_SOURCE_SHA && /^[a-f0-9]{40}$/u.test(head), 'Staged source mismatch');
  const manifest = { schema: 'issue178-probe-input@1', sourceSha: head, sourceTree: git(['rev-parse', 'HEAD^{tree}']),
    platform: process.platform, arch: process.arch, node: process.version, files };
  atomic(join(destination, 'manifest.json'), manifest);
  const digest = sha256(readFileSync(join(destination, 'manifest.json')));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'input_digest=' + digest + '\n');
  console.log(JSON.stringify({ stage: 'linux-input-complete', sourceSha: head, files,
    manifestSha256: digest }));
}
/** @param {string} destination */
async function run(destination) {
  check(process.platform === 'win32' && process.arch === 'x64' && process.version === 'v24.21.0', 'Native pinned Windows controller required');
  check(!existsSync(destination), 'Fresh result directory required');
  mkdirSync(destination, { recursive: true });
  const manifest = /** @type {Manifest} */ (JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')));
  check(sha256(readFileSync(join(here, 'manifest.json'))) === process.env.PROBE_INPUT_DIGEST, 'Linux artifact digest mismatch');
  check(manifest.platform === 'linux' && manifest.sourceSha === process.env.PROBE_SOURCE_SHA, 'Linux/source provenance mismatch');
  for (const [name, digest] of Object.entries(manifest.files)) check(sha256(readFileSync(join(here, name))) === digest, 'Detached fixture bytes changed');
  /** @type {Report} */
  const report = { schema: 'issue178-windows-feasibility@1', source: manifest,
    manifestSha256: sha256(readFileSync(join(here, 'manifest.json'))), platform: process.platform, arch: process.arch,
    osRelease: release(), node: process.version, powershell: powershell(), startedAt: new Date().toISOString(),
    complete: false, productAcceptance: false, liveCredentialAccess: false, cases: [], cleanup: [], errors: [],
    unexecuted: ['interruption after job/pipe/attribute allocation', 'full issue178 doctor/CredRead/configuration acceptance',
      'production Linux-built plugin qualification', 'other Windows architectures and host policies'],
    limits: { helperResponseMs: 30000, combinedHelperOutputBytes: 65536, supervisorProtocolBytes: 65536,
      nativeCleanupObservationMs: 3000, externalJobLimitMinutes: 15,
      identityObserver: 'synchronous; bounded 16KiB capture; external job backstop only' } };
  const checkpoint = () => {
    const path = join(destination, 'result.json');
    writeFileSync(path + '.partial', JSON.stringify(report, null, 2) + '\n');
    renameSync(path + '.partial', path);
  };
  checkpoint();
  const key = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const peer = tracked(spawn(process.execPath, [fileURLToPath(import.meta.url), 'helper', 'peer'], { shell: false, stdio: 'ignore', env: safe() }));
  /** @type {Observation} */
  let peerIdentity;
  try {
    check(Number.isInteger(peer.pid), 'Peer launch failed before PID assignment');
    peerIdentity = inspect({ pid: peer.pid });
    check(peerIdentity.state === 'alive' && peerIdentity.birth, 'Peer creation identity missing');
  } catch (error) {
    peer.kill(); await exited(peer);
    report.errors.push({ category: 'observer-admission', reason: error instanceof Error ? error.message : 'Observer unavailable' });
    report.peerCleanup = { directOwnedHandleExited: childOutcomes.get(peer).closed, launchFailed: peer.pid === undefined };
    report.cleanupConfirmed = report.peerCleanup.directOwnedHandleExited;
    report.completedAt = new Date().toISOString(); checkpoint(); process.exitCode = 1; return;
  }
  report.peer = peerIdentity;
  /** @type {Set<Child>} */
  const controllers = new Set();
  /** @type {Map<string,Identity>} */
  const owned = new Map();
  const cases = ['pem', 'base64', 'denied', 'malformed', 'missing', 'descendant-exit', 'immediate-exit',
    'cancel', 'eof', 'timeout', 'overflow', 'stderr-overflow', 'initialization-loss', 'controller-loss', 'supervisor-loss'];
  try {
    for (const mode of cases) {
      /** @type {Case} */
      const record = { mode, startedAt: new Date().toISOString(), identities: [], passed: false, requestSent: false, actionSent: false };
      report.cases.push(record); checkpoint();
      console.log(JSON.stringify({ stage: 'native-case', unit: mode, completed: report.cases.length - 1, remaining: cases.length - report.cases.length + 1 }));
      const child = tracked(fork(fileURLToPath(import.meta.url), ['controller'], { execArgv: [], env: safe(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
      controllers.add(child);
      let requestSent = false;
      let actionSent = false;
      /** @type {Identity|undefined} */
      let supervisor;
      /** @type {Message|undefined} */
      let completion;
      let controllerClosed = false;
      /** @type {number|undefined} */
      let rootPid;
      /** @type {string|undefined} */
      let eventFailure;
      /** @type {Status[]} */
      const statuses = [];
      record.statuses = statuses;
      /** @param {object} message */
      const send = (message) => {
        try {
          if (!child.connected) { eventFailure = 'Controller IPC disconnected'; return; }
          child.send(message, (error) => { if (error) eventFailure = 'Controller IPC send failed'; });
        } catch { eventFailure = 'Controller IPC send failed'; }
      };
      const request = {
        argv: [mode === 'missing' ? join(destination, 'missing.exe') : process.execPath, fileURLToPath(import.meta.url), 'helper',
          ['cancel', 'eof', 'timeout', 'controller-loss', 'supervisor-loss'].includes(mode) ? 'hold-tree' : mode, ...literal],
        environment: { ...safe(), ISSUE178_SYNTHETIC_KEY: key }, cwd: destination,
        deadline: new Date(Date.now() + 30000).toISOString(),
      };
      child.on('message', (raw) => {
        const message = /** @type {Message} */ (raw);
        try {
        if (message.event === 'status') {
          const value = message.value; statuses.push(value);
          if (value.phase === 'bootstrap') {
            supervisor = value.identity; owned.set(String(supervisor.pid) + ':' + supervisor.birth, supervisor);
            if (mode === 'initialization-loss') { actionSent = true; child.kill(); }
            else { requestSent = true; send({ action: 'request', request }); }
          }
          if (value.root) { rootPid = value.root.pid; owned.set(String(value.root.pid) + ':' + value.root.birth, value.root); record.identities.push(value.root); }
          if (value.phase === 'member') { owned.set(String(value.identity.pid) + ':' + value.identity.birth, value.identity); record.identities.push(value.identity); }
          if (!actionSent && value.phase === 'member' && value.identity.pid !== rootPid) {
            if (mode === 'cancel') { actionSent = true; send({ action: 'cancel' }); }
            if (mode === 'eof') { actionSent = true; send({ action: 'eof' }); }
            if (mode === 'controller-loss') { actionSent = true; child.kill(); }
            if (mode === 'supervisor-loss') { actionSent = true; send({ action: 'stop', stopId: 'supervisor-loss' }); }
          }
        } else if (message.event === 'supervisor-stop-result' && message.stop.id === 'supervisor-loss') {
          record.supervisorStop = { ...message.stop, observedAt: new Date().toISOString() };
        } else if (message.event === 'finished') {
          completion = message;
          record.final = message.statuses.slice().reverse().find((value) => value.phase === 'complete') ?? null;
          record.transport = { code: message.code, signal: message.signal, bytes: message.bytes,
            protocolBytes: message.protocolBytes, nonProtocolLines: message.nonProtocolLines,
            trailingProtocolBytes: message.trailingProtocolBytes };
        }
        else if (message.event === 'spawn-error') eventFailure = 'Supervisor launch failed';
        else if (message.event === 'controller-error') eventFailure = 'Supervisor controller operation failed';
        } catch { eventFailure = 'Controller message observation failed'; }
        record.requestSent = requestSent; record.actionSent = actionSent;
      });
      child.once('error', () => { eventFailure = 'Controller launch failed'; });
      child.once('close', () => { controllerClosed = true; });
      send({ action: 'launch' });
      // This is the real 30s credential response window, followed by existing cleanup observation.
      // A 10s protocol stall after that window is diagnostic failure, never an extended helper allowance.
      const observationDeadline = Date.now() + 43000;
      while (!completion && !controllerClosed && !eventFailure && Date.now() < observationDeadline) await delay(25);
      if (eventFailure) fail(eventFailure);
      if (!completion && !controllerClosed) { send({ action: 'stop', stopId: 'protocol-stall' }); fail('Supervisor protocol stalled after response and cleanup windows'); }
      await exited(child); controllers.delete(child);
      const final = record.final;
      if (!completion) record.transport = { controllerLost: true };
      if (['initialization-loss', 'controller-loss', 'supervisor-loss'].includes(mode)) {
        if (mode === 'initialization-loss') record.boundary = 'awaiting-first-request-before-Reflection.Emit-or-native-allocation';
        check(actionSent && supervisor, 'Loss boundary was not reached');
        if (mode === 'supervisor-loss') {
          const stop = record.supervisorStop;
          check(stop?.attempted && stop.accepted && !stop.threw && stop.signal === 'SIGTERM' && stop.childPid === supervisor.pid &&
            stop.supervisor?.pid === supervisor.pid && stop.supervisor.birth === supervisor.birth &&
            Date.parse(stop.completedAt) < Date.parse(request.deadline) && Date.parse(stop.observedAt) < Date.parse(request.deadline),
          'Forced supervisor loss was not acknowledged before the original response deadline');
          check(completion?.code === null && completion.signal === 'SIGTERM' && completion.nonProtocolLines === 0 &&
            completion.trailingProtocolBytes === 0 && !completion.statuses.some((value) => value.phase === 'complete'),
          'Supervisor loss requires a directly observed signal close without normal completion');
        }
        await delay(1000);
        const observed = inspect(supervisor);
        record.supervisorAbsence = observed;
        check(observed.state === 'absent', 'Supervisor survived the loss boundary');
        record.jobZero = 'unobserved-after-loss';
      } else {
        check(final && final.jobZero && final.pendingReadsSettled, 'Native job-zero/I/O settlement proof missing');
        const expected = { missing: 'admission-failure', denied: 'helper-exit', cancel: 'cancel', eof: 'parent-eof',
          timeout: 'timeout', overflow: 'overflow', 'stderr-overflow': 'overflow' }[mode] ?? 'success';
        check(final.reason === expected, 'Unexpected native terminal reason');
        check(completion.nonProtocolLines === 0, 'Unstructured supervisor diagnostics');
        check(completion.bytes <= 65536, 'Private output bound exceeded');
        if (mode === 'pem' || mode === 'base64') {
          let pem = Buffer.from(completion.output, 'base64').toString('utf8');
          if (mode === 'base64') pem = Buffer.from(pem, 'base64').toString('utf8');
          check(pem === key && createPrivateKey(pem).asymmetricKeyType === 'rsa', 'Selected synthetic RSA response mismatch');
          record.literalArgumentsExact = true; record.selectedRsaResponseExact = true;
        }
        if (mode === 'malformed') {
          check(Buffer.from(completion.output, 'base64').toString() === 'SYNTHETIC_MALFORMED_KEY', 'Malformed capture mismatch');
          record.sourceValidation = 'outside-this-supervision-probe';
        }
      }
      const identities = [...new Map(record.identities.map((identity) => [String(identity.pid), identity])).values()];
      record.nativeAbsence = identities.map((identity) => inspect(identity));
      check(record.nativeAbsence.every((value) => value.state === 'absent'), 'An owned helper identity survived');
      // Peer preservation stays pending until its original birth identity is alive after every case.
      record.completedAt = new Date().toISOString();
      record.driverRssBytes = process.memoryUsage().rss;
      checkpoint();
    }
    report.peerAfterCases = inspect(peerIdentity);
    check(report.peerAfterCases.state === 'alive' && report.peerAfterCases.sameIdentity, 'Unrelated peer was changed');
    for (const record of report.cases) { record.peerPreserved = true; record.passed = true; }
    report.complete = true;
  } catch (error) {
    report.errors.push({ category: 'probe-failure', reason: error instanceof Error ? error.message : 'Unknown probe failure' });
  } finally {
    for (const child of controllers) {
      try { if (child.connected) child.send({ action: 'stop', stopId: 'cleanup' }, () => {}); } catch { /* Kill and retained close outcome follow. */ }
      await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited(child);
    }
    for (const identity of owned.values()) {
      try { report.cleanup.push(await absent(identity)); }
      catch { report.cleanup.push({ identity, absent: 'unknown' }); }
    }
    if (peer.exitCode === null && peer.signalCode === null) peer.kill();
    await exited(peer);
    report.peerCleanup = inspect(peerIdentity);
    report.cleanupConfirmed = report.cleanup.every((value) => value.absent === true) && report.peerCleanup.state === 'absent';
    report.cleanupContract = 'Observed owned PID/creation identities absent; loss cases retain unobserved job-zero status separately';
    report.completedAt = new Date().toISOString();
    checkpoint();
  }
  console.log(JSON.stringify({ stage: 'native-complete', passed: report.cases.filter((value) => value.passed).length,
    total: cases.length, complete: report.complete, cleanupConfirmed: report.cleanupConfirmed, evidence: join(destination, 'result.json') }));
  if (!report.complete || !report.cleanupConfirmed) process.exitCode = 1;
}
const [mode, argument] = process.argv.slice(2);
if (mode === 'helper') await helper(argument);
else if (mode === 'controller') await controller();
else if (mode === 'stage') stage(resolve(argument));
else if (mode === 'run') await run(resolve(argument));
else fail('Use only the approved stage/run/fixture modes');
