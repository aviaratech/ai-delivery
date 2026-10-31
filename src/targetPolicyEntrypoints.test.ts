import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'vitest';

import { freshEntrypointFixture, type EntrypointPolicy, type EntrypointRequest } from './fixtures/inertEntrypoints.js';

type Observation = {
  pid: number;
  mode: string;
  value: Record<string, unknown> | null;
  calls: { name: string; input: unknown }[];
  interpreter: { version: string; executable: string };
  fixtureDriver: string;
};
type Scenario = {
  name: string;
  mode: 'cli' | 'mcp' | 'direct';
  args: string[];
  witness?: string;
  verify(value: Record<string, unknown>): void;
};
const info = (v: Record<string, unknown>) => {
  assert.equal(v.issueNumber, 17);
  assert.equal(v.points, 2);
  assert.equal(v.parentIssueNumber, 11);
  assert.deepEqual(v.blockedBy, [13]);
  assert.equal(v.worktree, null);
  assert.deepEqual(v.childProgress, { childCount: 2, closedChildCount: 1, percentClosed: 50 });
};
const scenarios: Scenario[] = [
  { name: 'CLI info', mode: 'cli', args: ['info', '--issue', '17'], witness: 'issues.get', verify: info },
  {
    name: 'CLI parent wrapper',
    mode: 'cli',
    args: ['parent', '--issue', '17'],
    witness: 'issues.get',
    verify: (v) => assert.deepEqual(v, { issueNumber: 17, parentIssueNumber: 11 }),
  },
  {
    name: 'CLI blocker wrapper',
    mode: 'cli',
    args: ['blockers', '--issue', '17'],
    witness: 'issues.get',
    verify: (v) => assert.deepEqual(v, { issueNumber: 17, blockedBy: [13] }),
  },
  {
    name: 'CLI-only subissues',
    mode: 'cli',
    args: ['subissues', '--issue', '17'],
    witness: 'issues.listSubIssues',
    verify: (v) => assert.deepEqual(v, { issueNumber: 17, subissues: [18, 19] }),
  },
  {
    name: 'CLI direct PR selector',
    mode: 'cli',
    args: ['pr:info', '--pr', '23'],
    witness: 'pulls.get',
    verify: (v) => {
      assert.equal(v.prNumber, 23);
      assert.equal(v.headBranch, 'issue/17');
    },
  },
  {
    name: 'CLI-only PR list',
    mode: 'cli',
    args: ['pr:list', '--state', 'open'],
    witness: 'pulls.list',
    verify: (v) => {
      assert.equal(v.schemaVersion, 'ai-delivery.pr-list@1');
      assert.equal((v.pullRequests as { number: number }[])[0]!.number, 23);
    },
  },
  {
    name: 'CLI-only checks',
    mode: 'cli',
    args: ['pr:checks', '--pr', '23'],
    witness: 'checks.listForRef',
    verify: (v) => {
      assert.equal(v.prNumber, 23);
      assert.equal(v.combinedStatus, 'success');
      assert.deepEqual(v.checkRuns, [{ name: 'checks', status: 'completed', conclusion: 'success' }]);
    },
  },
  {
    name: 'CLI-only routing preflight',
    mode: 'cli',
    args: ['config:resolve'],
    witness: 'appActorLogin',
    verify: (v) => {
      assert.match(String(v.configDigest), /^sha256:[a-f0-9]{64}$/u);
      assert.equal((v.routing as { repository: string }).repository, 'example/widget');
      assert.equal((v.reviewRoute as { reviewer: { actorLogin: string } }).reviewer.actorLogin, 'reviewer[bot]');
    },
  },
  {
    name: 'CLI offline migration',
    mode: 'cli',
    args: ['migrate:legacy-issues'],
    verify: (v) => {
      assert.equal(v.schemaVersion, 'ai-delivery.legacy-issue-migration@1');
      assert.equal(v.validated, 0);
      const plans = v.plans as {
        number: number;
        body: string;
        native: { points: number; issueType: string };
        retiredLabels: string[];
      }[];
      assert.equal(plans.length, 1);
      assert.equal(plans[0]!.number, 17);
      assert.equal(plans[0]!.native.points, 2);
      assert.equal(plans[0]!.native.issueType, 'Task');
      assert.match(plans[0]!.body, /node consumer-trap.cjs/u);
      assert.deepEqual(plans[0]!.retiredLabels, ['effort:s', 'type:task']);
    },
  },
  { name: 'public agent export', mode: 'direct', args: [], witness: 'issues.get', verify: info },
  { name: 'fresh public MCP', mode: 'mcp', args: [], witness: 'issues.get', verify: info },
  ...(['install', 'doctor', 'update', 'rollback', 'remove'] as const).map((action) => ({
    name: `CLI plugin ${action} dry-run`,
    mode: 'cli' as const,
    args: [
      'plugin',
      action,
      '--host',
      'codex',
      '--scope',
      'user',
      '--dry-run',
      '--json',
      ...(['install', 'update'].includes(action) ? ['--version', '0.3.25'] : []),
    ],
    verify: (v: Record<string, unknown>) => {
      assert.equal(v.action, action);
      assert.equal(v.dryRun, true);
      assert.equal(v.changed, false);
      assert.equal(v.installed, false);
      assert.equal(v.repositoryAdmission, 'explicit_stage_and_admit_required');
    },
  })),
  ...[false, true].map((checkAuth) => ({
    name: `CLI plugin uninstalled doctor${checkAuth ? ' auth disposition' : ''}`,
    mode: 'cli' as const,
    args: ['plugin', 'doctor', '--host', 'codex', '--scope', 'user', '--json', ...(checkAuth ? ['--check-auth'] : [])],
    verify: (v: Record<string, unknown>) => {
      assert.equal(v.action, 'doctor');
      assert.equal(v.dryRun, false);
      assert.equal(v.changed, false);
      assert.equal(v.installed, false);
      if (checkAuth) {
        const probe = v.authProbe as {
          reason: string;
          outcome: string;
          authentication: { status: string };
          repositoryAccess: { status: string };
          processReferences: { status: string };
        };
        assert.equal(probe.reason, 'native_plugin_not_ready');
        assert.equal(probe.outcome, 'blocked');
        assert.equal(probe.authentication.status, 'not_checked');
        assert.equal(probe.repositoryAccess.status, 'not_checked');
        assert.equal(probe.processReferences.status, 'not_checked');
      }
    },
  })),
];

