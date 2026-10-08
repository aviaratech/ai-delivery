import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Console } from 'node:console';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';
import { afterEach, test, vi } from 'vitest';

import { parseDeliveryConfig } from './config/deliveryConfig.js';
import { syntheticDiscoveryConfig } from './fixtures/discovery.js';
import type { GitHubClients } from './github/client.js';
import { replaceParentIssue } from './github/relationships.js';
import type { DeliveryContext } from './issue.js';
import {
  CLIError,
  handleCommandError,
  logDebug,
  logError,
  logInfo,
  logProgress,
  logSuccess,
  logWarn,
  setLogsSuppressed,
} from './logger.js';
import { addWorktreeEntry, removeWorktreeEntry, type WorktreeEntry } from './services/worktreeRegistry.js';

// Project/field metadata is unrelated to stream routing. Keep these provider
// adapters local while exercising real parent linking, issue start and dispatch.
vi.mock('./github/nativeIssueMetadata.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./github/nativeIssueMetadata.js')>()),
  getConfiguredNativeIssueMetadata: async () => ({ points: 2 }),
  setConfiguredNativeIssueMetadata: async () => ({ points: 2 }),
  clearConfiguredNativeIssuePoints: async () => {},
}));
vi.mock('./github/projectDelivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./github/projectDelivery.js')>()),
  getIssueProjectStatus: async () => null,
  syncIssueProjectStatus: async () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setLogsSuppressed(false);
});

function fixture(developmentFails = false): { context: DeliveryContext; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-delivery-stdout-')));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Synthetic Delivery');
  git('config', 'user.email', 'delivery@example.test');
  writeFileSync(join(root, 'artifact.txt'), 'synthetic\n');
  git('add', 'artifact.txt');
  git('commit', '-qm', 'synthetic base');
  git('remote', 'add', 'origin', 'https://github.com/example/widget.git');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  let parent: number | null = null;
  const issue = {
    id: 170,
    number: 17,
    node_id: 'ISSUE-17',
    title: 'Synthetic change',
    body: '## Outcome\nDeliver a verified synthetic change to the local repository.\n\n## Scope\n- `artifact.txt`\n\n## Acceptance Criteria\n- [ ] Change works\n- [ ] Review passes\n\n## Verification\nRun `node --version`.',
    state: 'open',
    html_url: 'https://github.com/example/widget/issues/17',
    labels: [],
    type: { name: 'Task' },
  };
  const rest = new Octokit();
  Object.assign(rest.issues, {
    get: async ({ issue_number }: { issue_number: number }) => ({
      data:
        issue_number === 17
          ? { ...issue, state: developmentFails ? 'closed' : 'open' }
          : { ...issue, number: issue_number, id: issue_number * 10, node_id: `ISSUE-${String(issue_number)}` },
    }),
    create: async () => ({ data: issue }),
    update: async () => ({ data: issue }),
    listSubIssues: async () => ({ data: parent === null ? [] : [issue] }),
    addSubIssue: async ({ issue_number }: { issue_number: number }) => {
      parent = issue_number;
      return { data: issue };
    },
  });
  Object.assign(rest, { paginate: async () => (parent === null ? [] : [issue]) });
  const clients: GitHubClients = {
    authSource: 'personal',
    role: 'author',
    rest,
    graphql: (async (query: string) => {
      const page = { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } };
      if (query.includes('blockedBy(')) {
        return {
          repository: {
            issue: {
              blockedBy: page,
              parent:
                parent === null
                  ? null
                  : { id: 'ISSUE-5', number: parent, repository: { nameWithOwner: 'example/widget' } },
            },
          },
        };
      }
      if (query.includes('blocking(')) return { repository: { issue: { blocking: page } } };
      if (query.includes('subIssues(')) return { repository: { issue: { subIssues: page } } };
      throw new Error('Unexpected synthetic stdout query.');
    }) as GitHubClients['graphql'],
  };
  const config = parseDeliveryConfig({
    ...syntheticDiscoveryConfig,
    schemaVersion: 'ai-delivery.config@2',
    policy: { contract: 'RepositoryDeliveryPolicy@1', module: './policy.mjs' },
    roles: {
      author: { identity: 'host-author', authSource: 'personal', credentialEnv: { token: 'AUTHOR_TOKEN' } },
      reviewer: {
        identity: 'synthetic-reviewer',
        credentialEnv: {
          appId: 'REVIEWER_APP_ID',
          installationId: 'REVIEWER_INSTALLATION_ID',
          privateKeyPath: 'REVIEWER_KEY_PATH',
        },
      },
    },
    commandPolicy: {
      checks: { format: 'REQUIRED', gitClean: 'REQUIRED', lint: 'REQUIRED', test: 'REQUIRED', typecheck: 'REQUIRED' },
      timeoutsMs: { lint: 60000, test: 60000, typecheck: 60000 },
    },
  });
  return {
    context: { root, repo: { owner: 'example', repo: 'widget' }, clients, config },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function captureStreams(): { output: { stdout: string; stderr: string }; restore: () => void } {
  const output = { stdout: '', stderr: '' };
  const previousConsole = globalThis.console;
  // Vitest intercepts console calls before they reach process streams. Use a
  // native console so the byte-level capture matches an actual CLI process.
  globalThis.console = new Console(process.stdout, process.stderr);
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    output.stdout += String(value);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    output.stderr += String(value);
    return true;
  });
  return {
    output,
    restore: () => {
      out.mockRestore();
      err.mockRestore();
      globalThis.console = previousConsole;
    },
  };
}

test('parent replacement emits its diagnostic on stderr without writing any stdout bytes', async () => {
  const f = fixture();
  const capture = captureStreams();
  try {
    await replaceParentIssue({ ...f.context.clients, repo: f.context.repo, issueNumber: 17, parentIssueNumber: 5 });
    assert.equal(capture.output.stdout, '');
    assert.match(capture.output.stderr, /Linked issue #17 as sub-issue of issue #5\./u);
  } finally {
    capture.restore();
    f.cleanup();
  }
});

test.each(['add', 'remove'] as const)(
  'registry %s emits its diagnostic without writing any stdout bytes',
  async (operation) => {
    const f = fixture();
    const row: WorktreeEntry = {
      path: join(f.context.root, '.worktrees', 'synthetic'),
      branch: 'issue/17',
      type: 'issue',
      issueNumber: 17,
      identity: 'host-author',
      status: 'active',
      createdAt: '2026-10-08T00:00:00Z',
      updatedAt: '2026-10-08T00:00:00Z',
    };
    const capture = captureStreams();
    try {
      await addWorktreeEntry(row, f.context.root);
      if (operation === 'remove') {
        capture.output.stdout = '';
        capture.output.stderr = '';
        assert.equal(await removeWorktreeEntry(row.path, f.context.root), true);
      }
      assert.equal(capture.output.stdout, '');
      assert.match(
        capture.output.stderr,
        operation === 'add' ? /Added to worktree registry:/u : /Removed from worktree registry:/u,
      );
    } finally {
      capture.restore();
      f.cleanup();
    }
  },
);

async function runCli(
  context: DeliveryContext,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: typeof process.exitCode }> {
  vi.resetModules();
  const configuration = await import('./config/deliveryConfig.js');
  const issues = await import('./issue.js');
  const admission = await import('./services/deliveryAdmission.js');
  const prs = await import('./pr.js');
  const dispatch = await import('./dispatch.js');
  vi.spyOn(configuration, 'loadDeliverySettings').mockResolvedValue({
    ...context.config,
    configPath: null,
    overrides: { schemaVersion: 'ai-delivery.config@2' },
    policyModulePath: join(context.root, 'policy.mjs'),
    sourceDigest: 'synthetic',
  });
  vi.spyOn(issues, 'loadDeliveryContext').mockResolvedValue(context);
  // Synthetic authorization seams: these tests exercise streams, not live access.
  vi.spyOn(admission, 'assertDeliveryRuntimeAdmitted').mockResolvedValue(
    {} as Awaited<ReturnType<typeof admission.assertDeliveryRuntimeAdmitted>>,
  );
  vi.spyOn(prs, 'preflightReviewRoute').mockResolvedValue({} as Awaited<ReturnType<typeof prs.preflightReviewRoute>>);
  const argv = process.argv;
  const exitCode = process.exitCode;
  const capture = captureStreams();
  let completed: () => void = () => {};
  let failed: (error: unknown) => void = () => {};
  const resultWritten = new Promise<void>((resolve, reject) => {
    completed = resolve;
    failed = reject;
  });
  const execute = dispatch.executeTool;
  vi.spyOn(dispatch, 'executeTool').mockImplementation(async (...input) => {
    try {
      return await execute(...input);
    } catch (error) {
      failed(error);
      throw error;
    }
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    capture.output.stdout += String(value);
    // Wait for the result, not the earlier diagnostic chunk that reproduces #74.
    if (String(value).startsWith('{')) completed();
    return true;
  });
  try {
    process.exitCode = undefined;
    process.argv = [process.execPath, 'ai-delivery', '--repo-root', context.root, '--identity', 'host-author', ...args];
    await import('./cli.js');
    await resultWritten;
    return { ...capture.output, exitCode: process.exitCode };
  } finally {
    capture.restore();
    vi.restoreAllMocks();
    process.argv = argv;
    process.exitCode = exitCode;
  }
}

test('parent update through the CLI entry produces one parseable JSON result', async () => {
  const f = fixture();
  try {
    const output = await runCli(f.context, ['update', '--issue', '17', '--parent', '5']);
    const result = JSON.parse(output.stdout) as { issueNumber: number; parentIssueNumber: number };
    assert.equal(result.issueNumber, 17);
    assert.equal(result.parentIssueNumber, 5);
    assert.equal(output.exitCode, undefined);
    assert.match(output.stderr, /Linked issue #17 as sub-issue of issue #5\./u);
  } finally {
    f.cleanup();
  }
});

test('failed development after parent linking preserves parseable CLI recovery JSON and nonzero exit', async () => {
  const f = fixture(true);
  try {
    const output = await runCli(f.context, [
      'start',
      '--title',
      'Synthetic change',
      '--body',
      '## Outcome\nDeliver a verified synthetic change to the local repository.\n\n## Scope\n- `artifact.txt`\n\n## Acceptance Criteria\n- [ ] Change works\n- [ ] Review passes\n\n## Verification\nRun `node --version`.',
      '--parent',
      '5',
      '--develop',
    ]);
    const result = JSON.parse(output.stdout) as {
      status: string;
      createdIssue: { number: number };
      failure: { phase: string; message: string };
      safeResume: {
        arguments: { issueNumber: number; parentIssueNumber: number; develop: boolean; resumeCreated: boolean };
      };
    };
    assert.equal(result.status, 'created-not-started');
    assert.equal(result.createdIssue.number, 17);
    assert.equal(result.failure.phase, 'development');
    assert.match(result.failure.message, /closed/u);
    assert.equal(result.safeResume.arguments.issueNumber, 17);
    assert.equal(result.safeResume.arguments.parentIssueNumber, 5);
    assert.equal(result.safeResume.arguments.develop, true);
    assert.equal(result.safeResume.arguments.resumeCreated, true);
    assert.equal(output.exitCode, 1);
    assert.match(output.stderr, /Linked issue #17 as sub-issue of issue #5\./u);
  } finally {
    f.cleanup();
  }
});

test('all enabled diagnostics preserve their content on stderr', () => {
  vi.stubEnv('DEBUG', '1');
  const capture = captureStreams();
  try {
    logDebug('debug proof');
    logInfo('info proof');
    logSuccess('success proof');
    logWarn('warning proof');
    logError('error proof');
    logProgress('progress proof');
    handleCommandError(new CLIError('failure proof', { hint: 'retry proof' }));
    assert.equal(capture.output.stdout, '');
    for (const message of ['debug', 'info', 'success', 'warning', 'error', 'progress', 'failure', 'retry']) {
      assert.match(capture.output.stderr, new RegExp(`${message} proof`, 'u'));
    }
  } finally {
    capture.restore();
  }
});

test('MCP suppression still silences diagnostics while retaining errors and recovery hints on stderr', () => {
  vi.stubEnv('DEBUG', 'true');
  setLogsSuppressed(true);
  const capture = captureStreams();
  try {
    logDebug('hidden');
    logInfo('hidden');
    logSuccess('hidden');
    logWarn('hidden');
    logProgress('hidden');
    handleCommandError(new CLIError('visible error', { hint: 'visible recovery' }));
    assert.equal(capture.output.stdout, '');
    assert.doesNotMatch(capture.output.stderr, /hidden/u);
    assert.match(capture.output.stderr, /visible error/u);
    assert.match(capture.output.stderr, /visible recovery/u);
  } finally {
    capture.restore();
  }
});