const driver = fileURLToPath(new URL('./fixtures/inertEntrypointChild.js', import.meta.url));
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
for (const kind of ['tracked', 'edited'] as const satisfies readonly EntrypointPolicy[]) {
  for (const scenario of scenarios) {
    test(
      `${scenario.name} leaves ${kind} consumer policy inert in a fresh native process`,
      { tags: ['release'], timeout: 15_000 },
      () => {
        const f = freshEntrypointFixture(kind);
        let negative: Observation | undefined;
        const controls: Observation[] = [];
        let cleaned = false;
        let observationPassed = false;
        try {
          const requestPath = join(f.base, 'request.json');
          const env = { ...f.env, AI_DELIVERY_ENTRYPOINT_REQUEST: requestPath };
          const run = (request: EntrypointRequest, main: string, args: string[] = []) => {
            writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
            const stdout = execFileSync(
              process.execPath,
              ['--max-old-space-size=96', '--experimental-test-module-mocks', '--import', driver, main, ...args],
              {
                env,
                cwd: f.root,
                timeout: 5_000,
                maxBuffer: 64 * 1024,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            assert.ok(existsSync(request.report), 'Missing complete child observation');
            const observation: unknown = JSON.parse(readFileSync(request.report, 'utf8'));
            assert.ok(observation && typeof observation === 'object' && !Array.isArray(observation));
            assert.ok('pid' in observation && typeof observation.pid === 'number');
            assert.ok('mode' in observation && typeof observation.mode === 'string');
            assert.ok('calls' in observation && Array.isArray(observation.calls));
            const calls = observation.calls.map((call: unknown) => {
              assert.ok(call && typeof call === 'object' && 'name' in call && typeof call.name === 'string');
              assert.ok('input' in call);
              return { name: call.name, input: call.input };
            });
            assert.ok(
              'interpreter' in observation && observation.interpreter && typeof observation.interpreter === 'object',
            );
            const interpreter = observation.interpreter;
            assert.ok('version' in interpreter && typeof interpreter.version === 'string');
            assert.ok('executable' in interpreter && typeof interpreter.executable === 'string');
            assert.ok('fixtureDriver' in observation && typeof observation.fixtureDriver === 'string');
            const value: unknown = request.mode === 'control' ? null : JSON.parse(stdout);
            assert.ok(value === null || (typeof value === 'object' && !Array.isArray(value)));
            return {
              pid: observation.pid,
              mode: observation.mode,
              calls,
              interpreter: { version: interpreter.version, executable: interpreter.executable },
              fixtureDriver: observation.fixtureDriver,
              value: value as Record<string, unknown> | null,
              entrypointOutputBytes: Buffer.byteLength(stdout),
            };
          };
          for (const [index, bytes] of (kind === 'tracked' ? [f.tracked] : [f.tracked, f.selected]).entries()) {
            writeFileSync(f.policy, bytes);
            const observation = run(
              { root: f.root, report: join(f.base, `control-${index}.json`), head: f.head, mode: 'control', args: [] },
              f.policy,
            );
            controls.push(observation);
            assert.deepEqual(JSON.parse(readFileSync(f.sentinel, 'utf8')), {
              marker: index === 0 ? 'tracked' : 'edited',
              module: pathToFileURL(f.policy).href,
            });
            rmSync(f.sentinel);
          }
          writeFileSync(f.policy, f.selected);
          f.assertInert();
          let args = [...scenario.args];
          if (scenario.name === 'CLI offline migration') {
            const inventory = join(f.base, 'legacy.json');
            writeFileSync(
              inventory,
              JSON.stringify({
                issues: [
                  {
                    number: 17,
                    body: 'Verification prose: node consumer-trap.cjs and npm run trap.',
                    labels: ['effort:s', 'type:task'],
                  },
                ],
              }),
            );
            args.push('--input-file', inventory);
          }
          negative = run(
            { root: f.root, report: join(f.base, 'negative.json'), head: f.head, mode: scenario.mode, args },
            scenario.mode === 'cli' ? cli : driver,
            scenario.mode === 'cli' ? ['--repo', 'example/widget', '--repo-root', f.root, ...args] : [],
          );
          assert.equal(negative.mode, scenario.mode);
          assert.equal(negative.interpreter.executable, process.execPath);
          assert.ok(
            controls.every((control) => control.pid !== negative!.pid),
            'Positive and negative controls must use separate process launches',
          );
          assert.ok(negative.value && typeof negative.value === 'object' && !Array.isArray(negative.value));
          scenario.verify(negative.value);
          if (scenario.witness)
            assert.ok(
              negative.calls.some((c) => c.name === scenario.witness),
              `Missing actual external-port witness ${scenario.witness}`,
            );
          else
            assert.deepEqual(
              negative.calls,
              [],
              'Offline/plugin dispositions must not authenticate or contact a remote port',
            );
          if (scenario.name.startsWith('CLI plugin')) {
            assert.equal(
              existsSync(join(f.home, '.cache')),
              false,
              'Dry-run/uninstalled doctor must not create managed state',
            );
            assert.equal(existsSync(join(f.home, '.codex')), false, 'No native host settings may be created');
          }
          f.assertInert();
          f.assertBound();
          for (const call of negative.calls) {
            const input = call.input as Record<string, unknown> | null;
            if (input && 'owner' in input) assert.equal(input.owner, 'example');
            if (input && 'repo' in input) assert.equal(input.repo, 'widget');
            if (input && 'name' in input) assert.equal(input.name, 'widget');
            if (input && 'issue_number' in input) {
              if (call.name === 'GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values')
                assert.ok(
                  [17, 18, 19].includes(input.issue_number as number),
                  'Only parent and declared direct children may supply fields',
                );
              else assert.equal(input.issue_number, 17);
            }
            if (input && 'pull_number' in input) assert.equal(input.pull_number, 23);
            if (call.name === 'checks.listForRef' || call.name === 'repos.getCombinedStatusForRef')
              assert.equal(input?.ref, f.head);
          }
          observationPassed = true;
        } finally {
          const policyInert = !existsSync(f.sentinel);
          try {
            f.cleanup();
            cleaned = true;
          } finally {
            const evidence = process.env.AI_DELIVERY_INERT_EVIDENCE_DIR;
            if (evidence)
              writeFileSync(
                join(evidence, `${f.head}-${scenario.name.replace(/[^a-zA-Z0-9]/gu, '-')}-${kind}.json`),
                JSON.stringify({
                  scenario: scenario.name,
                  policyState: kind,
                  selectedPayloadSha256: f.payloadSha256,
                  indexedPayloadSha256: f.indexedSha256,
                  controls,
                  negative,
                  policyInert,
                  observationPassed,
                  ownedCleanup: cleaned,
                }) + '\n',
                { flag: 'wx' },
              );
          }
        }
      },
    );
  }
}
